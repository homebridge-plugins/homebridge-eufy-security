import type { FragmentRecordingHandle, MediaFragment } from '@mega-yfue/eufy-sdk';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { type MediaProcess, PROCESS_STOP_GRACE_MS, SOURCE_START_BACKSTOP_MS } from './live-stream.js';

/**
 * How long the adaptation is given to write out what the source already handed it, once the source has
 * ended and its input is closed.
 *
 * The output backstop is already discharged by then, so without this bound a stalled adaptation would
 * leave a consumer waiting for a recording that had in fact finished. Expiry ends the recording with
 * whatever was flushed rather than failing it, because the media up to that point is complete.
 */
const OUTPUT_FLUSH_DEADLINE_MS = 5_000;

/**
 * How much media each source fragment is asked to carry.
 *
 * This bounds only how long adapted output waits behind media the camera has already captured, and has
 * nothing to do with the fragment length HomeKit selected, because the adaptation refragments its output on
 * its own keyframes regardless. Asking for the selected length instead makes first output wait a whole
 * output fragment behind a source that already had the media: measured on a wired camera, asking for one
 * second rather than the selected four brought first output forward by more than two seconds. The source
 * still closes a fragment only on a keyframe, so a camera with a longer group of pictures simply delivers
 * on its own cadence and nothing here shortens it.
 */
const SOURCE_FRAGMENT_SECONDS = 1;

/**
 * An adaptation process whose output is the recording itself, so unlike a live one its `stdout` is read
 * rather than discarded.
 */
export interface RecordingMediaProcess extends MediaProcess {
  readonly stdout: Readable;
}

export type RecordingMediaProcessFactory = (executable: string, args: readonly string[]) => RecordingMediaProcess;

export interface NegotiatedRecordedAudio {
  readonly codec: 'AAC-eld';
  readonly channels: number;
  readonly sampleRate: 16 | 24;
  readonly maxBitRate: number;
}

/**
 * The complete recording contract one HomeKit controller selected. Audio is absent both when the
 * controller negotiated none and when it withdrew recording audio, because either way the output carries
 * no audio track at all.
 */
export interface NegotiatedRecording {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly maxBitRate: number;
  readonly profile: 'baseline' | 'main' | 'high';
  readonly level: '3.1' | '3.2' | '4.0';
  readonly iFrameIntervalMs: number;
  readonly fragmentLengthMs: number;
  readonly audio?: NegotiatedRecordedAudio;
}

/** Why one recording produced no further usable output, in the bounded vocabulary the media domain owns. */
export type RecordingFailure =
  | 'source-unavailable'
  | 'source-error'
  | 'no-output-within-backstop'
  | 'adaptation-failed';

/**
 * One recording lifecycle outcome, reported once per transition and carrying no device identity, address,
 * key, media byte, or SDK message.
 */
export type RecordingOutcome =
  | { readonly outcome: 'recording' }
  | { readonly outcome: 'failed'; readonly reason: RecordingFailure };

/** One adapted output unit: the initialization segment, or one complete media fragment. */
export interface RecordedFragment {
  readonly data: Buffer;
  readonly last: boolean;
}

export interface RecordingMediaSource {
  recordFragments?(options?: { fragmentSeconds?: number }): FragmentRecordingHandle;
}

/** One recording in progress: the units it produces, and the one call that ends it. */
export interface AdaptedRecording extends AsyncIterable<RecordedFragment> {
  stop(): void;
}

export interface RecordingLifecycle {
  onOutcome?(outcome: RecordingOutcome): void;
}

/**
 * Adapts an SDK fragment recording into fragmented MP4 output that honours a negotiated HomeKit recording
 * contract.
 *
 * The SDK's own fragments are Eufy source truth: they carry the camera's codec, profile, level, geometry,
 * frame rate and keyframe cadence unchanged, and no negotiated contract can be satisfied by passing them
 * through. They are therefore demuxed and recoded here, and the output is refragmented on this plugin's
 * own keyframes so every fragment starts with one and none is longer than the selected fragment length.
 */
