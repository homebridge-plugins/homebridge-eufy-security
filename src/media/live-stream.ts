import type { LiveAudioFrame, LiveStreamConsumer, LiveVideoConfig, LiveVideoFrame, TalkbackHandle } from '@mega-yfue/eufy-sdk';
import { LiveStreamStartError } from '@mega-yfue/eufy-sdk';
import { createSocket } from 'node:dgram';
import { execFile, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type {
  AdaptationDiagnostics,
  AdaptationEvent,
  AdaptationRole,
  LiveMediaAdapter,
  LiveMediaSource,
  LiveMediaTarget,
  LiveMediaTransport,
  LiveSessionFailure,
  LiveSessionOutcome,
  NegotiatedLiveAudio,
  NegotiatedLiveMedia,
  NegotiatedLiveVideo,
  PreparedLiveMedia,
  TalkbackFailure,
} from './contracts.js';

/** How long a deliberately stopped adaptation process is given to exit before it is killed. */
export const PROCESS_STOP_GRACE_MS = 2_000;

/**
 * Whether an adaptation opened for `running` can code what the source announced as `announced`.
 *
 * Only the codec decides it. An adaptation's input format is fixed at spawn, so an H.265 access unit fed to
 * a process opened for H.264 does not parse; a changed geometry is absorbed, because the decoder
 * reinitialises on the new parameter sets and the scale filter follows it. Measured through this plugin's
 * bundled FFmpeg on its own argument list: 60 of 60 frames across 1280x720 to 640x360, 60 of 60 in reverse,
 * 90 of 90 across 640 to 1280 to 640, no warnings; and a codec change decoding only the frames before it.
 *
 * The geometry never reached the argument list either — the output geometry is HomeKit's selection — so
 * rebuilding on it spawned a byte-identical command, discarded the frames in flight, and waited for the
 * next keyframe. A camera ramps its ladder during the first seconds of a session, four rungs inside 3.9 s
 * on a mains-powered camera measured on the fleet, so all of that was paid before any video reached the
 * controller.
 */
function canCode(running: LiveVideoConfig, announced: LiveVideoConfig): boolean {
  return running.codec === announced.codec;
}

const INITIAL_RTCP_GRACE_MS = 15_000;
const SOURCE_ACQUISITION_DEADLINE_MS = 10_000;
const RETURN_AUDIO_BIND_GRACE_MS = 250;
/**
 * Backstop for a started media session that never produces adapted output. The SDK source owns the
 * warm-up window, retries the start inside it, and fails its consumers with a typed `error` event, which
 * is the primary failure signal for both live and recording sessions; that window is an SDK-internal
 * default the plugin cannot read, so this bound sits strictly above it and only catches an SDK that
 * reports nothing at all.
 */
export const SOURCE_START_BACKSTOP_MS = 30_000;
const SOURCE_ACQUISITION_TIMEOUT = Symbol('source-acquisition-timeout');

/**
 * The bounded reason one SDK source failure reports.
 *
 * The SDK stages a start that produced no keyframe by what the source delivered, and a start that carried
 * audio and never a single video frame is the one signature worth naming apart: measured on a real camera
 * that had been switched off, the source accepted the start, delivered audio for the whole warm-up window,
 * and reported `audio-only`. Every other stage is a source error, because nothing else distinguishes it
 * from a transport that failed.
 */
function sourceFailure(error: unknown): LiveSessionFailure {
  return error instanceof LiveStreamStartError && error.stage === 'audio-only' ? 'source-audio-only' : 'source-error';
}

/** One adaptation process, in the terms every adapted media session controls it by. */
export interface MediaProcess {
  readonly stdin: Writable;
  readonly stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** How many diagnostic lines one adaptation retains, which is what a failure is attributed from. */
const ADAPTATION_STDERR_TAIL_LINES = 8;
/** The longest partial line held while waiting for its terminator, so a silent process cannot grow one. */
const ADAPTATION_STDERR_PARTIAL_BYTES = 512;

/**
 * Splits one adaptation process's stderr into whole lines and retains a bounded tail of the diagnostic
 * ones.
 *
 * Both consumers of that pipe read it: `-progress pipe:2` writes the key/value block that says adaptation
 * reached its output, and everything else on it is the only account of why a process refused or stopped.
 * Progress lines are excluded from the tail because they are emitted on a timer and would otherwise be the
 * whole of it by the time anything went wrong.
 */
export class AdaptationStderr {
  private partial = '';
  private readonly retained: string[] = [];

  /** Consumes one chunk and returns the lines it completed, in the order they were written. */
  observe(chunk: Buffer): readonly string[] {
    const lines = `${this.partial}${chunk.toString()}`.split(/\r?\n/);
    this.partial = lines.pop()?.slice(-ADAPTATION_STDERR_PARTIAL_BYTES) ?? '';
    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('progress=')) {
        continue;
      }
      this.retained.push(line);
      if (this.retained.length > ADAPTATION_STDERR_TAIL_LINES) {
        this.retained.shift();
      }
    }
    return lines;
  }

  /** The retained diagnostic tail, oldest first. */
  tail(): readonly string[] {
    return [...this.retained];
  }
}

