import { Writable } from 'node:stream';

/**
 * An adaptation input a specification can stop reading, which is what a pipe to a stalled FFmpeg process is.
 *
 * A one-byte high-water mark makes every write report backpressure, so a contract about what a media session
 * does when its adaptation stops reading is decided by the session rather than by how many bytes a pipe
 * holds. While stalled the write completion is withheld, so no `drain` follows until the stall is released.
 */
export class StallingAdaptationInput extends Writable {
  readonly written: Buffer[] = [];
  private held?: () => void;
  private stalled = false;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    if (this.stalled) {
      this.held = done;
      return;
    }
    done();
  }

  /** Stop taking anything more, retaining the write in flight so no `drain` can follow it. */
  stall(): void {
    this.stalled = true;
  }

  /** Take the retained write and start reading again, which is what lets `drain` follow. */
  release(): void {
    this.stalled = false;
    const held = this.held;
    this.held = undefined;
    held?.();
  }
}
