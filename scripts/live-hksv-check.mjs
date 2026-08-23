/**
 * Qualifies negotiated HomeKit Secure Video output against a real camera, measured on the adapted bytes.
 *
 * It drives the plugin's own recording adaptation directly with a recording configuration a HomeKit
 * controller could select, and judges what came out rather than what the command line asked for: the
 * initialization segment, the boxes each fragment is made of, the coded profile, level and dimensions read
 * from the sequence parameter set, whether every fragment opens on a sync sample, whether any fragment is
 * longer than the selected fragment length, whether an audio track is present, and how long the first unit
 * and the cancellation took.
 *
 * WHAT THIS DOES NOT COVER. HomeKit transports a recording over a HomeKit Data Stream, and an unpaired
 * controller cannot open one, so this run stops at the adaptation boundary. The recording delegate's HAP
 * surface is covered hermetically against the real HAP definitions in
 * `test/contracts/camera-streaming-adapter.test.ts`, and playback in the Home app remains a paired
 * acceptance step.
 *
 * PREREQUISITES:
 *   1. `npm run build`, because this reuses the plugin's built adaptation and persistence.
 *   2. A storage root with an accepted session, and NO plugin instance running against that account:
 *      this opens a second realtime owner against a copy of the root. Stop the instance under test first.
 *   3. A wired camera. A battery camera answers too, but its power budget bounds the run.
 *
 * It never writes media to disk, and prints no more than the last four characters of a serial.
 *
 * Usage:
 *   npm run build
 *   node scripts/live-hksv-check.mjs --storage /tmp/hb-check/homebridge-eufy --serial T8XXXXXXXXXXXXXX
 *   node scripts/live-hksv-check.mjs --storage … --serial … --width 1280 --height 720 --fps 30 \
 *     --bitrate 800 --profile main --level 3.1 --fragment-ms 4000 --iframe-ms 4000 --seconds 30
 *   node scripts/live-hksv-check.mjs --storage … --serial … --no-audio
 */
import { createRequire } from 'node:module';

import { describeSequenceParameterSet, observations, options, required } from './hap-live-harness.mjs';
import { openCameraSession, shortSerial } from './eufy-camera-session.mjs';

/**
 * Where a box's children begin, relative to the end of its own header.
 *
 * Plain containers start immediately. A sample description box carries a version, flags and an entry
 * count first, and a sample entry carries a fixed record whose width depends on the track's media type,
 * so a walk that treats either as a plain container never reaches the codec configuration inside it.
 */
