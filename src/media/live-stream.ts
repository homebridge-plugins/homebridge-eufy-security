import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame } from '@mega-yfue/eufy-sdk';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

const PROCESS_STOP_GRACE_MS = 2_000;
const INITIAL_RTCP_GRACE_MS = 15_000;
const SOURCE_ACQUISITION_DEADLINE_MS = 10_000;
/**
 * Backstop for a started session that never produces video. The SDK live source owns the warm-up
 * window, retries the start inside it, and fails its consumers with a typed `error` event, which is
 * the primary failure signal here; that window is an SDK-internal default the plugin cannot read, so
 * this bound sits strictly above it and only catches an SDK that reports nothing at all.
 */
const VIDEO_START_BACKSTOP_MS = 30_000;
const SOURCE_ACQUISITION_TIMEOUT = Symbol('source-acquisition-timeout');

export interface LiveMediaProcess {
  readonly stdin: Writable;
  readonly stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ReservedMediaPort {
  readonly port: number;
  onMessage(listener: () => void): void;
  close(): void;
}

export type LiveMediaProcessFactory = (executable: string, args: readonly string[]) => LiveMediaProcess;
export type MediaPortFactory = (addressVersion: 'ipv4' | 'ipv6') => Promise<ReservedMediaPort>;

export interface LiveMediaTransport {
  readonly addressVersion: 'ipv4' | 'ipv6';
  readonly targetAddress: string;
  readonly video: LiveMediaTarget;
  readonly audio?: LiveMediaTarget;
  readonly onVideoFailure?: () => void;
  readonly onSessionOutcome?: (outcome: LiveSessionOutcome) => void;
}

/** Why one live session ended without usable video, in a bounded plugin-owned vocabulary. */
export type LiveSessionFailure =
  | 'source-acquisition-timeout'
  | 'no-video-within-backstop'
  | 'source-error'
  | 'source-stopped'
  | 'rtcp-timeout'
  | 'adaptation-failed';

/**
 * One live session lifecycle outcome, reported once per transition and carrying no device identity,
 * address, key, media byte, or SDK message.
 */
export type LiveSessionOutcome =
  | { readonly outcome: 'streaming' }
  | { readonly outcome: 'failed'; readonly reason: LiveSessionFailure };

export interface LiveMediaTarget {
  readonly port: number;
  readonly srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80' | 'AES_CM_256_HMAC_SHA1_80';
  readonly srtpKey: Buffer;
  readonly srtpSalt: Buffer;
}

export interface NegotiatedLiveMedia {
  readonly video: NegotiatedLiveVideo;
  readonly audio?: NegotiatedLiveAudio;
}

export interface NegotiatedLiveVideo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly maxBitRate: number;
  readonly profile: 'baseline' | 'main' | 'high';
  readonly level: '3.1' | '3.2' | '4.0';
  readonly payloadType: number;
  readonly ssrc: number;
  readonly mtu: number;
  readonly rtcpInterval: number;
}

export interface NegotiatedLiveAudio {
  readonly codec: 'AAC-eld';
  readonly channels: number;
  readonly sampleRate: 16 | 24;
  readonly maxBitRate: number;
  readonly payloadType: number;
  readonly ssrc: number;
}

export interface PreparedLiveMedia {
  readonly videoPort: number;
  readonly audioPort?: number;
  start(source: { live(): Promise<LiveStreamHandle> }, negotiated: NegotiatedLiveMedia): Promise<void>;
  reconfigure(video: NegotiatedLiveVideo): void;
  stop(): void;
}

