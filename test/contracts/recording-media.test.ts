import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { FragmentRecordingHandle, MediaFragment, StreamBudgetNotice } from '@mega-yfue/eufy-sdk';

import type {
  AdaptedRecording,
  NegotiatedRecording,
  RecordedFragment,
  RecordingOutcome,
} from '../../src/media/contracts.js';
import { FfmpegRecordingMedia } from '../../src/media/recording.js';

const NEGOTIATED: NegotiatedRecording = {
  width: 1920,
  height: 1080,
  fps: 30,
  maxBitRate: 2_000,
  profile: 'high',
  level: '4.0',
  iFrameIntervalMs: 4_000,
  fragmentLengthMs: 4_000,
  prebufferLengthMs: 0,
  audio: { codec: 'AAC-lc', channels: 1, sampleRate: 32, maxBitRate: 32 },
};

/** One ISO base media box, the unit the adapted output is split on. */
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

const INIT_SEGMENT = Buffer.concat([box('ftyp', Buffer.from('iso5')), box('moov', Buffer.alloc(24, 1))]);

function mediaFragment(marker: number, bytes = 32): Buffer {
  return Buffer.concat([box('moof', Buffer.alloc(12, marker)), box('mdat', Buffer.alloc(bytes, marker))]);
}

/** An adaptation process whose output, failure, and exit this specification drives directly. */
function adaptationProcess() {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const written: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => written.push(chunk));
  return {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    written,
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    kill: vi.fn(),
  };
}

/**
 * One SDK fragment recording whose fragments, budget notices, completion, and failure are delivered by
 * this specification rather than by a device.
 */
class SyntheticFragmentRecording extends EventEmitter implements FragmentRecordingHandle {
  readonly stop = vi.fn();
  private readonly pending: MediaFragment[] = [];
  private waiting?: { resolve: (result: IteratorResult<MediaFragment>) => void; reject: (error: unknown) => void };
  private completed = false;
  private failure?: unknown;
  iterations = 0;

  deliver(fragment: MediaFragment): void {
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve({ done: false, value: fragment });
      return;
    }
    this.pending.push(fragment);
  }

  complete(): void {
    this.completed = true;
    this.waiting?.resolve({ done: true, value: undefined });
    this.waiting = undefined;
  }

  fail(error: unknown): void {
    this.failure = error;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }

  budget(notice: StreamBudgetNotice): void {
    this.emit('budget', notice);
  }

  [Symbol.asyncIterator](): AsyncIterator<MediaFragment> {
    this.iterations += 1;
    return {
      next: () =>
        new Promise<IteratorResult<MediaFragment>>((resolve, reject) => {
          const ready = this.pending.shift();
          if (ready) {
            resolve({ done: false, value: ready });
            return;
          }
          if (this.failure !== undefined) {
            reject(this.failure);
            return;
          }
          if (this.completed) {
            resolve({ done: true, value: undefined });
            return;
          }
          this.waiting = { resolve, reject };
        }),
      return: async () => {
        this.completed = true;
        return { done: true, value: undefined };
      },
    };
  }
}

/** Consumes an adapted recording in the background exactly as the HomeKit recording delegate does. */
function consume(recording: AdaptedRecording) {
  const units: RecordedFragment[] = [];
  let failure: unknown;
  let finished = false;
  const iteration = (async () => {
    for await (const unit of recording) {
      units.push(unit);
    }
  })()
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      finished = true;
    });
  return { units, iteration, failed: () => failure !== undefined, finished: () => finished };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * One recording session with its source, its adaptation process, and every reported outcome recorded, so
 * each contract drives the same seam the HomeKit recording delegate drives.
 */
