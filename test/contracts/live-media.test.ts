import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type {
  LiveAudioFrame,
  LiveStreamHandle,
  LiveVideoFrame,
  StreamBudgetNotice,
  TalkbackHandle,
} from '@mega-yfue/eufy-sdk';
import { LiveStreamStartError } from '@mega-yfue/eufy-sdk';
import bundledFfmpegPath from 'ffmpeg-for-homebridge';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdaptationNotice,
  LiveSessionOutcome,
  NegotiatedLiveAudio,
  NegotiatedLiveVideo,
  TalkbackOutcome,
} from '../../src/media/contracts.js';
import { FfmpegLiveMedia, resolveFfmpegIdentity, type MediaProcess } from '../../src/media/live-stream.js';

const NEGOTIATED_VIDEO: NegotiatedLiveVideo = {
  width: 1280,
  height: 720,
  fps: 30,
  maxBitRate: 300,
  profile: 'main',
  level: '3.1',
  payloadType: 99,
  ssrc: 1234,
  mtu: 1200,
  rtcpInterval: 0.5,
};

const AAC_ELD_16: NegotiatedLiveAudio = {
  codec: 'AAC-eld',
  channels: 1,
  sampleRate: 16,
  maxBitRate: 24,
  payloadType: 110,
  ssrc: 5678,
};

const KEYFRAME = {
  codec: 'h264' as const,
  width: 1280,
  height: 720,
  keyframe: true,
  data: Buffer.from([0, 0, 0, 1, 0x65]),
};

class SyntheticLiveStream extends EventEmitter implements LiveStreamHandle {
  start(): this {
    return this;
  }

  stop = vi.fn();

  video(frame: LiveVideoFrame): void {
    this.emit('video', frame);
  }

  audio(frame: LiveAudioFrame): void {
    this.emit('audio', frame);
  }
}

type SyntheticProcess = MediaProcess & { emit(event: string, ...args: unknown[]): boolean; readonly input: Buffer[] };

/**
 * The options one adaptation process applies to its input, which is everything before `-i`. FFmpeg reads
 * the same option name on either side of the input, so an input contract has to be judged on this slice
 * rather than on the whole argument list.
 */
function inputOptions(args: readonly string[]): string[] {
  return args.slice(0, args.indexOf('-i'));
}

function process(): SyntheticProcess {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const input: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => input.push(Buffer.from(chunk)));
  return {
    stdin,
    stderr: new PassThrough(),
    input,
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    kill: vi.fn(() => true),
  };
}

type SyntheticReturnAudioProcess = SyntheticProcess & { stdout: PassThrough };

function returnAudioProcess(): SyntheticReturnAudioProcess {
  const child = process() as SyntheticReturnAudioProcess;
  child.stdout = new PassThrough();
  return child;
}

class SyntheticTalkback extends EventEmitter implements TalkbackHandle {
  readonly written: Buffer[] = [];
  readonly sink = new PassThrough();
  readonly stop = vi.fn(async () => {
    this.emit('stop');
  });
  readonly pending = 0;

  constructor() {
    super();
    this.sink.on('data', (chunk: Buffer) => this.written.push(Buffer.from(chunk)));
  }

  write(chunk: Buffer): void {
    this.sink.write(chunk);
  }

  writable(): PassThrough {
    return this.sink;
  }

  end(): void {
    this.sink.end();
  }

  budget(notice: StreamBudgetNotice): void {
    this.emit('budget', notice);
  }

