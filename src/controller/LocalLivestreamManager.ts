import { PassThrough, Readable } from 'stream';
import { Station, Device, StreamMetadata, EufySecurity } from 'eufy-security-client';
import { CameraAccessory } from '../accessories/CameraAccessory.js';
import { Deferred } from '../utils/utils.js';
import { ILogObj, Logger } from 'tslog';
import { PREBUFFER_DURATION_MS, PREBUFFER_ESTIMATED_BYTE_RATE } from '../settings.js';
import { DebugRecordingManager } from './DebugRecordingManager.js';

/** Internal state: streams plus a timestamp for dedup/reuse logic. */
interface ActiveStream {
  videostream: Readable;
  audiostream: Readable;
  metadata: StreamMetadata;
  createdAt: number;
  /** Shared ID linking raw + processed debug recordings from the same session. */
  sessionId: string;
}

/** Data returned to consumers — only the streams they need. */
export type LivestreamData = Pick<ActiveStream, 'videostream' | 'audiostream' | 'metadata'>;

const P2P_TIMEOUT_MS = 15_000;
const DUPLICATE_STREAM_GUARD_S = 5;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10_000;
/** Grace period before actually stopping a P2P stream after the last consumer releases. */
const STOP_GRACE_MS = 5_000;

/**
 * Fixed-capacity ring buffer that stores raw P2P video chunks (H.264 NALUs).
 *
 * When a P2P stream is pre-warmed on motion detection, data flows but has no
 * consumer.  This buffer captures the last {@link PREBUFFER_DURATION_MS} of
 * video so that when HKSV requests a recording, the buffered data can be
 * drained into FFmpeg's input immediately — eliminating the probe/analysis
 * delay that normally occurs while FFmpeg waits for the first bytes.
 */
class StreamBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(durationMs: number, byteRate: number) {
    this.maxBytes = Math.ceil(durationMs * byteRate);
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.length;
    }
  }

  /** Return all buffered chunks and reset. */
  drain(): Buffer[] {
    const buffered = this.chunks;
    this.chunks = [];
    this.totalBytes = 0;
    return buffered;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  get byteLength(): number {
    return this.totalBytes;
  }
}

export class LocalLivestreamManager {
  private stationStream: ActiveStream | null = null;
  private pending: { deferred: Deferred<LivestreamData>; timer: NodeJS.Timeout } | null = null;
  private retryCount = 0;
  private stopGraceTimer: NodeJS.Timeout | null = null;
  /** Number of consumers currently holding a forked copy of the stream. */
  private activeConsumers = 0;

  /** Ring buffer for raw video data captured during pre-warm (no consumers). */
  private videoBuffer: StreamBuffer | null = null;
  /** Listener reference for cleaning up the buffer tap on the video stream. */
  private bufferListener: ((chunk: Buffer) => void) | null = null;
  /** The videostream the buffer listener is attached to (for reliable cleanup). */
  private bufferedVideoStream: Readable | null = null;

  private readonly eufyClient: EufySecurity;
  private readonly log: Logger<ILogObj>;
  private readonly serialNumber: string;
  private readonly debugRecordingManager: DebugRecordingManager | null;
  private readonly debugEnabled: boolean;

  constructor(camera: CameraAccessory) {
    this.eufyClient = camera.platform.eufyClient;
    this.serialNumber = camera.device.getSerial();
    this.log = camera.log;
    this.debugEnabled = camera.platform.config.debugLivestream ?? false;
    this.debugRecordingManager = camera.platform.debugRecordingManager ?? null;

    this.log.debug(`LocalLivestreamManager initialized for ${camera.device.getName()} (serial: ${this.serialNumber})`);

    this.eufyClient.on('station livestream start', this.onStationLivestreamStart);
    this.eufyClient.on('station livestream stop', this.onStationLivestreamStop);
  }

  /** Destroy active streams and reset state. */
  private destroyStreams(): void {
    this.stopBuffering();
    // Stop raw debug recording before destroying streams
    this.debugRecordingManager?.stopRawRecording(this.serialNumber);
    if (this.stationStream) {
      this.stationStream.audiostream.unpipe();
      this.stationStream.audiostream.destroy();
      this.stationStream.videostream.unpipe();
      this.stationStream.videostream.destroy();
      this.stationStream = null;
      this.activeConsumers = 0;
    }
  }

