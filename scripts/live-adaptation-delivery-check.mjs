/**
 * Qualifies that live adaptation accounts for every source access unit it is fed, and that first coded
 * output does not wait on the source keyframe interval (issue #1035).
 *
 * `npm run verify` pins the adaptation input contract but cannot code a frame, so the two rules that need a
 * real encoder are measured here, against the plugin's own `FfmpegLiveMedia` and the FFmpeg it ships with.
 *
 * Two sources, one measurement:
 *   - `--serial` opens a real SDK live source. This is the acceptance run: it proves the rules on the frames
 *     a camera actually delivers. It reads a COPY of the storage root, writes nothing, and needs the
 *     Homebridge instance that owns the account stopped, because it is a second realtime owner.
 *   - `--paced` feeds a locally encoded elementary stream at capture pace, once per requested keyframe
 *     interval. No account or device is involved, so this is what shows first output is independent of the
 *     source keyframe interval rather than merely fast on one camera. At least two `--gop` values are needed
 *     for that comparison to mean anything.
 *
 * Accounting, not raw equality, is the delivery rule. The negotiated output is constant rate, so a source
 * delivering at another rate is legitimately duplicated or thinned to reach it; what may never happen is a
 * fed access unit that is neither coded, duplicated from, nor accounted as thinned. FFmpeg reports all
 * three, so `coded - duplicated + thinned` must equal what was written in.
 *
 * Time to first output is read from the same `-progress` stream, which FFmpeg emits about twice a second, so
 * a reported latency is an upper bound quantised to that period rather than an exact one. That is enough for
 * the rule being judged: the defect this replaced grew the figure by seconds as the GOP grew.
 *
 * Usage:
 *   npm run build
 *   node scripts/live-adaptation-delivery-check.mjs --paced [--codec h264|h265] [--gop 15,30,60,120,250] \
 *     [--fps 30] [--seconds 10]
 *   node scripts/live-adaptation-delivery-check.mjs --storage /tmp/hb-check/homebridge-eufy \
 *     --serial T8XXXXXXXXXXXXXX [--seconds 20] [--fps 15] [--prebuffer 0]
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { observations, options, required } from './hap-live-harness.mjs';
import { openCameraSession, shortSerial } from './eufy-camera-session.mjs';

/** How long the session is observed after its source stops, before the input is closed to drain the tail. */
const SETTLE_MS = 1_000;
/** How long a drained adaptation process is given to report its final counts and exit. */
const DRAIN_MS = 10_000;
/** How long a first coded frame may take before the analysis window is judged to be unbounded again. */
const FIRST_OUTPUT_BUDGET_MS = 1_000;
const PROGRESS_FIELD = /^[a-z_0-9]+=/;
const REFERENCE_ERROR = /co located POCs unavailable|Could not find ref|non-existing PPS|no frame|Invalid NAL/i;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Spawns the adaptation processes `FfmpegLiveMedia` asks for and measures each one.
 *
 * Every access unit reaches FFmpeg through the session's own `stdin.write`, and FFmpeg reports its coded,
 * duplicated, and thinned frame counts through the `-progress` stream the plugin already requests, so both
 * sides of the delivery rule are read at the same seam the plugin uses in production.
 *
 * A live session never closes its input, so the last access units of a window sit in the pipeline with
 * nothing to flush them: the constant-rate output cannot emit a frame whose duration it has not yet seen.
 * `drain` closes the input once the source has stopped, which is what makes a final count final. It is a
 * measurement action and not the plugin's lifetime, so the session's own reported outcomes are read before
 * it, because the resulting process exit is this harness ending the process rather than a session failure.
 */