  fail(): void {
    this.emit('error', new Error('synthetic talkback failure'));
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** One live session with controller return audio and every isolated talkback resource exposed. */
async function talkbackSession(talkback: () => Promise<TalkbackHandle>) {
  const stream = new SyntheticLiveStream();
  const children: SyntheticProcess[] = [];
  const returned: SyntheticReturnAudioProcess[] = [];
  const spawned: string[][] = [];
  const returnedArgs: string[][] = [];
  const ports: Array<{ port: number; onMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const talkbackOutcomes: TalkbackOutcome[] = [];
  const onVideoFailure = vi.fn();
  const notices: AdaptationNotice[] = [];
  const media = new FfmpegLiveMedia(
    '/synthetic/ffmpeg',
    { report: (notice) => notices.push(notice) },
    (_executable, args) => {
      const child = process();
      children.push(child);
      spawned.push([...args]);
      return child;
    },
    async () => {
      const port = { port: 41000 + ports.length, onMessage: vi.fn(), close: vi.fn(async () => undefined) };
      ports.push(port);
      return port;
    },
    (_executable, args) => {
      const child = returnAudioProcess();
      returned.push(child);
      returnedArgs.push([...args]);
      return child;
    },
  );
  const prepared = await media.prepare({
    addressVersion: 'ipv4',
    targetAddress: '192.0.2.10',
    video: {
      port: 50100,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: Buffer.alloc(16),
      srtpSalt: Buffer.alloc(14),
    },
    audio: {
      port: 50101,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: Buffer.alloc(16),
      srtpSalt: Buffer.alloc(14),
    },
    onVideoFailure,
    onTalkbackOutcome: (outcome) => talkbackOutcomes.push(outcome),
  });
  await prepared.start({ live: async () => stream, talkback }, { video: NEGOTIATED_VIDEO, audio: AAC_ELD_16 });
  return {
    prepared,
    stream,
    children,
    spawned,
    returned,
    returnedArgs,
    ports,
    talkbackOutcomes,
    onVideoFailure,
    notices,
  };
}

/**
 * One prepared session that records every adaptation process, the arguments it was given, and every
 * reported outcome. `audio` negotiates the second output so the audio adaptation contracts share this setup.
 */
async function liveSession(
  source?: { live(): Promise<LiveStreamHandle> },
  { audio }: { audio?: NegotiatedLiveAudio } = {},
) {
  const stream = new SyntheticLiveStream();
  const onVideoFailure = vi.fn();
  const outcomes: LiveSessionOutcome[] = [];
  const released = vi.fn();
  const children: SyntheticProcess[] = [];
  const spawned: string[][] = [];
  const notices: AdaptationNotice[] = [];
  let receiverReport: (() => void) | undefined;
  const media = new FfmpegLiveMedia(
    '/synthetic/ffmpeg',
    { report: (notice) => notices.push(notice) },
    (_executable, args) => {
      const child = process();
      children.push(child);
      spawned.push([...args]);
      return child;
    },
    async () => ({
      port: 41000,
      onMessage: (listener) => {
        receiverReport = listener;
      },
      close: vi.fn(),
    }),
  );
  const prepared = await media.prepare({
    addressVersion: 'ipv4',
    targetAddress: '192.0.2.10',
    video: {
      port: 50100,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: Buffer.alloc(16),
      srtpSalt: Buffer.alloc(14),
    },
    ...(audio
      ? {
          audio: {
            port: 50101,
            srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80' as const,
            srtpKey: Buffer.alloc(16),
            srtpSalt: Buffer.alloc(14),
          },
        }
      : {}),
    onVideoFailure,
    onSessionOutcome: (outcome) => outcomes.push(outcome),
    onSessionReleased: released,
  });
  return {
    prepared,
    stream,
    children,
    spawned,
    onVideoFailure,
    outcomes,
    released,
    notices,
    start: (): Promise<void> =>
      prepared.start(source ?? { live: async () => stream }, { video: NEGOTIATED_VIDEO, ...(audio ? { audio } : {}) }),
    receiverReport: (): void => receiverReport?.(),
  };
}

describe('live media adaptation', () => {
  it('starts adaptation for a first keyframe delivered after the SDK warm-up window', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(22_000);

    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.children).toHaveLength(0);

    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(0);

    expect(session.children).toHaveLength(1);
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);
    session.prepared.stop();
    expect(session.released).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('fails a session on the SDK warm-up error before the video backstop', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(20_000);
    session.stream.emit('error', new Error('synthetic warm-up failure'));

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'source-error', stage: 'first-source-keyframe' }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.outcomes).toHaveLength(1);
    vi.useRealTimers();
  });