/**
 * Which FFmpeg an adaptation will run, so a failure can be attributed to a build rather than to FFmpeg in
 * general.
 *
 * `version` is the binary's own banner and is absent when it did not answer at all, which is what a path
 * naming nothing runnable looks like. That distinction is the whole point of resolving it before any media
 * exists: a bundled static build and a distribution build on the same host have completely different
 * encoder sets, and neither can be inferred from the host facts alone.
 */
export interface FfmpegIdentity {
  readonly path: string;
  readonly source: 'bundled' | 'configured';
  readonly version?: string;
}

/** How the version banner is read: the executable's own answer, or nothing where it did not give one. */
export type FfmpegVersionProbe = (path: string) => Promise<string | undefined>;

/** How long the version probe is allowed to take before the binary counts as not having answered. */
const FFMPEG_VERSION_PROBE_TIMEOUT_MS = 5_000;
/** How much of the banner is kept: enough for the build and version, and no more. */
const FFMPEG_VERSION_BANNER_LENGTH = 120;

/**
 * Runs `-version` on one path and returns its first banner line, or nothing where it produced none.
 *
 * Every failure answers the same way, because none of them can be told apart by a caller that only needs
 * to know whether this binary can be asked to encode: a missing file, a file that is not executable, one
 * that is not FFmpeg, and one that hangs all mean the same thing to the media that would have used it.
 */
const probeFfmpegVersion: FfmpegVersionProbe = (path) =>
  new Promise((resolve) => {
    execFile(
      path,
      ['-hide_banner', '-version'],
      { timeout: FFMPEG_VERSION_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        const banner = error ? undefined : stdout.split(/\r?\n/, 1)[0]?.trim().slice(0, FFMPEG_VERSION_BANNER_LENGTH);
        resolve(banner === undefined || banner === '' ? undefined : banner);
      },
    );
  });

/**
 * Resolves the complete identity of one adaptation binary, without opening any media.
 *
 * Reading the banner spawns the binary, so this is asked once at launch and its answer is not waited on: a
 * support archive is worth one process at startup, and no camera is worth delaying for one.
 */
export async function resolveFfmpegIdentity(
  path: string,
  source: 'bundled' | 'configured',
  probe: FfmpegVersionProbe = probeFfmpegVersion,
): Promise<FfmpegIdentity> {
  const version = await probe(path).catch(() => undefined);
  return { path, source, ...(version === undefined ? {} : { version }) };
}

export interface ReservedMediaPort {
  readonly port: number;
  onMessage(listener: () => void): void;
  close(): void | Promise<void>;
}

export type LiveMediaProcessFactory = (executable: string, args: readonly string[]) => MediaProcess;
export interface ReturnAudioProcess extends MediaProcess {
  readonly stdout: Readable;
}
export type ReturnAudioProcessFactory = (executable: string, args: readonly string[]) => ReturnAudioProcess;
export type MediaPortFactory = (addressVersion: 'ipv4' | 'ipv6') => Promise<ReservedMediaPort>;

/** Adapts separate SDK elementary streams into independently failing HomeKit SRTP outputs. */
export class FfmpegLiveMedia implements LiveMediaAdapter {
  constructor(
    private readonly executable: string,
    private readonly adaptationDiagnostics?: AdaptationDiagnostics,
    private readonly createProcess: LiveMediaProcessFactory = spawnLiveMediaProcess,
    private readonly reservePort: MediaPortFactory = reserveMediaPort,
    private readonly createReturnAudioProcess: ReturnAudioProcessFactory = spawnReturnAudioProcess,
  ) {}

