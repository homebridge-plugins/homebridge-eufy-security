import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeviceManifest, EufyMega, PersistedSession } from '@mega-yfue/eufy-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountOwnership } from '../../src/account-ownership.js';
import { parseConfig } from '../../src/configuration.js';
import type { CompleteDeviceSnapshot } from '../../src/device-snapshot.js';
import { createEufyPlatform, type PlatformLifecycleEvent } from '../../src/platform.js';
import { RuntimeTracker } from '../../src/runtime-tracker.js';
import { AccountSessionPersistence } from '../../src/session-persistence.js';
import type { SdkClient } from '../../src/sdk-client.js';
import { PersistedSdkClient } from '../../src/sdk-client.js';

const roots: string[] = [];

function manifest(serial: string): DeviceManifest {
  return {
    sn: serial,
    name: 'Synthetic device',
    modelName: 'Synthetic model',
    codec: 'unknown',
    source: 'security',
    bound: true,
    capabilities: [],
    details: [],
  };
}

function snapshot(serial: string): CompleteDeviceSnapshot {
  return { version: 1, complete: true, devices: [manifest(serial)] };
}

function session(): PersistedSession {
  return {
    userId: 'synthetic-user',
    authToken: 'synthetic-token',
    region: 'US',
    openudid: 'synthetic-openudid',
    shareKey: '00112233445566778899aabbccddeeff',
    keyIdent: 'synthetic-key',
    tokenExpiresAt: 0,
    savedAt: 1,
  } as PersistedSession;
}

async function activeRuntime(withSession = true): Promise<{
  directory: string;
  persistence: AccountSessionPersistence;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'eufy-runtime-owner-'));
  roots.push(directory);
  const persistence = new AccountSessionPersistence(join(directory, 'eufy-security', 'accounts'));
  const staging = await persistence.stage('runtime@example.invalid');
  staging.configuration.save(
    parseConfig({
      platform: 'EufySecurity',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    }),
  );
  if (withSession) {
    staging.session.save(session());
  }
  staging.snapshot.save(snapshot('synthetic-old'));
  await staging.commit();
  return { directory, persistence };
}