const CHILD_OFFSETS = new Map([
  ...['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'moof', 'traf', 'dinf'].map((type) => [type, 0]),
  ['stsd', 8],
  ['avc1', 78],
  ['avc3', 78],
  ['hvc1', 78],
  ['hev1', 78],
  ['mp4a', 28],
]);
const SYNC_SAMPLE_FLAGS_DEPENDS_ON_OTHERS = 1;

/** Walks every box in a buffer, reporting each with the path that reached it. */
export function walkBoxes(buffer, visit, start = 0, end = buffer.length, path = '') {
  let offset = start;
  while (offset + 8 <= end) {
    const declared = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let size = declared;
    let body = offset + 8;
    if (declared === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      body = offset + 16;
    }
    if (size < 8 || offset + size > end) {
      return;
    }
    visit({ type, offset, size, body, end: offset + size, path: `${path}/${type}` });
    const childOffset = CHILD_OFFSETS.get(type);
    if (childOffset !== undefined) {
      walkBoxes(buffer, visit, body + childOffset, offset + size, `${path}/${type}`);
    }
    offset += size;
  }
}

/** The types of the top-level boxes of one buffer, in order. */
export function topLevelBoxes(buffer) {
  const types = [];
  walkBoxes(buffer, ({ type, path }) => {
    if (path === `/${type}`) {
      types.push(type);
    }
  });
  return types;
}

/**
 * What one initialization segment declares: the media timescale of each track, the coded video parameters
 * read from the sequence parameter set inside `avcC`, and whether an audio sample entry is present.
 */
export function describeInitialization(buffer) {
  const timescales = [];
  let coded;
  let audioSampleEntry;
  let audioSampleRate;
  let audioChannels;
  walkBoxes(buffer, ({ type, offset, body, end }) => {
    if (type === 'mdhd') {
      timescales.push(buffer.readUInt32BE(offset + 20));
    }
    if (type === 'avcC' && !coded) {
      const count = buffer[body + 5] & 0x1f;
      let cursor = body + 6;
      for (let index = 0; index < count && cursor + 2 <= end; index += 1) {
        const length = buffer.readUInt16BE(cursor);
        coded ??= describeSequenceParameterSet(buffer.subarray(cursor + 2, cursor + 2 + length));
        cursor += 2 + length;
      }
    }
    if (type === 'mp4a') {
      audioSampleEntry = true;
      audioSampleRate = buffer.readUInt16BE(body + 24);
      audioChannels = buffer.readUInt16BE(body + 16);
    }
  });
  return { timescales, coded, audioSampleEntry: Boolean(audioSampleEntry), audioSampleRate, audioChannels };
}

/**
 * What one media fragment declares per track: how many samples it carries, where its decode time starts,
 * how long its samples run in that track's own timescale, and whether its first sample is one a decoder
 * can start from. The declared run is reported for diagnosis; a fragment's length is judged from where the
 * next one starts, because a muxer is free to round the durations it declares for its own samples.
 *
 * A sample table is sized entirely by the flags its `trun` declares, and any field it omits falls back to
 * the default its `tfhd` declares and then to the track's `trex`. Reading it any other way is how a
 * malformed run, or a muxer that carries durations only as defaults, goes unnoticed.
 */
export function describeFragment(buffer, timescales, defaults) {
  const tracks = [];
  walkBoxes(buffer, ({ type, offset, body }) => {
    if (type === 'tfhd') {
      const flags = buffer.readUIntBE(offset + 9, 3);
      let cursor = body + 8;
      if (flags & 0x000001) {
        cursor += 8;
      }
      if (flags & 0x000002) {
        cursor += 4;
      }
      const fallback = { ...(defaults[tracks.length] ?? {}) };
      if (flags & 0x000008) {
        fallback.duration = buffer.readUInt32BE(cursor);
        cursor += 4;
      }
      if (flags & 0x000010) {
        cursor += 4;
      }
      if (flags & 0x000020) {
        fallback.flags = buffer.readUInt32BE(cursor);
      }
      tracks.push({ index: tracks.length, samples: 0, ticks: 0, fallback });
    }
    if (type === 'tfdt' && tracks.length > 0) {
      tracks.at(-1).decodeTime = Number(buffer.readBigUInt64BE(body + 4));
    }
    if (type === 'trun' && tracks.length > 0) {
      const track = tracks.at(-1);
      const flags = buffer.readUIntBE(offset + 9, 3);
      const count = buffer.readUInt32BE(offset + 12);
      let cursor = offset + 16;
      if (flags & 0x000001) {
        cursor += 4;
      }
      let firstFlags;
      if (flags & 0x000004) {
        firstFlags = buffer.readUInt32BE(cursor);
        cursor += 4;
      }
      for (let index = 0; index < count; index += 1) {
        if (flags & 0x000100) {
          track.ticks += buffer.readUInt32BE(cursor);
          cursor += 4;
        } else {
          track.ticks += track.fallback.duration ?? 0;
        }
        if (flags & 0x000200) {
          cursor += 4;
        }
        if (flags & 0x000400) {
          const sampleFlags = buffer.readUInt32BE(cursor);
          cursor += 4;
          if (index === 0) {
            firstFlags ??= sampleFlags;
          }
        }
        if (flags & 0x000800) {
          cursor += 4;
        }
      }
      track.samples = count;
      track.wellFormed = cursor - offset === buffer.readUInt32BE(offset);
      const resolved = firstFlags ?? track.fallback.flags ?? 0;
      track.syncSample =
        ((resolved >>> 24) & 0x03) !== SYNC_SAMPLE_FLAGS_DEPENDS_ON_OTHERS && ((resolved >>> 16) & 0x01) === 0;
      track.timescale = timescales[track.index] ?? 1;
      track.seconds = track.ticks / track.timescale;
      track.startSeconds = (track.decodeTime ?? 0) / track.timescale;
    }
  });
  return tracks;
}

/**
 * The span each fragment occupies on each track's timeline, taken from where the next fragment starts
 * rather than from the durations a fragment declares for its own samples. The span is what a controller
 * has to buffer, and it is the only measure a muxer cannot inflate by rounding sample durations.
 */
export function fragmentSpans(fragments) {
  return fragments.map(({ tracks }, index) =>
    tracks.map((track) => {
      const next = fragments[index + 1]?.tracks[track.index];
      return next ? next.startSeconds - track.startSeconds : undefined;
    }),
  );
}

/** The per-sample defaults an initialization segment declares for each track, in `trex` order. */
export function trackDefaults(buffer) {
  const defaults = [];
  walkBoxes(buffer, ({ type, body }) => {
    if (type === 'trex') {
      defaults.push({ duration: buffer.readUInt32BE(body + 12), flags: buffer.readUInt32BE(body + 20) });
    }
  });
  return defaults;
}

/**
 * Whether one measured fragment span honours the selected fragment length.
 *
 * A fragment boundary can only be a coded frame, and a source may code slower than the frame rate a
 * controller selected, so the quantum a span can overrun by is the source's own frame interval rather than
 * the negotiated one. That interval is measured from the fragment instead of assumed, and the fragment
 * without the one frame that straddles its boundary must be inside the selected length.
 */
export function withinSelectedFragment({ seconds, frameSeconds }, selectedSeconds) {
  return seconds - frameSeconds <= selectedSeconds + 0.001;
}

/**
 * The MPEG-4 audio object type an initialization segment's decoder configuration declares, which is 39 for
 * AAC-ELD. It is the only place the negotiated recording audio codec can be confirmed: an `mp4a` sample
 * entry alone says nothing about which AAC profile is inside it.
 */
export function audioObjectType(buffer) {
  let objectType;
  walkBoxes(buffer, ({ type, body, end }) => {
    if (type !== 'esds') {
      return;
    }
    for (let cursor = body + 4; cursor + 2 <= end; cursor += 1) {
      if (buffer[cursor] !== 0x05) {
        continue;
      }
      let length = cursor + 1;
      while (length < end && buffer[length] & 0x80) {
        length += 1;
      }
      const config = buffer.readUInt16BE(length + 1);
      const short = (config >>> 11) & 0x1f;
      objectType = short === 31 ? ((config >>> 5) & 0x3f) + 32 : short;
      return;
    }
  });
  return objectType;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = options(process.argv.slice(2));
  const serial = required(parsed, 'serial');
  const storage = required(parsed, 'storage');
  const seconds = Number(parsed.get('seconds') ?? 30);
  const audioRequested = parsed.get('no-audio') === undefined;
  const negotiated = {
    width: Number(parsed.get('width') ?? 1920),
    height: Number(parsed.get('height') ?? 1080),
    fps: Number(parsed.get('fps') ?? 30),
    maxBitRate: Number(parsed.get('bitrate') ?? 2000),
    profile: parsed.get('profile') ?? 'high',
    level: parsed.get('level') ?? '4.0',
    iFrameIntervalMs: Number(parsed.get('iframe-ms') ?? 4000),
    fragmentLengthMs: Number(parsed.get('fragment-ms') ?? 4000),
    ...(audioRequested ? { audio: { codec: 'AAC-eld', channels: 1, sampleRate: 24, maxBitRate: 32 } } : {}),
  };

  const require = createRequire(import.meta.url);
  const { FfmpegRecordingMedia } = await import('../dist/media/recording.js').catch(() => {
    throw new Error('dist/ is missing; run npm run build before this check');
  });
  const ffmpeg = parsed.get('ffmpeg') ?? require('ffmpeg-for-homebridge');
  const results = observations('HKSV recording qualification');
  const session = await openCameraSession(storage);

  try {
    const { actions } = await session.camera(serial);
    console.log(`camera ${shortSerial(serial)} recordFragments=${typeof actions.recordFragments}`);
    results.check(typeof actions.recordFragments === 'function', 'the camera exposes a typed fragment recording');
    if (typeof actions.recordFragments !== 'function') {
      results.summarize();
      process.exit(process.exitCode ?? 1);
    }
    console.log(
      `negotiated ${negotiated.width}x${negotiated.height}@${negotiated.fps} ${negotiated.profile}@${negotiated.level} ` +
        `${negotiated.maxBitRate}kbps fragment=${negotiated.fragmentLengthMs}ms iframe=${negotiated.iFrameIntervalMs}ms ` +
        `audio=${audioRequested ? 'AAC-ELD 24kHz mono' : 'none'}`,
    );

    const outcomes = [];
    const recording = new FfmpegRecordingMedia(ffmpeg).record(
      { recordFragments: (opts) => actions.recordFragments(opts) },
      negotiated,
      { onOutcome: (outcome) => outcomes.push(outcome) },
    );

    const startedAt = Date.now();
    let initialization;
    let defaults = [];
    let timescales = [];
    const fragments = [];
    let firstUnitMs;
    let lastFlag = 0;
    let iterationError;
    const deadline = setTimeout(() => recording.stop(), seconds * 1_000);
    deadline.unref?.();

    try {
      for await (const unit of recording) {
        if (!initialization) {
          firstUnitMs = Date.now() - startedAt;
          initialization = unit.data;
          defaults = trackDefaults(unit.data);
          timescales = describeInitialization(unit.data).timescales;
          console.log(`initialization bytes=${unit.data.length} boxes=[${topLevelBoxes(unit.data).join(',')}]`);
        } else {
          fragments.push({
            boxes: topLevelBoxes(unit.data),
            tracks: describeFragment(unit.data, timescales, defaults),
          });
        }
        if (unit.last) {
          lastFlag += 1;
        }
      }
    } catch (error) {
      iterationError = error;
    }
    clearTimeout(deadline);
    const stoppedAt = Date.now();
    recording.stop();
    const cancellationMs = Date.now() - stoppedAt;

    console.log(`outcomes=${JSON.stringify(outcomes)} fragments=${fragments.length} first-unit=${firstUnitMs}ms`);
    results.check(initialization !== undefined, 'the recording produced an initialization segment first');
    if (!initialization) {
      console.log(`iteration ended with ${iterationError ? 'an error' : 'no output'}`);
      results.summarize();
      process.exit(process.exitCode ?? 1);
    }

    results.check(
      topLevelBoxes(initialization).join(',') === 'ftyp,moov',
      'the initialization segment is exactly a file type box and a movie box',
    );
    const described = describeInitialization(initialization);
    console.log(
      `coded ${described.coded?.width}x${described.coded?.height} ${described.coded?.profile}@${described.coded?.level} ` +
        `tracks=${described.timescales.length} ` +
        `audio=${described.audioSampleEntry ? `${described.audioSampleRate}Hz x${described.audioChannels}` : 'none'}`,
    );
    results.check(
      described.coded?.width === negotiated.width && described.coded?.height === negotiated.height,
      `the recording coded the negotiated ${negotiated.width}x${negotiated.height}`,
    );
    results.check(
      described.coded?.profile === negotiated.profile && described.coded?.level === negotiated.level,
      `the recording coded exactly the negotiated ${negotiated.profile} profile at level ${negotiated.level}`,
    );
    results.check(
      described.audioSampleEntry === audioRequested,
      audioRequested
        ? 'the recording carries an audio sample entry for the negotiated AAC-ELD track'
        : 'the recording carries no audio track at all',
    );
    if (audioRequested) {
      const objectType = audioObjectType(initialization);
      console.log(`audio object type=${objectType}`);
      results.check(objectType === 39, 'the recorded audio track declares the AAC-ELD audio object type');
    }

    results.check(fragments.length > 0, 'the recording produced at least one media fragment');
    results.check(
      fragments.every(({ boxes }) => boxes.join(',') === 'moof,mdat'),
      'every media fragment is exactly a movie fragment box and its media data box',
    );
    results.check(
      fragments.every(({ tracks }) => tracks.length > 0 && tracks.every((track) => track.wellFormed)),
      'every fragment run declares exactly the per-sample fields its own flags promise',
    );
    results.check(
      fragments.every(({ tracks }) => tracks.every((track) => track.syncSample)),
      'every media fragment opens on a sample a decoder can start from',
    );
    const selectedSeconds = negotiated.fragmentLengthMs / 1_000;
    const spans = fragmentSpans(fragments)
      .map((tracks, index) => ({ seconds: tracks[0], samples: fragments[index].tracks[0]?.samples ?? 0 }))
      .filter(({ seconds, samples }) => seconds !== undefined && samples > 0)
      .map(({ seconds, samples }) => ({ seconds, frameSeconds: seconds / samples }));
    const skews = fragments
      .filter(({ tracks }) => tracks.length > 1)
      .map(({ tracks }) => tracks[1].startSeconds - tracks[0].startSeconds);
    console.log(
      `video spans=[${spans.map(({ seconds }) => seconds.toFixed(3)).join(',')}] ` +
        `source frame=${(Math.max(...spans.map(({ frameSeconds }) => frameSeconds)) * 1_000).toFixed(1)}ms ` +
        `selected=${selectedSeconds.toFixed(3)}s`,
    );
    results.check(spans.length > 0, 'the recording produced enough fragments to measure a fragment span');
    results.check(
      spans.every((span) => withinSelectedFragment(span, selectedSeconds)),
      `no media fragment spans more than the selected ${negotiated.fragmentLengthMs}ms of video ` +
        'plus the one frame that straddles its boundary',
    );
    if (skews.length > 0) {
      const worstSkew = Math.max(...skews.map((skew) => Math.abs(skew)));
      console.log(`audio-to-video decode-time skew=[${skews.map((skew) => skew.toFixed(3)).join(',')}]`);
      results.check(
        worstSkew <= selectedSeconds,
        'the audio track stays aligned with the video timeline rather than drifting away from it across fragments',
      );
    }
    results.check(
      outcomes.some(({ outcome }) => outcome === 'recording'),
      'the adaptation reported one recording outcome for its first output',
    );
    results.check(firstUnitMs < 30_000, 'first output arrived within the adaptation backstop');
    results.unverified(
      `first output took ${firstUnitMs}ms, which a cold source cannot bring under HomeKit's ten-second budget: ` +
        'that needs pre-event media from an already-warm source, which is not adapted yet (#1000)',
    );
    console.log(`cancellation=${cancellationMs}ms last-flagged-units=${lastFlag}`);
    results.check(cancellationMs < 1_000, 'cancellation returned the iteration without waiting for the source');
    results.check(lastFlag <= 1, 'at most one output unit was flagged as the last of the recording');
  } finally {
    await session.close();
  }

  results.summarize();
}
