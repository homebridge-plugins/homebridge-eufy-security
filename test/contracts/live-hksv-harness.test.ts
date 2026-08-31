import { describe, expect, it } from 'vitest';

import {
  audioObjectType,
  describeFragment,
  describeInitialization,
  fragmentSpans,
  preEventMedia,
  recordedRateCeiling,
  topLevelBoxes,
  trackDefaults,
  walkBoxes,
  withinSelectedFragment,
} from '../../scripts/live-hksv-check.mjs';

/**
 * The measurement `live-hksv-check.mjs` judges a real recording with, exercised on synthesized boxes so a
 * green live run is not the only evidence that it reads a fragmented MP4 correctly. Every structure here
 * is built to the shape FFmpeg's fragmented MP4 muxer writes, which is the input the check actually reads.
 */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** One box declaring its length in the 64-bit form, which a large `mdat` uses. */
function largeBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'ascii');
  header.writeBigUInt64BE(BigInt(payload.length + 16), 8);
  return Buffer.concat([header, payload]);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/** A sequence parameter set for 1280x720 Main profile at level 3.1, as an encoder would emit it. */
const SPS_1280_720_MAIN_31 = Buffer.from('674d401feca02802dd8088000003000800000301e078c18cb000', 'hex');

function mdhd(timescale: number): Buffer {
  return box('mdhd', Buffer.concat([u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0)]));
}

function avc1(sps: Buffer): Buffer {
  const avcC = box(
    'avcC',
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]),
    sps,
    Buffer.from([1, 0, 4, 0x68, 0xce, 0x3c, 0x80]),
  );
  return box('avc1', Buffer.alloc(78), avcC);
}

/** An audio sample entry whose decoder configuration declares an escaped AAC-ELD object type. */
function mp4a(sampleRate: number, channels: number, objectType: number): Buffer {
  const header = Buffer.alloc(28);
  header.writeUInt16BE(channels, 16);
  header.writeUInt16BE(16, 18);
  header.writeUInt16BE(sampleRate, 24);
  const config =
    objectType >= 32
      ? Buffer.from([0xf8 | ((objectType - 32) >> 3), ((objectType - 32) << 5) & 0xe0, 0x00])
      : Buffer.from([(objectType << 3) | 0x01, 0x00]);
  const esds = box(
    'esds',
    u32(0),
    Buffer.from([0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, 0x40, 0x15]),
    Buffer.alloc(11),
    Buffer.from([0x05, config.length]),
    config,
  );
  return box('mp4a', header, esds);
}

function track(timescale: number, sampleEntry: Buffer): Buffer {
  return box('trak', box('mdia', mdhd(timescale), box('minf', box('stbl', box('stsd', u32(0), u32(1), sampleEntry)))));
}

function initialization({ audio = true, objectType = 39 } = {}): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('iso5iso6mp41')),
    box(
      'moov',
      box('mvhd', Buffer.alloc(100)),
      track(15_360, avc1(SPS_1280_720_MAIN_31)),
      ...(audio ? [track(24_000, mp4a(24_000, 1, objectType))] : []),
      box(
        'mvex',
        box('trex', u32(0), u32(1), u32(1), u32(512), u32(0), u32(0x01010000)),
        ...(audio ? [box('trex', u32(0), u32(2), u32(1), u32(1024), u32(0), u32(0x02000000))] : []),
      ),
    ),
  ]);
}

/**
 * One track fragment. `defaultDuration` puts the per-sample duration in `tfhd` the way FFmpeg does, which
 * a reader that only looks at `trun` sample entries silently measures as zero.
 */
function traf({
  trackId,
  decodeTime,
  samples,
  defaultDuration,
  perSampleDuration,
  firstSampleFlags = 0x02000000,
}: {
  trackId: number;
  decodeTime: number;
  samples: number;
  defaultDuration?: number;
  perSampleDuration?: number;
  firstSampleFlags?: number;
}): Buffer {
  const tfhdFlags = 0x020000 | (defaultDuration === undefined ? 0 : 0x000008);
  const tfhd = box(
    'tfhd',
    Buffer.from([0, tfhdFlags >> 16, (tfhdFlags >> 8) & 0xff, tfhdFlags & 0xff]),
    u32(trackId),
    ...(defaultDuration === undefined ? [] : [u32(defaultDuration)]),
  );
  const tfdt = box(
    'tfdt',
    Buffer.from([1, 0, 0, 0]),
    (() => {
      const buffer = Buffer.alloc(8);
      buffer.writeBigUInt64BE(BigInt(decodeTime));
      return buffer;
    })(),
  );
  const trunFlags = 0x000001 | 0x000004 | (perSampleDuration === undefined ? 0 : 0x000100) | 0x000200;
  const entries: Buffer[] = [];
  for (let index = 0; index < samples; index += 1) {
    entries.push(...(perSampleDuration === undefined ? [] : [u32(perSampleDuration)]), u32(100));
  }
  const trun = box(
    'trun',
    Buffer.from([0, trunFlags >> 16, (trunFlags >> 8) & 0xff, trunFlags & 0xff]),
    u32(samples),
    u32(0),
    u32(firstSampleFlags),
    ...entries,
  );
  return box('traf', tfhd, tfdt, trun);
}

