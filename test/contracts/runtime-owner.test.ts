import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionExpiredError,
  type AvailabilityObservation,
  type Device,
  type DeviceManifest,
  type EufyMega,
  type PersistedSession,
} from '@mega-yfue/eufy-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountOwnership } from '../../src/account/ownership.js';
import { AccountSessionPersistence } from '../../src/account/persistence.js';
import { parseConfig } from '../../src/configuration.js';
import type { CompleteDeviceSnapshot } from '../../src/device/snapshot.js';
import { createSdkLogger } from '../../src/diagnostics.js';
import { createEufyPlatform, type PlatformLifecycleEvent } from '../../src/platform.js';
import { RuntimeOwner } from '../../src/runtime/owner.js';
import { PersistedSdkClient, type SdkClient, type SdkStartResult } from '../../src/runtime/sdk-client.js';
import { RuntimeTracker } from '../../src/runtime/tracker.js';

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

function sdkDevice(serial: string): Device {
  return { describe: () => manifest(serial) } as unknown as Device;
}

function realtimeReady() {
  return {
    state: 'ready',
    push: { required: 1, ready: 1, failed: 0, pending: 0 },
    mqtt: { required: 0, ready: 0, failed: 0, pending: 0 },
    wiredP2p: { required: 1, ready: 1, failed: 0, pending: 0 },
  };
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
  const persistence = new AccountSessionPersistence(join(directory, 'homebridge-eufy', 'accounts'));
  const staging = await persistence.stage('runtime@example.invalid');
  staging.configuration.save(
    parseConfig({
      platform: 'HomebridgeEufy',
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

async function releaseLease(onReleased?: () => void): Promise<{ state: 'stopped' }> {
  onReleased?.();
  return { state: 'stopped' };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('persisted runtime owner', () => {
  it('routes SDK debug diagnostics through a redacted Homebridge logger', () => {
    const debug = vi.fn();
    const error = vi.fn();
    const logger = createSdkLogger({ debug, info: vi.fn(), warn: vi.fn(), error })!;

    logger.debug(
      '[mega] device T8000P0000000000 at 192.0.2.1 belongs to account@example.invalid',
      Object.assign(new Error('must-not-appear'), { name: 'SensitiveDeviceName' }),
      { token: 'must-not-appear' },
    );
    logger.error('synthetic failure', 'must-not-appear');

    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[0]?.[0]).toContain('"subsystem":"mega"');
    expect(debug.mock.calls[0]?.[0]).toContain('"errorType":"Error"');
    expect(debug.mock.calls[0]?.[0]).toContain('"type":"object"');
    expect(debug.mock.calls[0]?.[0]).not.toContain('T8000');
    expect(debug.mock.calls[0]?.[0]).not.toContain('192.0.2.1');
    expect(debug.mock.calls[0]?.[0]).not.toContain('account@example.invalid');
    expect(debug.mock.calls[0]?.[0]).not.toContain('must-not-appear');
    expect(debug.mock.calls[0]?.[0]).not.toContain('SensitiveDeviceName');
    expect(debug.mock.calls[1]?.[0]).toContain('"level":"error"');
    expect(error).not.toHaveBeenCalled();
  });
  it('owns startup, complete publication, and shutdown through one direct interface', async () => {
    const calls: string[] = [];
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    const current = snapshot('synthetic-current');
    const release = vi.fn(async (onReleased?: () => void) => {
      calls.push('release');
      onReleased?.();
      return { state: 'stopped' as const };
    });
    const availability: AvailabilityObservation = {
      entity: { kind: 'device', sn: 'synthetic-current' },
      availability: 'unavailable',
      source: { transport: 'smqtt', signal: 'state-info' },
      scope: 'device',
      receivedAt: 1,
    };
    const client: SdkClient = {
      start: vi.fn(async () => {
        calls.push('client:start');
        return {
          state: 'ready' as const,
          registry: new Map([['synthetic-current', sdkDevice('synthetic-current')]]),
          snapshot: current,
        };
      }),
      stop: vi.fn(async () => {
        calls.push('client:stop');
      }),
      deviceAvailability: vi.fn(() => availability),
    };
    const runtime = new RuntimeOwner({ error: vi.fn(), warn: vi.fn() }, config, () => client, {
      storageRoot: '/synthetic-runtime',
      ownership: {
        acquire: vi.fn(async () => {
          calls.push('acquire');
          return { state: 'owner' as const, lease: { release }, recovered: false };
        }),
      },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: {
            load: () => null,
            save: vi.fn(() => calls.push('snapshot:save')),
          },
        })),
      },
      statusPublisher: {
        start: vi.fn(() => {
          calls.push('status:starting');
          return true;
        }),
        update: vi.fn((state) => {
          calls.push(`status:${state}`);
          return true;
        }),
        stop: vi.fn(() => calls.push('status:stopped')),
      },
    });

    await Promise.all([runtime.start(), runtime.start()]);
    expect(runtime.currentAvailability('synthetic-current')).toBe(availability);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(runtime.currentAvailability('synthetic-current')).toBeUndefined();

    expect(client.start).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'acquire',
      'status:starting',
      'client:start',
      'snapshot:save',
      'status:ready',
      'status:stopping',
      'client:stop',
      'release',
      'status:stopped',
    ]);
  });

  it('publishes versioned complete registry views separately from runtime availability', async () => {
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    const first = snapshot('synthetic-first');
    const second = snapshot('synthetic-second');
    let reportInventory: ((result: SdkStartResult) => void) | undefined;
    let reportEvent: ((event: { eventName: 'contactState'; deviceSn: string; open: boolean }) => void) | undefined;
    const client: SdkClient = {
      onEvent(listener): void {
        reportEvent = listener;
      },
      onInventory(listener): void {
        reportInventory = listener;
      },
      start: vi.fn(async () => ({
        state: 'ready' as const,
        registry: new Map([['synthetic-first', sdkDevice('synthetic-first')]]),
        snapshot: first,
      })),
      stop: vi.fn(async () => undefined),
    };
    const warn = vi.fn();
    const updateStatus = vi.fn(() => true);
    const runtime = new RuntimeOwner({ error: vi.fn(), warn }, config, () => client, {
      storageRoot: '/synthetic-runtime',
      ownership: {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release: vi.fn(releaseLease) },
          recovered: false,
        })),
      },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: { load: () => null, save: vi.fn() },
        })),
      },
      statusPublisher: { start: () => true, update: updateStatus, stop: vi.fn() },
    });
    const states: string[] = [];
    const views: Array<{ version: number; serials: string[]; state: string }> = [];
    const events: string[] = [];
    const unsubscribeState = runtime.subscribeState((state) => states.push(state));
    const unsubscribeEvents = runtime.subscribeEvents((event) => events.push(`${event.eventName}:${event.deviceSn}`));
    runtime.subscribeRegistry(() => {
      throw new Error('synthetic subscriber failure');
    });
    const unsubscribeRegistry = runtime.subscribeRegistry((view) => {
      views.push({ version: view.version, serials: [...view.registry.keys()], state: runtime.currentState() });
      expect(runtime.currentRegistry()).toBe(view);
    });

    expect(runtime.currentState()).toBe('stopped');
    expect(runtime.currentRegistry()).toBeUndefined();
    await runtime.start();

    expect(runtime.currentState()).toBe('ready');
    expect(runtime.currentRegistry()).toMatchObject({
      version: 1,
      generation: 'synthetic-generation',
      snapshot: first,
    });
    expect(states).toEqual(['acquiring-ownership', 'starting', 'ready']);
    expect(views).toEqual([{ version: 1, serials: ['synthetic-first'], state: 'starting' }]);
    expect(warn).toHaveBeenCalledWith(
      '[registry-subscriber-failed] A device registry consumer failed; review Homebridge Eufy health in the dashboard.',
    );

    reportEvent?.({ eventName: 'contactState', deviceSn: 'synthetic-first', open: true });
    expect(events).toEqual(['contactState:synthetic-first']);

    reportInventory?.({
      state: 'degraded',
      complete: true,
      registry: new Map([['synthetic-second', sdkDevice('synthetic-second')]]),
      snapshot: second,
    });
    await vi.waitFor(() => expect(runtime.currentRegistry()?.version).toBe(2));
    expect(views.at(-1)).toEqual({ version: 2, serials: ['synthetic-second'], state: 'ready' });
    expect(runtime.currentState()).toBe('degraded');
    expect(updateStatus).toHaveBeenLastCalledWith('degraded', {
      generation: 'synthetic-generation',
      complete: true,
      snapshot: second,
      status: 'transport-degraded',
    });

    reportInventory?.({ state: 'authentication-required' });
    await vi.waitFor(() => expect(runtime.currentState()).toBe('authentication-required'));
    expect(runtime.currentRegistry()).toMatchObject({ version: 2, snapshot: second });

    unsubscribeRegistry();
    unsubscribeEvents();
    unsubscribeState();
    await runtime.stop();
    expect(runtime.currentState()).toBe('stopped');
    expect(runtime.currentRegistry()).toMatchObject({ version: 2, snapshot: second });
  });

  it('acquires once and publishes a complete snapshot before becoming ready', async () => {
    const { directory, persistence } = await activeRuntime();
    const active = await persistence.active();
    const nextSnapshot = snapshot('synthetic-current');
    const client: SdkClient = {
      start: vi.fn(async () => ({
        state: 'ready' as const,
        registry: new Map([['synthetic-current', sdkDevice('synthetic-current')]]),
        snapshot: nextSnapshot,
      })),
      stop: vi.fn(async () => undefined),
    };
    const factory = vi.fn(() => client);
    const acquire = vi.spyOn(AccountOwnership.prototype, 'acquire');
    const events = lifecycle();
    const Platform = createEufyPlatform(factory);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      events.api(directory),
    );
    events.listeners.didFinishLaunching?.();
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));
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
      expect.objectContaining({ error: expect.any(Function), info: expect.any(Function), warn: expect.any(Function) }),
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

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      events.api(directory),
    );
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));
    await vi.waitFor(
      async () => await expect(tracker.read()).resolves.toMatchObject({ state: 'authentication-required' }),
    );
    expect(factory).not.toHaveBeenCalled();
    const ownership = new AccountOwnership(join(directory, 'homebridge-eufy', 'ownership'));
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

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      events.api(directory),
    );
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));
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
        registry: new Map([['synthetic-current', sdkDevice('synthetic-current')]]),
        snapshot: current,
      })),
      stop: vi.fn(async () => undefined),
    };
    const events = lifecycle();
    const Platform = createEufyPlatform(() => client);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      events.api(directory),
    );
    events.listeners.didFinishLaunching?.();
    const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));
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

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'HomebridgeEufy' },
      events.api(directory),
    );
    events.listeners.didFinishLaunching?.();

    const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));
    await vi.waitFor(
      async () => await expect(tracker.read()).resolves.toMatchObject({ state: 'authentication-required' }),
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    const ownership = new AccountOwnership(join(directory, 'homebridge-eufy', 'ownership'));
    const result = await ownership.acquire('runtime@example.invalid', 'temporary-authentication');
    expect(result.state).toBe('owner');
    if (result.state === 'owner') {
      await result.lease.release();
    }
  });

  it('reports owner conflict without constructing or stopping a client or stealing the live lease', async () => {
    const { directory, persistence } = await activeRuntime();
    const ownership = new AccountOwnership(join(directory, 'homebridge-eufy', 'ownership'));
    const held = await ownership.acquire('runtime@example.invalid', 'runtime');
    expect(held.state).toBe('owner');
    const active = await persistence.active();
    const tracker = new RuntimeTracker(join(directory, 'homebridge-eufy', 'tracker.json'));
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
      new Platform({ error, info: vi.fn(), warn: vi.fn() }, { platform: 'HomebridgeEufy' }, events.api(directory));
      events.listeners.didFinishLaunching?.();

      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(error.mock.calls[0]![0]).toContain(
        '[runtime-owner-conflict] Another process owns the Eufy account session.',
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
        platform: 'HomebridgeEufy',
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
    const waitForRealtime = vi.fn(async () => {
      calls.push('waitForRealtime');
      return realtimeReady();
    });
    const getDevice = vi.fn(async () => {
      calls.push('getDevice');
      return { describe: () => manifest('synthetic-current') };
    });
    const client = {
      loggedIn: true,
      login,
      waitForRealtime,
      on: vi.fn((event: string) => {
        calls.push(`on:${event}`);
      }),
      off: vi.fn(),
      getDevices,
      getDevice,
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
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
    expect(calls.slice(0, 9)).toEqual([
      'on:error',
      'on:sessionExpired',
      'on:event',
      'on:commandUnconfirmed',
      'on:connect',
      'on:disconnect',
      'on:deviceAdded',
      'on:deviceRemoved',
      'on:deviceCapabilities',
    ]);
    expect(calls.indexOf('login')).toBeLessThan(calls.indexOf('getDevices'));
    expect(calls.indexOf('waitForRealtime')).toBeLessThan(calls.indexOf('getDevices'));
    expect(waitForRealtime).toHaveBeenCalledWith();
    expect(getDevices).toHaveBeenCalledOnce();
    expect(getDevice).toHaveBeenCalledExactlyOnceWith('synthetic-current');
  });

  it('does not publish readiness before required realtime transports are ready', async () => {
    const { persistence } = await activeRuntime();
    const active = await persistence.active();
    expect(active).not.toBeNull();
    const current = snapshot('synthetic-current');
    const getDevices = vi.fn(async () => [{ sn: 'synthetic-current' }]);
    const client = {
      loggedIn: true,
      login: vi.fn(async () => ({ status: 'ok' as const, raw: { restored: true } })),
      waitForRealtime: vi.fn(async () => ({
        ...realtimeReady(),
        state: 'partial' as const,
        wiredP2p: { required: 2, ready: 1, failed: 1, pending: 0 },
      })),
      on: vi.fn(),
      off: vi.fn(),
      getDevices,
      getDevice: vi.fn(async () => sdkDevice('synthetic-current')),
      disconnect: vi.fn(async () => undefined),
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
        username: 'runtime@example.invalid',
        password: 'persisted-password',
      }),
      active!,
      client,
    );

    await expect(runtime.start()).resolves.toMatchObject({ state: 'degraded', snapshot: current });
    expect(client.waitForRealtime).toHaveBeenCalledWith();
    expect(getDevices).toHaveBeenCalledOnce();
  });

  it('lets final realtime readiness settle initial transport lifecycle events', async () => {
    const { persistence } = await activeRuntime();
    const active = await persistence.active();
    expect(active).not.toBeNull();
    const listeners = new Map<string, (...args: never[]) => void>();
    let finishReadiness: ((readiness: ReturnType<typeof realtimeReady>) => void) | undefined;
    const waitForRealtime = vi.fn(
      () =>
        new Promise<ReturnType<typeof realtimeReady>>((resolve) => {
          finishReadiness = resolve;
        }),
    );
    const getDevices = vi.fn(async () => [{ sn: 'synthetic-current' }]);
    const client = {
      loggedIn: true,
      login: vi.fn(async () => ({ status: 'ok' as const, raw: { restored: true } })),
      waitForRealtime,
      on: vi.fn((event: string, listener: (...args: never[]) => void) => listeners.set(event, listener)),
      off: vi.fn(),
      getDevices,
      getDevice: vi.fn(async () => sdkDevice('synthetic-current')),
      disconnect: vi.fn(async () => undefined),
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
        username: 'runtime@example.invalid',
        password: 'persisted-password',
      }),
      active!,
      client,
    );

    const starting = runtime.start();
    await vi.waitFor(() => expect(waitForRealtime).toHaveBeenCalledOnce());
    listeners.get('connect')?.();
    listeners.get('disconnect')?.();
    expect(getDevices).not.toHaveBeenCalled();
    finishReadiness?.(realtimeReady());

    await expect(starting).resolves.toMatchObject({ state: 'degraded', snapshot: snapshot('synthetic-current') });
    expect(getDevices).toHaveBeenCalledOnce();
  });

  it('keeps the pinned SDK startup path when realtime readiness is unavailable', async () => {
    const { persistence } = await activeRuntime();
    const active = await persistence.active();
    expect(active).not.toBeNull();
    const client = {
      loggedIn: true,
      login: vi.fn(async () => ({ status: 'ok' as const, raw: { restored: true } })),
      on: vi.fn(),
      off: vi.fn(),
      getDevices: vi.fn(async () => [{ sn: 'synthetic-current' }]),
      getDevice: vi.fn(async () => sdkDevice('synthetic-current')),
      disconnect: vi.fn(async () => undefined),
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
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
  });

  it('degrades on connectivity loss, refreshes after recovery, and removes every SDK listener on stop', async () => {
    const { persistence } = await activeRuntime();
    const active = await persistence.active();
    expect(active).not.toBeNull();
    const listeners = new Map<string, Set<(...args: never[]) => void>>();
    const on = vi.fn((event: string, listener: (...args: never[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    });
    const off = vi.fn((event: string, listener: (...args: never[]) => void) => {
      const eventListeners = listeners.get(event);
      eventListeners?.delete(listener);
      if (eventListeners?.size === 0) {
        listeners.delete(event);
      }
    });
    const disconnect = vi.fn(async () => undefined);
    let finishRefresh: ((devices: Array<{ sn: string }>) => void) | undefined;
    const getDevices = vi.fn(() => {
      if (getDevices.mock.calls.length === 2) {
        return new Promise<Array<{ sn: string }>>((resolve) => {
          finishRefresh = resolve;
        });
      }
      return Promise.resolve([{ sn: 'synthetic-current' }]);
    });
    const client = {
      loggedIn: true,
      login: vi.fn(async () => ({ status: 'ok' as const, raw: { restored: true } })),
      waitForRealtime: vi.fn(async () => realtimeReady()),
      on,
      off,
      disconnect,
      getDevices,
      getDevice: vi.fn(async () => ({ describe: () => manifest('synthetic-current') })),
    } as unknown as EufyMega;
    const runtime = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
        username: 'runtime@example.invalid',
        password: 'persisted-password',
      }),
      active!,
      client,
    );
    const inventory = vi.fn();
    const events = vi.fn();
    runtime.onInventory(inventory);
    runtime.onEvent(events);

    await expect(runtime.start()).resolves.toMatchObject({ state: 'ready' });
    expect([...listeners.keys()]).toEqual([
      'error',
      'sessionExpired',
      'event',
      'commandUnconfirmed',
      'connect',
      'disconnect',
      'deviceAdded',
      'deviceRemoved',
      'deviceCapabilities',
    ]);

    const contactEvent = { eventName: 'contactState', deviceSn: 'synthetic-current', open: true };
    listeners.get('event')?.forEach((listener) => listener(contactEvent as never));
    expect(events).toHaveBeenCalledWith(contactEvent);

    listeners.get('deviceAdded')?.forEach((listener) => listener());
    await vi.waitFor(() => expect(getDevices).toHaveBeenCalledTimes(2));
    listeners.get('disconnect')?.forEach((listener) => listener());
    expect(inventory).toHaveBeenCalledWith({ state: 'degraded' });
    finishRefresh?.([{ sn: 'synthetic-current' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inventory).toHaveBeenLastCalledWith({ state: 'degraded' });

    listeners.get('connect')?.forEach((listener) => listener());
    await vi.waitFor(() => expect(getDevices).toHaveBeenCalledTimes(3));
    expect(inventory).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'ready', snapshot: snapshot('synthetic-current') }),
    );
    listeners.get('error')?.forEach((listener) => listener(new Error('synthetic transport fault') as never));
    expect(
      inventory,
      'a transport fault is not an authentication failure; the session is still the one the account granted',
    ).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ready' }));

    listeners
      .get('sessionExpired')
      ?.forEach((listener) => listener(new SessionExpiredError('synthetic persisted session expired') as never));
    expect(
      inventory,
      'the SDK announces a kicked session only here, so this is the only place a passive expiry can be observed',
    ).toHaveBeenLastCalledWith({ state: 'authentication-required' });

    const installedListeners = [...listeners.entries()].flatMap(([event, eventListeners]) =>
      [...eventListeners].map((listener) => [event, listener] as const),
    );
    const priorOffCalls = off.mock.calls.length;
    await runtime.stop();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledTimes(priorOffCalls + installedListeners.length);
    for (const [event, listener] of installedListeners) {
      expect(off).toHaveBeenCalledWith(event, listener);
    }
    expect(listeners.size).toBe(0);
  });

  it('converges authentication expiry and shutdown on one cleanup operation', async () => {
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    let reportInventory: ((result: SdkStartResult) => void) | undefined;
    let finishDisconnect: (() => void) | undefined;
    const release = vi.fn(releaseLease);
    const client: SdkClient = {
      onInventory(listener): void {
        reportInventory = listener;
      },
      start: vi.fn(async () => ({
        state: 'ready' as const,
        registry: new Map([['synthetic-current', sdkDevice('synthetic-current')]]),
        snapshot: snapshot('synthetic-current'),
      })),
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDisconnect = resolve;
          }),
      ),
    };
    const statusPublisher = { start: vi.fn(() => true), update: vi.fn(() => true), stop: vi.fn() };
    const runtime = new RuntimeOwner({ error: vi.fn(), warn: vi.fn() }, config, () => client, {
      storageRoot: '/synthetic-runtime',
      ownership: {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release },
          recovered: false,
        })),
      },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: { load: () => snapshot('synthetic-current'), save: vi.fn() },
        })),
      },
      statusPublisher,
    });
    await runtime.start();

    reportInventory?.({ state: 'authentication-required' });
    const shutdown = runtime.stop();
    expect(runtime.currentState()).toBe('stopping');
    expect(client.stop).toHaveBeenCalledOnce();
    finishDisconnect?.();
    await shutdown;

    expect(release).toHaveBeenCalledOnce();
    expect(runtime.currentState()).toBe('stopped');
    expect(statusPublisher.stop).toHaveBeenCalledOnce();
  });

  it('bounds stalled disconnect, releases its lease once, and publishes failed cleanup', async () => {
    vi.useFakeTimers();
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    const release = vi.fn(releaseLease);
    const client: SdkClient = {
      start: vi.fn(async () => ({ state: 'degraded' as const })),
      stop: vi.fn(() => new Promise<void>(() => {})),
    };
    const statusPublisher = { start: vi.fn(() => true), update: vi.fn(() => true), stop: vi.fn() };
    const warn = vi.fn();
    const runtime = new RuntimeOwner({ error: vi.fn(), warn }, config, () => client, {
      storageRoot: '/synthetic-runtime',
      shutdownTimeoutMs: 1_000,
      ownership: {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release },
          recovered: false,
        })),
      },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: { load: () => snapshot('synthetic-old'), save: vi.fn() },
        })),
      },
      statusPublisher,
    });
    await runtime.start();

    const stopping = runtime.stop();
    expect(runtime.currentState()).toBe('stopping');
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(client.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(runtime.currentState()).toBe('failed');
    expect(statusPublisher.update).toHaveBeenLastCalledWith('failed');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(
      '[shutdown-timeout] The Eufy runtime exceeded its shutdown deadline; Homebridge shutdown will continue. (1000 ms)',
    );
    await runtime.stop();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('publishes failed and retains the latest snapshot when owned startup fails', async () => {
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    const previousSnapshot = snapshot('synthetic-old');
    const release = vi.fn(releaseLease);
    const client: SdkClient = {
      start: vi.fn(async () => {
        throw new Error('synthetic owned startup failure');
      }),
      stop: vi.fn(async () => undefined),
    };
    const statusPublisher = { start: vi.fn(() => true), update: vi.fn(() => true), stop: vi.fn() };
    const error = vi.fn();
    const runtime = new RuntimeOwner({ error, warn: vi.fn() }, config, () => client, {
      storageRoot: '/synthetic-runtime',
      ownership: {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release },
          recovered: false,
        })),
      },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: { load: () => previousSnapshot, save: vi.fn() },
        })),
      },
      statusPublisher,
    });

    await runtime.start();

    expect(runtime.currentState()).toBe('failed');
    expect(client.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(statusPublisher.start).toHaveBeenCalledWith('starting', {
      generation: 'synthetic-generation',
      complete: false,
      snapshot: previousSnapshot,
    });
    expect(statusPublisher.update).toHaveBeenLastCalledWith('failed');
    expect(error).not.toHaveBeenCalled();
    await runtime.stop();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds pending ownership and releases a lease granted after shutdown', async () => {
    vi.useFakeTimers();
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    let finishAcquire:
      | ((value: { state: 'owner'; lease: { release: () => Promise<{ state: 'stopped' }> }; recovered: false }) => void)
      | undefined;
    const release = vi.fn(releaseLease);
    const acquire = vi.fn(
      () =>
        new Promise<{
          state: 'owner';
          lease: { release: () => Promise<{ state: 'stopped' }> };
          recovered: false;
        }>((resolve) => {
          finishAcquire = resolve;
        }),
    );
    const factory = vi.fn();
    const statusPublisher = { start: vi.fn(() => true), update: vi.fn(() => true), stop: vi.fn() };
    const runtime = new RuntimeOwner({ error: vi.fn(), warn: vi.fn() }, config, factory, {
      storageRoot: '/synthetic-runtime',
      shutdownTimeoutMs: 1_000,
      ownership: { acquire },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: { load: () => snapshot('synthetic-old'), save: vi.fn() },
        })),
      },
      statusPublisher,
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    const stopping = runtime.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(runtime.currentState()).toBe('failed');
    expect(statusPublisher.update).not.toHaveBeenCalled();
    finishAcquire?.({ state: 'owner', lease: { release }, recovered: false });
    await starting;
    await vi.advanceTimersByTimeAsync(0);

    expect(release).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.currentState()).toBe('failed');
    vi.useRealTimers();
  });

  it('does not publish shutdown state when pending ownership resolves to conflict', async () => {
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      username: 'runtime@example.invalid',
      password: 'persisted-password',
    });
    let finishAcquire:
      | ((value: {
          state: 'owner-conflict';
          owner: { version: 1; kind: 'runtime'; pid: number; acquiredAt: string };
        }) => void)
      | undefined;
    const acquire = vi.fn(
      () =>
        new Promise<{
          state: 'owner-conflict';
          owner: { version: 1; kind: 'runtime'; pid: number; acquiredAt: string };
        }>((resolve) => {
          finishAcquire = resolve;
        }),
    );
    const statusPublisher = { start: vi.fn(() => true), update: vi.fn(() => true), stop: vi.fn() };
    const runtime = new RuntimeOwner({ error: vi.fn(), warn: vi.fn() }, config, vi.fn(), {
      storageRoot: '/synthetic-runtime',
      ownership: { acquire },
      persistence: {
        active: vi.fn(async () => ({
          account: 'runtime@example.invalid',
          generation: 'synthetic-generation',
          configuration: { load: () => config },
          session: { load: () => session(), save: vi.fn(), clear: vi.fn() },
          push: { load: () => null, save: vi.fn(), clear: vi.fn() },
          snapshot: { load: () => snapshot('synthetic-old'), save: vi.fn() },
        })),
      },
      statusPublisher,
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    const stopping = runtime.stop();
    finishAcquire?.({
      state: 'owner-conflict',
      owner: { version: 1, kind: 'runtime', pid: 42, acquiredAt: '2026-01-01T00:00:00.000Z' },
    });
    await Promise.all([starting, stopping]);

    expect(runtime.currentState()).toBe('stopped');
    expect(statusPublisher.start).not.toHaveBeenCalled();
    expect(statusPublisher.update).not.toHaveBeenCalled();
    expect(statusPublisher.stop).not.toHaveBeenCalled();
  });

  it('does not replace stopped with authentication-required after a late account lookup', async () => {
    const config = parseConfig({ platform: 'HomebridgeEufy' });
    let finishLookup: ((active: null) => void) | undefined;
    const statusPublisher = { start: vi.fn(() => true), update: vi.fn(() => true), stop: vi.fn() };
    const runtime = new RuntimeOwner({ error: vi.fn(), warn: vi.fn() }, config, vi.fn(), {
      storageRoot: '/synthetic-runtime',
      persistence: {
        active: vi.fn(
          () =>
            new Promise<null>((resolve) => {
              finishLookup = resolve;
            }),
        ),
      },
      statusPublisher,
    });

    const starting = runtime.start();
    await runtime.stop();
    finishLookup?.(null);
    await starting;

    expect(runtime.currentState()).toBe('stopped');
    expect(statusPublisher.update).not.toHaveBeenCalledWith('authentication-required');
  });
});
