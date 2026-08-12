import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { AccountOwnership } from '../../src/account/ownership.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'homebridge-eufy-ownership-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function spawnOwnershipAttempt(root: string): Promise<{
  child: ChildProcess;
  result: { state: string; pid?: number; owner?: { pid: number } };
}> {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const moduleUrl = pathToFileURL(join(repository, 'src/account/ownership.ts')).href;
  const script = `
    import { AccountOwnership } from ${JSON.stringify(moduleUrl)};
    const result = await new AccountOwnership(process.argv[1]).acquire(process.argv[2], 'runtime');
    process.stdout.write(JSON.stringify(result.state === 'owner' ? { state: result.state, pid: process.pid } : result) + '\\n');
    if (result.state === 'owner') setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, root, 'synthetic-account'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const [output] = (await once(child.stdout!, 'data')) as [Buffer];
  return { child, result: JSON.parse(output.toString()) as { state: string; pid?: number; owner?: { pid: number } } };
}

async function spawnOwner(root: string): Promise<ChildProcess> {
  const attempt = await spawnOwnershipAttempt(root);
  expect(attempt.result).toEqual({ state: 'owner', pid: attempt.child.pid });
  return attempt.child;
}

describe('account SDK ownership', () => {
  it('refuses to share or steal a lease held by a live owner', async () => {
    const root = await temporaryRoot();
    const runtime = await spawnOwner(root);
    const temporaryAuthentication = new AccountOwnership(root);

    const conflict = await temporaryAuthentication.acquire('synthetic-account', 'temporary-authentication');

    expect(conflict).toMatchObject({
      state: 'owner-conflict',
      owner: { kind: 'runtime', pid: runtime.pid },
    });
  });

  it('safely recovers ownership after the previous process stops', async () => {
    const root = await temporaryRoot();
    const previousOwner = await spawnOwner(root);
    previousOwner.kill('SIGKILL');
    await once(previousOwner, 'exit');

    const recovered = await new AccountOwnership(root).acquire('synthetic-account', 'temporary-authentication');
    expect(recovered).toMatchObject({ state: 'owner', recovered: true });
    if (recovered.state === 'owner') {
      await recovered.lease.release();
    }
  });

  it('allows only one winner when processes concurrently recover a stale owner', async () => {
    const root = await temporaryRoot();
    const previousOwner = await spawnOwner(root);
    previousOwner.kill('SIGKILL');
    await once(previousOwner, 'exit');

    const attempts = await Promise.all(Array.from({ length: 6 }, () => spawnOwnershipAttempt(root)));
    const owners = attempts.filter(({ result }) => result.state === 'owner');
    const conflicts = attempts.filter(({ result }) => result.state === 'owner-conflict');

    expect(owners).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    expect(conflicts.every(({ result }) => result.owner?.pid === owners[0]?.child.pid)).toBe(true);
  });

  it('reports stopped when its owner releases the account', async () => {
    const root = await temporaryRoot();
    const ownership = new AccountOwnership(root);
    const acquired = await ownership.acquire('synthetic-account', 'runtime');
    expect(acquired.state).toBe('owner');
    if (acquired.state !== 'owner') {
      return;
    }

    await expect(acquired.lease.release()).resolves.toEqual({ state: 'stopped' });
    await expect(acquired.lease.release()).resolves.toEqual({ state: 'stopped' });
  });

  it('runs release finalization before a successor can acquire ownership', async () => {
    const root = await temporaryRoot();
    const ownership = new AccountOwnership(root);
    const acquired = await ownership.acquire('synthetic-account', 'runtime');
    expect(acquired.state).toBe('owner');
    if (acquired.state !== 'owner') {
      return;
    }
    let successor: ReturnType<AccountOwnership['acquire']> | undefined;
    let successorAcquired = false;

    await acquired.lease.release(() => {
      successor = ownership.acquire('synthetic-account', 'temporary-authentication');
      void successor.then(() => {
        successorAcquired = true;
      });
      expect(successorAcquired).toBe(false);
    });

    expect(successorAcquired).toBe(false);
    const result = await successor;
    expect(result?.state).toBe('owner');
    if (result?.state === 'owner') {
      await result.lease.release();
    }
  });

  it('does not expose the account identifier in its filesystem names', async () => {
    const root = await temporaryRoot();
    const ownership = new AccountOwnership(root);
    const acquired = await ownership.acquire('private-account@example.invalid', 'runtime');
    expect(acquired.state).toBe('owner');

    const entries = await readdir(root, { recursive: true });
    expect(entries.join('/')).not.toContain('private-account@example.invalid');

    if (acquired.state === 'owner') {
      await acquired.lease.release();
    }
  });
});
