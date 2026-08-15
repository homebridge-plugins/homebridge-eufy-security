import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { PersistedSession } from '@mega-yfue/eufy-sdk';

import { AccountOwnership } from '../../src/account/ownership.js';
import { parseConfig } from '../../src/configuration.js';
import { AccountSessionPersistence } from '../../src/account/persistence.js';
import type { SdkClient } from '../../src/runtime/sdk-client.js';
import { createEufyPlatform, type PlatformLifecycleEvent } from '../../src/platform.js';
import { RuntimeTracker } from '../../src/runtime/tracker.js';

describe('platform lifecycle', () => {
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

  it('passes validated V5 configuration to its SDK client factory', () => {
    const client: SdkClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const clientFactory = vi.fn(() => client);
    const Platform = createEufyPlatform(clientFactory);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      {
        platform: 'HomebridgeEufy',
        country: 'ca',
        entityPreferences: { 'synthetic-absent-entity': { represented: false } },
      },
      { on: vi.fn() },
    );

    expect(clientFactory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        country: 'CA',
        entityPreferences: { 'synthetic-absent-entity': { represented: false } },
      }),
    );
  });

  it('warns once per startup while discarded V4 settings await acknowledgement', () => {
    const warn = vi.fn();
    const Platform = createEufyPlatform(() => ({ start: vi.fn(), stop: vi.fn() }));

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn },
      {
        platform: 'HomebridgeEufy',
        discardedV4Settings: ['cameras', 'ignoreDevices'],
      },
      { on: vi.fn() },
    );

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Discarded V4 settings need acknowledgement in the Homebridge Eufy dashboard',
    );

    const acknowledgedWarn = vi.fn();
    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: acknowledgedWarn },
      {
        platform: 'HomebridgeEufy',
        discardedV4Settings: ['cameras'],
        discardedV4Acknowledged: true,
      },
      { on: vi.fn() },
    );
    expect(acknowledgedWarn).not.toHaveBeenCalled();
  });

  it('starts its SDK client after Homebridge finishes launching', async () => {
    const client: SdkClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const Platform = createEufyPlatform(() => client);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      {
        on(event, listener): void {
          listeners[event] = listener;
        },
      },
    );
    listeners.didFinishLaunching?.();
    listeners.didFinishLaunching?.();

    await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
  });

  it('publishes fresh runtime evidence until the SDK client stops', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eufy-platform-runtime-'));
    const persistence = new AccountSessionPersistence(join(directory, 'homebridge-eufy', 'accounts'));
    const staging = await persistence.stage('guest@example.invalid');
    staging.configuration.save(
      parseConfig({ platform: 'HomebridgeEufy', username: 'guest@example.invalid', password: 'synthetic-password' }),
    );
    staging.session.save(session());
    await staging.commit();
    const client: SdkClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const Platform = createEufyPlatform(() => client);

    try {
      new Platform(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        { platform: 'HomebridgeEufy', username: 'guest@example.invalid' },
        {
          on(event, listener): void {
            listeners[event] = listener;
          },
          user: { storagePath: () => directory },
        },
      );
      const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));

      listeners.didFinishLaunching?.();
      await vi.waitFor(async () => await expect(tracker.fresh()).resolves.toMatchObject({ state: 'starting' }));
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
      const ownership = new AccountOwnership(join(directory, 'homebridge-eufy', 'ownership'));
      await expect(ownership.acquire('guest@example.invalid', 'temporary-authentication')).resolves.toMatchObject({
        state: 'owner-conflict',
        owner: { kind: 'runtime' },
      });
      listeners.shutdown?.();
      await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
      await vi.waitFor(async () => await expect(tracker.fresh()).resolves.toBeNull());
      const acquired = await ownership.acquire('guest@example.invalid', 'temporary-authentication');
      expect(acquired.state).toBe('owner');
      if (acquired.state === 'owner') {
        await acquired.lease.release();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('acquires the atomically published replacement account only after a normal restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eufy-platform-replacement-'));
    const root = join(directory, 'homebridge-eufy');
    const persistence = new AccountSessionPersistence(join(root, 'accounts'));
    const replacementConfig = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'replacement@example.invalid',
      password: 'synthetic-password',
      country: 'CA',
      trustedDeviceName: 'Replacement Homebridge',
      entityPreferences: { 'absent-device': { represented: false } },
    });
    const staging = await persistence.stage('replacement@example.invalid');
    staging.configuration.save(replacementConfig);
    staging.session.save(session());
    staging.snapshot.save({ version: 1, complete: true, devices: [] });
    await staging.commit();
    const client: SdkClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const clientFactory = vi.fn(() => client);
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const Platform = createEufyPlatform(clientFactory);

    try {
      new Platform(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        { platform: 'HomebridgeEufy', username: 'old@example.invalid', password: 'old-password' },
        {
          on(event, listener): void {
            listeners[event] = listener;
          },
          user: { storagePath: () => directory },
        },
      );
      expect(clientFactory).not.toHaveBeenCalled();

      listeners.didFinishLaunching?.();

      await vi.waitFor(() =>
        expect(clientFactory).toHaveBeenCalledExactlyOnceWith(
          replacementConfig,
          expect.objectContaining({ account: 'replacement@example.invalid' }),
          expect.objectContaining({
            error: expect.any(Function),
            info: expect.any(Function),
            warn: expect.any(Function),
          }),
        ),
      );
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
      const ownership = new AccountOwnership(join(root, 'ownership'));
      await expect(ownership.acquire('replacement@example.invalid', 'temporary-authentication')).resolves.toMatchObject(
        {
          state: 'owner-conflict',
          owner: { kind: 'runtime' },
        },
      );
      const oldAccount = await ownership.acquire('old@example.invalid', 'temporary-authentication');
      expect(oldAccount.state).toBe('owner');
      if (oldAccount.state === 'owner') {
        await oldAccount.lease.release();
      }
      listeners.shutdown?.();
      await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
      let acquiredAfterShutdown: Awaited<ReturnType<AccountOwnership['acquire']>> | undefined;
      await vi.waitFor(async () => {
        const result = await ownership.acquire('replacement@example.invalid', 'temporary-authentication');
        if (result.state !== 'owner') {
          throw new Error('runtime ownership has not been released');
        }
        acquiredAfterShutdown = result;
      });
      if (acquiredAfterShutdown?.state === 'owner') {
        await acquiredAfterShutdown.lease.release();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('contains and reports SDK client startup failures', async () => {
    const client: SdkClient = {
      start: vi.fn().mockRejectedValue(new Error('synthetic startup failure')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const error = vi.fn();
    const Platform = createEufyPlatform(() => client);

    new Platform(
      { error, info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      {
        on(event, listener): void {
          listeners[event] = listener;
        },
      },
    );
    listeners.didFinishLaunching?.();

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledExactlyOnceWith('Eufy SDK startup failed: synthetic startup failure'),
    );
  });

  it('bounds shutdown when the SDK client does not stop', async () => {
    vi.useFakeTimers();
    const client: SdkClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockReturnValue(new Promise<void>(() => {})),
    };
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const warn = vi.fn();
    const Platform = createEufyPlatform(() => client, 1_000);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn },
      { platform: 'HomebridgeEufy' },
      {
        on(event, listener): void {
          listeners[event] = listener;
        },
      },
    );
    listeners.shutdown?.();
    listeners.shutdown?.();

    expect(client.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Eufy SDK shutdown exceeded 1000ms; Homebridge shutdown will continue',
    );
    vi.useRealTimers();
  });

  it('disconnects an in-progress startup without waiting for its deadline', async () => {
    vi.useFakeTimers();
    let finishStartup: (() => void) | undefined;
    const client: SdkClient = {
      start: vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finishStartup = resolve;
        }),
      ),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const Platform = createEufyPlatform(() => client, 1_000);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      {
        on(event, listener): void {
          listeners[event] = listener;
        },
      },
    );
    listeners.didFinishLaunching?.();
    listeners.shutdown?.();

    expect(client.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    finishStartup?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each(['SIGHUP', 'SIGINT', 'SIGTERM'] as const)(
    'routes %s and Homebridge shutdown through one runtime cleanup',
    async (signal) => {
      const client: SdkClient = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const lifecycleListeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
      const signalListeners = new Map<string, () => void>();
      const signalTarget = {
        on: vi.fn((event: string, listener: () => void) => signalListeners.set(event, listener)),
        off: vi.fn((event: string, listener: () => void) => {
          if (signalListeners.get(event) === listener) {
            signalListeners.delete(event);
          }
        }),
      };
      const Platform = createEufyPlatform(() => client, 10_000, signalTarget);

      new Platform(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        { platform: 'HomebridgeEufy' },
        {
          on(event, listener): void {
            lifecycleListeners[event] = listener;
          },
        },
      );

      lifecycleListeners.didFinishLaunching?.();
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
      signalListeners.get(signal)?.();
      lifecycleListeners.shutdown?.();
      await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
      expect(signalListeners.size).toBe(0);
      expect(signalTarget.off).toHaveBeenCalledTimes(3);
    },
  );
});
