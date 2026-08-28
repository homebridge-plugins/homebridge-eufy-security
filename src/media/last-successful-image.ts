import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
 * acceptable fallback. Filesystem failures never propagate, because losing a fallback image must not fail a
 * HomeKit request or block startup.
 *
 * No filesystem call here is synchronous. An image is bounded at ten mebibytes and a replacement is flushed
 * to disk, so doing that work on the one thread the whole plugin shares would stall live media, recording and
 * motion delivery on a host whose disk concurrent adaptations are already saturating — the very moment a
 * successful snapshot is most likely. Accepting an image is therefore separated from persisting it: the
 * in-memory image is what this process serves and is claimed at once, and the file only carries one across a
 * restart. That also means a disk that refuses the write no longer discards a good image the process holds.
 */
export class PersistedLastSuccessfulImages {
  private readonly directory: string;
  private readonly retained = new Map<string, RetainedImage>();
  private readonly discardedNames = new Set<string>();
  private replacements = 0;
  private invalidReported = false;
  private restoreEnabled = true;
  /**
   * Filesystem work runs one operation at a time, in the order it was requested.
   *
   * Every operation here replaces or removes a file another one may be reading, so their order is the
   * correctness property: a discard that overtook the write it was meant to undo would leave the image
   * behind, and two replacements landing out of order would leave the file disagreeing with what this
   * process serves. Serializing also bounds what this store contributes to a saturated disk to one bounded
   * image at a time.
   */
  private lane: Promise<unknown> = Promise.resolve();

  constructor(
    storageRoot: string,
    private readonly onInvalid?: () => void,
  ) {
    this.directory = join(storageRoot, SNAPSHOT_DIRECTORY);
  }

  async read(serial: string): Promise<Buffer | undefined> {
    const known = this.retained.get(serial);
    if (known) {
      return known.jpeg;
    }
    if (!this.restoreEnabled || this.discardedNames.has(this.name(serial))) {
      return undefined;
    }
    return this.serialize(async () => {
      const current = this.retained.get(serial);
      if (current) {
        return current.jpeg;
      }
      const restored = await this.restore(serial);
      this.retained.set(serial, restored ? { jpeg: restored } : {});
      return restored;
    });
  }

  /** Accepts one image for this process at once, and resolves when its file has been replaced. */
  async write(serial: string, jpeg: Buffer, provenance: SnapshotProvenance): Promise<void> {
    if (!isBoundedJpeg(jpeg) || !this.accepts(serial, jpeg, provenance)) {
      return;
    }
    this.discardedNames.delete(this.name(serial));
    this.retained.set(serial, { jpeg, provenance, acceptedAtMs: Date.now() });
    await this.serialize(() => this.persist(serial, jpeg));
  }

  /** Removes one entity's persisted and process-local fallback without exposing its opaque filename. */
  async discard(serial: string): Promise<void> {
    this.retained.set(serial, {});
    this.discardedNames.add(this.name(serial));
    await this.serialize(() => this.discardPath(this.file(serial)));
  }

  /** Removes images not belonging to the latest complete authoritative inventory. */
  async reconcile(serials: Iterable<string>): Promise<void> {
    const retainedNames = new Set([...serials].map((serial) => this.name(serial)));
    for (const serial of this.retained.keys()) {
      if (!retainedNames.has(this.name(serial))) {
        this.retained.set(serial, {});
      }
    }
    await this.serialize(async () => {
      let present: string[];
      try {
        present = await readdir(this.directory);
      } catch {
        return;
      }
      for (const name of present) {
        if (/^[0-9a-f]{64}\.jpg$/.test(name) && !retainedNames.has(name)) {
          this.discardedNames.add(name);
          await this.discardPath(join(this.directory, name));
        }
      }
    });
  }

  /** Removes every retained image for explicit account or plugin-data cleanup. */
  async discardAll(): Promise<void> {
    this.retained.clear();
    this.restoreEnabled = false;
    await this.serialize(() => this.discardPath(this.directory, true));
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

  /** Queues one filesystem operation behind whatever this store is already doing. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lane.then(work);
    this.lane = result.catch(() => undefined);
    return result;
  }

  private async restore(serial: string): Promise<Buffer | undefined> {
    const file = this.file(serial);
    try {
      if ((await stat(file)).size > MAXIMUM_IMAGE_BYTES) {
        this.reportInvalid();
        await this.discardPath(file);
        return undefined;
      }
      const jpeg = await readFile(file);
      if (isBoundedJpeg(jpeg)) {
        return jpeg;
      }
      this.reportInvalid();
      await this.discardPath(file);
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Replaces the retained file through a staged copy and a rename, so no reader ever sees a partial image. */
  private async persist(serial: string, jpeg: Buffer): Promise<void> {
    const file = this.file(serial);
    const staged = `${file}.${process.pid}.${(this.replacements += 1)}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await writeFile(staged, jpeg, { mode: 0o600, flush: true });
      await rename(staged, file);
    } catch {
      await this.remove(staged);
    }
  }

  /** A file that cannot be removed is not a reason to fail startup or a snapshot request. */
  private async remove(file: string): Promise<void> {
    try {
      await rm(file, { force: true });
    } catch {
      return;
    }
  }

  /** Moves discarded data out of the readable namespace before best-effort physical removal. */
  private async discardPath(path: string, recursive = false): Promise<void> {
    const discarded = `${path}.discarded.${process.pid}.${(this.replacements += 1)}`;
    try {
      await rename(path, discarded);
    } catch {
      try {
        await rm(path, { force: true, recursive });
      } catch {}
      return;
    }
    try {
      await rm(discarded, { force: true, recursive });
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
