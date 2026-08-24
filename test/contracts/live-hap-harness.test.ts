import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encode as encodeTlv, H264Level, H264Profile, writeUInt16 } from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error the live harness is untyped operator tooling consumed only by these measurement contracts
import * as harness from '../../scripts/hap-live-harness.mjs';

const {
  MeasuredVideoStream,
  describeSequenceParameterSet,
  appendedLines,
  conditionCodes,
  describeSupportedVideoStreamConfiguration,
  isStructuralJpeg,
  judgeWindow,
  logMark,
  refuseUnadvertised,
  retainedSnapshotName,
  selectedVideoConfiguration,
  snapshotImage,
  unadvertisedSelection,
  untlv,
  untlvList,
  waitFor,
} = harness;

/**
 * Sequence parameter sets produced by `ffmpeg -f lavfi -i testsrc` at the resolutions, profiles, and
 * levels this plugin negotiates. They contain synthetic imagery parameters only, never device media.
 */
const PARAMETER_SETS = {
  '1280x720 high 3.1': Buffer.from('Z2QAH6zZQFAFuwEQAAADABAAAAMDwPGDGWAA', 'base64'),
  '640x360 baseline 3.0': Buffer.from('Z0LAHtkAoC/5cBEAAAMAAQAAAwA8DxYuSAA=', 'base64'),
  '1920x1080 main 4.0': Buffer.from('Z01AKOygPAET8uAiAAADAAIAAAMAeB4wYywA', 'base64'),
} as const;
const PICTURE_PARAMETER_SET = Buffer.from([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
const MASTER_KEY = Buffer.alloc(16, 7);
const MASTER_SALT = Buffer.alloc(14, 9);
const SSRC = 0x1a2b3c4d;
const PAYLOAD_TYPE = 99;

/** RFC 3711 4.3.1 key derivation, written independently of the harness it verifies. */
function sessionMaterial(label: number, length: number): Buffer {
  const iv = Buffer.alloc(16);
  MASTER_SALT.copy(iv, 0);
  iv[7] ^= label;
  return createCipheriv('aes-128-ctr', MASTER_KEY, iv).update(Buffer.alloc(length));
}

/** One authenticated SRTP packet, encrypted and tagged the way an accessory sends it. */
function srtpPacket(options: {
  sequence: number;
  timestamp: number;
  marker: boolean;
  payload: Buffer;
  rolloverCounter?: number;
  ssrc?: number;
  tamper?: boolean;
}): Buffer {
  const rolloverCounter = options.rolloverCounter ?? 0;
  const ssrc = options.ssrc ?? SSRC;
  const header = Buffer.alloc(12);
  header.writeUInt8(0x80, 0);
  header.writeUInt8((options.marker ? 0x80 : 0) | PAYLOAD_TYPE, 1);
  header.writeUInt16BE(options.sequence, 2);
  header.writeUInt32BE(options.timestamp, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  const iv = Buffer.alloc(16);
  sessionMaterial(2, 14).copy(iv, 0);
  for (let byte = 0; byte < 4; byte += 1) {
    iv[4 + byte] ^= (ssrc >>> (24 - byte * 8)) & 0xff;
    iv[8 + byte] ^= (rolloverCounter >>> (24 - byte * 8)) & 0xff;
  }
  iv[12] ^= (options.sequence >>> 8) & 0xff;
  iv[13] ^= options.sequence & 0xff;
  const encrypted = createCipheriv('aes-128-ctr', sessionMaterial(0, 16), iv).update(options.payload);

  const roc = Buffer.alloc(4);
  roc.writeUInt32BE(rolloverCounter);
  const tag = createHmac('sha1', sessionMaterial(1, 20))
    .update(Buffer.concat([header, encrypted, roc]))
    .digest()
    .subarray(0, 10);
  const packet = Buffer.concat([header, encrypted, tag]);
  if (options.tamper) {
    packet[12] ^= 0xff;
  }
  return packet;
}

function stapA(...nalUnits: readonly Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x78]),
    ...nalUnits.flatMap((nal) => {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(nal.length);
      return [size, nal];
    }),
  ]);
}