function recordingSession(negotiated: NegotiatedRecording = NEGOTIATED) {
  const source = new SyntheticFragmentRecording();
  const children: ReturnType<typeof adaptationProcess>[] = [];
  const spawned: string[][] = [];
  const outcomes: RecordingOutcome[] = [];
  const media = new FfmpegRecordingMedia('/synthetic/ffmpeg', (_executable, args) => {
    const child = adaptationProcess();
    children.push(child);
    spawned.push([...args]);
    return child;
  });
  const requested: { fragmentSeconds?: number; preBufferSeconds?: number }[] = [];
  const recording = media.record(
    {
      recordFragments: (options) => {
        requested.push({ ...options });
        return source;
      },
    },
    negotiated,
    { onOutcome: (outcome) => outcomes.push(outcome) },
  );
  return { source, children, spawned, outcomes, recording, requested, consumed: consume(recording) };
}

/** The arguments an adaptation received before its input, where FFmpeg accepts the same flag twice. */
function inputArguments(args: readonly string[]): readonly string[] {
  return args.slice(0, args.indexOf('-i'));
}

describe('recording media adaptation', () => {
  it('transcodes source fragments into the negotiated profile, level, geometry, and bit rate', async () => {
    const session = recordingSession();
    await settle();
    expect(session.spawned).toHaveLength(1);
    const args = session.spawned[0];
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0']));
    expect(args).toEqual(
      expect.arrayContaining([
        '-vf',
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      ]),
    );
    expect(args).toEqual(expect.arrayContaining(['-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '4000k']));
    expect(inputArguments(args)).toEqual(expect.arrayContaining(['-f', 'mp4']));
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('fragments the output on forced keyframes no further apart than the selected fragment length', async () => {
    const session = recordingSession({ ...NEGOTIATED, iFrameIntervalMs: 8_000, fragmentLengthMs: 4_000 });
    await settle();
    const args = session.spawned[0];
    expect(args).toEqual(expect.arrayContaining(['-force_key_frames', 'expr:gte(t,n_forced*3.9667)']));
    expect(args).toEqual(expect.arrayContaining(['-g', '119', '-keyint_min', '119', '-sc_threshold', '0']));
    expect(args).toEqual(
      expect.arrayContaining(['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4']),
    );
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('codes a keyframe at the selected i-frame interval when it is shorter than a fragment', async () => {
    const session = recordingSession({ ...NEGOTIATED, iFrameIntervalMs: 2_000, fragmentLengthMs: 4_000 });
    await settle();
    const args = session.spawned[0];
    expect(args).toEqual(expect.arrayContaining(['-force_key_frames', 'expr:gte(t,n_forced*1.9667)']));
    expect(args).toEqual(expect.arrayContaining(['-g', '59', '-keyint_min', '59']));
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('asks for a keyframe one frame before the fragment a boundary can only land on a frame of', async () => {
    const session = recordingSession({ ...NEGOTIATED, fps: 15, iFrameIntervalMs: 4_000, fragmentLengthMs: 4_000 });
    await settle();
    expect(session.spawned[0]).toEqual(
      expect.arrayContaining(['-force_key_frames', 'expr:gte(t,n_forced*3.9333)', '-fpsmax', '15']),
    );
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('bounds the recorded frame rate without duplicating frames the source never sent', async () => {
    const session = recordingSession();
    await settle();
    const args = session.spawned[0];
    expect(args).toEqual(expect.arrayContaining(['-fpsmax', '30']));
    expect(args).not.toContain('-r');
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('requests source fragments short enough not to delay output behind captured media', async () => {
    const session = recordingSession({ ...NEGOTIATED, fragmentLengthMs: 4_000 });
    await settle();
    expect(session.requested).toEqual([{ fragmentSeconds: 1 }]);
    expect(session.source.iterations).toBe(1);
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('drains the pre-event media window the negotiated recording carries', async () => {
    const session = recordingSession({ ...NEGOTIATED, prebufferLengthMs: 4_000 });
    await settle();
    expect(session.requested).toEqual([{ fragmentSeconds: 1, preBufferSeconds: 4 }]);
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('asks for no pre-event media at all for a recording that carries no window', async () => {
    const session = recordingSession({ ...NEGOTIATED, prebufferLengthMs: 0 });
    await settle();
    expect(session.requested).toEqual([{ fragmentSeconds: 1 }]);
    expect(session.requested[0]).not.toHaveProperty('preBufferSeconds');
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('emits the initialization segment as its own first output unit', async () => {
    const session = recordingSession();
    await settle();
    session.source.deliver({ init: Buffer.from('source-init'), data: Buffer.alloc(0), keyframe: true });
    await settle();
    expect(Buffer.concat(session.children[0].written).toString()).toBe('source-init');
    session.children[0].stdout.write(INIT_SEGMENT);
    await settle();
    expect(session.consumed.units).toHaveLength(1);
    expect(session.consumed.units[0].data.equals(INIT_SEGMENT)).toBe(true);
    expect(session.consumed.units[0].last).toBe(false);
    expect(session.outcomes).toEqual([{ outcome: 'recording' }]);
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('emits each moof and mdat pair as one fragment and never a box between recordings', async () => {
    const session = recordingSession();
    await settle();
    const child = session.children[0];
    child.stdout.write(INIT_SEGMENT);
    const first = mediaFragment(0xaa);
    const second = mediaFragment(0xbb, 64);
    child.stdout.write(Buffer.concat([first, second.subarray(0, 5)]));
    await settle();
    expect(session.consumed.units).toHaveLength(2);
    expect(session.consumed.units[1].data.equals(first)).toBe(true);
    child.stdout.write(second.subarray(5));
    child.stdout.write(box('mfra', Buffer.alloc(8)));
    await settle();
    expect(session.consumed.units).toHaveLength(3);
    expect(session.consumed.units[2].data.equals(second)).toBe(true);
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('marks the final fragment last only once the source has ended', async () => {
    const session = recordingSession();
    await settle();
    const child = session.children[0];
    child.stdout.write(Buffer.concat([INIT_SEGMENT, mediaFragment(0x01)]));
    await settle();
    expect(session.consumed.units.map((unit) => unit.last)).toEqual([false, false]);

    session.source.complete();
    await settle();
    child.stdout.write(mediaFragment(0x02));
    await settle();
    expect(session.consumed.units).toHaveLength(2);

    child.stdout.end();
    child.emit('exit', 0, null);
    await session.consumed.iteration;
    expect(session.consumed.units).toHaveLength(3);
    expect(session.consumed.units[2].last).toBe(true);
    expect(session.consumed.failed()).toBe(false);
  });

  it('ends a recording whose adaptation never flushes what the ended source already gave it', async () => {
    vi.useFakeTimers();
    try {
      const session = recordingSession();
      await vi.advanceTimersByTimeAsync(0);
      session.children[0].stdout.write(Buffer.concat([INIT_SEGMENT, mediaFragment(0x01)]));
      await vi.advanceTimersByTimeAsync(0);
      session.source.complete();
      await vi.advanceTimersByTimeAsync(0);
      session.children[0].stdout.write(mediaFragment(0x02));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.consumed.units).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5_000);
      await session.consumed.iteration;
      expect(session.consumed.units).toHaveLength(3);
      expect(session.consumed.units[2].last).toBe(true);
      expect(session.consumed.failed()).toBe(false);
      expect(session.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades to a video-only recording when the source carries no audio track', async () => {
    const session = recordingSession();
    await settle();
    const args = session.spawned[0];
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '0:a:0?']));
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('records no audio at all when the negotiated recording carries none', async () => {
    const { audio: _audio, ...withoutAudio } = NEGOTIATED;
    const session = recordingSession(withoutAudio);
    await settle();
    const args = session.spawned[0];
    expect(args).toContain('-an');
    expect(args).not.toContain('0:a:0?');
    expect(args).not.toContain('libfdk_aac');
    session.recording.stop();
    await session.consumed.iteration;
  });

  it('codes the recorded audio profile and sample rate the controller selected', async () => {
    const low = recordingSession();
    await settle();
    expect(low.spawned[0]).toEqual(
      expect.arrayContaining(['-c:a', 'libfdk_aac', '-profile:a', 'aac_low', '-ar', '32k', '-ac', '1', '-b:a', '32k']),
    );
    low.recording.stop();
    await low.consumed.iteration;

    const eld = recordingSession({
      ...NEGOTIATED,
      audio: { codec: 'AAC-eld', channels: 1, sampleRate: 16, maxBitRate: 24 },
    });
    await settle();
    expect(eld.spawned[0]).toEqual(expect.arrayContaining(['-profile:a', 'aac_eld', '-ar', '16k', '-b:a', '24k']));
    eld.recording.stop();
    await eld.consumed.iteration;
  });

  it('stops the source and its adaptation promptly when a recording is cancelled', async () => {
    const session = recordingSession();
    await settle();
    session.children[0].stdout.write(INIT_SEGMENT);
    await settle();
    session.recording.stop();
    await session.consumed.iteration;
    expect(session.source.stop).toHaveBeenCalledTimes(1);
    expect(session.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.consumed.finished()).toBe(true);
    expect(session.consumed.failed()).toBe(false);
  });

  it('stops the source and its adaptation when its consumer stops iterating', async () => {
    const source = new SyntheticFragmentRecording();
    const children: ReturnType<typeof adaptationProcess>[] = [];
    const media = new FfmpegRecordingMedia('/synthetic/ffmpeg', () => {
      const child = adaptationProcess();
      children.push(child);
      return child;
    });
    const recording = media.record({ recordFragments: () => source }, NEGOTIATED);
    await settle();
    children[0].stdout.write(Buffer.concat([INIT_SEGMENT, mediaFragment(0x01)]));
    await settle();
    const seen: RecordedFragment[] = [];
    for await (const unit of recording) {
      seen.push(unit);
      break;
    }
    await settle();
    expect(seen).toHaveLength(1);
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('extends a source media budget only while the recording is being consumed', async () => {
    const session = recordingSession();
    await settle();
    const extend = vi.fn();
    session.source.budget({ graceMs: 10_000, extend });
    expect(extend).toHaveBeenCalledTimes(1);
    session.recording.stop();
    await session.consumed.iteration;
    session.source.budget({ graceMs: 10_000, extend });
    expect(extend).toHaveBeenCalledTimes(1);
  });

  it('fails a recording that produces no output within the backstop', async () => {
    vi.useFakeTimers();
    try {
      const session = recordingSession();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(session.outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      await session.consumed.iteration;
      expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'no-output-within-backstop' }]);
      expect(session.consumed.failed()).toBe(true);
      expect(session.source.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a recording whose adaptation exits before its source ends', async () => {
    const session = recordingSession();
    await settle();
    session.children[0].stdout.write(INIT_SEGMENT);
    await settle();
    session.children[0].emit('exit', 1, null);
    await session.consumed.iteration;
    expect(session.outcomes).toEqual([{ outcome: 'recording' }, { outcome: 'failed', reason: 'adaptation-failed' }]);
    expect(session.consumed.failed()).toBe(true);
  });

  it('fails a recording whose source reports an error', async () => {
    const session = recordingSession();
    await settle();
    session.source.fail(new Error('synthetic source failure'));
    await session.consumed.iteration;
    expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'source-error' }]);
    expect(session.consumed.failed()).toBe(true);
  });

  it('fails a recording the source exposes no fragment recording for', async () => {
    const outcomes: RecordingOutcome[] = [];
    const media = new FfmpegRecordingMedia('/synthetic/ffmpeg', () => {
      throw new Error('no adaptation may be spawned');
    });
    const recording = media.record({}, NEGOTIATED, { onOutcome: (outcome) => outcomes.push(outcome) });
    const consumed = consume(recording);
    await consumed.iteration;
    expect(outcomes).toEqual([{ outcome: 'failed', reason: 'source-unavailable' }]);
    expect(consumed.failed()).toBe(true);
  });
});