export class FfmpegRecordingMedia {
  constructor(
    private readonly executable: string,
    private readonly createProcess: RecordingMediaProcessFactory = spawnRecordingMediaProcess,
  ) {}

  /**
   * Starts one recording and returns it before any output exists, because a HomeKit controller consumes
   * the units as they are produced rather than waiting for a complete recording.
   *
   * A recording ends in exactly one of three ways: its consumer stops it, its source runs out of media
   * and the final unit is marked as last, or it fails and the iteration rejects. Every one of them
   * releases the SDK handle, the adaptation process, and the source's budget extension exactly once.
   */
  record(
    source: RecordingMediaSource,
    negotiated: NegotiatedRecording,
    lifecycle?: RecordingLifecycle,
  ): AdaptedRecording {
    const units = new RecordedFragmentQueue();
    let handle: FragmentRecordingHandle | undefined;
    let child: RecordingMediaProcess | undefined;
    let stopped = false;
    let sourceEnded = false;
    let outputBackstop: ReturnType<typeof setTimeout> | undefined;
    let flushDeadline: ReturnType<typeof setTimeout> | undefined;
    const trailing: Buffer[] = [];

    const teardown = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimeout(outputBackstop);
      clearTimeout(flushDeadline);
      handle?.stop();
      if (child) {
        child.stdin.destroy();
        child.kill('SIGTERM');
        const killDeadline = setTimeout(() => child?.kill('SIGKILL'), PROCESS_STOP_GRACE_MS);
        killDeadline.unref?.();
        child.on('exit', () => clearTimeout(killDeadline));
      }
    };
    /**
     * Ends the recording at its consumer's request. A HomeKit controller closes a recording stream
     * whenever it decides it has enough, so the iteration completes rather than reporting a failure.
     */
    const stop = (): void => {
      teardown();
      units.end();
    };
    const fail = (reason: RecordingFailure): void => {
      if (units.settled) {
        return;
      }
      teardown();
      lifecycle?.onOutcome?.({ outcome: 'failed', reason });
      units.fail(new Error('recording adaptation produced no further usable output'));
    };
    /**
     * Ends the recording once its adaptation has written everything the source gave it, marking the last
     * unit so the controller is told the recording is complete rather than merely interrupted.
     */
    const finish = (): void => {
      if (units.settled) {
        return;
      }
      for (const [index, data] of trailing.entries()) {
        units.push({ data, last: index === trailing.length - 1 });
      }
      trailing.length = 0;
      teardown();
      units.end();
    };

    const emit = (data: Buffer, initialization: boolean): void => {
      if (units.settled) {
        return;
      }
      if (initialization) {
        clearTimeout(outputBackstop);
        outputBackstop = undefined;
        units.push({ data, last: false });
        lifecycle?.onOutcome?.({ outcome: 'recording' });
        return;
      }
      if (sourceEnded) {
        trailing.push(data);
        return;
      }
      units.push({ data, last: false });
    };

    try {
      handle = source.recordFragments?.({ fragmentSeconds: SOURCE_FRAGMENT_SECONDS });
    } catch {
      handle = undefined;
    }
    if (!handle) {
      fail('source-unavailable');
      return recordingOf(units, stop);
    }
    handle.on('budget', (notice) => {
      if (!stopped) {
        notice.extend();
      }
    });

    try {
      child = this.createProcess(this.executable, recordingArguments(negotiated));
    } catch {
      fail('adaptation-failed');
      return recordingOf(units, stop);
    }
    const adaptation = child;
    const output = new Fmp4OutputReader(emit);
    adaptation.stderr.resume();
    adaptation.stdout.on('data', (chunk: Buffer) => output.read(chunk));
    adaptation.stdout.on('end', () => {
      if (sourceEnded) {
        finish();
      }
    });
    adaptation.stdin.on('error', () => {
      if (!stopped) {
        fail('adaptation-failed');
      }
    });
    adaptation.on('error', () => {
      if (!stopped) {
        fail('adaptation-failed');
      }
    });
    adaptation.on('exit', () => {
      if (stopped) {
        return;
      }
      if (sourceEnded) {
        finish();
        return;
      }
      fail('adaptation-failed');
    });
    outputBackstop = setTimeout(() => fail('no-output-within-backstop'), SOURCE_START_BACKSTOP_MS);
    outputBackstop.unref?.();