function adaptationRecorder(executable) {
  const adaptations = [];
  const factory = (_executable, args) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const record = {
      args: [...args],
      child,
      fed: 0,
      coded: 0,
      duplicated: 0,
      thinned: 0,
      firstFedAt: undefined,
      firstCodedAfterMs: undefined,
      diagnostics: [],
    };
    adaptations.push(record);
    let remainder = '';
    child.stderr.on('data', (chunk) => {
      const lines = `${remainder}${chunk.toString()}`.split(/\r?\n/);
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (!PROGRESS_FIELD.test(line)) {
          if (line.trim().length > 0 && record.diagnostics.length < 20) {
            record.diagnostics.push(line.trim());
          }
          continue;
        }
        const [field, value] = line.split('=');
        const count = Number(value);
        if (!Number.isFinite(count)) {
          continue;
        }
        if (field === 'frame') {
          record.coded = count;
          if (count > 0 && record.firstCodedAfterMs === undefined && record.firstFedAt !== undefined) {
            record.firstCodedAfterMs = performance.now() - record.firstFedAt;
          }
        } else if (field === 'dup_frames') {
          record.duplicated = count;
        } else if (field === 'drop_frames') {
          record.thinned = count;
        }
      }
    });
    const stdin = new Proxy(child.stdin, {
      get(target, property) {
        if (property === 'write') {
          return (...written) => {
            record.fed += 1;
            record.firstFedAt ??= performance.now();
            return target.write(...written);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      stdin,
      stderr: child.stderr,
      on: (event, listener) => child.on(event, listener),
      kill: (signal) => child.kill(signal),
    };
  };
  return { adaptations, factory };
}

/** Closes every measured input and waits, bounded, for its final counts. */
async function drainAll(adaptations) {
  await Promise.all(
    adaptations.map(
      ({ child }) =>
        new Promise((resolve) => {
          const deadline = setTimeout(resolve, DRAIN_MS);
          deadline.unref?.();
          child.once('exit', () => {
            clearTimeout(deadline);
            resolve();
          });
          child.stdin.end();
        }),
    ),
  );
}

/**
 * Holds the negotiated HomeKit endpoint a session sends to, and keeps the session inside its RTCP bound.
 *
 * A real controller reports reception on the port it was answered with, and a session that never hears one
 * ends itself, so the measurement window cannot be observed without playing that part.
 */
async function homeKitEndpoint() {
  const socket = createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  let packets = 0;
  socket.on('message', () => (packets += 1));
  let reports;
  return {
    target: {
      port: socket.address().port,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: randomBytes(16),
      srtpSalt: randomBytes(14),
    },
    reportReceptionTo(port) {
      reports = setInterval(() => socket.send(Buffer.alloc(8), port, '127.0.0.1'), 500);
    },
    get packets() {
      return packets;
    },
    async close() {
      clearInterval(reports);
      await new Promise((resolve) => socket.close(resolve));
    },
  };
}

/** The negotiated selection every measured session uses, differing only in the output frame rate. */
function negotiated(fps) {
  return {
    video: {
      width: 1280,
      height: 720,
      fps,
      maxBitRate: 800,
      profile: 'main',
      level: '3.1',
      payloadType: 99,
      ssrc: 1234,
      mtu: 1200,
      rtcpInterval: 0.5,
    },
  };
}

/**
 * Encodes one elementary stream locally and splits it into access units.
 *
 * A source keyframe interval can only be chosen on a stream this run encodes itself, and the split has to
 * be the one the SDK performs: one access unit per coded picture, keyframe flagged from its own NAL type,
 * because that is the unit `FfmpegLiveMedia` writes and therefore the unit being counted.
 */
async function pacedAccessUnits(executable, { codec, gop, fps, seconds, width, height }) {
  const rate =
    codec === 'h265'
      ? ['-x265-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`]
      : ['-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];
  const child = spawn(
    executable,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=${fps}`,
      '-t',
      String(seconds),
      '-c:v',
      codec === 'h265' ? 'libx265' : 'libx264',
      '-preset',
      'veryfast',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      ...rate,
      '-bf',
      '0',
      '-f',
      codec === 'h265' ? 'hevc' : 'h264',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chunks = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) {
    throw new Error(`encoding a ${codec} source failed (${code}): ${stderr.slice(-300)}`);
  }
  return splitAccessUnits(Buffer.concat(chunks), codec, width, height);
}

/** Boundaries of the Annex-B NAL units in one elementary stream, in order. */
function nalUnits(stream) {
  const units = [];
  for (let offset = 0; offset + 3 < stream.length; offset += 1) {
    const short = stream[offset] === 0 && stream[offset + 1] === 0 && stream[offset + 2] === 1;
    const long =
      short === false &&
      stream[offset] === 0 &&
      stream[offset + 1] === 0 &&
      stream[offset + 2] === 0 &&
      stream[offset + 3] === 1;
    if (!short && !long) {
      continue;
    }
    const body = offset + (short ? 3 : 4);
    if (units.length > 0) {
      units.at(-1).end = offset;
    }
    units.push({ start: offset, body, end: stream.length });
    offset = body - 1;
  }
  return units;
}

/**
 * Groups NAL units into access units, one per coded picture.
 *
 * A new access unit begins at the first coded slice after the previous picture, so parameter sets and any
 * other non-slice NAL stay attached to the picture they describe rather than arriving as a unit of their own.
 */
function splitAccessUnits(stream, codec, width, height) {
  const units = nalUnits(stream);
  const accessUnits = [];
  let current;
  for (const unit of units) {
    const header = stream[unit.body];
    const type = codec === 'h265' ? (header >> 1) & 0x3f : header & 0x1f;
    const slice = codec === 'h265' ? type <= 21 : type === 1 || type === 5;
    const keyframe = codec === 'h265' ? type >= 16 && type <= 21 : type === 5;
    if (slice && current?.slice) {
      accessUnits.push(current);
      current = undefined;
    }
    current ??= { codec, width, height, keyframe: false, slice: false, start: unit.start, end: unit.end };
    current.end = unit.end;
    current.slice ||= slice;
    current.keyframe ||= keyframe;
  }
  if (current) {
    accessUnits.push(current);
  }
  return accessUnits.map(({ start, end, slice, ...frame }) => ({ ...frame, data: stream.subarray(start, end) }));
}

/** An SDK live source shape carrying access units this run supplies at capture pace. */
class PacedLiveStream extends EventEmitter {
  constructor(accessUnits, fps) {
    super();
    this.accessUnits = accessUnits;
    this.interval = 1_000 / fps;
    this.stopped = false;
  }

  async play() {
    const startedAt = performance.now();
    for (const [index, frame] of this.accessUnits.entries()) {
      if (this.stopped) {
        return;
      }
      const due = startedAt + index * this.interval;
      await delay(Math.max(due - performance.now(), 0));
      if (this.stopped) {
        return;
      }
      this.emit('video', frame);
    }
  }

  stop() {
    this.stopped = true;
  }
}

/**
 * Runs one measured session and reports what the adaptation did with what it was given.
 *
 * The source is whatever `open` returns, so the real SDK source and the paced one are judged by identical
 * accounting; nothing about the session, its arguments, or its lifetime differs between them.
 */
async function measure({ executable, open, feed, fps, results, label }) {
  const { FfmpegLiveMedia } = await import('../dist/media/live-stream.js').catch(() => {
    throw new Error('dist/ is missing; run npm run build before this check');
  });
  const endpoint = await homeKitEndpoint();
  const { adaptations, factory } = adaptationRecorder(executable);
  const outcomes = [];
  let reported = [];
  const prepared = await new FfmpegLiveMedia(executable, factory).prepare({
    addressVersion: 'ipv4',
    targetAddress: '127.0.0.1',
    video: endpoint.target,
    onSessionOutcome: (outcome) => outcomes.push(outcome),
  });
  endpoint.reportReceptionTo(prepared.videoPort);
  let delivered = 0;
  let keyframes = 0;
  let beforeFirstKeyframe = 0;
  let firstKeyframeAfterMs;
  const inputs = [];
  const startedAt = performance.now();
  try {
    await prepared.start(
      {
        live: async () => {
          const handle = await open();
          handle.on('video', (frame) => {
            delivered += 1;
            const current = inputs.at(-1);
            if (current?.codec !== frame.codec || current.width !== frame.width || current.height !== frame.height) {
              inputs.push({ codec: frame.codec, width: frame.width, height: frame.height, frames: 0 });
            }
            inputs.at(-1).frames += 1;
            if (frame.keyframe) {
              keyframes += 1;
              firstKeyframeAfterMs ??= performance.now() - startedAt;
            } else if (keyframes === 0) {
              beforeFirstKeyframe += 1;
            }
          });
          return handle;
        },
      },
      negotiated(fps),
    );
    await feed();
    await delay(SETTLE_MS);
    reported = [...outcomes];
    await drainAll(adaptations);
  } finally {
    prepared.stop();
    await endpoint.close();
  }

  if (adaptations.length === 0) {
    console.log(
      `  ${label}: delivered=${delivered} keyframes=${keyframes} preKeyframe=${beforeFirstKeyframe}` +
        ` outcomes=${JSON.stringify(reported)}`,
    );
    results.check(false, `${label} started an adaptation process`);
    return undefined;
  }
  const total = (field) => adaptations.reduce((sum, record) => sum + record[field], 0);
  const fed = total('fed');
  const coded = total('coded');
  const duplicated = total('duplicated');
  const thinned = total('thinned');
  const first = adaptations.find(({ firstCodedAfterMs }) => firstCodedAfterMs !== undefined);
  const diagnostics = adaptations.flatMap(({ diagnostics: lines }) => lines);
  const report = {
    label,
    delivered,
    keyframes,
    beforeFirstKeyframe,
    firstKeyframeAfterMs: firstKeyframeAfterMs === undefined ? undefined : Math.round(firstKeyframeAfterMs),
    fed,
    coded,
    duplicated,
    thinned,
    accounted: coded - duplicated + thinned,
    withheld: delivered - fed,
    firstCodedAfterMs: first === undefined ? undefined : Math.round(first.firstCodedAfterMs),
    processes: adaptations.length,
    rtcpPackets: endpoint.packets,
    diagnostics,
    outcomes: reported,
  };
  console.log(
    `  ${label}: delivered=${delivered} keyframes=${keyframes} firstKeyframe=${report.firstKeyframeAfterMs ?? 'never'}ms` +
      ` preKeyframe=${beforeFirstKeyframe} processes=${report.processes} fed=${fed} withheld=${report.withheld}` +
      ` coded=${coded} dup=${duplicated} thinned=${thinned} accounted=${report.accounted}` +
      ` firstCoded=${report.firstCodedAfterMs ?? 'never'}ms`,
  );
  for (const diagnostic of diagnostics) {
    console.log(`    ffmpeg: ${diagnostic}`);
  }
  console.log(
    `    source inputs: ${inputs.map(({ codec, width, height, frames }) => `${codec} ${width}x${height} frames=${frames}`).join(' -> ')}`,
  );
  return report;
}

/** Judges one measured window against the two rules this check exists for. */
function judge(results, report) {
  if (!report) {
    return;
  }
  results.check(report.fed > 0, `${report.label} fed the adaptation at least one access unit`);
  results.check(report.coded > 0, `${report.label} coded at least one frame`);
  results.check(
    report.accounted === report.fed,
    `${report.label} accounted for every fed access unit (${report.accounted} of ${report.fed})`,
  );
  results.check(
    report.withheld === report.beforeFirstKeyframe,
    `${report.label} withheld only the access units that arrived before its first keyframe` +
      ` (${report.withheld} withheld of ${report.delivered} delivered, ${report.beforeFirstKeyframe} before the first keyframe)`,
  );
  results.check(
    report.firstCodedAfterMs !== undefined && report.firstCodedAfterMs <= FIRST_OUTPUT_BUDGET_MS,
    `${report.label} coded its first frame within ${FIRST_OUTPUT_BUDGET_MS}ms of the first fed access unit`,
  );
  results.check(
    !report.diagnostics.some((line) => REFERENCE_ERROR.test(line)),
    `${report.label} produced no decoder reference error`,
  );
  results.check(
    !report.outcomes.some(({ outcome }) => outcome === 'failed'),
    `${report.label} reported no session failure`,
  );
}

const parsed = options(process.argv.slice(2));
const require = createRequire(import.meta.url);
const executable = parsed.get('ffmpeg') ?? require('ffmpeg-for-homebridge');
const results = observations('live adaptation delivery');

if (parsed.get('paced') !== undefined) {
  const codec = parsed.get('codec') ?? 'h264';
  const fps = Number(parsed.get('fps') ?? 30);
  const seconds = Number(parsed.get('seconds') ?? 10);
  const intervals = (parsed.get('gop') ?? '15,30,60,120,250').split(',').map(Number);
  const latencies = [];
  for (const gop of intervals) {
    const accessUnits = await pacedAccessUnits(executable, { codec, gop, fps, seconds, width: 1280, height: 720 });
    const stream = new PacedLiveStream(accessUnits, fps);
    const report = await measure({
      executable,
      open: async () => stream,
      feed: () => stream.play(),
      fps,
      results,
      label: `${codec} gop=${gop}`,
    });
    judge(results, report);
    if (report?.firstCodedAfterMs !== undefined) {
      latencies.push({ gop, firstCodedAfterMs: report.firstCodedAfterMs });
    }
  }
  const measured = latencies.map(({ firstCodedAfterMs }) => firstCodedAfterMs);
  console.log(`first output by keyframe interval: ${JSON.stringify(latencies)}`);
  results.check(
    latencies.length === intervals.length,
    `every requested keyframe interval produced a first coded frame (${latencies.length} of ${intervals.length})`,
  );
  if (measured.length < 2) {
    results.unverified(
      'one keyframe interval cannot show whether first output scales with it; pass at least two --gop values',
    );
  } else {
    const spread = Math.max(...measured) - Math.min(...measured);
    results.check(
      spread <= FIRST_OUTPUT_BUDGET_MS,
      `time to first output did not scale with the source keyframe interval (spread ${spread}ms)`,
    );
  }
} else {
  const serial = required(parsed, 'serial');
  const storage = required(parsed, 'storage');
  const fps = Number(parsed.get('fps') ?? 15);
  const seconds = Number(parsed.get('seconds') ?? 20);
  const prebuffer = Number(parsed.get('prebuffer') ?? 0);
  const session = await openCameraSession(storage);
  try {
    const { actions } = await session.camera(serial);
    let handle;
    const report = await measure({
      executable,
      open: async () => {
        handle = await actions.live(prebuffer > 0 ? { preBufferSeconds: prebuffer } : undefined);
        return handle;
      },
      feed: async () => {
        await delay(seconds * 1_000);
        handle?.stop();
      },
      fps,
      results,
      label: `camera ${shortSerial(serial)}`,
    });
    judge(results, report);
  } finally {
    await session.close();
  }
}

results.summarize();