  /**
   * Start capturing raw video chunks into the ring buffer.
   * Called when a stream is established with no consumers (pre-warm scenario).
   * The buffer is drained into the first consumer fork via {@link forkStream}.
   */
  private startBuffering(videostream: Readable): void {
    this.stopBuffering();
    this.videoBuffer = new StreamBuffer(PREBUFFER_DURATION_MS, PREBUFFER_ESTIMATED_BYTE_RATE);
    this.bufferListener = (chunk: Buffer) => this.videoBuffer?.push(chunk);
    this.bufferedVideoStream = videostream;
    videostream.on('data', this.bufferListener);
    this.log.debug(`Prebuffer started (max ${PREBUFFER_DURATION_MS}ms / ${((PREBUFFER_DURATION_MS * PREBUFFER_ESTIMATED_BYTE_RATE) / 1024).toFixed(0)} KB).`);
  }

  /** Stop buffering and detach the listener from the video stream. */
  private stopBuffering(): void {
    if (this.bufferListener && this.bufferedVideoStream) {
      this.bufferedVideoStream.removeListener('data', this.bufferListener);
    }
    this.bufferListener = null;
    this.bufferedVideoStream = null;
    this.videoBuffer = null;
  }

  /**
   * Return a forked copy of the active livestream, or start a new one.
   * Each caller gets its own PassThrough fork so that when one consumer's
   * FFmpeg exits and destroys its input, the underlying P2P stream survives
   * for other consumers.  A consumer count tracks active forks so the P2P
   * session is only stopped when the last consumer calls stopLocalLiveStream().
   */
  public async getLocalLiveStream(): Promise<LivestreamData> {
    if (this.stopGraceTimer) {
      clearTimeout(this.stopGraceTimer);
      this.stopGraceTimer = null;
      this.log.debug('Cancelled deferred stop — reusing active stream.');
    }

    if (!this.stationStream) {
      await this.startLocalLiveStream();
    }

    if (!this.stationStream) {
      throw new Error('Livestream failed to start.');
    }

    const runtime = ((Date.now() - this.stationStream.createdAt) / 1000).toFixed(1);
    this.activeConsumers++;
    this.log.debug(
      `Providing forked stream (consumers: ${this.activeConsumers}, ` +
      `stream age: ${runtime}s).`,
    );

    return this.forkStream(this.stationStream);
  }

  /**
   * Create PassThrough forks of the video and audio streams.  The forks
   * automatically unpipe when closed so the originals stay healthy.
   *
   * If a prebuffer has accumulated (from a pre-warmed stream with no consumers),
   * the buffered video data is drained into the fork first so that FFmpeg
   * receives data immediately without waiting for new P2P frames.
   */
  private forkStream(source: ActiveStream): LivestreamData {
    const videoFork = new PassThrough();
    const audioFork = new PassThrough();

    // Drain any prebuffered video data into the fork before piping live data.
    // This eliminates FFmpeg's probe delay by providing immediate input.
    // Backpressure note: at 4s / ~1 MB the PassThrough internal buffer
    // handles this comfortably. If PREBUFFER_DURATION_MS is increased
    // significantly, consider making this drain async with drain events.
    if (this.videoBuffer && !this.videoBuffer.isEmpty) {
      const buffered = this.videoBuffer.drain();
      const totalBytes = buffered.reduce((sum, c) => sum + c.length, 0);
      this.log.debug(`Draining ${buffered.length} prebuffered chunks (${(totalBytes / 1024).toFixed(1)} KB) into video fork.`);
      for (const chunk of buffered) {
        videoFork.write(chunk);
      }
    }

    // Stop buffering — live data now flows directly to the consumer.
    this.stopBuffering();

    source.videostream.pipe(videoFork);
    source.audiostream.pipe(audioFork);

    videoFork.on('close', () => source.videostream.unpipe(videoFork));
    audioFork.on('close', () => source.audiostream.unpipe(audioFork));

    return {
      videostream: videoFork,
      audiostream: audioFork,
      metadata: source.metadata,
    };
  }

  /** True when a P2P livestream is currently active or starting. */
  public isStreamActive(): boolean {
    return this.stationStream !== null || this.pending !== null;
  }