function lifecycle() {
  const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
  return {
    listeners,
    api(directory: string) {
      return {
        on(event: PlatformLifecycleEvent, listener: () => void): void {
          listeners[event] = listener;
        },
        user: { storagePath: () => directory },
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('persisted runtime owner', () => {
  it('acquires once and publishes a complete snapshot before becoming ready', async () => {
    const { directory, persistence } = await activeRuntime();
    const active = await persistence.active();
    const nextSnapshot = snapshot('synthetic-current');
    const client: SdkClient = {
      start: vi.fn(async () => ({
        state: 'ready' as const,
        registry: new Map([['synthetic-current', { describe: () => manifest('synthetic-current') }]]),
        snapshot: nextSnapshot,
      })),
      stop: vi.fn(async () => undefined),
    };
    const factory = vi.fn(() => client);
    const acquire = vi.spyOn(AccountOwnership.prototype, 'acquire');
    const events = lifecycle();
    const Platform = createEufyPlatform(factory);

    new Platform({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, { platform: 'EufySecurity' }, events.api(directory));
    events.listeners.didFinishLaunching?.();
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'eufy-security', 'tracker.json'));
    await vi.waitFor(
      async () =>
        await expect(tracker.read()).resolves.toMatchObject({
          state: 'ready',
          generation: active?.generation,
          complete: true,
          snapshot: nextSnapshot,
        }),
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ account: 'runtime@example.invalid', generation: active?.generation }),
    );
    expect(client.start).toHaveBeenCalledOnce();
    expect((await persistence.active())?.snapshot.load()).toEqual(nextSnapshot);
    acquire.mockRestore();
  });

  it('enters authentication-required without constructing a client when the active session is missing', async () => {
    const { directory } = await activeRuntime(false);
    const events = lifecycle();
    const factory = vi.fn();
    const Platform = createEufyPlatform(factory);

    new Platform({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, { platform: 'EufySecurity' }, events.api(directory));
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'eufy-security', 'tracker.json'));
    await vi.waitFor(
      async () => await expect(tracker.read()).resolves.toMatchObject({ state: 'authentication-required' }),
    );
    expect(factory).not.toHaveBeenCalled();
    const ownership = new AccountOwnership(join(directory, 'eufy-security', 'ownership'));
    const result = await ownership.acquire('runtime@example.invalid', 'temporary-authentication');
    expect(result.state).toBe('owner');
    if (result.state === 'owner') {
      await result.lease.release();
    }
  });

  it('preserves the latest complete snapshot when current inventory is partial', async () => {
    const { directory, persistence } = await activeRuntime();
    const client: SdkClient = {
      start: vi.fn(async () => ({ state: 'degraded' as const })),
      stop: vi.fn(async () => undefined),
    };
    const events = lifecycle();
    const Platform = createEufyPlatform(() => client);

    new Platform({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, { platform: 'EufySecurity' }, events.api(directory));
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'eufy-security', 'tracker.json'));
    await vi.waitFor(
      async () =>
        await expect(tracker.read()).resolves.toMatchObject({
          state: 'degraded',
          complete: false,
          snapshot: snapshot('synthetic-old'),
        }),
    );
    expect((await persistence.active())?.snapshot.load()).toEqual(snapshot('synthetic-old'));
  });

  it('retains a newly published complete snapshot when a later refresh is partial', async () => {
    const { directory, persistence } = await activeRuntime();
    let reportInventory: ((result: { state: 'degraded' }) => void) | undefined;
    const current = snapshot('synthetic-current');
    const client: SdkClient = {
      onInventory(listener): void {
        reportInventory = listener;
      },
      start: vi.fn(async () => ({
        state: 'ready' as const,
        registry: new Map([['synthetic-current', { describe: () => manifest('synthetic-current') }]]),
        snapshot: current,
      })),
      stop: vi.fn(async () => undefined),
    };
    const events = lifecycle();
    const Platform = createEufyPlatform(() => client);

    new Platform({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, { platform: 'EufySecurity' }, events.api(directory));
    events.listeners.didFinishLaunching?.();
    const tracker = new RuntimeTracker(join(directory, 'eufy-security', 'tracker.json'));
    await vi.waitFor(async () => await expect(tracker.read()).resolves.toMatchObject({ state: 'ready' }));

    reportInventory?.({ state: 'degraded' });

    await vi.waitFor(
      async () => await expect(tracker.read()).resolves.toMatchObject({ state: 'degraded', snapshot: current }),
    );
    expect((await persistence.active())?.snapshot.load()).toEqual(current);
  });

  it('cleans up a client and lease when the persisted session is rejected', async () => {
    const { directory } = await activeRuntime();
    const client: SdkClient = {
      start: vi.fn(async () => ({ state: 'authentication-required' as const })),
      stop: vi.fn(async () => undefined),
    };
    const factory = vi.fn(() => client);
    const events = lifecycle();
    const Platform = createEufyPlatform(factory);

    new Platform({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, { platform: 'EufySecurity' }, events.api(directory));
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'eufy-security', 'tracker.json'));
    await vi.waitFor(
      async () => await expect(tracker.read()).resolves.toMatchObject({ state: 'authentication-required' }),
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    const ownership = new AccountOwnership(join(directory, 'eufy-security', 'ownership'));
    const result = await ownership.acquire('runtime@example.invalid', 'temporary-authentication');
    expect(result.state).toBe('owner');
    if (result.state === 'owner') {
      await result.lease.release();
    }
  });

  it('reports owner conflict without constructing or stopping a client or stealing the live lease', async () => {
    const { directory, persistence } = await activeRuntime();
    const ownership = new AccountOwnership(join(directory, 'eufy-security', 'ownership'));
    const held = await ownership.acquire('runtime@example.invalid', 'runtime');
    expect(held.state).toBe('owner');
    const active = await persistence.active();
    const tracker = new RuntimeTracker(join(directory, 'eufy-security', 'tracker.json'));
    tracker.start('ready', {
      generation: active?.generation,
      complete: true,
      snapshot: active?.snapshot.load() ?? undefined,
    });
    const events = lifecycle();
    const factory = vi.fn();
    const error = vi.fn();
    const Platform = createEufyPlatform(factory);

    try {
      new Platform({ error, info: vi.fn(), warn: vi.fn() }, { platform: 'EufySecurity' }, events.api(directory));
      events.listeners.didFinishLaunching?.();

      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith('Eufy SDK startup blocked by another live account owner'),
      );
      await expect(tracker.read()).resolves.toMatchObject({ state: 'ready' });
      expect(factory).not.toHaveBeenCalled();
      await expect(ownership.acquire('runtime@example.invalid', 'temporary-authentication')).resolves.toMatchObject({
        state: 'owner-conflict',
        owner: { kind: 'runtime' },
      });
      events.listeners.shutdown?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(tracker.read()).resolves.toMatchObject({ state: 'ready' });
    } finally {
      tracker.stop();
      if (held.state === 'owner') {
        await held.lease.release();
      }
    }
  });

  it('never calls login when the persisted session is not locally accepted by the SDK', async () => {
    const { persistence } = await activeRuntime();
    const active = await persistence.active();
    expect(active).not.toBeNull();
    const login = vi.fn();
    const client = {
      loggedIn: false,
      login,
      on: vi.fn(),
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'EufySecurity',
        username: 'runtime@example.invalid',
        password: 'persisted-password',
      }),
      active!,
      client,
    );

    await expect(runtime.start()).resolves.toEqual({ state: 'authentication-required' });
    expect(login).not.toHaveBeenCalled();
  });

  it('installs listeners before accepted-session inventory and builds one canonical registry pass', async () => {
    const { persistence } = await activeRuntime();
    const active = await persistence.active();
    expect(active).not.toBeNull();
    const calls: string[] = [];
    const login = vi.fn(async () => {
      calls.push('login');
      return { status: 'ok' as const, raw: { restored: true } };
    });
    const getDevices = vi.fn(async () => {
      calls.push('getDevices');
      return [{ sn: 'synthetic-current' }];
    });
    const getDevice = vi.fn(async () => {
      calls.push('getDevice');
      return { describe: () => manifest('synthetic-current') };
    });
    const client = {
      loggedIn: true,
      login,
      on: vi.fn((event: string) => {
        calls.push(`on:${event}`);
      }),
      off: vi.fn(),
      getDevices,
      getDevice,
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'EufySecurity',
        username: 'runtime@example.invalid',
        password: 'persisted-password',
      }),
      active!,
      client,
    );

    await expect(runtime.start()).resolves.toMatchObject({
      state: 'ready',
      snapshot: snapshot('synthetic-current'),
    });
    expect(calls.slice(0, 5)).toEqual([
      'on:error',
      'on:event',
      'on:deviceAdded',
      'on:deviceRemoved',
      'on:deviceCapabilities',
    ]);
    expect(calls.indexOf('login')).toBeLessThan(calls.indexOf('getDevices'));
    expect(getDevices).toHaveBeenCalledOnce();
    expect(getDevice).toHaveBeenCalledExactlyOnceWith('synthetic-current');
  });
});
