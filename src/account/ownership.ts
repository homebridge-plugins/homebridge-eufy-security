import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AccountOwnerKind = 'runtime' | 'temporary-authentication';

export interface AccountOwnerEvidence {
  acquiredAt: string;
  kind: AccountOwnerKind;
  pid: number;
}

export type AccountOwnershipResult =
  | { state: 'owner'; lease: AccountLease; recovered: boolean }
  | { state: 'owner-conflict'; owner: AccountOwnerEvidence };

export type AccountReleaseResult = { state: 'stopped' } | { state: 'owner-conflict'; owner: AccountOwnerEvidence };

interface LeaseRecord extends AccountOwnerEvidence {
  processIdentity?: string;
  token: string;
  version: 1;
}

interface OperationRecord {
  choosing: boolean;
  pid: number;
  processIdentity?: string;
  ticket: number;
  token: string;
  version: 1;
}

const GUARD_RETRY_MS = 10;
const GUARD_TIMEOUT_MS = 5_000;

/**
 * How long one of this module's temporary files may exist before it is certainly abandoned.
 *
 * A lease or guard write creates its temporary file and renames it within the same turn, so a surviving
 * temporary file is orders of magnitude older than any write in progress.
 */
const ABANDONED_TEMPORARY_FILE_MS = 60_000;

/**
 * Removes the temporary files interrupted lease and guard writes left behind.
 *
 * `writeAtomically` deletes its own temporary file when a write fails, but a process killed between
 * creating and renaming it never runs that cleanup, so the file would otherwise remain forever and
 * every later guard scan would pay for it. Age alone decides: a temporary file belonging to a live write
 * is milliseconds old, so anything past the staleness window belongs to a process that is gone. Deciding
 * by the process id embedded in the name would have to trust that name and survive process-id reuse.
 *
 * This duplicates `reapAbandonedTemporaryFiles` in `persistence.ts` deliberately. This module has no
 * internal imports so that a bare `node` child process can load it from source, which is how the
 * cross-process ownership contracts prove that a live lease cannot be stolen.
 */
function reapAbandonedTemporaryFiles(directory: string): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) {
      continue;
    }
    const path = join(directory, entry);
    try {
      if (Date.now() - statSync(path).mtimeMs > ABANDONED_TEMPORARY_FILE_MS) {
        rmSync(path, { force: true });
      }
    } catch {
      continue;
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function readProcessIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    const startTime = fields[19];
    return startTime ? `proc:${startTime}` : undefined;
  } catch {
    try {
      const startTime = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim();
      return startTime ? `ps:${createHash('sha256').update(startTime).digest('hex')}` : undefined;
    } catch {
      return undefined;
    }
  }
}

export function isOwnerProcessAlive(record: { pid: number; processIdentity?: string }): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
  const currentIdentity = readProcessIdentity(record.pid);
  return !record.processIdentity || !currentIdentity || record.processIdentity === currentIdentity;
}

/** An acquired account-scoped SDK ownership lease. */
export class AccountLease {
  private readonly ownership: AccountOwnership;
  private readonly accountKey: string;
  private readonly token: string;

  constructor(ownership: AccountOwnership, accountKey: string, token: string) {
    this.ownership = ownership;
    this.accountKey = accountKey;
    this.token = token;
  }

  release(onReleased?: () => void): Promise<AccountReleaseResult> {
    return this.ownership.release(this.accountKey, this.token, onReleased);
  }
}

/** Coordinates exclusive SDK ownership without relying on advisory tracker state. */
export class AccountOwnership {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async acquire(accountScope: string, kind: AccountOwnerKind): Promise<AccountOwnershipResult> {
    if (accountScope.length === 0) {
      throw new Error('accountScope must not be empty');
    }

    const accountKey = createHash('sha256').update(accountScope).digest('hex');
    const accountDirectory = join(this.root, accountKey);
    await this.prepareDirectory(accountDirectory);
    const releaseGuard = await this.acquireGuard(accountDirectory);

    try {
      const ownerPath = join(accountDirectory, 'owner.json');
      const current = await this.readRecord(ownerPath);
      if (current && isOwnerProcessAlive(current)) {
        return { state: 'owner-conflict', owner: this.evidence(current) };
      }

      const record: LeaseRecord = {
        version: 1,
        token: randomUUID(),
        kind,
        pid: process.pid,
        processIdentity: readProcessIdentity(process.pid),
        acquiredAt: new Date().toISOString(),
      };
      await this.writeAtomically(ownerPath, record);
      return {
        state: 'owner',
        recovered: current !== null,
        lease: new AccountLease(this, accountKey, record.token),
      };
    } finally {
      await releaseGuard();
    }
  }