  /** Session ID for the current debug recording pair (raw + processed). */
  public getSessionId(): string | null {
    return this.stationStream?.sessionId ?? null;
  }

  /**
   * Pre-warm the P2P livestream without creating a consumer fork.
   * The stream will be kept alive by the STOP_GRACE_MS timer once established.
   * If a consumer calls getLocalLiveStream() while the stream is warm,
   * it will reuse the existing connection instantly.
   */
  public async preWarmStream(): Promise<void> {
    if (this.isStreamActive()) {
      return;
    }
    await this.startLocalLiveStream();
    // Stream is now active but has zero consumers.
    // Schedule a grace-period stop so it doesn't run forever if unused.
    if (this.activeConsumers === 0 && !this.stopGraceTimer) {
      this.log.debug(`Pre-warmed stream has no consumers — scheduling ${STOP_GRACE_MS / 1000}s grace stop.`);
      this.stopGraceTimer = setTimeout(() => {
        this.stopGraceTimer = null;
        if (this.activeConsumers > 0) {
          return;
        }
        this.log.debug('Pre-warm grace period expired — stopping stream.');
        this.forceStopLocalLiveStream();
      }, STOP_GRACE_MS);
    }
  }

  /**
   * Requests a P2P livestream from the eufy station and waits for the
   * 'station livestream start' event.  If a start is already in progress,
   * the caller piggy-backs on the existing promise instead of issuing a
   * duplicate request.
   */
  private startLocalLiveStream(): Promise<LivestreamData> {
    if (this.pending) {
      this.log.debug('Livestream already starting — waiting on existing request.');
      return this.pending.deferred.promise;
    }

    this.log.debug(`Starting station livestream for serial: ${this.serialNumber}...`);

    const deferred = new Deferred<LivestreamData>();
    this.issueP2PRequest(deferred);
    return deferred.promise;
  }

  /**
   * Issue a P2P start request with a timeout. Used for both initial
   * attempts and retries (reusing the same deferred).
   */
  private issueP2PRequest(deferred: Deferred<LivestreamData>): void {
    const timer = setTimeout(() => {
      this.log.error(
        `Livestream timeout: no P2P stream event within ${P2P_TIMEOUT_MS / 1000}s` +
        ` for serial ${this.serialNumber}.`,
      );
      this.settlePending('reject', new Error('Livestream timeout — check eufy-lib.log for P2P errors.'));
    }, P2P_TIMEOUT_MS);

    this.pending = { deferred, timer };

    this.eufyClient.startStationLivestream(this.serialNumber).catch((err) => {
      this.log.error(`startStationLivestream failed: ${err}`);
      this.settlePending('reject', err);
    });
  }

