import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  private readonly discardedNames = new Set<string>();
  private replacements = 0;
  private invalidReported = false;
  private restoreEnabled = true;

  constructor(
    storageRoot: string,
    private readonly onInvalid?: () => void,
  ) {
    this.directory = join(storageRoot, SNAPSHOT_DIRECTORY);
  }

  read(serial: string): Buffer | undefined {
    const known = this.retained.get(serial);
    if (known) {
      return known.jpeg;
    }
    if (!this.restoreEnabled || this.discardedNames.has(this.name(serial))) {
      return undefined;
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
    this.discardedNames.delete(this.name(serial));
    this.retained.set(serial, { jpeg, provenance, acceptedAtMs: Date.now() });
  }

  /** Removes one entity's persisted and process-local fallback without exposing its opaque filename. */
  discard(serial: string): void {
    this.retained.set(serial, {});
    this.discardedNames.add(this.name(serial));
    this.discardPath(this.file(serial));
  }

  /** Removes images not belonging to the latest complete authoritative inventory. */
  reconcile(serials: Iterable<string>): void {
    const retainedNames = new Set([...serials].map((serial) => this.name(serial)));
    try {
      for (const name of readdirSync(this.directory)) {
        if (/^[0-9a-f]{64}\.jpg$/.test(name) && !retainedNames.has(name)) {
          this.discardedNames.add(name);
          this.discardPath(join(this.directory, name));
        }
      }
    } catch {}
    for (const serial of this.retained.keys()) {
      if (!retainedNames.has(this.name(serial))) {
        this.retained.set(serial, {});
      }
    }
  }

  /** Removes every retained image for explicit account or plugin-data cleanup. */
  discardAll(): void {
    this.retained.clear();
    this.restoreEnabled = false;
    this.discardPath(this.directory, true);
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
        this.reportInvalid();
        this.discardPath(file);
        return undefined;
      }
      const jpeg = readFileSync(file);
      if (isBoundedJpeg(jpeg)) {
        return jpeg;
      }
      this.reportInvalid();
      this.discardPath(file);
      return undefined;
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
      this.remove(staged);
      return false;
    }
  }

  /** A file that cannot be removed is not a reason to fail startup or a snapshot request. */
  private remove(file: string): void {
    try {
      rmSync(file, { force: true });
    } catch {
      return;
    }
  }

  /** Moves discarded data out of the readable namespace before best-effort physical removal. */
  private discardPath(path: string, recursive = false): void {
    const discarded = `${path}.discarded.${process.pid}.${(this.replacements += 1)}`;
    try {
      renameSync(path, discarded);
    } catch {
      try {
        rmSync(path, { force: true, recursive });
      } catch {}
      return;
    }
    try {
      rmSync(discarded, { force: true, recursive });
    } catch {}
  }

  private file(serial: string): string {
    return join(this.directory, this.name(serial));
  }

  private name(serial: string): string {
    return `${createHash('sha256').update(serial).digest('hex')}.jpg`;
  }

  private reportInvalid(): void {
    if (!this.invalidReported) {
      this.invalidReported = true;
      try {
        this.onInvalid?.();
      } catch {}
    }
  }
}