  async release(accountKey: string, token: string, onReleased?: () => void): Promise<AccountReleaseResult> {
    const accountDirectory = join(this.root, accountKey);
    await this.prepareDirectory(accountDirectory);
    const releaseGuard = await this.acquireGuard(accountDirectory);

    try {
      const ownerPath = join(accountDirectory, 'owner.json');
      const current = await this.readRecord(ownerPath);
      if (!current) {
        return { state: 'stopped' };
      }
      if (current.token !== token) {
        return { state: 'owner-conflict', owner: this.evidence(current) };
      }

      await rm(ownerPath, { force: true });
      onReleased?.();
      return { state: 'stopped' };
    } finally {
      await releaseGuard();
    }
  }

  private async prepareDirectory(accountDirectory: string): Promise<void> {
    await mkdir(accountDirectory, { mode: 0o700, recursive: true });
    await chmod(this.root, 0o700);
    await chmod(accountDirectory, 0o700);
    reapAbandonedTemporaryFiles(accountDirectory);
  }

  private async acquireGuard(accountDirectory: string): Promise<() => Promise<void>> {
    const operationsDirectory = join(accountDirectory, 'operations');
    await mkdir(operationsDirectory, { mode: 0o700, recursive: true });
    await chmod(operationsDirectory, 0o700);
    reapAbandonedTemporaryFiles(operationsDirectory);
    const token = randomUUID();
    const operationPath = join(operationsDirectory, `${token}.json`);
    const operation: OperationRecord = {
      version: 1,
      token,
      pid: process.pid,
      processIdentity: readProcessIdentity(process.pid),
      choosing: true,
      ticket: 0,
    };
    const startedAt = Date.now();
    await this.writeAtomically(operationPath, operation);

    const initialRecords = await this.readOperationRecords(operationsDirectory, token);
    operation.choosing = false;
    operation.ticket = initialRecords.reduce((maximum, record) => Math.max(maximum, record.ticket), 0) + 1;
    await this.writeAtomically(operationPath, operation);

    try {
      while (true) {
        const records = await this.readOperationRecords(operationsDirectory, token);
        const predecessor = records.find(
          (record) =>
            record.choosing ||
            record.ticket < operation.ticket ||
            (record.ticket === operation.ticket && record.token < operation.token),
        );
        if (!predecessor) {
          return async () => {
            await rm(operationPath, { force: true });
          };
        }
        if (Date.now() - startedAt >= GUARD_TIMEOUT_MS) {
          throw new Error(`account ownership operation is busy in process ${predecessor.pid}`);
        }
        await new Promise((resolve) => setTimeout(resolve, GUARD_RETRY_MS));
      }
    } catch (error) {
      await rm(operationPath, { force: true });
      throw error;
    }
  }

  private async readOperationRecords(directory: string, ownToken: string): Promise<OperationRecord[]> {
    const records: OperationRecord[] = [];
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith('.json') || entry === `${ownToken}.json`) {
        continue;
      }
      const path = join(directory, entry);
      const record = await this.readOperationRecord(path);
      if (!record) {
        continue;
      }
      if (!isOwnerProcessAlive(record)) {
        await rm(path, { force: true });
      } else {
        records.push(record);
      }
    }
    return records;
  }

  private async writeAtomically(path: string, record: LeaseRecord | OperationRecord): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readRecord(path: string): Promise<LeaseRecord | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseRecord>;
      if (
        value.version !== 1 ||
        typeof value.token !== 'string' ||
        (value.kind !== 'runtime' && value.kind !== 'temporary-authentication') ||
        typeof value.pid !== 'number' ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        !this.isValidProcessIdentity(value.processIdentity) ||
        typeof value.acquiredAt !== 'string'
      ) {
        throw new Error('account ownership lease is malformed');
      }
      return value as LeaseRecord;
    } catch (error) {
      if (this.hasCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }
  }

  private async readOperationRecord(path: string): Promise<OperationRecord | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<OperationRecord>;
      if (
        value.version !== 1 ||
        typeof value.token !== 'string' ||
        typeof value.choosing !== 'boolean' ||
        !Number.isSafeInteger(value.ticket) ||
        value.ticket! < 0 ||
        typeof value.pid !== 'number' ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        !this.isValidProcessIdentity(value.processIdentity)
      ) {
        throw new Error('account ownership operation record is malformed');
      }
      return value as OperationRecord;
    } catch (error) {
      if (this.hasCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }
  }

  private evidence(record: LeaseRecord): AccountOwnerEvidence {
    return { acquiredAt: record.acquiredAt, kind: record.kind, pid: record.pid };
  }

  private isValidProcessIdentity(value: unknown): value is string | undefined {
    return value === undefined || (typeof value === 'string' && /^(?:proc:\d+|ps:[0-9a-f]{64})$/.test(value));
  }

  private hasCode(error: unknown, code: string): boolean {
    return hasCode(error, code);
  }
}