describe('HKSV recording measurement', () => {
  it('reads the top-level boxes of an initialization segment and a media fragment', () => {
    expect(topLevelBoxes(initialization())).toEqual(['ftyp', 'moov']);
    const fragment = Buffer.concat([box('moof', box('mfhd', u32(0), u32(1))), box('mdat', Buffer.alloc(64))]);
    expect(topLevelBoxes(fragment)).toEqual(['moof', 'mdat']);
  });

  it('reads a box that declares its length in the 64-bit form', () => {
    const fragment = Buffer.concat([box('moof', box('mfhd', u32(0), u32(1))), largeBox('mdat', Buffer.alloc(64))]);
    expect(topLevelBoxes(fragment)).toEqual(['moof', 'mdat']);
  });

  it('descends through sample description boxes and sample entries to the codec configuration', () => {
    const described = describeInitialization(initialization());
    expect(described.timescales).toEqual([15_360, 24_000]);
    expect(described.coded).toEqual({ width: 1280, height: 720, profile: 'main', level: '3.1' });
    expect(described.audioSampleEntry).toBe(true);
    expect(described.audioSampleRate).toBe(24_000);
    expect(described.audioChannels).toBe(1);
  });

  it('reports no audio sample entry for a video-only initialization segment', () => {
    const described = describeInitialization(initialization({ audio: false }));
    expect(described.timescales).toEqual([15_360]);
    expect(described.audioSampleEntry).toBe(false);
    expect(describeInitialization(initialization({ audio: false })).coded?.profile).toBe('main');
  });

  it('reads the escaped AAC-ELD audio object type out of the decoder configuration', () => {
    expect(audioObjectType(initialization({ objectType: 39 }))).toBe(39);
    expect(audioObjectType(initialization({ objectType: 2 }))).toBe(2);
    expect(audioObjectType(initialization({ audio: false }))).toBeUndefined();
  });

  it('takes a sample duration from the track fragment header when the run omits it', () => {
    const fragment = Buffer.concat([
      box(
        'moof',
        box('mfhd', u32(0), u32(1)),
        traf({ trackId: 1, decodeTime: 0, samples: 60, defaultDuration: 1_024 }),
      ),
      box('mdat', Buffer.alloc(64)),
    ]);
    const init = initialization();
    const [video] = describeFragment(fragment, describeInitialization(init).timescales, trackDefaults(init));
    expect(video.samples).toBe(60);
    expect(video.seconds).toBeCloseTo(4, 3);
    expect(video.wellFormed).toBe(true);
    expect(video.syncSample).toBe(true);
  });

  it('takes a sample duration from the run when it declares one per sample', () => {
    const fragment = Buffer.concat([
      box(
        'moof',
        box('mfhd', u32(0), u32(1)),
        traf({ trackId: 1, decodeTime: 0, samples: 30, perSampleDuration: 512 }),
      ),
      box('mdat', Buffer.alloc(64)),
    ]);
    const init = initialization();
    const [video] = describeFragment(fragment, describeInitialization(init).timescales, trackDefaults(init));
    expect(video.seconds).toBeCloseTo(1, 3);
    expect(video.wellFormed).toBe(true);
  });

  it('reports a run whose declared size disagrees with the fields its own flags promise', () => {
    const fragment = Buffer.concat([
      box('moof', box('mfhd', u32(0), u32(1)), traf({ trackId: 1, decodeTime: 0, samples: 4, defaultDuration: 1_024 })),
      box('mdat', Buffer.alloc(16)),
    ]);
    const corrupted = Buffer.from(fragment);
    let trunAt = -1;
    walkBoxes(corrupted, ({ type, offset }) => {
      if (type === 'trun') {
        trunAt = offset;
      }
    });
    corrupted.writeUInt32BE(corrupted.readUInt32BE(trunAt) - 4, trunAt);
    const init = initialization();
    const [video] = describeFragment(corrupted, describeInitialization(init).timescales, trackDefaults(init));
    expect(video.wellFormed).toBe(false);
  });

  it('reports a fragment whose first sample a decoder cannot start from', () => {
    const fragment = Buffer.concat([
      box(
        'moof',
        box('mfhd', u32(0), u32(1)),
        traf({ trackId: 1, decodeTime: 0, samples: 4, defaultDuration: 1_024, firstSampleFlags: 0x01010000 }),
      ),
      box('mdat', Buffer.alloc(16)),
    ]);
    const init = initialization();
    const [video] = describeFragment(fragment, describeInitialization(init).timescales, trackDefaults(init));
    expect(video.syncSample).toBe(false);
  });

  it('spans a fragment from where the next one starts rather than from the durations it declares', () => {
    const init = initialization();
    const timescales = describeInitialization(init).timescales;
    const defaults = trackDefaults(init);
    const fragments = [0, 61_440, 122_880].map((decodeTime, index) => ({
      tracks: describeFragment(
        Buffer.concat([
          box(
            'moof',
            box('mfhd', u32(0), u32(index + 1)),
            traf({ trackId: 1, decodeTime, samples: 60, defaultDuration: 2_048 }),
          ),
          box('mdat', Buffer.alloc(16)),
        ]),
        timescales,
        defaults,
      ),
    }));
    expect(fragmentSpans(fragments).map((tracks) => tracks[0])).toEqual([4, 4, undefined]);
  });

  it('reads pre-event media as the media a source handed over faster than real time', () => {
    const drained = [
      { arrivalMs: 8_038, startSeconds: 0, seconds: 2.02 },
      { arrivalMs: 8_658, startSeconds: 2.02, seconds: 2 },
      { arrivalMs: 10_660, startSeconds: 4.02, seconds: 2 },
      { arrivalMs: 12_660, startSeconds: 6.02, seconds: 2 },
    ];
    const measured = preEventMedia(drained);
    expect(measured.fragments).toBe(4);
    expect(measured.mediaSeconds).toBeCloseTo(8.02, 6);
    expect(measured.wallSeconds).toBeCloseTo(4.622, 6);
    expect(measured.seconds).toBeCloseTo(1.378, 3);
  });

  it('reads no pre-event media from a source that produced every fragment in real time', () => {
    const realtime = [
      { arrivalMs: 0, startSeconds: 0, seconds: 2 },
      { arrivalMs: 2_000, startSeconds: 2, seconds: 2 },
      { arrivalMs: 4_000, startSeconds: 4, seconds: 2 },
    ];
    expect(preEventMedia(realtime).seconds).toBe(0);
    expect(preEventMedia([{ arrivalMs: 0, startSeconds: 0, seconds: 2 }])).toEqual({
      fragments: 1,
      mediaSeconds: 2,
      wallSeconds: 0,
      seconds: 0,
    });
    expect(preEventMedia([])).toEqual({ fragments: 0, mediaSeconds: 0, wallSeconds: 0, seconds: 0 });
  });

  it('admits a span that overruns the selected length by no more than its straddling frame', () => {
    expect(withinSelectedFragment({ seconds: 4.0, frameSeconds: 1 / 30 }, 4)).toBe(true);
    expect(withinSelectedFragment({ seconds: 4.012, frameSeconds: 1 / 15 }, 4)).toBe(true);
    expect(withinSelectedFragment({ seconds: 3.933, frameSeconds: 1 / 15 }, 4)).toBe(true);
    expect(withinSelectedFragment({ seconds: 4.5, frameSeconds: 1 / 30 }, 4)).toBe(false);
    expect(withinSelectedFragment({ seconds: 8.0, frameSeconds: 1 / 15 }, 4)).toBe(false);
  });
});

/**
 * What a recording's measured rate is compared against.
 *
 * A recording is one file carrying both tracks, so the denominator is the whole of what was negotiated. The
 * first live run of this measurement used the video figure alone and reported a compliant recording as over:
 * measured on two wired cameras at a negotiated 800 kbps of video and 32 of audio, the fragments carried 777
 * and 818 kbps, and 818 is inside 832 while being outside 800.
 */
describe('recorded rate ceiling', () => {
  it('is the negotiated video and audio rates together, because one file carries both', () => {
    expect(recordedRateCeiling({ maxBitRate: 800, audio: { maxBitRate: 32 } })).toBe(832);
    expect(818).toBeLessThanOrEqual(recordedRateCeiling({ maxBitRate: 800, audio: { maxBitRate: 32 } }));
  });

  it('is the video rate alone for a recording that negotiated no audio track', () => {
    expect(recordedRateCeiling({ maxBitRate: 800 })).toBe(800);
    expect(recordedRateCeiling({ maxBitRate: 2000, audio: undefined })).toBe(2000);
  });
});
