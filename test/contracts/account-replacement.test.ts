import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PersistedPush, PersistedSession } from '@mega-yfue/eufy-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../src/configuration.js';
import { AccountSessionPersistence, type AccountPersistenceBoundary } from '../../src/account/persistence.js';
import { TemporaryAuthentication } from '../../src/account/temporary-authentication.js';
import { discoverCompleteDeviceSnapshot, type CompleteDeviceSnapshot } from '../../src/device/snapshot.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'homebridge-eufy-replacement-'));
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

function configuration(account: string, serial: string) {
  return parseConfig({
    platform: 'EufySecurity',
    username: account,
    password: `password-${account}`,
    country: 'US',
    trustedDeviceName: 'Synthetic Homebridge',
    pollingIntervalMinutes: 10,
    ffmpegPath: '/synthetic/ffmpeg',
    entityPreferences: {
      [serial]: { represented: false, snapshotMode: 'Cloud' },
    },
  });
}

function snapshot(serial: string): CompleteDeviceSnapshot {
  return {
    version: 1,
    complete: true,
    devices: [
      {
        sn: serial,
        name: `Device ${serial}`,
        model: 'T0000',
        modelName: 'Synthetic Device',
        codec: 'camera',
        source: 'model',
        bound: true,
        capabilities: [],
        details: [],
      },
    ],
  };
}