  /**
   * Reserves the negotiated output ports so `SetupEndpoints` can be answered with them, and returns a
   * session that holds nothing else: no SDK handle, adaptation process, or device session exists until
   * `start`. The reservation therefore lives for as long as its HomeKit consumer keeps the session, and
   * `stop` releases every reservation exactly once however the session ended.
   */
  async prepare(transport: LiveMediaTransport): Promise<PreparedLiveMedia> {
    const videoPort = await this.reservePort(transport.addressVersion);
    const targetAddress = transport.addressVersion === 'ipv6' ? `[${transport.targetAddress}]` : transport.targetAddress;
    let audioPort: ReservedMediaPort | undefined;
    try {
      audioPort = transport.audio ? await this.reservePort(transport.addressVersion) : undefined;
    } catch (error) {
      videoPort.close();
      throw error;
    }

    let source: LiveStreamConsumer | undefined;
    let videoProcess: MediaProcess | undefined;
    let audioProcess: MediaProcess | undefined;
    let returnAudioProcess: ReturnAudioProcess | undefined;
    let talkbackHandle: TalkbackHandle | undefined;
    let talkbackSink: Writable | undefined;
    let talkbackStarting = false;
    let talkbackEnded = false;
    let negotiated: NegotiatedLiveMedia | undefined;
    let stopped = false;
    let receivedVideoKeyframe = false;
    let reconfigurationPending = false;
    /**
     * The coded configuration the source last announced, and the one the running adaptation was opened for.
     *
     * Both, rather than a flag, because only a difference between them is a reason to replace an adaptation:
     * announcements arrive before the first keyframe has opened one, and a configuration that moves away and
     * back leaves the running adaptation still able to code what follows. What counts as a difference is
     * {@link canCode}.
     */
    let videoConfig: LiveVideoConfig | undefined;
    let adaptationConfig: LiveVideoConfig | undefined;
    let audioInputCodec: LiveAudioFrame['codec'] | undefined;
    let rtcpDeadline: ReturnType<typeof setTimeout> | undefined;
    let initialRtcpGrace: ReturnType<typeof setTimeout> | undefined;
    let videoStartBackstop: ReturnType<typeof setTimeout> | undefined;
    let videoFailed = false;
    let rtcpObserved = false;
    let streaming = false;
    const stoppingProcesses = new WeakSet<object>();
    const congested = new Set<Writable>();
    const { adaptationDiagnostics } = this;

    /**
     * Releases one adaptation input's claim on the source, whether it drained or stopped existing.
     *
     * An adaptation that is replaced or exits while full never emits the `drain` its claim is waiting for, so
     * discharging the claim is part of ending the process rather than something only a successful drain does:
     * otherwise one stalled process that a geometry change already replaced would hold the source for the
     * rest of the session. It is idempotent and claimed from both directions — the process ending, and its
     * input closing — because an adaptation can stop either way and neither alone covers both.
     */
    const releaseAdaptation = (sink: Writable): void => {
      if (congested.delete(sink) && !stopped && congested.size === 0) {
        source?.resume();
      }
    };

    /**
     * Writes one media payload to an adaptation, holding the SDK source while that input stays full.
     *
     * A discarded write result relocates a keyframe-aware bounded queue in the SDK into a byte-blind pipe
     * buffer, which then grows in plugin heap for the life of the session and stalls the event loop with it.
     * Holding the source instead arms the SDK's own drop-to-keyframe policy, so a session that cannot keep up
     * resynchronises on decodable media rather than replaying a stale backlog.
     *
     * One source feeds both adaptations, so it is held while *any* of them is full and released only once
     * every one has drained. That keeps a single source of truth for backpressure on this path: no queue,
     * threshold, or drop rule is invented here.
     */
    const writeToAdaptation = (sink: Writable, data: Buffer): void => {
      if (sink.write(data) || congested.has(sink)) {
        return;
      }
      congested.add(sink);
      if (congested.size === 1) {
        source?.pause();
      }
      sink.once('drain', () => releaseAdaptation(sink));
    };

    /**
     * Reports what one adaptation process did, whether or not the session it belonged to fails for it.
     *
     * An audio adaptation is restarted rather than failed and a return-audio one fails only talkback, so
     * without a report of their own those two exit with no account anywhere of why they stopped. An `output`
     * report carries nothing but the tail, so it is made only when the process actually wrote something:
     * a silent process that ended as intended has nothing to attribute.
     */
    const reportAdaptation = (
      role: AdaptationRole,
      event: AdaptationEvent,
      stderr: AdaptationStderr,
      code?: number | null,
      signal?: NodeJS.Signals | null,
    ): void => {
      const tail = stderr.tail();
      if (event === 'output' && tail.length === 0) {
        return;
      }
      adaptationDiagnostics?.report({
        role,
        event,
        ...(typeof code === 'number' ? { code } : {}),
        ...(typeof signal === 'string' ? { signal } : {}),
        ...(tail.length ? { stderr: tail } : {}),
      });
    };

    const stopProcess = (process: MediaProcess | undefined): void => {
      if (!process) {
        return;
      }
      stoppingProcesses.add(process);
      process.stdin.destroy();
      releaseAdaptation(process.stdin);
      process.kill('SIGTERM');
      const killDeadline = setTimeout(() => process.kill('SIGKILL'), PROCESS_STOP_GRACE_MS);
      killDeadline.unref?.();
      process.on('exit', () => clearTimeout(killDeadline));
    };
    /** Stop a caller-owned SDK handle without allowing synchronous or asynchronous faults to abort cleanup. */
    const stopTalkbackHandle = (handle: TalkbackHandle): void => {
      try {
        void handle.stop().catch(() => undefined);
      } catch {}
    };
    const stopTalkback = (stopHandle = true): void => {
      if (talkbackEnded) {
        return;
      }
      talkbackEnded = true;
      stopProcess(returnAudioProcess);
      returnAudioProcess = undefined;
      talkbackSink?.destroy();
      talkbackSink = undefined;
      const handle = talkbackHandle;
      talkbackHandle = undefined;
      if (stopHandle && handle) {
        stopTalkbackHandle(handle);
      }
    };
    const failTalkback = (reason: TalkbackFailure): void => {
      if (stopped || talkbackEnded) {
        return;
      }
      transport.onTalkbackOutcome?.({ outcome: 'failed', reason });
      stopTalkback();
    };
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimeout(rtcpDeadline);
      clearTimeout(initialRtcpGrace);
      clearTimeout(videoStartBackstop);
      stopTalkback();
      stopProcess(videoProcess);
      stopProcess(audioProcess);
      if (source) {
        source.stop();
        transport.onSessionReleased?.();
      }
      videoPort.close();
      audioPort?.close();
    };
    const failVideo = (reason: LiveSessionFailure): void => {
      if (stopped || videoFailed) {
        return;
      }
      videoFailed = true;
      stop();
      const stage =
        reason === 'source-acquisition-timeout' || source === undefined
          ? 'sdk-source-acquisition'
          : reason === 'rtcp-timeout'
            ? 'controller-rtcp'
            : !receivedVideoKeyframe
              ? 'first-source-keyframe'
              : 'first-adapted-output';
      transport.onSessionOutcome?.({ outcome: 'failed', reason, stage });
      transport.onVideoFailure?.();
    };
    /**
     * RTCP liveness bounds a session that is already sending media. Before adaptation reaches the
     * negotiated output the start backstop owns the bound, so an early datagram only records that the
     * controller is present; arming the recurring deadline here would fail a source that legitimately
     * warms for longer than one RTCP interval.
     */
    const resetRtcpDeadline = (): void => {
      rtcpObserved = true;
      clearTimeout(initialRtcpGrace);
      clearTimeout(rtcpDeadline);
      if (!streaming) {
        return;
      }
      const interval = Math.max(negotiated?.video.rtcpInterval ?? 1, 1) * 5_000;
      rtcpDeadline = setTimeout(() => failVideo('rtcp-timeout'), interval);
      rtcpDeadline.unref?.();
    };
    videoPort.onMessage(resetRtcpDeadline);
    /**
     * Adaptation reached the negotiated output, so the session is bounded from here by RTCP liveness
     * rather than by the start backstop. The initial grace is armed from this point because media may
     * legitimately start well after the session does.
     *
     * A selection HomeKit has already replaced does not discharge the deadline for its replacement, however
     * much it keeps reporting: FFmpeg reports progress on a timer whether or not new media reaches it, so
     * only the adaptation that carries the current selection can say that selection is being served.
     */
    const observeAdaptationProgress = (reporter: MediaProcess): void => {
      if (stopped || (reconfigurationPending && reporter === videoProcess)) {
        return;
      }
      clearTimeout(videoStartBackstop);
      videoStartBackstop = undefined;
      if (streaming) {
        return;
      }
      streaming = true;
      if (rtcpObserved) {
        resetRtcpDeadline();
      } else {
        initialRtcpGrace = setTimeout(() => failVideo('rtcp-timeout'), INITIAL_RTCP_GRACE_MS);
        initialRtcpGrace.unref?.();
      }
      transport.onSessionOutcome?.({ outcome: 'streaming' });
    };