  it('names a source that answered with audio and never a video frame apart from any other source error', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(20_000);
    session.stream.emit(
      'error',
      new LiveStreamStartError({ reason: 'warm-timeout', stage: 'audio-only', timeoutMs: 20_000, attempts: 10 }),
    );

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([
      { outcome: 'failed', reason: 'source-audio-only', stage: 'first-source-keyframe' },
    ]);
    vi.useRealTimers();
  });

  it('reports a start that never delivered a frame at all as a source error rather than an audio-only one', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(20_000);
    session.stream.emit(
      'error',
      new LiveStreamStartError({
        reason: 'warm-timeout',
        stage: 'awaiting-first-frame',
        timeoutMs: 20_000,
        attempts: 10,
      }),
    );

    expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'source-error', stage: 'first-source-keyframe' }]);
    vi.useRealTimers();
  });

  it('names an audio-only start that failed the source acquisition itself', async () => {
    const failure = new LiveStreamStartError({
      reason: 'source-ended',
      stage: 'audio-only',
      timeoutMs: 20_000,
      attempts: 3,
    });
    const session = await liveSession({
      live: async () => {
        throw failure;
      },
    });

    await expect(session.start()).rejects.toBe(failure);

    expect(session.outcomes).toEqual([
      { outcome: 'failed', reason: 'source-audio-only', stage: 'sdk-source-acquisition' },
    ]);
  });

  it('bounds a silent source at the video backstop and reports the bounded reason', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([
      { outcome: 'failed', reason: 'no-video-within-backstop', stage: 'first-source-keyframe' },
    ]);
    vi.useRealTimers();
  });

  it('arms the initial RTCP grace from first adaptation progress rather than session start', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(25_000);
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(14_999);

    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);
    expect(session.onVideoFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'rtcp-timeout', stage: 'controller-rtcp' },
    ]);
    vi.useRealTimers();
  });

  /**
   * `FFmpeg exited with code: 234`, five reporters and two hours of troubleshooting is what one shared reason
   * costs. A binary that never started names the path; one that exited before producing anything names the
   * build's encoders, arguments or format; one that exited after it had been streaming names a run that was
   * working. The three have different fixes, so they are reported apart, and the process's own stderr tail is
   * reported with them because it states which of the three it actually was.
   */
  it('tells an adaptation that never started from one that exited before its first output', async () => {
    const spawnFailed = await liveSession();
    await spawnFailed.start();
    spawnFailed.stream.video(KEYFRAME);
    spawnFailed.children[0]!.emit('error', new Error('spawn /synthetic/ffmpeg ENOENT'));
    await settle();

    expect(spawnFailed.outcomes).toEqual([
      { outcome: 'failed', reason: 'adaptation-spawn-failed', stage: 'first-adapted-output' },
    ]);
    expect(spawnFailed.notices).toEqual([{ role: 'live-video', event: 'spawn-failed' }]);

    const exited = await liveSession();
    await exited.start();
    exited.stream.video(KEYFRAME);
    exited.children[0]!.stderr.push("Unknown encoder 'libx264'\n");
    await settle();
    exited.children[0]!.emit('exit', 234, null);
    await settle();

    expect(exited.outcomes).toEqual([
      { outcome: 'failed', reason: 'adaptation-exited-before-output', stage: 'first-adapted-output' },
    ]);
    expect(exited.notices).toEqual([
      { role: 'live-video', event: 'exited-before-output', code: 234, stderr: ["Unknown encoder 'libx264'"] },
    ]);
  });

  it('tells an adaptation that stopped mid-session from one that never produced output', async () => {
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await settle();
    session.children[0]!.emit('exit', null, 'SIGSEGV');
    await settle();

    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'adaptation-exited-while-streaming', stage: 'first-adapted-output' },
    ]);
    expect(session.notices).toEqual([{ role: 'live-video', event: 'exited-while-streaming', signal: 'SIGSEGV' }]);
  });

  /**
   * `-progress pipe:2` writes its block on a timer whether or not media reaches the process, so retaining
   * everything on that pipe would leave the tail holding nothing but progress by the time anything went
   * wrong. Only the diagnostic lines are kept, bounded, and a line still waiting for its terminator is not
   * one of them.
   */
  it('retains only the last diagnostic lines of an adaptation, never its progress block', async () => {
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    for (let index = 0; index < 12; index += 1) {
      session.children[0]!.stderr.push(`diagnostic line ${index}\nprogress=continue\nframe=${index}\n`);
    }
    session.children[0]!.stderr.push('a line with no terminator yet');
    await settle();
    session.children[0]!.emit('exit', 1, null);
    await settle();

    expect(session.notices).toEqual([
      {
        role: 'live-video',
        event: 'exited-while-streaming',
        code: 1,
        stderr: [
          'diagnostic line 8',
          'frame=8',
          'diagnostic line 9',
          'frame=9',
          'diagnostic line 10',
          'frame=10',
          'diagnostic line 11',
          'frame=11',
        ],
      },
    ]);
  });

  it('reports an audio adaptation that stopped without failing the video it runs beside', async () => {
    const session = await liveSession(undefined, { audio: AAC_ELD_16 });
    await session.start();
    session.stream.video(KEYFRAME);
    session.stream.audio({ codec: 'aac', data: Buffer.alloc(4) });
    await settle();
    session.children[1]!.stderr.push("Unknown encoder 'libfdk_aac'\n");
    await settle();
    session.children[1]!.emit('exit', 1, null);
    await settle();

    expect(session.outcomes, 'a silent camera is not a broken one, so audio never fails the session').toEqual([]);
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.notices).toEqual([
      {
        role: 'live-audio',
        event: 'exited-before-output',
        code: 1,
        stderr: ["Unknown encoder 'libfdk_aac'"],
      },
    ]);
  });

  /**
   * A profile that declares FFmpeg output has to receive some for a session that worked, not only for one
   * that failed: an unwatchable live view is a working session whose adaptation warned its way through it.
   * A process that ended as the session intended is therefore reported for what it wrote, with no reason
   * raised against the camera, and a process that wrote nothing is not reported at all.
   */
  it('reports what a deliberately stopped adaptation wrote, without failing the session for it', async () => {
    const noisy = await liveSession();
    await noisy.start();
    noisy.stream.video(KEYFRAME);
    noisy.children[0]!.stderr.push('progress=continue\nPast duration 0.799995 too large\n');
    await settle();
    noisy.prepared.stop();
    noisy.children[0]!.emit('exit', 0, 'SIGTERM');
    await settle();

    expect(noisy.outcomes, 'a stopped session is not a failed one').toEqual([{ outcome: 'streaming' }]);
    expect(noisy.onVideoFailure).not.toHaveBeenCalled();
    expect(noisy.notices).toEqual([
      { role: 'live-video', event: 'output', code: 0, signal: 'SIGTERM', stderr: ['Past duration 0.799995 too large'] },
    ]);

    const silent = await liveSession();
    await silent.start();
    silent.stream.video(KEYFRAME);
    silent.children[0]!.stderr.push('progress=continue\n');
    await settle();
    silent.prepared.stop();
    silent.children[0]!.emit('exit', 0, 'SIGTERM');
    await settle();

    expect(silent.notices, 'a process that said nothing has nothing to attribute').toEqual([]);
  });

  it('does not let an early receiver report bound a session before its media starts', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.receiverReport();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.outcomes).toEqual([]);

    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(4_999);

    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);

    await vi.advanceTimersByTimeAsync(1);

    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'rtcp-timeout', stage: 'controller-rtcp' },
    ]);
    vi.useRealTimers();
  });

  it('reports an upstream source end apart from a source failure', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    session.stream.emit('stop');

    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'source-stopped', stage: 'first-adapted-output' },
    ]);
    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('timestamps live video by arrival and bounds the analysis that precedes a first coded frame', async () => {
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);

    const options = inputOptions(session.spawned[0]!);
    expect(options).toEqual(
      expect.arrayContaining(['-use_wallclock_as_timestamps', '1', '-probesize', '32', '-analyzeduration', '1']),
    );
    session.prepared.stop();
  });

  /**
   * Measured at this seam with a discarding input option reinstated: time to first coded frame grew from
   * 0.5s to 8.7s as the source keyframe interval grew from 15 to 250 frames, while 50 of 300 fed access units
   * reached the coded output. One option on one input caused all of it, so the rule is stated over every
   * adapted input rather than pinned as one argument list.
   */
  it('never asks any adapted input to discard what it analysed or to invent a timeline', async () => {
    const video = await liveSession();
    await video.start();
    video.stream.video(KEYFRAME);
    video.stream.video({ ...KEYFRAME, codec: 'h265', keyframe: true, data: Buffer.from([0, 0, 0, 1, 0x26]) });
    const audio = await liveSession(undefined, { audio: AAC_ELD_16 });
    await audio.start();
    audio.stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1]) });
    const alaw = await liveSession(undefined, { audio: AAC_ELD_16 });
    await alaw.start();
    alaw.stream.audio({ codec: 'g711a', data: Buffer.from([0xd5]) });

    const inputs = [...video.spawned, ...audio.spawned, ...alaw.spawned].map(inputOptions);
    expect(inputs).toHaveLength(4);
    for (const options of inputs) {
      expect(options).toEqual(expect.arrayContaining(['-probesize', '32', '-analyzeduration', '1']));
      for (const forbidden of ['nobuffer', 'discardcorrupt', 'genpts', 'gendts', 'igndts']) {
        expect(options.join(' ')).not.toContain(forbidden);
      }
    }
    video.prepared.stop();
    audio.prepared.stop();
    alaw.prepared.stop();
  });

  /**
   * Every access unit a session accepts has to reach the process that codes it, byte for byte and in order.
   * The count is the only thing that catches a whole group of pictures being lost silently: a session that
   * drops frames still starts, still reports progress, and still produces a coded stream.
   */
  it.each(['h264', 'h265'] as const)(
    'writes every %s access unit it accepts to the adaptation, in order and unaltered',
    async (codec) => {
      const session = await liveSession();
      await session.start();
      const gop = [
        { ...KEYFRAME, codec, data: Buffer.from([0, 0, 0, 1, codec === 'h265' ? 0x26 : 0x65]) },
        ...Array.from({ length: 249 }, (_, index) => ({
          ...KEYFRAME,
          codec,
          keyframe: false,
          data: Buffer.from([0, 0, 0, 1, codec === 'h265' ? 0x02 : 0x41, index >> 8, index & 0xff]),
        })),
      ];
      for (const frame of gop) {
        session.stream.video(frame);
      }

      expect(session.children).toHaveLength(1);
      expect(session.spawned[0]![session.spawned[0]!.indexOf('-f') + 1]).toBe(codec === 'h265' ? 'hevc' : 'h264');
      expect(Buffer.concat(session.children[0]!.input)).toEqual(Buffer.concat(gop.map(({ data }) => data)));
      session.prepared.stop();
    },
  );

  /**
   * A source that changes geometry cannot be coded by the running process, so the access units between the
   * change and the keyframe a replacement can start from are the only ones a session may withhold. Every
   * other unit still reaches an adaptation, and each process receives only the units it can code.
   */
  it('withholds only the access units no adaptation can code across a source geometry change', async () => {
    const session = await liveSession();
    await session.start();
    const first = [KEYFRAME, { ...KEYFRAME, keyframe: false, data: Buffer.from([0, 0, 0, 1, 0x41, 1]) }];
    const withheld = [
      { ...KEYFRAME, width: 640, height: 360, keyframe: false, data: Buffer.from([0, 0, 0, 1, 0x41, 2]) },
      { ...KEYFRAME, width: 640, height: 360, keyframe: false, data: Buffer.from([0, 0, 0, 1, 0x41, 3]) },
    ];
    const second = [
      { ...KEYFRAME, width: 640, height: 360, data: Buffer.from([0, 0, 0, 1, 0x65, 4]) },
      { ...KEYFRAME, width: 640, height: 360, keyframe: false, data: Buffer.from([0, 0, 0, 1, 0x41, 5]) },
    ];
    for (const frame of [...first, ...withheld, ...second]) {
      session.stream.video(frame);
    }

    expect(session.children).toHaveLength(2);
    expect(Buffer.concat(session.children[0]!.input)).toEqual(Buffer.concat(first.map(({ data }) => data)));
    expect(Buffer.concat(session.children[1]!.input)).toEqual(Buffer.concat(second.map(({ data }) => data)));
    session.prepared.stop();
  });

  it('transcodes H.264 when passthrough compliance cannot be proven from SDK frames', async () => {
    const stream = new SyntheticLiveStream();
    const spawned: Array<{ executable: string; args: string[]; process: MediaProcess }> = [];
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      const child = process();
      spawned.push({ executable, args: [...args], process: child });
      return child;
    });
    const media = new FfmpegLiveMedia('/synthetic/ffmpeg', undefined, spawn, async () => ({
      port: 41000,
      onMessage: vi.fn(),
      close: vi.fn(),
    }));
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16, 1),
        srtpSalt: Buffer.alloc(14, 2),
      },
    });

    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
      },
    );
    stream.video({
      codec: 'h264',
      width: 1280,
      height: 720,
      keyframe: true,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
    });

    expect(prepared.videoPort).toBe(41000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].executable).toBe('/synthetic/ffmpeg');
    expect(spawned[0].args).toEqual(
      expect.arrayContaining([
        '-c:v',
        'libx264',
        '-preset',
        'superfast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'main',
        '-level:v',
        '3.1',
        '-r',
        '30',
        '-b:v',
        '300k',
        '-payload_type',
        '99',
        '-ssrc',
        '1234',
        '-srtp_out_suite',
        'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params',
        Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(14, 2)]).toString('base64'),
        'srtp://192.0.2.10:50100?rtcpport=50100&pkt_size=1200',
      ]),
    );
    const extend = vi.fn();
    stream.emit('budget', { graceMs: 1_000, extend });
    expect(extend).toHaveBeenCalledOnce();
    prepared.stop();
    stream.emit('budget', { graceMs: 1_000, extend });
    expect(extend).toHaveBeenCalledOnce();
  });

  it('transcodes H.265 and resized H.264 to every negotiated video constraint after a keyframe', async () => {
    const cases = [
      { codec: 'h265' as const, width: 1920, height: 1080, inputFormat: 'hevc' },
      { codec: 'h264' as const, width: 1920, height: 1080, inputFormat: 'h264' },
    ];

    for (const candidate of cases) {
      const stream = new SyntheticLiveStream();
      const spawned: string[][] = [];
      const media = new FfmpegLiveMedia(
        '/synthetic/ffmpeg',
        undefined,
        (_executable, args) => {
          spawned.push([...args]);
          return process();
        },
        async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
      );
      const prepared = await media.prepare({
        addressVersion: 'ipv4',
        targetAddress: '192.0.2.10',
        video: {
          port: 50100,
          srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
          srtpKey: Buffer.alloc(16),
          srtpSalt: Buffer.alloc(14),
        },
      });
      await prepared.start(
        { live: async () => stream },
        {
          video: {
            width: 1280,
            height: 720,
            fps: 15,
            maxBitRate: 250,
            profile: 'high',
            level: '4.0',
            payloadType: 99,
            ssrc: 1234,
            mtu: 1200,
            rtcpInterval: 0.5,
          },
        },
      );

      stream.video({ ...candidate, keyframe: false, data: Buffer.from([0, 0, 1, 1]) });
      expect(spawned).toHaveLength(0);
      stream.video({ ...candidate, keyframe: true, data: Buffer.from([0, 0, 1, 0x65]) });

      expect(spawned[0]).toEqual(
        expect.arrayContaining([
          '-f',
          candidate.inputFormat,
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-level:v',
          '4.0',
          '-r',
          '15',
          '-g',
          '30',
          '-b:v',
          '250k',
          '-maxrate',
          '250k',
        ]),
      );
      expect(spawned[0]).toContain(
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      );
      prepared.stop();
    }
  });

  it('applies a reconfigured selection to adaptation while keeping the negotiated RTP identity', async () => {
    const stream = new SyntheticLiveStream();
    const spawned: string[][] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      undefined,
      (_executable, args) => {
        spawned.push([...args]);
        return process();
      },
      async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16, 5),
        srtpSalt: Buffer.alloc(14, 6),
      },
    });
    const video = {
      width: 1280,
      height: 720,
      fps: 30,
      maxBitRate: 300,
      profile: 'main' as const,
      level: '3.1' as const,
      payloadType: 99,
      ssrc: 1234,
      mtu: 1200,
      rtcpInterval: 0.5,
    };
    await prepared.start({ live: async () => stream }, { video });
    const keyframe = { codec: 'h264' as const, width: 1280, height: 720, keyframe: true, data: Buffer.from([0x65]) };
    stream.video(keyframe);

    prepared.reconfigure({ ...video, width: 640, height: 360, fps: 15, maxBitRate: 150 });
    stream.video({ ...keyframe, keyframe: false });
    expect(spawned).toHaveLength(1);
    stream.video(keyframe);

    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toContain(
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    );
    expect(spawned[1]).toContain('scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2');
    expect(spawned[1]).toEqual(expect.arrayContaining(['-r', '15', '-g', '30', '-b:v', '150k', '-maxrate', '150k']));
    expect(spawned[1]).toEqual(
      expect.arrayContaining([
        '-payload_type',
        '99',
        '-ssrc',
        '1234',
        '-srtp_out_params',
        Buffer.concat([Buffer.alloc(16, 5), Buffer.alloc(14, 6)]).toString('base64'),
        'srtp://192.0.2.10:50100?rtcpport=50100&pkt_size=1200',
      ]),
    );
    expect(stream.stop).not.toHaveBeenCalled();
    prepared.stop();
  });

  it('keeps the previous selection on the wire until a reconfigured one has a keyframe to start from', async () => {
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    expect(session.children).toHaveLength(1);
    const coding = vi.spyOn(session.children[0]!.stdin, 'write');

    session.prepared.reconfigure({ ...NEGOTIATED_VIDEO, width: 640, height: 360, maxBitRate: 132 });
    session.stream.video({ ...KEYFRAME, keyframe: false });

    expect(session.children).toHaveLength(1);
    expect(session.children[0]!.kill).not.toHaveBeenCalled();
    expect(coding).toHaveBeenCalledWith(KEYFRAME.data);

    session.stream.video(KEYFRAME);

    expect(session.children).toHaveLength(2);
    expect(session.children[0]!.kill).toHaveBeenCalled();
    expect(session.spawned[1]).toContain(
      'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
    );
    session.prepared.stop();
  });

  it('bounds a deferred reconfiguration even while the superseded selection keeps reporting progress', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);

    session.prepared.reconfigure({ ...NEGOTIATED_VIDEO, width: 640, height: 360, maxBitRate: 132 });
    for (let elapsed = 0; elapsed < 32_000; elapsed += 2_000) {
      session.receiverReport();
      session.children[0]!.stderr.push('progress=continue\n');
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'no-video-within-backstop', stage: 'first-adapted-output' },
    ]);
    vi.useRealTimers();
  });

  it('readapts a changed source codec at its next keyframe without changing negotiated output', async () => {
    const stream = new SyntheticLiveStream();
    const spawned: string[][] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      undefined,
      (_executable, args) => {
        spawned.push([...args]);
        return process();
      },
      async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
      },
    );
    stream.video({ codec: 'h264', width: 1920, height: 1080, keyframe: true, data: Buffer.from([0x65]) });
    stream.video({ codec: 'h265', width: 1920, height: 1080, keyframe: false, data: Buffer.from([0x02]) });
    expect(spawned).toHaveLength(1);
    stream.video({ codec: 'h265', width: 1920, height: 1080, keyframe: true, data: Buffer.from([0x26]) });
    stream.video({ codec: 'h265', width: 1280, height: 720, keyframe: true, data: Buffer.from([0x26]) });

    expect(spawned.map((args) => args[args.indexOf('-f') + 1])).toEqual(['h264', 'hevc', 'hevc']);
    for (const args of spawned) {
      expect(args).toContain('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
      expect(args).toEqual(expect.arrayContaining(['-r', '30', '-b:v', '300k', '-payload_type', '99']));
    }
    expect(stream.stop).not.toHaveBeenCalled();
    prepared.stop();
  });

  it('starts and retains video when source audio is absent or its separate process fails', async () => {
    const stream = new SyntheticLiveStream();
    const children: SyntheticProcess[] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      undefined,
      () => {
        const child = process();
        children.push(child);
        return child;
      },
      async () => ({ port: 41000 + children.length, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      audio: {
        port: 50101,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
        audio: {
          codec: 'AAC-eld',
          channels: 1,
          sampleRate: 16,
          maxBitRate: 24,
          payloadType: 110,
          ssrc: 5678,
        },
      },
    );

    stream.video({
      codec: 'h264',
      width: 1280,
      height: 720,
      keyframe: true,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
    });
    expect(children).toHaveLength(1);

    stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    expect(children).toHaveLength(2);
    children[1].emit('error', new Error('synthetic audio failure'));

    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(stream.stop).not.toHaveBeenCalled();
  });

  it('does not let a replaced audio process clear the process for a later source codec', async () => {
    const stream = new SyntheticLiveStream();
    const children: SyntheticProcess[] = [];
    const spawnedArgs: string[][] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      undefined,
      (_executable, args) => {
        const child = process();
        children.push(child);
        spawnedArgs.push([...args]);
        return child;
      },
      async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      audio: {
        port: 50101,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
        audio: {
          codec: 'AAC-eld',
          channels: 1,
          sampleRate: 16,
          maxBitRate: 24,
          payloadType: 110,
          ssrc: 5678,
        },
      },
    );
    stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    stream.audio({ codec: 'g711a', data: Buffer.from([1, 2, 3]) });
    expect(children).toHaveLength(2);
    expect(spawnedArgs[0]).toEqual(expect.arrayContaining(['-f', 'aac', '-c:a', 'libfdk_aac', 'aac_eld']));
    expect(spawnedArgs[1]).toEqual(expect.arrayContaining(['-f', 'alaw', '-c:a', 'libfdk_aac', 'aac_eld']));

    children[0].emit('exit', 0, null);
    stream.audio({ codec: 'g711a', data: Buffer.from([4, 5, 6]) });

    expect(children).toHaveLength(2);
    expect(children[1].kill).not.toHaveBeenCalled();
  });

  it('tells only a raw a-law input the sample rate assumption its format cannot carry', async () => {
    const session = await liveSession(undefined, { audio: AAC_ELD_16 });
    await session.start();

    session.stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    expect(inputOptions(session.spawned[0]!)).not.toContain('-ar');
    expect(inputOptions(session.spawned[0]!)).not.toContain('-ac');

    session.stream.audio({ codec: 'g711a', data: Buffer.from([1, 2, 3]) });
    expect(inputOptions(session.spawned[1]!)).toEqual(expect.arrayContaining(['-ar', '16k', '-ac', '1']));
    session.prepared.stop();
  });

  it('requests the global header AAC-ELD needs to leave the encoder at all', async () => {
    const session = await liveSession(undefined, {
      audio: { ...AAC_ELD_16, sampleRate: 24, maxBitRate: 32 },
    });
    await session.start();
    session.stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });

    expect(session.spawned[0]).toEqual(
      expect.arrayContaining([
        '-c:a',
        'libfdk_aac',
        '-profile:a',
        'aac_eld',
        '-flags',
        '+global_header',
        '-ar',
        '24k',
        '-ac',
        '1',
        '-b:a',
        '32k',
      ]),
    );
    session.prepared.stop();
  });

  it('bounds startup when a long GOP supplies no keyframe', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video({ ...KEYFRAME, keyframe: false, data: Buffer.from([0, 0, 0, 1, 0x41]) });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.children).toHaveLength(0);
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([
      { outcome: 'failed', reason: 'no-video-within-backstop', stage: 'first-source-keyframe' },
    ]);
    vi.useRealTimers();
  });

  it('bounds stalled source acquisition and no-RTCP sessions', async () => {
    vi.useFakeTimers();
    const stalled = await liveSession({ live: () => new Promise<LiveStreamHandle>(() => undefined) });
    const start = expect(stalled.start()).rejects.toThrow('source acquisition timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await start;

    expect(stalled.onVideoFailure).toHaveBeenCalledOnce();
    expect(stalled.outcomes).toEqual([
      { outcome: 'failed', reason: 'source-acquisition-timeout', stage: 'sdk-source-acquisition' },
    ]);

    const noRtcp = await liveSession();
    await noRtcp.start();
    noRtcp.stream.video(KEYFRAME);
    noRtcp.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(noRtcp.onVideoFailure).toHaveBeenCalledOnce();
    expect(noRtcp.stream.stop).toHaveBeenCalledOnce();
    expect(noRtcp.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'rtcp-timeout', stage: 'controller-rtcp' },
    ]);
    vi.useRealTimers();
  });

  it('restarts the keyframe deadline after an acknowledged reconfiguration', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('prog');
    session.children[0]!.stderr.push('ress=continue\n');
    await vi.advanceTimersByTimeAsync(0);

    session.prepared.reconfigure({ ...NEGOTIATED_VIDEO, width: 640, height: 360 });
    for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
      session.receiverReport();
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'no-video-within-backstop', stage: 'first-adapted-output' },
    ]);
    vi.useRealTimers();
  });
});

