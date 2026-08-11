import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { FcmStore, PersistedPush, PersistedSession, SessionStore } from '@mega-yfue/eufy-sdk';

const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

interface ActiveGenerationRecord {
  account: string;
  generation: string;
  version: 1;
}

export interface ActiveAccountStores {
  account: string;
  push: FcmStore;
  session: SessionStore;
}

function writeJsonAtomically(path: string, value: unknown, label: string, maxBytes: number): void {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) {
    throw new Error(`${label} record exceeds ${maxBytes} bytes`);
  }

  const directory = dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }
}

function readJsonBounded(path: string, maxBytes: number): unknown | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      return null;
    }
    return JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

class AtomicJsonStore<T> {
  constructor(
    private readonly path: string,
    private readonly label: string,
    private readonly maxBytes: number,
  ) {}

  load(): T | null {
    return readJsonBounded(this.path, this.maxBytes) as T | null;
  }

  save(value: T): void {
    writeJsonAtomically(this.path, value, this.label, this.maxBytes);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

/** Isolated session and push stores for one pending authentication result. */
export class StagedAccountStores implements ActiveAccountStores {
  readonly push: FcmStore;
  readonly session: SessionStore;
  private settled = false;

  constructor(
    readonly account: string,
    private readonly persistence: AccountSessionPersistence,
    private readonly generation: string,
    readonly directory: string,
    maxRecordBytes: number,
  ) {
    this.session = new AtomicJsonStore<PersistedSession>(join(directory, 'session.json'), 'session', maxRecordBytes);
    this.push = new AtomicJsonStore<PersistedPush>(join(directory, 'push.json'), 'push', maxRecordBytes);
  }

  async commit(): Promise<void> {
    if (this.settled) {
      throw new Error('staged account stores are already settled');
    }
    await this.persistence.commit(this);
    this.settled = true;
  }

  async discard(): Promise<void> {
    if (!this.settled) {
      await rm(this.directory, { force: true, recursive: true });
      this.settled = true;
    }
  }

  getGeneration(): string {
    return this.generation;
  }
}

/** Owns bounded active and staging stores used by SDK owners before any runtime connection exists. */
export class AccountSessionPersistence {
  constructor(
    private readonly root: string,
    private readonly maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  ) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0 || maxRecordBytes > MAX_RECORD_BYTES) {
      throw new Error(`maxRecordBytes must be between 1 and ${MAX_RECORD_BYTES}`);
    }
  }

  async active(): Promise<ActiveAccountStores | null> {
    await this.prepareRoot();
    const active = await this.readActiveGeneration();
    if (!active) {
      return null;
    }
    const directory = join(this.root, 'generations', active.generation);
    return this.stores(active.account, directory);
  }

  async stage(account: string): Promise<StagedAccountStores> {
    if (account.length === 0 || Buffer.byteLength(account) > this.maxRecordBytes / 2) {
      throw new Error('account identifier is empty or too large');
    }
    await this.prepareRoot();
    const stagingRoot = join(this.root, 'staging');
    await rm(stagingRoot, { force: true, recursive: true });
    await mkdir(stagingRoot, { mode: 0o700, recursive: true });
    await chmod(stagingRoot, 0o700);
    const generation = randomUUID();
    const directory = join(stagingRoot, generation);
    await mkdir(directory, { mode: 0o700 });
    return new StagedAccountStores(account, this, generation, directory, this.maxRecordBytes);
  }

  async commit(staging: StagedAccountStores): Promise<void> {
    const generationsRoot = join(this.root, 'generations');
    await mkdir(generationsRoot, { mode: 0o700, recursive: true });
    await chmod(generationsRoot, 0o700);
    const generation = staging.getGeneration();
    const destination = join(generationsRoot, generation);
    await rename(staging.directory, destination);

    try {
      await this.writeActiveGeneration({ version: 1, account: staging.account, generation });
    } catch (error) {
      await rm(destination, { force: true, recursive: true });
      throw error;
    }

    try {
      const generations = await readdir(generationsRoot);
      await Promise.allSettled(
        generations
          .filter((candidate) => candidate !== generation)
          .map((candidate) => rm(join(generationsRoot, candidate), { force: true, recursive: true })),
      );
    } catch {}
  }

  private stores(account: string, directory: string): ActiveAccountStores {
    return {
      account,
      session: new AtomicJsonStore<PersistedSession>(join(directory, 'session.json'), 'session', this.maxRecordBytes),
      push: new AtomicJsonStore<PersistedPush>(join(directory, 'push.json'), 'push', this.maxRecordBytes),
    };
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.root, { mode: 0o700, recursive: true });
    await chmod(this.root, 0o700);
  }

  private async readActiveGeneration(): Promise<ActiveGenerationRecord | null> {
    const value = readJsonBounded(
      join(this.root, 'active.json'),
      this.maxRecordBytes,
    ) as Partial<ActiveGenerationRecord>;
    if (
      value === null ||
      value.version !== 1 ||
      typeof value.account !== 'string' ||
      typeof value.generation !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.generation)
    ) {
      return null;
    }
    return value as ActiveGenerationRecord;
  }

  private async writeActiveGeneration(record: ActiveGenerationRecord): Promise<void> {
    writeJsonAtomically(join(this.root, 'active.json'), record, 'active account', this.maxRecordBytes);
  }
}