async function saveGeneration(persistence: AccountSessionPersistence, account: string, serial: string): Promise<void> {
  const staging = await persistence.stage(account);
  staging.session.save(session(account));
  staging.push.save(push(account));
  staging.configuration.save(configuration(account, serial));
  staging.snapshot.save(snapshot(serial));
  await staging.commit();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('atomic account replacement', () => {
  it('publishes stores, normalized configuration, preferences, and a complete snapshot together', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot());

    await saveGeneration(persistence, 'replacement@example.invalid', 'replacement-device');

    const active = await persistence.active();
    expect(active?.account).toBe('replacement@example.invalid');
    expect(active?.session.load()).toEqual(session('replacement@example.invalid'));
    expect(active?.push.load()).toEqual(push('replacement@example.invalid'));
    expect(active?.configuration.load()).toEqual(configuration('replacement@example.invalid', 'replacement-device'));
    expect(active?.snapshot.load()).toEqual(snapshot('replacement-device'));
  });

  it.each<AccountPersistenceBoundary>([
    'session-record',
    'push-record',
    'configuration-record',
    'device-snapshot-record',
    'generation-publication',
    'active-generation-record',
    'active-generation-publication',
  ])('keeps the prior active generation usable when %s persistence fails', async (boundary) => {
    const root = await temporaryRoot();
    let injectedBoundary: AccountPersistenceBoundary | undefined;
    const persistence = new AccountSessionPersistence(root, undefined, {
      before(boundaryName) {
        if (injectedBoundary === boundaryName) {
          throw new Error(`injected ${boundaryName} failure`);
        }
      },
    });
    await saveGeneration(persistence, 'active@example.invalid', 'retained-device');
    injectedBoundary = boundary;

    await expect(saveGeneration(persistence, 'replacement@example.invalid', 'replacement-device')).rejects.toThrow(
      `injected ${boundary} failure`,
    );

    const active = await new AccountSessionPersistence(root).active();
    expect(active?.account).toBe('active@example.invalid');
    expect(active?.session.load()).toEqual(session('active@example.invalid'));
    expect(active?.push.load()).toEqual(push('active@example.invalid'));
    expect(active?.configuration.load()).toEqual(configuration('active@example.invalid', 'retained-device'));
    expect(active?.snapshot.load()).toEqual(snapshot('retained-device'));
  });

  it('discovers a complete snapshot before publishing and requires restart after releasing ownership', async () => {
    const calls: string[] = [];
    const config = configuration('replacement@example.invalid', 'retained-device');
    const discovered = snapshot('replacement-device');
    const stores = {
      account: 'replacement@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      configuration: { load: () => null, save: vi.fn(() => calls.push('save-configuration')), clear: vi.fn() },
      snapshot: { load: () => null, save: vi.fn(() => calls.push('save-snapshot')), clear: vi.fn() },
      commit: vi.fn(async () => calls.push('commit')),
      discard: vi.fn(async () => calls.push('discard')),
    };
    const authentication = new TemporaryAuthentication(
      {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: {
            release: vi.fn(async () => {
              calls.push('release');
              return { state: 'stopped' as const };
            }),
          },
          recovered: false,
        })),
      },
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(async () => ({
          status: 'ok',
          session: { userId: 'synthetic-user', authToken: 'synthetic-token', raw: {} },
        })),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        discover: vi.fn(async () => {
          calls.push('discover');
          return discovered;
        }),
        disconnect: vi.fn(async () => calls.push('disconnect')),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(authentication.start({ configuration: config })).resolves.toEqual({ status: 'restart-required' });
    expect(stores.configuration.save).toHaveBeenCalledWith(config);
    expect(stores.snapshot.save).toHaveBeenCalledWith(discovered);
    expect(calls).toEqual(['discover', 'save-configuration', 'save-snapshot', 'disconnect', 'commit', 'release']);
  });

  it('discards staged state when complete discovery fails', async () => {
    const config = configuration('replacement@example.invalid', 'retained-device');
    const stores = {
      account: 'replacement@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      configuration: { load: () => null, save: vi.fn(), clear: vi.fn() },
      snapshot: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const authentication = new TemporaryAuthentication(
      { acquire: vi.fn(async () => ({ state: 'owner' as const, lease: { release }, recovered: false })) },
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(async () => ({
          status: 'ok',
          session: { userId: 'synthetic-user', authToken: 'synthetic-token', raw: {} },
        })),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        discover: vi.fn(async () => {
          throw new Error('partial inventory');
        }),
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(authentication.start({ configuration: config })).resolves.toEqual({ status: 'failed' });
    expect(stores.commit).not.toHaveBeenCalled();
    expect(stores.configuration.save).not.toHaveBeenCalled();
    expect(stores.snapshot.save).not.toHaveBeenCalled();
    expect(stores.discard).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains authoritative absent-device preferences when the Homebridge mirror is stale', async () => {
    const activeConfig = configuration('active@example.invalid', 'retained-device');
    const candidate = configuration('replacement@example.invalid', 'replacement-device');
    const savedConfiguration = vi.fn();
    const stores = {
      account: 'replacement@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      configuration: { load: () => null, save: savedConfiguration, clear: vi.fn() },
      snapshot: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const authentication = new TemporaryAuthentication(
      {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release: vi.fn(async () => ({ state: 'stopped' as const })) },
          recovered: false,
        })),
      },
      {
        active: vi.fn(async () => ({ account: 'active@example.invalid', configuration: { load: () => activeConfig } })),
        stage: vi.fn(async () => stores),
      },
      () => ({
        login: vi.fn(async () => ({
          status: 'ok',
          session: { userId: 'synthetic-user', authToken: 'synthetic-token', raw: {} },
        })),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        discover: vi.fn(async () => snapshot('replacement-device')),
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(authentication.start({ configuration: candidate })).resolves.toEqual({ status: 'restart-required' });
    expect(savedConfiguration).toHaveBeenCalledWith({
      ...activeConfig,
      username: 'replacement@example.invalid',
      password: 'password-replacement@example.invalid',
      entityPreferences: {
        'replacement-device': { represented: false, snapshotMode: 'Cloud' },
        'retained-device': { represented: false, snapshotMode: 'Cloud' },
      },
    });
  });

  it('rejects a tolerated SDK inventory error instead of publishing a partial snapshot', async () => {
    let errorListener: ((error: Error) => void) | undefined;
    const manifest = snapshot('listed-device').devices[0];
    const client = {
      on: vi.fn((_event: 'error', listener: (error: Error) => void) => {
        errorListener = listener;
      }),
      off: vi.fn(),
      getDevices: vi.fn(async () => {
        errorListener?.(new Error('synthetic house query failure'));
        return [{ sn: 'listed-device' }];
      }),
      getDevice: vi.fn(async () => ({ describe: () => manifest })),
    };

    await expect(discoverCompleteDeviceSnapshot(client)).rejects.toThrow('incomplete device discovery');
    expect(client.getDevice).toHaveBeenCalledWith('listed-device');
    expect(client.off).toHaveBeenCalledWith('error', errorListener);
  });

  it('rejects malformed nested members when reopening a persisted snapshot', async () => {
    const persistence = new AccountSessionPersistence(await temporaryRoot());
    await saveGeneration(persistence, 'active@example.invalid', 'active-device');
    const active = await persistence.active();

    active?.snapshot.save({
      version: 1,
      complete: true,
      devices: [
        {
          ...snapshot('active-device').devices[0],
          details: [{ capability: 'camera', accessor: 'camera', reads: 'malformed' }],
        },
      ],
    } as never);

    expect(active?.snapshot.load()).toBeNull();
  });
});