function fragments(nal: Buffer, count: number): Buffer[] {
  const body = nal.subarray(1);
  const chunk = Math.ceil(body.length / count);
  return Array.from({ length: count }, (_, index) => {
    const start = index === 0 ? 0x80 : 0;
    const end = index === count - 1 ? 0x40 : 0;
    return Buffer.concat([
      Buffer.from([(nal[0] & 0xe0) | 28, start | end | (nal[0] & 0x1f)]),
      body.subarray(index * chunk, (index + 1) * chunk),
    ]);
  });
}

function senderReport(): Buffer {
  const report = Buffer.alloc(28);
  report.writeUInt8(0x80, 0);
  report.writeUInt8(200, 1);
  report.writeUInt16BE(6, 2);
  report.writeUInt32BE(SSRC >>> 0, 4);
  return report;
}

function measured(onNalUnit?: (nal: Buffer) => void): MeasuredVideoStream {
  return new MeasuredVideoStream({
    masterKey: MASTER_KEY,
    masterSalt: MASTER_SALT,
    ssrc: SSRC,
    ...(onNalUnit ? { onNalUnit } : {}),
  });
}

const IDR = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(600, 0x41)]);
const SLICE = Buffer.concat([Buffer.from([0x41]), Buffer.alloc(200, 0x42)]);

/**
 * `SupportedVideoStreamConfiguration` encoded exactly the way `RTPStreamManagement` encodes it from a
 * camera controller's streaming options, including the zero-length delimiters HAP writes between the
 * entries of a repeated type. Written with hap-nodejs's own encoder so the fixture cannot drift from the
 * accessory side of the contract.
 */
function advertisement(
  profiles: readonly H264Profile[],
  levels: readonly H264Level[],
  resolutions: readonly [number, number, number][],
): string {
  return encodeTlv(
    1,
    encodeTlv(
      1,
      0,
      2,
      encodeTlv(1, [...profiles], 2, [...levels], 3, 0),
      3,
      resolutions.map(([width, height, fps]) => encodeTlv(1, writeUInt16(width), 2, writeUInt16(height), 3, fps)),
    ),
  ).toString('base64');
}

const ADVERTISED = describeSupportedVideoStreamConfiguration(
  advertisement(
    [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
    [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
    [
      [320, 180, 15],
      [640, 360, 30],
      [1280, 720, 30],
      [1920, 1080, 30],
    ],
  ),
);

const SELECTION = {
  width: 1280,
  height: 720,
  fps: 30,
  bitrate: 299,
  profile: 'main',
  level: '3.1',
  videoPayloadType: 99,
  audioPayloadType: 110,
};

type CodedParameterSet = { width: number; height: number; profile: string; level: string };

/** Judges one window with a recording sink in place of a run's observation accounting. */
function judged(coded: readonly CodedParameterSet[], expected: unknown): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    judgeWindow(
      { check: (ok: boolean, description: string) => (ok ? passed : failed).push(description) },
      { label: 'window', window: measuredVideo(coded), seconds: 1, expected },
    );
  } finally {
    log.mockRestore();
  }
  return { passed, failed };
}

/** One measured window carrying the given coded parameter sets, as a session snapshot would report it. */
function measuredVideo(coded: readonly CodedParameterSet[]) {
  return {
    packets: 30,
    bytes: 3_000,
    unauthenticated: 0,
    foreign: 0,
    rtcpPackets: 3,
    frames: 30,
    keyframes: 1,
    highestSequence: 30,
    payloadTypes: new Set([99]),
    ssrcs: new Set([1]),
    distinctTimestamps: 30,
    parameterSets: coded.map((set) => ({ ...set, frames: 30 })),
  };
}

describe('observed live conditions', () => {
  it('waits for a condition that has to be read from the accessory', async () => {
    const status = { value: 1 };
    const read = vi.fn(async () => status.value);
    setTimeout(() => {
      status.value = 0;
    }, 20);

    const elapsed = await waitFor(async () => (await read()) === 0, 2_000, 5);

    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(await waitFor(async () => false, 30, 5)).toBeUndefined();
  });

  it('reads only the section of a log a run appended, and reports its condition codes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'live-harness-log-')), 'instance.log');
    writeFileSync(file, 'earlier [camera-live-session-failed] a previous run\n');

    const mark = logMark(file);
    appendFileSync(
      file,
      '[camera-live-session-refused] Live view is unavailable because the camera is turned off\n' +
        '\n' +
        'plain line with no condition\n',
    );

    expect(appendedLines(mark)).toHaveLength(2);
    expect(conditionCodes(appendedLines(mark))).toEqual(new Set(['camera-live-session-refused']));
    expect(logMark(undefined)).toBeUndefined();
  });
});