  /**
   * Settle (resolve or reject) the pending start promise, clear the timer,
   * and optionally stop the livestream on rejection. On failure, retries
   * with exponential backoff before final rejection.
   */
  private settlePending(action: 'resolve', value: LivestreamData): void;
  private settlePending(action: 'reject', reason: unknown): void;
  private settlePending(action: 'resolve' | 'reject', payload: unknown): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);

    if (action === 'resolve') {
      this.retryCount = 0;
      this.pending = null;
      p.deferred.resolve(payload as LivestreamData);
      return;
    }

    // Failure path — retry with exponential backoff if attempts remain
    if (this.retryCount < MAX_RETRIES) {
      const delay = Math.min(
        BASE_RETRY_DELAY_MS * Math.pow(2, this.retryCount) + Math.random() * 1000,
        MAX_RETRY_DELAY_MS,
      );
      this.retryCount++;
      this.log.warn(
        `P2P connection failed. Retrying in ${(delay / 1000).toFixed(1)}s` +
        ` (attempt ${this.retryCount + 1}/${MAX_RETRIES + 1})...`,
      );
      // Keep pending alive during backoff so new callers piggyback
      p.timer = setTimeout(() => {
        this.log.debug(
          `Retrying station livestream for serial: ${this.serialNumber}` +
          ` (attempt ${this.retryCount + 1}/${MAX_RETRIES + 1})...`,
        );
        this.issueP2PRequest(p.deferred);
      }, delay);
    } else {
      this.retryCount = 0;
      this.pending = null;
      this.log.error(`Livestream failed after ${MAX_RETRIES + 1} attempts.`);
      p.deferred.reject(payload instanceof Error ? payload : new Error(String(payload)));
      this.forceStopLocalLiveStream();
    }
  }

  /**
   * Signal that a consumer is done with its forked stream.  When the last
   * consumer releases, the P2P session is stopped after a short grace period
   * to allow a subsequent consumer (e.g. a livestream right after a snapshot)
   * to reuse the session without a stop/start cycle.
   */
  public stopLocalLiveStream(): void {
    this.activeConsumers = Math.max(0, this.activeConsumers - 1);
    this.log.debug(`Consumer released (remaining: ${this.activeConsumers}).`);

    if (this.activeConsumers > 0) {
      return;
    }

    // Last consumer — schedule a deferred stop
    if (this.stopGraceTimer) return;
    this.log.debug(`Deferring stream stop by ${STOP_GRACE_MS / 1000}s to allow reuse.`);
    this.stopGraceTimer = setTimeout(() => {
      this.stopGraceTimer = null;
      if (this.activeConsumers > 0) {
        this.log.debug('Grace period expired but new consumer(s) present — not stopping.');
        return;
      }
      this.log.debug('Grace period expired — stopping stream now.');
      this.forceStopLocalLiveStream();
    }, STOP_GRACE_MS);
  }

  /** Unconditionally tear down the P2P session and all state. */
  private forceStopLocalLiveStream(): void {
    this.log.debug('Stopping station livestream.');
    if (this.stopGraceTimer) {
      clearTimeout(this.stopGraceTimer);
      this.stopGraceTimer = null;
    }
    this.retryCount = 0;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.eufyClient.stopStationLivestream(this.serialNumber).catch((err) => {
      this.log.warn(`stopStationLivestream failed: ${err}`);
    });
    this.destroyStreams();
  }

  /** True when the event belongs to this camera instance. */
  private isOwnDevice(device: Device): boolean {
    return device.getSerial() === this.serialNumber;
  }

  private onStationLivestreamStop = (_station: Station, device: Device): void => {
    if (!this.isOwnDevice(device)) return;
    this.log.debug(`Station livestream for ${device.getName()} has stopped.`);
    this.destroyStreams();
  };

  private onStationLivestreamStart = (
    station: Station,
    device: Device,
    metadata: StreamMetadata,
    videostream: Readable,
    audiostream: Readable,
  ): void => {
    if (!this.isOwnDevice(device)) return;

    // Guard against duplicate events fired in quick succession.
    if (this.stationStream) {
      const elapsed = (Date.now() - this.stationStream.createdAt) / 1000;
      if (elapsed < DUPLICATE_STREAM_GUARD_S) {
        this.log.warn('Duplicate livestream event received — ignoring.');
        return;
      }
    }

    // Tear down any prior stream before storing the new one.
    this.destroyStreams();

    this.log.debug(`${station.getName()} P2P livestream for ${device.getName()} started.`);
    this.log.debug('Stream metadata:', JSON.stringify(metadata));

    const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
    this.stationStream = { videostream, audiostream, metadata, createdAt: Date.now(), sessionId };

    // Start prebuffering video data. If a consumer is already waiting (pending
    // resolve), forkStream will drain the buffer immediately. If this is a
    // pre-warm with no consumers, the buffer accumulates until one arrives.
    this.startBuffering(videostream);

    // Start raw debug recording if enabled — captures the P2P feed before any FFmpeg processing.
    // Large highWaterMark lets the fork buffer data while FFmpeg starts up,
    // preventing backpressure from stalling the source P2P stream.
    if (this.debugEnabled && this.debugRecordingManager) {
      const rawVideoFork = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
      const rawAudioFork = new PassThrough({ highWaterMark: 256 * 1024 });
      videostream.pipe(rawVideoFork);
      audiostream.pipe(rawAudioFork);
      rawVideoFork.on('close', () => videostream.unpipe(rawVideoFork));
      rawAudioFork.on('close', () => audiostream.unpipe(rawAudioFork));
      this.debugRecordingManager.startRawRecording(
        this.serialNumber, rawVideoFork, rawAudioFork, metadata, sessionId,
      ).catch((err) => this.log.warn(`Raw debug recording failed to start: ${err}`));
    }

    this.settlePending('resolve', this.stationStream);
  };
}