/** Adapts separate SDK elementary streams into independently failing HomeKit SRTP outputs. */
export class FfmpegLiveMedia {
  constructor(
    private readonly executable: string,
    private readonly createProcess: LiveMediaProcessFactory = spawnLiveMediaProcess,
    private readonly reservePort: MediaPortFactory = reserveMediaPort,
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

    let source: LiveStreamHandle | undefined;
    let videoProcess: LiveMediaProcess | undefined;
    let audioProcess: LiveMediaProcess | undefined;
    let negotiated: NegotiatedLiveMedia | undefined;
    let stopped = false;
    let receivedVideoKeyframe = false;
    let reconfigurationPending = false;
    let videoInput: Pick<LiveVideoFrame, 'codec' | 'width' | 'height'> | undefined;
    let audioInputCodec: LiveAudioFrame['codec'] | undefined;
    let rtcpDeadline: ReturnType<typeof setTimeout> | undefined;
    let initialRtcpGrace: ReturnType<typeof setTimeout> | undefined;
    let videoStartBackstop: ReturnType<typeof setTimeout> | undefined;
    let videoFailed = false;
    let rtcpObserved = false;
    let streaming = false;
    const stoppingProcesses = new WeakSet<object>();

    const stopProcess = (process: LiveMediaProcess | undefined): void => {
      if (!process) {
        return;
      }
      stoppingProcesses.add(process);
      process.stdin.destroy();
      process.kill('SIGTERM');
      const killDeadline = setTimeout(() => process.kill('SIGKILL'), PROCESS_STOP_GRACE_MS);
      killDeadline.unref?.();
      process.on('exit', () => clearTimeout(killDeadline));
    };
    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimeout(rtcpDeadline);
      clearTimeout(initialRtcpGrace);
      clearTimeout(videoStartBackstop);
      stopProcess(videoProcess);
      stopProcess(audioProcess);
      source?.stop();
      videoPort.close();
      audioPort?.close();
    };
    const failVideo = (reason: LiveSessionFailure): void => {
      if (stopped || videoFailed) {
        return;
      }
      videoFailed = true;
      stop();
      transport.onSessionOutcome?.({ outcome: 'failed', reason });
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
    const observeAdaptationProgress = (reporter: LiveMediaProcess): void => {
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
     * Writes one source access unit to the adaptation that is entitled to code it.
     *
     * A changed source codec or geometry cannot be coded by the current process at all, so those frames wait
     * for the keyframe that lets a replacement start. A reconfigured HomeKit selection changes only the
     * output, so the current process keeps coding and keeps the previous selection on the wire until that
     * same keyframe arrives; a controller reconfigures precisely when it is unhappy with what it receives,
     * and the source is then often the very thing not producing keyframes.
     */
    const writeVideo = (frame: LiveVideoFrame): void => {
      if (stopped || !negotiated) {
        return;
      }
      if (!receivedVideoKeyframe) {
        if (!frame.keyframe) {
          return;
        }
        receivedVideoKeyframe = true;
      }
      const inputChanged =
        videoInput !== undefined &&
        (videoInput.codec !== frame.codec || videoInput.width !== frame.width || videoInput.height !== frame.height);
      if (videoProcess && inputChanged && !frame.keyframe) {
        return;
      }
      if (videoProcess && frame.keyframe && (inputChanged || reconfigurationPending)) {
        reconfigurationPending = false;
        stopProcess(videoProcess);
        videoProcess = undefined;
      }
      if (!videoProcess) {
        videoInput = { codec: frame.codec, width: frame.width, height: frame.height };
        const child = this.createProcess(
          this.executable,
          videoArguments(frame, negotiated.video, targetAddress, transport.video),
        );
        videoProcess = child;
        let progressRemainder = '';
        child.stderr.on('data', (chunk: Buffer) => {
          const lines = `${progressRemainder}${chunk.toString()}`.split(/\r?\n/);
          progressRemainder = lines.pop()?.slice(-64) ?? '';
          if (lines.some((line) => line.startsWith('progress='))) {
            observeAdaptationProgress(child);
          }
        });
        child.stdin.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            failVideo('adaptation-failed');
          }
        });
        child.on('error', () => {
          if (!stoppingProcesses.has(child)) {
            failVideo('adaptation-failed');
          }
        });
        child.on('exit', () => {
          if (!stopped && !stoppingProcesses.has(child)) {
            failVideo('adaptation-failed');
          }
        });
      }
      videoProcess.stdin.write(frame.data);
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
        child.stderr.resume();
        const clearChild = (): void => {
          if (audioProcess === child) {
            audioProcess = undefined;
          }
        };
        child.stdin.on('error', () => {
          stopProcess(child);
          clearChild();
        });
        child.on('error', () => {
          stopProcess(child);
          clearChild();
        });
        child.on('exit', clearChild);
      }
      if (audioInputCodec !== frame.codec) {
        stopProcess(audioProcess);
        audioProcess = undefined;
        audioInputCodec = undefined;
        writeAudio(frame);
        return;
      }
      audioProcess.stdin.write(frame.data);
    };

    return {
      videoPort: videoPort.port,
      ...(audioPort ? { audioPort: audioPort.port } : {}),
      async start(camera, selection): Promise<void> {
        if (stopped) {
          throw new Error('live media session is already stopped');
        }
        negotiated = selection;
        let sourcePromise: Promise<LiveStreamHandle>;
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
          failVideo(error === SOURCE_ACQUISITION_TIMEOUT ? 'source-acquisition-timeout' : 'source-error');
          throw error === SOURCE_ACQUISITION_TIMEOUT ? new Error('live media source acquisition timed out') : error;
        } finally {
          clearTimeout(acquisitionDeadline);
        }
        if (stopped) {
          source.stop();
          return;
        }
        videoStartBackstop = setTimeout(() => failVideo('no-video-within-backstop'), VIDEO_START_BACKSTOP_MS);
        videoStartBackstop.unref?.();
        source.on('video', writeVideo);
        source.on('audio', writeAudio);
        source.on('budget', (notice) => {
          if (!stopped) {
            notice.extend();
          }
        });
        source.on('error', () => failVideo('source-error'));
        source.on('stop', () => failVideo('source-stopped'));
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
        videoStartBackstop = setTimeout(() => failVideo('no-video-within-backstop'), VIDEO_START_BACKSTOP_MS);
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
  frame: LiveVideoFrame,
  selection: NegotiatedLiveVideo,
  targetAddress: string,
  target: LiveMediaTarget,
): string[] {
  return [
    ...commonArguments(frame.codec === 'h265' ? 'hevc' : frame.codec, ['-use_wallclock_as_timestamps', '1']),
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

function spawnLiveMediaProcess(executable: string, args: readonly string[]): LiveMediaProcess {
  return spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
}

function reserveMediaPort(addressVersion: 'ipv4' | 'ipv6'): Promise<ReservedMediaPort> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(addressVersion === 'ipv6' ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const address = socket.address();
      socket.removeListener('error', reject);
      resolve({
        port: address.port,
        onMessage: (listener) => socket.on('message', listener),
        close: () => socket.close(),
      });
    });
  });
}