describe('served HomeKit snapshot imagery', () => {
  it('derives the opaque retained filename without returning the camera serial', () => {
    const accessory = {
      services: [
        {
          type: '0000003E-0000-1000-8000-0026BB765291',
          characteristics: [{ type: '00000030-0000-1000-8000-0026BB765291', value: 'SYNTHETIC0000000001' }],
        },
      ],
    };

    expect(retainedSnapshotName(accessory)).toBe(
      'b493c8118bcb5d34315a2b8ec0e6769f3bbf17143de3e56bacd1d7bbe51704e3.jpg',
    );
    expect(retainedSnapshotName({ services: [] })).toBeUndefined();
  });

  it('accepts only a structurally complete JPEG', () => {
    const complete = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from('synthetic entropy'),
      Buffer.from([0xff, 0xd9]),
    ]);

    expect(isStructuralJpeg(complete)).toBe(true);
    expect(isStructuralJpeg(complete.subarray(0, complete.length - 2))).toBe(false);
    expect(isStructuralJpeg(complete.subarray(1))).toBe(false);
    expect(isStructuralJpeg(Buffer.alloc(0))).toBe(false);
  });

  it('reports one served image by size and digest rather than by its bytes', async () => {
    const image = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from('synthetic served entropy'),
      Buffer.from([0xff, 0xd9]),
    ]);
    const getImage = vi.fn(async () => image);

    const served = await snapshotImage({ getImage }, 7, { width: 640, height: 360 });

    expect(getImage).toHaveBeenCalledWith(640, 360, 7);
    expect(served).toEqual({
      bytes: image.length,
      digest: createHash('sha256').update(image).digest('hex').slice(0, 12),
      structural: true,
    });
    expect(Object.values(served)).not.toContain(image);
  });
});

describe('advertised HomeKit video stream configuration', () => {
  it('reports the profiles, levels, and resolutions one accessory advertises', () => {
    expect(ADVERTISED).toEqual([
      {
        codec: 'h264',
        profiles: ['baseline', 'main', 'high'],
        levels: ['3.1', '3.2', '4.0'],
        packetizationMode: 0,
        resolutions: [
          { width: 320, height: 180, fps: 15 },
          { width: 640, height: 360, fps: 30 },
          { width: 1280, height: 720, fps: 30 },
          { width: 1920, height: 1080, fps: 30 },
        ],
      },
    ]);
  });

  it('reads a single-combination advertisement without inventing the rest of the matrix', () => {
    expect(
      describeSupportedVideoStreamConfiguration(
        advertisement([H264Profile.BASELINE], [H264Level.LEVEL3_1], [[640, 360, 15]]),
      ),
    ).toEqual([
      {
        codec: 'h264',
        profiles: ['baseline'],
        levels: ['3.1'],
        packetizationMode: 0,
        resolutions: [{ width: 640, height: 360, fps: 15 }],
      },
    ]);
  });

  it('separates the entries of a repeated type instead of concatenating them', () => {
    const list = encodeTlv(1, [Buffer.from([1, 2]), Buffer.from([3])], 2, Buffer.from([4]), 1, Buffer.from([5]));

    expect(untlvList(list, 1)).toEqual([Buffer.from([1, 2]), Buffer.from([3]), Buffer.from([5])]);
    expect(untlv(list).get(1)).toEqual(Buffer.from([1, 2, 3, 5]));
  });

  it('accepts a selection the accessory advertised, at or below the advertised frame rate', () => {
    expect(unadvertisedSelection(ADVERTISED, SELECTION)).toEqual([]);
    expect(unadvertisedSelection(ADVERTISED, { ...SELECTION, fps: 15 })).toEqual([]);
    expect(unadvertisedSelection(ADVERTISED, { ...SELECTION, profile: 'high', level: '4.0' })).toEqual([]);
  });

  it('names every part of a selection the accessory never advertised', () => {
    const reduced = describeSupportedVideoStreamConfiguration(
      advertisement([H264Profile.BASELINE], [H264Level.LEVEL3_1], [[640, 360, 15]]),
    );

    expect(unadvertisedSelection(reduced, SELECTION)).toEqual(['profile main', '1280x720@30']);
    expect(unadvertisedSelection(reduced, { ...SELECTION, profile: 'baseline', width: 640, height: 360 })).toEqual([
      '640x360@30',
    ]);
    expect(unadvertisedSelection(ADVERTISED, { ...SELECTION, level: '5.1' })).toEqual(['level 5.1']);
  });

  it('requires one configuration to cover the whole selection rather than several', () => {
    const split = [
      ...describeSupportedVideoStreamConfiguration(
        advertisement([H264Profile.MAIN], [H264Level.LEVEL3_1], [[640, 360, 30]]),
      ),
      ...describeSupportedVideoStreamConfiguration(
        advertisement([H264Profile.BASELINE], [H264Level.LEVEL4_0], [[1280, 720, 30]]),
      ),
    ];

    expect(unadvertisedSelection(split, SELECTION)).toEqual(['1280x720@30']);
    expect(unadvertisedSelection(split, { ...SELECTION, width: 640, height: 360 })).toEqual([]);
  });

  it('refuses a selection outside the advertised matrix before anything is negotiated', () => {
    expect(() => refuseUnadvertised(ADVERTISED, SELECTION, 'selection')).not.toThrow();
    expect(() => refuseUnadvertised(ADVERTISED, { ...SELECTION, level: '5.1' }, 'selection')).toThrow(
      'the accessory does not advertise level 5.1 for the selection',
    );
  });
});

