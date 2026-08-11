import { describe, expect, it, vi } from 'vitest';

import type { SdkClient } from '../../src/sdk-client.js';
import { createEufyPlatform, type PlatformLifecycleEvent } from '../../src/platform.js';

describe('platform lifecycle', () => {
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
        platform: 'EufySecurity',
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

  it('starts its SDK client after Homebridge finishes launching', async () => {
    const client: SdkClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Partial<Record<PlatformLifecycleEvent, () => void>> = {};
    const Platform = createEufyPlatform(() => client);

    new Platform(
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      { platform: 'EufySecurity' },
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
      { platform: 'EufySecurity' },
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
      { platform: 'EufySecurity' },
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

  it('stops a client that finishes starting after the shutdown deadline', async () => {
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
      { platform: 'EufySecurity' },
      {
        on(event, listener): void {
          listeners[event] = listener;
        },
      },
    );
    listeners.didFinishLaunching?.();
    listeners.shutdown?.();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.stop).not.toHaveBeenCalled();
    finishStartup?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
