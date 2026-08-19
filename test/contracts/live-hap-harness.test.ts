import { createCipheriv, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// @ts-expect-error the live harness is untyped operator tooling consumed only by these measurement contracts
import { MeasuredVideoStream, describeSequenceParameterSet } from '../../scripts/hap-live-harness.mjs';

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