    /**
     * Records the coded configuration the source is about to deliver. Nothing is replaced here: a replacement
     * can only start on a keyframe, and this arrives ahead of the frame carrying the new configuration.
     */
    const observeVideoConfig = (config: LiveVideoConfig): void => {
      videoConfig = config;
    };

    /**
     * Writes one source access unit to the adaptation that is entitled to code it.
     *
     * A source configuration the running adaptation was not opened for cannot be coded by it at all, so those
     * frames wait for the keyframe that lets a replacement start. A reconfigured HomeKit selection changes
     * only the output, so the current process keeps coding and keeps the previous selection on the wire until
     * that same keyframe arrives; a controller reconfigures precisely when it is unhappy with what it
     * receives, and the source is then often the very thing not producing keyframes.
     */
    const writeVideo = (frame: LiveVideoFrame): void => {
      if (stopped || !negotiated || !videoConfig) {
        return;
      }
      if (!receivedVideoKeyframe) {
        if (!frame.keyframe) {
          return;
        }
        receivedVideoKeyframe = true;
      }
      const inputChanged = adaptationConfig !== undefined && !canCode(adaptationConfig, videoConfig);
      if (videoProcess && inputChanged && !frame.keyframe) {
        return;
      }
      if (videoProcess && frame.keyframe && (inputChanged || reconfigurationPending)) {
        reconfigurationPending = false;
        stopProcess(videoProcess);
        videoProcess = undefined;
      }
      if (!videoProcess) {
        adaptationConfig = videoConfig;
        const child = this.createProcess(
          this.executable,
          videoArguments(videoConfig, negotiated.video, targetAddress, transport.video),
        );
        videoProcess = child;
        const stderr = new AdaptationStderr();
        let producedOutput = false;
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.observe(chunk).some((line) => line.startsWith('progress='))) {
            producedOutput = true;
            observeAdaptationProgress(child);
          }
        });
        child.stdin.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            failVideo('adaptation-failed');
          }
        });
        child.stdin.on('close', () => releaseAdaptation(child.stdin));
        child.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            reportAdaptation('live-video', producedOutput ? 'exited-while-streaming' : 'spawn-failed', stderr);
            failVideo(producedOutput ? 'adaptation-exited-while-streaming' : 'adaptation-spawn-failed');
          }
        });
        child.on('exit', (code, signal) => {
          if (stopped || stoppingProcesses.has(child)) {
            reportAdaptation('live-video', 'output', stderr, code, signal);
            return;
          }
          reportAdaptation(
            'live-video',
            producedOutput ? 'exited-while-streaming' : 'exited-before-output',
            stderr,
            code,
            signal,
          );
          failVideo(producedOutput ? 'adaptation-exited-while-streaming' : 'adaptation-exited-before-output');
        });
      }
      writeToAdaptation(videoProcess.stdin, frame.data);
    };

    const writeAudio = (frame: LiveAudioFrame): void => {
      if (stopped || !negotiated?.audio || !transport.audio || !audioPort) {
        return;
      }
      if (!audioProcess) {
        audioInputCodec = frame.codec;
        const child = this.createProcess(
          this.executable,
          audioArguments(frame, negotiated.audio, targetAddress, transport.audio),
        );
        audioProcess = child;
        const stderr = new AdaptationStderr();
        let producedOutput = false;
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.observe(chunk).some((line) => line.startsWith('progress='))) {
            producedOutput = true;
          }
        });
        /**
         * An audio adaptation is dropped rather than failed, so its own end has to discharge whatever claim
         * it held on the source. Nothing else would if its input outlives it: the `drain` a full input is
         * waiting for never arrives, and the video beside it would starve.
         */
        const clearChild = (): void => {
          releaseAdaptation(child.stdin);
          if (audioProcess === child) {
            audioProcess = undefined;
          }
        };
        child.stdin.on('close', () => releaseAdaptation(child.stdin));
        child.stdin.on('error', () => {
          stopProcess(child);
          clearChild();
        });
        child.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            reportAdaptation('live-audio', producedOutput ? 'exited-while-streaming' : 'spawn-failed', stderr);
          }
          stopProcess(child);
          clearChild();
        });
        child.on('exit', (code, signal) => {
          reportAdaptation(
            'live-audio',
            stopped || stoppingProcesses.has(child)
              ? 'output'
              : producedOutput
                ? 'exited-while-streaming'
                : 'exited-before-output',
            stderr,
            code,
            signal,
          );
          clearChild();
        });
      }
      if (audioInputCodec !== frame.codec) {
        stopProcess(audioProcess);
        audioProcess = undefined;
        audioInputCodec = undefined;
        writeAudio(frame);
        return;
      }
      writeToAdaptation(audioProcess.stdin, frame.data);
    };

    /**
     * Write one decoded return-audio chunk through the SDK writable that owns ADTS frame recovery,
     * validation, pacing, and transport backpressure. The first chunk opens exactly one SDK handle;
     * stdout stays paused while that handle is acquired so acquisition cannot create an unbounded queue.
     */
    const writeReturnAudio = (camera: LiveMediaSource, child: ReturnAudioProcess, chunk: Buffer): void => {
      if (stopped || talkbackEnded) {
        return;
      }
      if (talkbackSink) {
        try {
          if (!talkbackSink.write(chunk)) {
            child.stdout.pause();
            talkbackSink.once('drain', () => {
              if (!stopped && !talkbackEnded) {
                child.stdout.resume();
              }
            });
          }
        } catch {
          failTalkback('device-audio-failed');
        }
        return;
      }
      if (talkbackStarting || !camera.talkback) {
        return;
      }
      talkbackStarting = true;
      child.stdout.pause();
      let acquisition: Promise<TalkbackHandle>;
      try {
        acquisition = camera.talkback();
      } catch {
        failTalkback('source-unavailable');
        return;
      }
      void acquisition.then(
        (handle) => {
          if (stopped || talkbackEnded) {
            stopTalkbackHandle(handle);
            return;
          }
          talkbackHandle = handle;
          try {
            const sink = handle.writable();
            talkbackSink = sink;
            handle.on('budget', (notice) => {
              if (!stopped && !talkbackEnded) {
                notice.extend();
              }
            });
            handle.on('error', () => failTalkback('device-audio-failed'));
          handle.on('stop', () => {
            if (!stopped && !talkbackEnded && talkbackHandle === handle) {
              failTalkback('device-audio-failed');
            }
          });
            sink.on('error', () => failTalkback('device-audio-failed'));
            const accepted = sink.write(chunk);
            if (talkbackEnded) {
              return;
            }
            transport.onTalkbackOutcome?.({ outcome: 'talking' });
            if (accepted) {
              child.stdout.resume();
            } else {
              sink.once('drain', () => {
                if (!stopped && !talkbackEnded) {
                  child.stdout.resume();
                }
              });
            }
          } catch {
            failTalkback('device-audio-failed');
          }
        },
        () => failTalkback('source-unavailable'),
      );
    };

    /**
     * Hand the accessory audio endpoint to FFmpeg and give the spawned process a bounded bind grace before
     * stream start is acknowledged. FFmpeg owns SRTP authentication, RTP AAC-ELD depacketization, decoding,
     * and AAC-LC ADTS encoding; the SDK handle remains unopened until the process produces decoded audio.
     */
    const startReturnAudio = async (camera: LiveMediaSource, selection: NegotiatedLiveAudio | undefined): Promise<void> => {
      if (!camera.talkback || !selection || !transport.audio || !audioPort) {
        return;
      }
      if (selection.sampleRate !== 16 || selection.channels !== 1) {
        failTalkback('unsupported-selection');
        return;
      }
      try {
        await audioPort.close();
        if (stopped || talkbackEnded) {
          return;
        }
        const child = this.createReturnAudioProcess(this.executable, returnAudioArguments());
        returnAudioProcess = child;
        const stderr = new AdaptationStderr();
        let producedOutput = false;
        child.stderr.on('data', (chunk: Buffer) => stderr.observe(chunk));
        child.stdin.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            failTalkback('adaptation-failed');
          }
        });
        child.stdout.on('data', (chunk: Buffer) => {
          producedOutput = true;
          writeReturnAudio(camera, child, chunk);
        });
        child.stdout.on('error', () => failTalkback('adaptation-failed'));
        child.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            reportAdaptation('return-audio', producedOutput ? 'exited-while-streaming' : 'spawn-failed', stderr);
            failTalkback('adaptation-failed');
          }
        });
        child.on('exit', (code, signal) => {
          if (stopped || talkbackEnded || stoppingProcesses.has(child)) {
            reportAdaptation('return-audio', 'output', stderr, code, signal);
            return;
          }
          reportAdaptation(
            'return-audio',
            producedOutput ? 'exited-while-streaming' : 'exited-before-output',
            stderr,
            code,
            signal,
          );
          failTalkback('adaptation-failed');
        });
        child.stdin.end(returnAudioSdp(audioPort.port, selection, transport.audio, transport.addressVersion));
        await new Promise((resolve) => setTimeout(resolve, RETURN_AUDIO_BIND_GRACE_MS));
      } catch {
        failTalkback('adaptation-failed');
      }
    };

    return {
      videoPort: videoPort.port,
      ...(audioPort ? { audioPort: audioPort.port } : {}),
      async start(camera, selection): Promise<void> {
        if (stopped) {
          throw new Error('live media session is already stopped');
        }
        negotiated = selection;
        const returnAudioReady = startReturnAudio(camera, selection.audio);
        let sourcePromise: Promise<LiveStreamConsumer>;
        let acquisitionDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          sourcePromise = camera.live();
          void sourcePromise.then(
            (lateSource) => {
              if (stopped && source !== lateSource) {
                lateSource.stop();
              }
            },
            () => undefined,
          );
          source = await Promise.race([
            sourcePromise,
            new Promise<never>((_, reject) => {
              acquisitionDeadline = setTimeout(() => reject(SOURCE_ACQUISITION_TIMEOUT), SOURCE_ACQUISITION_DEADLINE_MS);
              acquisitionDeadline.unref?.();
            }),
          ]);
        } catch (error) {
          failVideo(error === SOURCE_ACQUISITION_TIMEOUT ? 'source-acquisition-timeout' : sourceFailure(error));
          throw error === SOURCE_ACQUISITION_TIMEOUT ? new Error('live media source acquisition timed out') : error;
        } finally {
          clearTimeout(acquisitionDeadline);
        }
        if (stopped) {
          source.stop();
          return;
        }
        videoStartBackstop = setTimeout(() => failVideo('no-video-within-backstop'), SOURCE_START_BACKSTOP_MS);
        videoStartBackstop.unref?.();
        source.on('video-config', observeVideoConfig);
        source.on('video', writeVideo);
        source.on('audio', writeAudio);
        source.on('budget', (notice) => {
          if (!stopped) {
            notice.extend();
          }
        });
        source.on('error', (error) => failVideo(sourceFailure(error)));
        source.on('stop', () => failVideo('source-stopped'));
        await returnAudioReady;
      },
      /**
       * Acknowledges a reconfigured selection and applies it at the next source keyframe.
       *
       * Nothing is torn down here: the current adaptation keeps the previous selection on the wire until the
       * replacement has a keyframe to start from. The deferral is still bounded, because a session that never
       * applies the selection HomeKit asked for must end and be renegotiated rather than silently serve the
       * old one forever.
       */
      reconfigure(video): void {
        if (!negotiated) {
          return;
        }
        negotiated = { ...negotiated, video };
        reconfigurationPending = videoProcess !== undefined;
        clearTimeout(videoStartBackstop);
        videoStartBackstop = setTimeout(() => failVideo('no-video-within-backstop'), SOURCE_START_BACKSTOP_MS);
        videoStartBackstop.unref?.();
      },
      stop,
    };
  }
}