describe('selected HomeKit video configuration', () => {
  it('writes the requested profile and level to the wire, not a fixed pair', () => {
    for (const [profile, identifier] of [
      ['baseline', H264Profile.BASELINE],
      ['main', H264Profile.MAIN],
      ['high', H264Profile.HIGH],
    ] as const) {
      const parameters = untlv(untlv(selectedVideoConfiguration({ ...SELECTION, profile }, 1)).get(2));

      expect(parameters.get(1)).toEqual(Buffer.from([identifier]));
    }
    for (const [level, identifier] of [
      ['3.1', H264Level.LEVEL3_1],
      ['3.2', H264Level.LEVEL3_2],
      ['4.0', H264Level.LEVEL4_0],
    ] as const) {
      const parameters = untlv(untlv(selectedVideoConfiguration({ ...SELECTION, level }, 1)).get(2));

      expect(parameters.get(2)).toEqual(Buffer.from([identifier]));
    }
  });

  it('requests the non-interleaved packetization mode the accessory advertises', () => {
    const parameters = untlv(untlv(selectedVideoConfiguration(SELECTION, 1)).get(2));

    expect(parameters.get(3)).toEqual(Buffer.from([ADVERTISED[0].packetizationMode]));
  });

  it('carries the negotiated attributes and RTP identity of the selection', () => {
    const video = untlv(selectedVideoConfiguration(SELECTION, 0x1a2b3c4d));
    const attributes = untlv(video.get(3));
    const rtp = untlv(video.get(4));

    expect(video.get(1)).toEqual(Buffer.from([0]));
    expect(attributes.get(1)?.readUInt16LE(0)).toBe(1280);
    expect(attributes.get(2)?.readUInt16LE(0)).toBe(720);
    expect(attributes.get(3)?.[0]).toBe(30);
    expect(rtp.get(1)?.[0]).toBe(99);
    expect(rtp.get(2)?.readUInt32LE(0)).toBe(0x1a2b3c4d);
    expect(rtp.get(3)?.readUInt16LE(0)).toBe(299);
  });

  it('refuses to write a profile or level outside the HomeKit vocabulary', () => {
    expect(() => selectedVideoConfiguration({ ...SELECTION, profile: 'constrained-baseline' }, 1)).toThrow(/profile/);
    expect(() => selectedVideoConfiguration({ ...SELECTION, level: '5.1' }, 1)).toThrow(/level/);
  });
});

const CODED_EXACTLY = 'window coded exactly the negotiated main profile at level 3.1';
const NEGOTIATED = { width: 1280, height: 720, profile: 'main', level: '3.1' };

