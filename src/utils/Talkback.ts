import { Writable } from 'stream';

import { EufySecurityPlatform } from '../platform.js';
import { Device, EufySecurity, Station } from 'eufy-security-client';
import { Logger, ILogObj } from 'tslog';

/** Maximum bytes to buffer while waiting for the P2P talkback channel to open. */
const STARTUP_BUFFER_MAX = 4096;

/** Default idle timeout (ms) before talkback is stopped after the last audio data. */
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

/**
 * Manages the return-audio (talkback) pipeline for a single camera session.
 *
 * Audio data written to this stream is forwarded to the eufy P2P talkback
 * channel.  While the channel is opening, data is buffered (up to
 * {@link STARTUP_BUFFER_MAX} bytes) so early frames are not lost.
 */
export class TalkbackStream extends Writable {

  private readonly eufyClient: EufySecurity;
  private readonly log: Logger<ILogObj>;
  private readonly cameraSN: string;
  private readonly idleTimeoutMs: number;

  private startupBuffer: Buffer[] = [];
  private startupBufferSize = 0;
  private talkbackStarted = false;
  private talkbackRequested = false;
  private targetStream?: Writable;
  private idleTimeout?: NodeJS.Timeout;

  constructor(platform: EufySecurityPlatform, camera: Device, log: Logger<ILogObj>, idleTimeoutMs?: number) {
    super();

    this.eufyClient = platform.eufyClient;
    this.cameraSN = camera.getSerial();
    this.log = log;
    this.idleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    this.eufyClient.on('station talkback start', this.onTalkbackStarted);
    this.eufyClient.on('station talkback stop', this.onTalkbackStopped);
  }

  // --- Event handlers (arrow functions to preserve `this` context) ---

  private onTargetStreamError = (err: Error): void => {
    this.log.warn('Talkback target stream error: ' + err);
  };

  private onTalkbackStarted = (station: Station, device: Device, stream: Writable): void => {
    if (device.getSerial() !== this.cameraSN) {
      return;
    }

    this.log.debug('Talkback started via station ' + station.getName());
    this.talkbackStarted = true;

    if (this.targetStream) {
      this.targetStream.removeListener('error', this.onTargetStreamError);
    }

    this.targetStream = stream;
    this.targetStream.on('error', this.onTargetStreamError);

    this.drainStartupBuffer();
  };

  private onTalkbackStopped = (_station: Station, device: Device): void => {
    if (device.getSerial() !== this.cameraSN) {
      return;
    }

    this.log.debug('Talkback stopped.');
    this.talkbackStarted = false;
    this.talkbackRequested = false;
    this.targetStream = undefined;
  };

  // --- Writable implementation ---

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.resetIdleTimeout();

    if (this.targetStream) {
      // Channel is open — write directly
      this.targetStream.write(chunk, callback);
    } else {
      // Channel not yet open — buffer and request talkback
      this.bufferChunk(chunk);
      this.requestTalkback();
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.stopTalkback();
    callback();
  }

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    this.cleanup();
    callback();
  }

  // --- Public API ---

  /** Gracefully stop the talkback session and clean up all resources. */
  public stopTalkbackStream(): void {
    this.cleanup();
    this.destroy();
  }

  // --- Internal helpers ---

  private requestTalkback(): void {
    if (this.talkbackRequested) {
      return;
    }
    this.talkbackRequested = true;
    this.log.debug('Requesting talkback start...');
    this.eufyClient.startStationTalkback(this.cameraSN)
      .catch(error => {
        this.log.error('Talkback could not be started: ' + error);
        this.talkbackRequested = false;
      });
  }

  private stopTalkback(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = undefined;
    }
    if (this.talkbackStarted || this.talkbackRequested) {
      this.log.debug('Stopping talkback.');
      this.talkbackStarted = false;
      this.talkbackRequested = false;
      this.eufyClient.stopStationTalkback(this.cameraSN)
        .catch(error => {
          this.log.error('Talkback could not be stopped: ' + error);
        });
    }
  }

  private bufferChunk(chunk: Buffer): void {
    if (chunk.length >= STARTUP_BUFFER_MAX) {
      // Single chunk exceeds buffer — keep only this chunk
      this.clearStartupBuffer();
      this.startupBuffer.push(chunk);
      this.startupBufferSize = chunk.length;
      return;
    }
    while (this.startupBuffer.length > 0 && this.startupBufferSize + chunk.length > STARTUP_BUFFER_MAX) {
      const dropped = this.startupBuffer.shift()!;
      this.startupBufferSize -= dropped.length;
    }
    this.startupBuffer.push(chunk);
    this.startupBufferSize += chunk.length;
  }

  private drainStartupBuffer(): void {
    if (!this.targetStream || this.startupBuffer.length === 0) {
      return;
    }
    this.log.debug(`Draining ${this.startupBufferSize} bytes of buffered audio.`);
    for (const chunk of this.startupBuffer) {
      this.targetStream.write(chunk);
    }
    this.clearStartupBuffer();
  }

  private clearStartupBuffer(): void {
    this.startupBuffer = [];
    this.startupBufferSize = 0;
  }

  private resetIdleTimeout(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
    }
    this.idleTimeout = setTimeout(() => {
      this.log.debug('Talkback idle timeout — stopping.');
      this.stopTalkback();
    }, this.idleTimeoutMs);
  }

  private cleanup(): void {
    this.eufyClient.removeListener('station talkback start', this.onTalkbackStarted);
    this.eufyClient.removeListener('station talkback stop', this.onTalkbackStopped);
    this.stopTalkback();
    this.clearStartupBuffer();
    if (this.targetStream) {
      this.targetStream.removeListener('error', this.onTargetStreamError);
      this.targetStream = undefined;
    }
  }
}