describe('isolated return-audio adaptation', () => {
  it('binds the advertised return-audio endpoint before acknowledging stream start', async () => {
    let releaseAudio!: () => void;
    const audioReleased = new Promise<void>((resolve) => (releaseAudio = resolve));
    let reservations = 0;
    const returned: SyntheticReturnAudioProcess[] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      undefined,
      () => process(),
      async () => {
        const audio = reservations++ === 1;
        return {
          port: audio ? 41001 : 41000,
          onMessage: vi.fn(),
          close: vi.fn(() => (audio ? audioReleased : undefined)),
        };
      },
      () => {
        const child = returnAudioProcess();
        returned.push(child);
        return child;
      },
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      audio: {
        port: 50101,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    let started = false;
    const start = prepared
      .start(
        { live: async () => new SyntheticLiveStream(), talkback: async () => new SyntheticTalkback() },
        { video: NEGOTIATED_VIDEO, audio: AAC_ELD_16 },
      )
      .then(() => (started = true));
    await settle();

    expect(started).toBe(false);
    expect(returned).toHaveLength(0);

    releaseAudio();
    await settle();
    expect(returned).toHaveLength(1);
    expect(started).toBe(false);
    await start;
    expect(started).toBe(true);
    prepared.stop();
  });

  it('transcodes HomeKit return audio to 16 kHz mono AAC-LC ADTS before opening one SDK handle', async () => {
    const handle = new SyntheticTalkback();
    const talkback = vi.fn(async () => handle);
    const session = await talkbackSession(talkback);

    expect(session.ports[1]!.close).toHaveBeenCalledOnce();
    expect(session.returned).toHaveLength(1);
    expect(session.returnedArgs[0]).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'pipe,udp,rtp,crypto',
        '-f',
        'sdp',
        '-c:a',
        'libfdk_aac',
        '-profile:a',
        'aac_low',
        '-ar',
        '16k',
        '-ac',
        '1',
        '-b:a',
        '32k',
        '-f',
        'adts',
        'pipe:1',
      ]),
    );
    expect(inputOptions(session.returnedArgs[0]!)).toEqual(
      expect.arrayContaining(['-protocol_whitelist', 'pipe,udp,rtp,crypto', '-f', 'sdp', '-c:a', 'libfdk_aac']),
    );
    const sdp = Buffer.concat(session.returned[0]!.input).toString();
    expect(sdp).toContain('m=audio 41001 RTP/AVP 110');
    expect(sdp).toContain('a=rtpmap:110 MPEG4-GENERIC/16000/1');
    expect(sdp).toContain('sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00');
    expect(sdp).toContain('a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:');
    expect(talkback).not.toHaveBeenCalled();

    const first = Buffer.from([0xff, 0xf1, 0x60]);
    const second = Buffer.from([0x40, 0x03, 0xff, 0xfc]);
    session.returned[0]!.stdout.write(first);
    await settle();
    session.returned[0]!.stdout.write(second);
    await settle();

    expect(talkback).toHaveBeenCalledOnce();
    expect(Buffer.concat(handle.written)).toEqual(Buffer.concat([first, second]));
    expect(session.talkbackOutcomes).toEqual([{ outcome: 'talking' }]);
    session.prepared.stop();
    await settle();
    expect(handle.stop).toHaveBeenCalledOnce();
  });

  it('extends a source budget only while HomeKit return audio is being consumed', async () => {
    const handle = new SyntheticTalkback();
    const session = await talkbackSession(async () => handle);
    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();

    const extend = vi.fn();
    handle.budget({ graceMs: 10_000, extend });
    expect(extend).toHaveBeenCalledOnce();

    session.prepared.stop();
    await settle();
    handle.budget({ graceMs: 10_000, extend });
    expect(extend).toHaveBeenCalledOnce();
  });

  it('cleans a device-audio failure without stopping outbound video or audio', async () => {
    const handle = new SyntheticTalkback();
    const session = await talkbackSession(async () => handle);
    session.stream.video(KEYFRAME);
    session.stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();

    handle.fail();
    await settle();

    expect(handle.stop).toHaveBeenCalledOnce();
    expect(session.returned[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.children).toHaveLength(2);
    expect(session.children.every((child) => !vi.mocked(child.kill).mock.calls.length)).toBe(true);
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.talkbackOutcomes).toEqual([
      { outcome: 'talking' },
      { outcome: 'failed', reason: 'device-audio-failed' },
    ]);
  });

  it('reports an SDK-stopped talkback path while outbound media continues', async () => {
    const handle = new SyntheticTalkback();
    const session = await talkbackSession(async () => handle);
    session.stream.video(KEYFRAME);
    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();

    handle.emit('stop');
    await settle();

    expect(session.returned[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.children[0]!.kill).not.toHaveBeenCalled();
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.talkbackOutcomes).toEqual([
      { outcome: 'talking' },
      { outcome: 'failed', reason: 'device-audio-failed' },
    ]);
  });

  it('reports return-audio adaptation failure without coupling it to outbound media', async () => {
    const handle = new SyntheticTalkback();
    const talkback = vi.fn(async () => handle);
    const session = await talkbackSession(talkback);
    session.stream.video(KEYFRAME);

    session.returned[0]!.emit('error', new Error('synthetic return adaptation failure'));
    await settle();

    expect(talkback).not.toHaveBeenCalled();
    expect(session.returned[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.children[0]!.kill).not.toHaveBeenCalled();
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.talkbackOutcomes).toEqual([{ outcome: 'failed', reason: 'adaptation-failed' }]);
    expect(
      session.notices,
      'return audio fails only talkback, so without a report of its own its stderr has no account anywhere',
    ).toEqual([{ role: 'return-audio', event: 'spawn-failed' }]);
  });

  it('contains a synchronous SDK talkback acquisition failure inside return audio', async () => {
    const session = await talkbackSession(() => {
      throw new Error('synthetic synchronous talkback failure');
    });
    session.stream.video(KEYFRAME);

    expect(() => session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]))).not.toThrow();
    await settle();

    expect(session.returned[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.children[0]!.kill).not.toHaveBeenCalled();
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.talkbackOutcomes).toEqual([{ outcome: 'failed', reason: 'source-unavailable' }]);
  });

  it('cleans a handle whose writable return-audio seam cannot be opened', async () => {
    const handle = new SyntheticTalkback();
    vi.spyOn(handle, 'writable').mockImplementation(() => {
      throw new Error('synthetic writable failure');
    });
    const session = await talkbackSession(async () => handle);

    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();

    expect(handle.stop).toHaveBeenCalledOnce();
    expect(session.returned[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.talkbackOutcomes).toEqual([{ outcome: 'failed', reason: 'device-audio-failed' }]);
  });

  it('does not report recovery when the SDK rejects the first return-audio write synchronously', async () => {
    const handle = new SyntheticTalkback();
    vi.spyOn(handle.sink, 'write').mockImplementation(() => {
      handle.emit('error', new Error('synthetic frame rejection'));
      return true;
    });
    const session = await talkbackSession(async () => handle);

    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();

    expect(handle.stop).toHaveBeenCalledOnce();
    expect(session.talkbackOutcomes).toEqual([{ outcome: 'failed', reason: 'device-audio-failed' }]);
  });

  it('stops a talkback handle that resolves after HomeKit cancelled the session', async () => {
    let resolveTalkback!: (handle: TalkbackHandle) => void;
    const talkback = vi.fn(() => new Promise<TalkbackHandle>((resolve) => (resolveTalkback = resolve)));
    const session = await talkbackSession(talkback);
    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();
    expect(talkback).toHaveBeenCalledOnce();

    session.prepared.stop();
    const late = new SyntheticTalkback();
    resolveTalkback(late);
    await settle();

    expect(late.stop).toHaveBeenCalledOnce();
    expect(late.written).toEqual([]);
  });

  it('finishes whole-session cleanup when the SDK handle throws synchronously on stop', async () => {
    const handle = new SyntheticTalkback();
    handle.stop.mockImplementation(() => {
      throw new Error('synthetic synchronous stop failure');
    });
    const session = await talkbackSession(async () => handle);
    session.stream.video(KEYFRAME);
    session.returned[0]!.stdout.write(Buffer.from([0xff, 0xf1, 1]));
    await settle();

    expect(() => session.prepared.stop()).not.toThrow();
    expect(session.children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.ports.every(({ close }) => close.mock.calls.length > 0)).toBe(true);
  });
});