describe('coded fidelity of one measured window', () => {
  it('accepts only the exact negotiated profile and level', () => {
    expect(judged([NEGOTIATED], SELECTION).failed).toEqual([]);
    expect(judged([{ ...NEGOTIATED, profile: 'baseline' }], SELECTION).failed).toEqual([CODED_EXACTLY]);
    expect(judged([{ ...NEGOTIATED, level: '3.0' }], SELECTION).failed).toEqual([CODED_EXACTLY]);
    expect(judged([{ ...NEGOTIATED, profile: 'high' }], SELECTION).failed).toEqual([CODED_EXACTLY]);
  });

  it('accepts Constrained Baseline as the realization of a Baseline selection', () => {
    expect(judged([{ ...NEGOTIATED, profile: 'baseline' }], { ...SELECTION, profile: 'baseline' }).failed).toEqual([]);
  });

  it('fails a window whose coded dimensions are not the negotiated ones', () => {
    expect(judged([{ ...NEGOTIATED, width: 640, height: 360 }], SELECTION).failed).toEqual([
      'window coded the negotiated 1280x720',
    ]);
  });

  it('fails a window that coded one wrong parameter set before a correct one', () => {
    expect(judged([{ ...NEGOTIATED, profile: 'baseline' }, NEGOTIATED], SELECTION).failed).toEqual([CODED_EXACTLY]);
    expect(judged([{ ...NEGOTIATED, width: 640, height: 360 }, NEGOTIATED], SELECTION).failed).toEqual([
      'window coded the negotiated 1280x720',
    ]);
  });

  it('fails a window that coded no parameter set at all', () => {
    expect(judged([], SELECTION).failed).toEqual(['window coded the negotiated 1280x720', CODED_EXACTLY]);
  });
});

