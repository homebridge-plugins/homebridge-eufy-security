import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveStorageRoot, STORAGE_DIRECTORY } from '../../src/storage.js';

const roots: string[] = [];

async function storagePath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'homebridge-eufy-storage-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('plugin storage root', () => {
  it('uses the Homebridge Eufy product name for fresh state', async () => {
    const homebridge = await storagePath();

    expect(resolveStorageRoot(homebridge)).toBe(join(homebridge, STORAGE_DIRECTORY));
    expect(STORAGE_DIRECTORY).toBe('homebridge-eufy');
  });

  it('atomically adopts V5 state from its pre-rename directory', async () => {
    const homebridge = await storagePath();
    const legacy = join(homebridge, 'eufy-security');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'synthetic-state'), 'preserved');

    const resolved = resolveStorageRoot(homebridge);

    expect(resolved).toBe(join(homebridge, 'homebridge-eufy'));
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(resolved, 'synthetic-state'), 'utf8')).toBe('preserved');
  });

  it('keeps using the old path while a live SDK owner holds it', async () => {
    const homebridge = await storagePath();
    const legacy = join(homebridge, 'eufy-security');
    const ownership = join(legacy, 'ownership', 'synthetic-account');
    mkdirSync(ownership, { recursive: true });
    writeFileSync(
      join(ownership, 'owner.json'),
      JSON.stringify({ version: 1, kind: 'runtime', pid: process.pid, acquiredAt: new Date().toISOString() }),
    );

    expect(resolveStorageRoot(homebridge)).toBe(legacy);
    expect(existsSync(join(homebridge, 'homebridge-eufy'))).toBe(false);
  });

  it('fails closed instead of merging two storage roots', async () => {
    const homebridge = await storagePath();
    mkdirSync(join(homebridge, 'eufy-security'));
    mkdirSync(join(homebridge, 'homebridge-eufy'));

    expect(() => resolveStorageRoot(homebridge)).toThrow(
      'both homebridge-eufy and eufy-security storage directories exist',
    );
  });
});