describe('adaptation binary identity', () => {
  /**
   * A bundled static build and a distribution build on the same host advertise different encoder sets, so
   * without the binary's own banner an adaptation failure can be attributed to FFmpeg in general and no
   * further. A path that names nothing runnable answers with no banner at all, and that absence is what
   * distinguishes a missing or wrong configured path from an encoder the resolved build does not have.
   */
  it('reports the resolved path, which build it is, and the binary\u2019s own banner', async () => {
    const probe = vi.fn(async () => 'ffmpeg version 8.0 Copyright (c) 2000-2026 the FFmpeg developers');

    await expect(resolveFfmpegIdentity('/synthetic/bin/ffmpeg', 'configured', probe)).resolves.toEqual({
      path: '/synthetic/bin/ffmpeg',
      source: 'configured',
      version: 'ffmpeg version 8.0 Copyright (c) 2000-2026 the FFmpeg developers',
    });
    expect(probe).toHaveBeenCalledWith('/synthetic/bin/ffmpeg');
  });

  it('reports a binary that did not answer without inventing a version for it', async () => {
    await expect(resolveFfmpegIdentity('/synthetic/absent', 'bundled', async () => undefined)).resolves.toEqual({
      path: '/synthetic/absent',
      source: 'bundled',
    });
    await expect(
      resolveFfmpegIdentity('/synthetic/absent', 'configured', async () => {
        throw new Error('spawn /synthetic/absent ENOENT');
      }),
      'a probe that throws is a binary that cannot be asked to encode, which is the same answer',
    ).resolves.toEqual({ path: '/synthetic/absent', source: 'configured' });
  });

  it('reads the real banner off the bundled binary rather than trusting its path', async () => {
    const bundled = await resolveFfmpegIdentity(bundledFfmpegPath!, 'bundled');
    const absent = await resolveFfmpegIdentity(`${bundledFfmpegPath!}-synthetic-absent`, 'configured');

    expect(bundled.version, 'the default probe runs the binary, so this is the build that would encode').toMatch(
      /^ffmpeg version /,
    );
    expect(
      absent.version,
      'a path naming nothing runnable answers nothing, which is what tells it from a missing encoder',
    ).toBeUndefined();
  });
});