describe('live HomeKit stream measurement', () => {
  it('reports negotiated identity, frames, and parameter sets from authenticated SRTP', () => {
    const emitted: Buffer[] = [];
    const stream = measured((nal) => emitted.push(nal));
    let sequence = 1000;
    stream.accept(
      srtpPacket({
        sequence: sequence++,
        timestamp: 90000,
        marker: false,
        payload: stapA(PARAMETER_SETS['1280x720 high 3.1'], PICTURE_PARAMETER_SET),
      }),
    );
    for (const [index, fragment] of fragments(IDR, 3).entries()) {
      stream.accept(srtpPacket({ sequence: sequence++, timestamp: 90000, marker: index === 2, payload: fragment }));
    }
    stream.accept(srtpPacket({ sequence: sequence++, timestamp: 93000, marker: true, payload: SLICE }));

    const report = stream.report;
    expect(report.packets).toBe(5);
    expect(report.unauthenticated).toBe(0);
    expect(report.rtcpPackets).toBe(0);
    expect([...report.payloadTypes]).toEqual([PAYLOAD_TYPE]);
    expect([...report.ssrcs]).toEqual([SSRC >>> 0]);
    expect(report.frames).toBe(2);
    expect(report.keyframes).toBe(1);
    expect(report.parameterSets).toEqual([{ width: 1280, height: 720, profile: 'high', level: '3.1', frames: 2 }]);
    expect(report.highestSequence).toBe(sequence - 1);
    expect(emitted.map((nal) => nal[0] & 0x1f)).toEqual([7, 8, 5, 1]);
    expect(Buffer.concat(emitted.slice(2, 3))).toEqual(IDR);
  });

  it('counts one keyframe for an access unit an encoder split across slices', () => {
    const stream = measured();
    let sequence = 1;
    stream.accept(
      srtpPacket({
        sequence: sequence++,
        timestamp: 90000,
        marker: false,
        payload: stapA(PARAMETER_SETS['1280x720 high 3.1'], PICTURE_PARAMETER_SET),
      }),
    );
    for (const slice of [false, false, true]) {
      stream.accept(srtpPacket({ sequence: sequence++, timestamp: 90000, marker: slice, payload: IDR }));
    }
    for (const slice of [false, true]) {
      stream.accept(srtpPacket({ sequence: sequence++, timestamp: 93000, marker: slice, payload: SLICE }));
    }

    expect(stream.report).toMatchObject({ frames: 2, keyframes: 1 });
    expect(stream.report.parameterSets).toEqual([
      { width: 1280, height: 720, profile: 'high', level: '3.1', frames: 2 },
    ]);
  });

  it('separates multiplexed RTCP from media even when its type resembles a payload type', () => {
    const stream = measured();
    stream.accept(senderReport());
    stream.accept(srtpPacket({ sequence: 1, timestamp: 90000, marker: true, payload: SLICE }));

    expect(stream.report).toMatchObject({ rtcpPackets: 1, packets: 1, payloadTypes: new Set([PAYLOAD_TYPE]) });
  });

  it('counts a packet that fails SRTP authentication instead of decoding it', () => {
    const emitted: Buffer[] = [];
    const stream = measured((nal) => emitted.push(nal));
    stream.accept(srtpPacket({ sequence: 1, timestamp: 90000, marker: true, payload: SLICE, tamper: true }));

    expect(stream.report).toMatchObject({ packets: 0, unauthenticated: 1, frames: 0 });
    expect(emitted).toEqual([]);
  });

  it('does not let an unauthenticated packet advance the rollover counter', () => {
    const stream = measured();
    stream.accept(srtpPacket({ sequence: 0xfff0, timestamp: 90000, marker: true, payload: SLICE }));
    stream.accept(srtpPacket({ sequence: 3, timestamp: 93000, marker: true, payload: SLICE, tamper: true }));
    stream.accept(srtpPacket({ sequence: 0xfff1, timestamp: 96000, marker: true, payload: SLICE }));

    expect(stream.report).toMatchObject({ packets: 2, unauthenticated: 1, frames: 2 });
  });

  it('authenticates packets across a sequence-number rollover', () => {
    const stream = measured();
    stream.accept(srtpPacket({ sequence: 0xffff, timestamp: 90000, marker: true, payload: SLICE }));
    stream.accept(srtpPacket({ sequence: 2, timestamp: 93000, marker: true, payload: SLICE, rolloverCounter: 1 }));

    expect(stream.report).toMatchObject({ packets: 2, unauthenticated: 0, frames: 2 });
  });

  it('describes every negotiated resolution, profile, and level', () => {
    expect(describeSequenceParameterSet(PARAMETER_SETS['1280x720 high 3.1'])).toEqual({
      width: 1280,
      height: 720,
      profile: 'high',
      level: '3.1',
    });
    expect(describeSequenceParameterSet(PARAMETER_SETS['640x360 baseline 3.0'])).toEqual({
      width: 640,
      height: 360,
      profile: 'baseline',
      level: '3.0',
    });
    expect(describeSequenceParameterSet(PARAMETER_SETS['1920x1080 main 4.0'])).toEqual({
      width: 1920,
      height: 1080,
      profile: 'main',
      level: '4.0',
    });
  });

  it('records a reconfigured parameter set as a later distinct observation', () => {
    const stream = measured();
    let sequence = 1;
    for (const key of ['1280x720 high 3.1', '640x360 baseline 3.0'] as const) {
      stream.accept(
        srtpPacket({
          sequence: sequence++,
          timestamp: sequence * 3000,
          marker: false,
          payload: stapA(PARAMETER_SETS[key]),
        }),
      );
      stream.accept(srtpPacket({ sequence: sequence++, timestamp: sequence * 3000, marker: true, payload: IDR }));
    }

    expect(stream.report.parameterSets).toEqual([
      { width: 1280, height: 720, profile: 'high', level: '3.1', frames: 1 },
      { width: 640, height: 360, profile: 'baseline', level: '3.0', frames: 1 },
    ]);
    expect(stream.report.keyframes).toBe(2);
  });

  it('reports frames and bytes observed since a marked point', () => {
    const stream = measured();
    stream.accept(srtpPacket({ sequence: 1, timestamp: 90000, marker: true, payload: SLICE }));
    const mark = stream.report;
    stream.accept(srtpPacket({ sequence: 2, timestamp: 93000, marker: true, payload: SLICE }));
    stream.accept(srtpPacket({ sequence: 3, timestamp: 96000, marker: true, payload: SLICE }));

    expect(stream.report.frames - mark.frames).toBe(2);
    expect(stream.report.bytes - mark.bytes).toBe(2 * (12 + SLICE.length + 10));
  });
});
