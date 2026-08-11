import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PersistedPush, PersistedSession } from '@mega-yfue/eufy-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { AccountSessionPersistence } from '../../src/session-persistence.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'homebridge-eufy-sessions-'));
  roots.push(root);
  return root;
}

function session(userId: string): PersistedSession {
  return {
    userId,
    authToken: `token-${userId}`,
    region: 'US',
    openudid: `openudid-${userId}`,
    shareKey: '00112233445566778899aabbccddeeff',
    keyIdent: `key-${userId}`,
    tokenExpiresAt: 0,
    savedAt: 1,
  } as PersistedSession;
}

function push(id: string): PersistedPush {
  return { creds: { synthetic: id }, persistentIds: [id] } as unknown as PersistedPush;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('account session persistence', () => {
  it('publishes staged account, session, and push state as one active generation', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot());
    expect(await persistence.active()).toBeNull();

    const staging = await persistence.stage('first@example.invalid');
    staging.session.save(session('first'));
    staging.push.save(push('first'));
    await staging.commit();

    const active = await persistence.active();
    expect(active?.account).toBe('first@example.invalid');
    expect(active?.session.load()).toEqual(session('first'));
    expect(active?.push.load()).toEqual(push('first'));
  });

  it('leaves the active account and stores unchanged when staging is discarded', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot());
    const first = await persistence.stage('first@example.invalid');
    first.session.save(session('first'));
    first.push.save(push('first'));
    await first.commit();

    const replacement = await persistence.stage('replacement@example.invalid');
    replacement.session.save(session('replacement'));
    replacement.push.save(push('replacement'));
    await replacement.discard();

    const active = await persistence.active();
    expect(active?.account).toBe('first@example.invalid');
    expect(active?.session.load()).toEqual(session('first'));
    expect(active?.push.load()).toEqual(push('first'));
  });

  it('atomically replaces the active account and both SDK stores after staging succeeds', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot());
    const first = await persistence.stage('first@example.invalid');
    first.session.save(session('first'));
    first.push.save(push('first'));
    await first.commit();

    const replacement = await persistence.stage('replacement@example.invalid');
    replacement.session.save(session('replacement'));
    replacement.push.save(push('replacement'));
    await replacement.commit();

    const active = await persistence.active();
    expect(active?.account).toBe('replacement@example.invalid');
    expect(active?.session.load()).toEqual(session('replacement'));
    expect(active?.push.load()).toEqual(push('replacement'));
  });

  it('does not publish a staged account when commit is cancelled', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot());
    const first = await persistence.stage('first@example.invalid');
    first.session.save(session('first'));
    await first.commit();
    const replacement = await persistence.stage('replacement@example.invalid');
    replacement.session.save(session('replacement'));
    const controller = new AbortController();
    controller.abort();

    await expect(replacement.commit(controller.signal)).rejects.toThrow();
    const active = await persistence.active();
    expect(active?.account).toBe('first@example.invalid');
    expect(active?.session.load()).toEqual(session('first'));
  });

  it('bounds records and atomically preserves the previous record after a failed save', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot(), 512);
    const staging = await persistence.stage('first@example.invalid');
    staging.session.save(session('first'));

    expect(() => staging.session.save(session('x'.repeat(1_000)))).toThrowError('session record exceeds 512 bytes');
    expect(staging.session.load()).toEqual(session('first'));

    await writeFile(join(staging.directory, 'session.json'), 'x'.repeat(513), { mode: 0o600 });
    expect(staging.session.load()).toBeNull();
    await staging.discard();
  });

  it('keeps session storage owner-only', async () => {
    const root = await temporaryRoot();
    const persistence = new AccountSessionPersistence(root);
    const staging = await persistence.stage('first@example.invalid');
    staging.session.save(session('first'));
    staging.push.save(push('first'));
    await staging.commit();

    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const mode = (await stat(join(entry.parentPath, entry.name))).mode & 0o777;
      expect(mode).toBe(entry.isDirectory() ? 0o700 : 0o600);
    }
  });
});