    void (async () => {
      try {
        for await (const fragment of handle) {
          if (stopped) {
            return;
          }
          writeSourceFragment(adaptation, fragment);
        }
        if (stopped) {
          return;
        }
        sourceEnded = true;
        adaptation.stdin.end();
        flushDeadline = setTimeout(finish, OUTPUT_FLUSH_DEADLINE_MS);
        flushDeadline.unref?.();
      } catch {
        if (!stopped) {
          fail('source-error');
        }
      }
    })();

    return recordingOf(units, stop);
  }
}

/** Writes one source fragment to the adaptation, leading with the initialization segment it carries. */
function writeSourceFragment(adaptation: RecordingMediaProcess, fragment: MediaFragment): void {
  if (fragment.init) {
    adaptation.stdin.write(fragment.init);
  }
  if (fragment.data.length > 0) {
    adaptation.stdin.write(fragment.data);
  }
}

function recordingOf(units: RecordedFragmentQueue, stop: () => void): AdaptedRecording {
  return {
    stop,
    [Symbol.asyncIterator](): AsyncIterator<RecordedFragment> {
      return {
        next: () => units.next(),
        return: async () => {
          stop();
          units.end();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * Hands adapted units from the event-driven adaptation to the one consumer iterating them.
 *
 * A recording is settled exactly once: either the source ran out and the last unit was marked, or the
 * recording failed. Units produced after that are dropped rather than delivered, because a HomeKit
 * controller closes a stream the moment it is told the recording ended.
 */
class RecordedFragmentQueue {
  private readonly pending: RecordedFragment[] = [];
  private waiting?: { resolve: (result: IteratorResult<RecordedFragment>) => void; reject: (error: unknown) => void };
  private ended = false;
  private failure?: unknown;

  get settled(): boolean {
    return this.ended || this.failure !== undefined;
  }

  push(fragment: RecordedFragment): void {
    if (this.settled) {
      return;
    }
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve({ done: false, value: fragment });
      return;
    }
    this.pending.push(fragment);
  }

  end(): void {
    if (this.settled) {
      return;
    }
    this.ended = true;
    this.waiting?.resolve({ done: true, value: undefined });
    this.waiting = undefined;
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.failure = error;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }

  next(): Promise<IteratorResult<RecordedFragment>> {
    const ready = this.pending.shift();
    if (ready) {
      return Promise.resolve({ done: false, value: ready });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
}

const BOX_HEADER_BYTES = 8;
const LARGE_SIZE_BYTES = 8;

/**
 * Splits the adaptation's fragmented MP4 output into the units a HomeKit recording stream transports.
 *
 * The first unit is the initialization segment, emitted as soon as the movie box completes so a controller
 * is not made to wait for media it cannot use yet. Every later unit is one complete `moof` and its `mdat`,
 * held until both boxes have arrived because a controller cannot use half a fragment. Anything else the
 * muxer writes at the end of the stream, such as a random-access index, belongs to a file rather than to a
 * recording and is dropped.
 */
class Fmp4OutputReader {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly initialization: Buffer[] = [];
  private initialized = false;
  private fragment?: Buffer;

  constructor(private readonly emit: (data: Buffer, initialization: boolean) => void) {}

  read(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const box = this.takeBox();
      if (!box) {
        return;
      }
      this.accept(box);
    }
  }

  private takeBox(): { type: string; data: Buffer } | undefined {
    if (this.buffered.length < BOX_HEADER_BYTES) {
      return undefined;
    }
    const declared = this.buffered.readUInt32BE(0);
    const type = this.buffered.toString('ascii', 4, BOX_HEADER_BYTES);
    let size = declared;
    if (declared === 1) {
      if (this.buffered.length < BOX_HEADER_BYTES + LARGE_SIZE_BYTES) {
        return undefined;
      }
      size = Number(this.buffered.readBigUInt64BE(BOX_HEADER_BYTES));
    }
    if (size < BOX_HEADER_BYTES || this.buffered.length < size) {
      return undefined;
    }
    const data = this.buffered.subarray(0, size);
    this.buffered = this.buffered.subarray(size);
    return { type, data };
  }

  private accept({ type, data }: { type: string; data: Buffer }): void {
    if (!this.initialized) {
      this.initialization.push(data);
      if (type === 'moov') {
        this.initialized = true;
        this.emit(Buffer.concat(this.initialization), true);
        this.initialization.length = 0;
      }
      return;
    }
    if (type === 'moof') {
      this.fragment = data;
      return;
    }
    if (type === 'mdat' && this.fragment) {
      const fragment = Buffer.concat([this.fragment, data]);
      this.fragment = undefined;
      this.emit(fragment, false);
    }
  }
}

/**
 * Recodes one fragment recording into the negotiated HomeKit output.
 *
 * The input is a container with its own timeline, so nothing here generates or overrides timestamps: the
 * source's own decode times are what make a fragment's duration and a track's alignment meaningful, which
 * is exactly what a live elementary-stream input cannot supply.
 *
 * A negotiated frame rate is a maximum, not a target, so the rate is bounded rather than fixed. Pinning it
 * makes the encoder duplicate frames a slower source never sent, and every duplicate spends the negotiated
 * bit rate on a frame that carries nothing.
 *
 * Fragmentation is driven only by keyframes, so every fragment necessarily starts with one. A keyframe
 * interval longer than the fragment length cannot also bound the fragment, so the shorter of the two
 * governs; a duration-driven cut would instead be free to land between keyframes and produce a fragment no
 * controller can open.
 *
 * The forced interval is one frame shorter than that bound, because a keyframe can only be coded on a
 * frame the encoder actually has: asking for one at the bound itself puts the boundary on the first frame
 * at or after it, which measurably overruns the fragment length a controller selected. Shifting the
 * request back by exactly the quantum the boundary can be late by keeps every fragment inside it, and
 * keyframes slightly more often than selected are within a selected maximum.
 *
 * `superfast` is the cheapest `libx264` preset that retains CABAC, and therefore the cheapest one whose
 * coded stream can carry a negotiated Main or High profile.
 */
function recordingArguments(negotiated: NegotiatedRecording): string[] {
  const frameInterval = 1 / Math.max(negotiated.fps, 1);
  const boundSeconds = Math.min(negotiated.iFrameIntervalMs, negotiated.fragmentLengthMs) / 1_000;
  const keyframeInterval = Math.max(boundSeconds - frameInterval, frameInterval);
  const groupOfPictures = String(Math.max(1, Math.round(negotiated.fps * keyframeInterval)));
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-f',
    'mp4',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    ...(negotiated.audio ? ['-map', '0:a:0?'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'superfast',
    '-tune',
    'zerolatency',
    '-profile:v',
    negotiated.profile,
    '-level:v',
    negotiated.level,
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale=${negotiated.width}:${negotiated.height}:force_original_aspect_ratio=decrease,pad=${negotiated.width}:${negotiated.height}:(ow-iw)/2:(oh-ih)/2`,
    '-fpsmax',
    String(negotiated.fps),
    '-g',
    groupOfPictures,
    '-keyint_min',
    groupOfPictures,
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${keyframeInterval.toFixed(4)})`,
    '-b:v',
    `${negotiated.maxBitRate}k`,
    '-maxrate',
    `${negotiated.maxBitRate}k`,
    '-bufsize',
    `${negotiated.maxBitRate * 2}k`,
    ...(negotiated.audio
      ? [
          '-c:a',
          'libfdk_aac',
          '-profile:a',
          'aac_eld',
          '-ar',
          `${negotiated.audio.sampleRate}k`,
          '-ac',
          String(negotiated.audio.channels),
          '-b:a',
          `${negotiated.audio.maxBitRate}k`,
        ]
      : ['-an']),
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
}

function spawnRecordingMediaProcess(executable: string, args: readonly string[]): RecordingMediaProcess {
  return spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}