/**
 * Options every adapted elementary stream applies to its own input.
 *
 * A piped elementary stream carries no container, so FFmpeg's initial stream analysis is the only thing
 * standing between the first written access unit and the first coded frame. The caller already declares the
 * format, so that analysis has nothing left to discover and is bounded to its minimum; leaving it at the
 * default delays first output by seconds and scales that delay with the source keyframe interval.
 *
 * Nothing asks FFmpeg to discard or reinterpret what it read. Discarding the analysed packets throws away the
 * leading keyframe the caller waited for, and a raw A-law demuxer stops emitting timestamps entirely, so both
 * cost media that was already in hand.
 */
function commonArguments(inputFormat: string, inputOptions: readonly string[] = []): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-probesize',
    '32',
    '-analyzeduration',
    '1',
    '-progress',
    'pipe:2',
    '-nostats',
    '-f',
    inputFormat,
    ...inputOptions,
    '-i',
    'pipe:0',
  ];
}

function outputArguments(
  targetAddress: string,
  target: LiveMediaTarget,
  payloadType: number,
  ssrc: number,
  packetSize: number,
): string[] {
  return [
    '-payload_type',
    String(payloadType),
    '-ssrc',
    String(ssrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    target.srtpCryptoSuite,
    '-srtp_out_params',
    Buffer.concat([target.srtpKey, target.srtpSalt]).toString('base64'),
    `srtp://${targetAddress}:${target.port}?rtcpport=${target.port}&pkt_size=${packetSize}`,
  ];
}

/**
 * Raw SDK frames cannot prove profile, level, frame rate, and bitrate, so negotiated video is transcoded.
 *
 * Access units arrive as they are captured and carry no timeline of their own, so the input is timestamped
 * by arrival. Asking FFmpeg to generate presentation timestamps instead makes it interpolate them from a
 * frame rate a bare Annex-B pipe never states, which collapses the whole session onto one instant; the
 * constant-rate output then resolves the collision by discarding almost every frame it was given.
 *
 * `superfast` is the cheapest `libx264` preset that retains CABAC, and therefore the cheapest one whose
 * coded stream can carry a negotiated Main or High profile; `ultrafast` drops CABAC and codes Constrained
 * Baseline whatever `-profile:v` asks for. `-tune zerolatency` pins the same `sliced_threads`, `bframes`
 * and `rc_lookahead` at either preset, so this costs computation rather than frame delay.
 */
function videoArguments(
  input: LiveVideoConfig,
  selection: NegotiatedLiveVideo,
  targetAddress: string,
  target: LiveMediaTarget,
): string[] {
  return [
    ...commonArguments(input.codec === 'h265' ? 'hevc' : input.codec, ['-use_wallclock_as_timestamps', '1']),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'superfast',
    '-tune',
    'zerolatency',
    '-profile:v',
    selection.profile,
    '-level:v',
    selection.level,
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale=${selection.width}:${selection.height}:force_original_aspect_ratio=decrease,pad=${selection.width}:${selection.height}:(ow-iw)/2:(oh-ih)/2`,
    '-r',
    String(selection.fps),
    '-g',
    String(selection.fps * 2),
    '-keyint_min',
    String(selection.fps * 2),
    '-sc_threshold',
    '0',
    '-b:v',
    `${selection.maxBitRate}k`,
    '-maxrate',
    `${selection.maxBitRate}k`,
    '-bufsize',
    `${selection.maxBitRate * 2}k`,
    ...outputArguments(targetAddress, target, selection.payloadType, selection.ssrc, selection.mtu),
  ];
}

/**
 * Adapts one source audio elementary stream to the negotiated AAC-ELD output.
 *
 * The SDK reports no sample rate or channel count, because a station sends neither; 16 kHz mono is the
 * assumption every Eufy client applies. Raw A-law carries nothing at all and must be told that assumption,
 * while an ADTS input states its own rate in every frame header and rejects the option outright, which fails
 * the process before it reads a byte.
 *
 * `libfdk_aac` selects its transport from the requested output framing, and AAC-ELD cannot be carried in
 * ADTS, so without an explicit global header the encoder refuses to initialise at all.
 */
function audioArguments(
  frame: LiveAudioFrame,
  selection: NegotiatedLiveAudio,
  targetAddress: string,
  target: LiveMediaTarget,
): string[] {
  const rawAlaw = frame.codec === 'g711a';
  return [
    ...commonArguments(rawAlaw ? 'alaw' : 'aac', rawAlaw ? ['-ar', '16k', '-ac', '1'] : []),
    '-vn',
    '-c:a',
    'libfdk_aac',
    '-profile:a',
    'aac_eld',
    '-flags',
    '+global_header',
    '-ar',
    `${selection.sampleRate}k`,
    '-ac',
    String(selection.channels),
    '-b:a',
    `${selection.maxBitRate}k`,
    ...outputArguments(targetAddress, target, selection.payloadType, selection.ssrc, 188),
  ];
}

/**
 * Decode HomeKit's controller-to-accessory AAC-ELD SRTP and emit the SDK's exact talkback input: 16 kHz
 * mono AAC-LC in ADTS. The SDK owns complete-frame recovery, the 640-byte frame limit, and 64 ms pacing,
 * so FFmpeg must produce a byte stream rather than impose another clock.
 */
function returnAudioArguments(): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-protocol_whitelist',
    'pipe,udp,rtp,crypto',
    '-f',
    'sdp',
    '-c:a',
    'libfdk_aac',
    '-i',
    'pipe:0',
    '-map',
    '0:a:0',
    '-vn',
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
  ];
}

/**
 * Describe the one return-audio RTP stream HomeKit negotiated. AAC-ELD at 16 kHz mono uses the
 * established MPEG4-GENERIC AAC-hbr configuration below; the crypto material is the audio endpoint key
 * HomeKit supplied during SetupEndpoints and no media or identity enters diagnostics.
 */
function returnAudioSdp(
  port: number,
  selection: NegotiatedLiveAudio,
  target: LiveMediaTarget,
  addressVersion: 'ipv4' | 'ipv6',
): string {
  const network = addressVersion === 'ipv6' ? 'IP6' : 'IP4';
  const address = addressVersion === 'ipv6' ? '::' : '0.0.0.0';
  const key = Buffer.concat([target.srtpKey, target.srtpSalt]).toString('base64');
  return [
    'v=0',
    `o=- 0 0 IN ${network} ${address}`,
    's=HomeKit Return Audio',
    `c=IN ${network} ${address}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${selection.payloadType}`,
    `b=AS:${selection.maxBitRate}`,
    `a=rtpmap:${selection.payloadType} MPEG4-GENERIC/16000/1`,
    `a=fmtp:${selection.payloadType} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00`,
    `a=crypto:1 ${target.srtpCryptoSuite} inline:${key}`,
    'a=rtcp-mux',
    '',
  ].join('\r\n');
}

function spawnLiveMediaProcess(executable: string, args: readonly string[]): MediaProcess {
  return spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
}

function spawnReturnAudioProcess(executable: string, args: readonly string[]): ReturnAudioProcess {
  return spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function reserveMediaPort(addressVersion: 'ipv4' | 'ipv6'): Promise<ReservedMediaPort> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(addressVersion === 'ipv6' ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const address = socket.address();
      socket.removeListener('error', reject);
      let closing: Promise<void> | undefined;
      resolve({
        port: address.port,
        onMessage: (listener) => socket.on('message', listener),
        close: () =>
          (closing ??= new Promise<void>((done) => {
            socket.close(done);
          })),
      });
    });
  });
}
