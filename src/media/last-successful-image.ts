import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAXIMUM_IMAGE_BYTES, isBoundedJpeg, type SnapshotProvenance } from './snapshot.js';

const SNAPSHOT_DIRECTORY = 'snapshots';
const LIVE_PRECEDENCE_MS = 120_000;

interface RetainedImage {
  jpeg?: Buffer;
  provenance?: SnapshotProvenance;
  acceptedAtMs?: number;
}

/**
 * Retains one validated source JPEG per camera in owner-only plugin storage so the last successful
 * image survives restart and full Homebridge backup restoration.
 *
 * Files are sensitive plaintext camera images stored under an opaque SHA-256-derived name; neither
 * retained provenance nor its acceptance time is persisted, so a restored image behaves as the oldest
 * acceptable fallback. One bounded image is read at most once per camera per process and written only
 * when an acquisition succeeds, so synchronous replacement keeps atomicity without pacing cost.
 * Filesystem failures never propagate, because losing a fallback image must not fail a HomeKit request
 * or block startup.
 */
export class PersistedLastSuccessfulImages {
  private readonly directory: string;
  private readonly retained = new Map<string, RetainedImage>();
  private replacements = 0;

  constructor(storageRoot: string) {
    this.directory = join(storageRoot, SNAPSHOT_DIRECTORY);
  }

  read(serial: string): Buffer | undefined {
    const known = this.retained.get(serial);
    if (known) {
      return known.jpeg;
    }
    const restored = this.restore(serial);
    this.retained.set(serial, restored ? { jpeg: restored } : {});
    return restored;
  }

  write(serial: string, jpeg: Buffer, provenance: SnapshotProvenance): void {
    if (!isBoundedJpeg(jpeg) || !this.accepts(serial, jpeg, provenance)) {
      return;
    }
    if (!this.persist(serial, jpeg)) {
      return;
    }
    this.retained.set(serial, { jpeg, provenance, acceptedAtMs: Date.now() });
  }

  /**
   * A live image always replaces a retained image. A stored-only image may replace another stored-only
   * image only when it differs, and may replace a live image only two minutes after that live success.
   */
  private accepts(serial: string, jpeg: Buffer, provenance: SnapshotProvenance): boolean {
    const current = this.retained.get(serial);
    if (provenance === 'live') {
      return true;
    }
    if (current?.jpeg?.equals(jpeg)) {
      return false;
    }
    if (current?.provenance !== 'live' || current.acceptedAtMs === undefined) {
      return true;
    }
    return Date.now() - current.acceptedAtMs >= LIVE_PRECEDENCE_MS;
  }

  private restore(serial: string): Buffer | undefined {
    const file = this.file(serial);
    try {
      if (statSync(file).size > MAXIMUM_IMAGE_BYTES) {
        return undefined;
      }
      const jpeg = readFileSync(file);
      return isBoundedJpeg(jpeg) ? jpeg : undefined;
    } catch {
      return undefined;
    }
  }

  private persist(serial: string, jpeg: Buffer): boolean {
    const file = this.file(serial);
    const staged = `${file}.${process.pid}.${(this.replacements += 1)}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      writeFileSync(staged, jpeg, { mode: 0o600, flush: true });
      renameSync(staged, file);
      return true;
    } catch {
      this.discard(staged);
      return false;
    }
  }

  /** A staged replacement that cannot be removed is not a reason to fail a snapshot request. */
  private discard(staged: string): void {
    try {
      rmSync(staged, { force: true });
    } catch {
      return;
    }
  }

  private file(serial: string): string {
    return join(this.directory, `${createHash('sha256').update(serial).digest('hex')}.jpg`);
  }
}
