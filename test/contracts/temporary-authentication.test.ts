import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  TemporaryAuthentication,
  type TemporaryAuthenticationClient,
  type TemporaryAuthenticationClientOptions,
} from '../../src/temporary-authentication.js';
import { bindTemporaryAuthenticationProcessCleanup } from '../../src/ui-server.js';
import { RuntimeTracker } from '../../src/runtime-tracker.js';

describe('temporary authentication', () => {
  it('continues captcha on one owner and commits only after successful bounded cleanup', async () => {
    const calls: string[] = [];
    const lease = {
      release: vi.fn(async () => {
        calls.push('release');
        return { state: 'stopped' as const };
      }),
    };
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(async () => {
        calls.push('commit');
      }),
      discard: vi.fn(async () => {
        calls.push('discard');
      }),
    };
    const client: TemporaryAuthenticationClient = {
      login: vi.fn(async () => ({ status: 'captcha', image: 'data:image/png;base64,c3ludGhldGlj', retry: false })),
      solveCaptcha: vi.fn(async () => ({
        status: 'ok',
        session: { userId: 'synthetic-user', authToken: 'synthetic-token', raw: {} },
      })),
      submitVerifyCode: vi.fn(),
      disconnect: vi.fn(async () => {
        calls.push('disconnect');
      }),
    };
    const clientFactory = vi.fn((_options: TemporaryAuthenticationClientOptions) => client);
    const authentication = new TemporaryAuthentication(
      {
        acquire: vi.fn(async () => ({ state: 'owner' as const, lease, recovered: false })),
      },
      {
        stage: vi.fn(async () => stores),
      },
      clientFactory,
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(
      authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'captcha', image: 'data:image/png;base64,c3ludGhldGlj', retry: false });
    await expect(authentication.submitCaptcha('1234')).resolves.toEqual({ status: 'authenticated' });

    expect(clientFactory).toHaveBeenCalledWith({
      account: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'US',
      trustedDeviceName: 'Synthetic Homebridge',
      sessionStore: stores.session,
      pushStore: stores.push,
    });
    expect(client.solveCaptcha).toHaveBeenCalledWith('1234');
    expect(stores.discard).not.toHaveBeenCalled();
    expect(calls).toEqual(['disconnect', 'commit', 'release']);
  });

  it('blocks a live owner before staging stores or constructing a client', async () => {
    const owner = { acquiredAt: '2026-08-11T12:00:00.000Z', kind: 'runtime' as const, pid: 4242 };
    const persistence = { stage: vi.fn() };
    const clientFactory = vi.fn();
    const authentication = new TemporaryAuthentication(
      { acquire: vi.fn(async () => ({ state: 'owner-conflict' as const, owner })) },
      persistence,
      clientFactory,
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(
      authentication.start({
        account: 'blocked@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'blocked', owner });
    expect(persistence.stage).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('blocks account replacement when the active account has a live runtime owner', async () => {
    const owner = { acquiredAt: '2026-08-11T12:00:00.000Z', kind: 'runtime' as const, pid: 4242 };
    const acquire = vi.fn(async () => ({ state: 'owner-conflict' as const, owner }));
    const persistence = {
      active: vi.fn(async () => ({ account: 'active@example.invalid' })),
      stage: vi.fn(),
    };
    const clientFactory = vi.fn();
    const authentication = new TemporaryAuthentication({ acquire }, persistence, clientFactory, {
      flowTimeoutMs: 1_000,
      cleanupTimeoutMs: 100,
    });

    await expect(
      authentication.start({
        account: 'replacement@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'blocked', owner });
    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith('active@example.invalid', 'temporary-authentication');
    expect(persistence.stage).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('blocks authentication while runtime evidence is fresh', async () => {
    const ownership = { acquire: vi.fn() };
    const persistence = { stage: vi.fn() };
    const authentication = new TemporaryAuthentication(
      ownership,
      persistence,
      vi.fn(),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
      { fresh: vi.fn(async () => ({ state: 'ready' as const, updatedAt: '2026-08-11T12:00:00.000Z' })) },
    );

    await expect(
      authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({
      status: 'plugin-running',
      state: 'ready',
      updatedAt: '2026-08-11T12:00:00.000Z',
    });
    expect(ownership.acquire).not.toHaveBeenCalled();
    expect(persistence.stage).not.toHaveBeenCalled();
  });

  it('fails without exposing an authentication error and discards staged stores', async () => {
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const authentication = new TemporaryAuthentication(
      { acquire: vi.fn(async () => ({ state: 'owner' as const, lease: { release }, recovered: false })) },
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(async () => {
          throw new Error('synthetic-password must never escape');
        }),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(
      authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'failed' });
    expect(stores.commit).not.toHaveBeenCalled();
    expect(stores.discard).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('times out a pending challenge flow and performs idempotent cleanup', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const disconnect = vi.fn(async () => undefined);
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const authentication = new TemporaryAuthentication(
      { acquire: vi.fn(async () => ({ state: 'owner' as const, lease: { release }, recovered: false })) },
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(() => new Promise(() => undefined)),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        disconnect,
      }),
      { flowTimeoutMs: 50, cleanupTimeoutMs: 10 },
    );

    try {
      const result = authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({ status: 'timed-out' });
      await expect(authentication.close()).resolves.toEqual({ status: 'closed' });
      expect(disconnect).toHaveBeenCalledOnce();
      expect(stores.discard).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two-factor continuation on the same temporary client', async () => {
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(async () => undefined),
      discard: vi.fn(),
    };
    const client: TemporaryAuthenticationClient = {
      login: vi.fn(async () => ({ status: '2fa', method: 'synthetic verification' })),
      solveCaptcha: vi.fn(),
      submitVerifyCode: vi.fn(async () => ({
        status: 'ok',
        session: { userId: 'synthetic-user', authToken: 'synthetic-token', raw: {} },
      })),
      disconnect: vi.fn(async () => undefined),
    };
    const clientFactory = vi.fn(() => client);
    const authentication = new TemporaryAuthentication(
      {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release: vi.fn(async () => ({ state: 'stopped' as const })) },
          recovered: false,
        })),
      },
      { stage: vi.fn(async () => stores) },
      clientFactory,
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(
      authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'two-factor', method: 'synthetic verification' });
    await expect(authentication.submitTwoFactor('654321')).resolves.toEqual({ status: 'authenticated' });
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(client.submitVerifyCode).toHaveBeenCalledWith('654321');
  });

  it('lets UI closure win a race with a pending successful login', async () => {
    let resolveLogin!: (result: Awaited<ReturnType<TemporaryAuthenticationClient['login']>>) => void;
    const login = new Promise<Awaited<ReturnType<TemporaryAuthenticationClient['login']>>>((resolve) => {
      resolveLogin = resolve;
    });
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(),
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
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(() => login),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );
    const start = authentication.start({
      account: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'US',
      trustedDeviceName: 'Synthetic Homebridge',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(authentication.close()).resolves.toEqual({ status: 'closed' });
    resolveLogin({
      status: 'ok',
      session: { userId: 'synthetic-user', authToken: 'synthetic-token', raw: {} },
    });
    await expect(start).resolves.toEqual({ status: 'closed' });
    expect(stores.commit).not.toHaveBeenCalled();
    expect(stores.discard).toHaveBeenCalledOnce();
  });

  it('waits for pending ownership acquisition before closing and releasing it', async () => {
    let resolveAcquire!: (value: {
      state: 'owner';
      lease: { release: () => Promise<{ state: 'stopped' }> };
      recovered: false;
    }) => void;
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const acquire = new Promise<{
      state: 'owner';
      lease: { release: () => Promise<{ state: 'stopped' }> };
      recovered: false;
    }>((resolve) => {
      resolveAcquire = resolve;
    });
    const persistence = { stage: vi.fn() };
    const authentication = new TemporaryAuthentication({ acquire: vi.fn(() => acquire) }, persistence, vi.fn(), {
      flowTimeoutMs: 1_000,
      cleanupTimeoutMs: 100,
    });
    const start = authentication.start({
      account: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'US',
      trustedDeviceName: 'Synthetic Homebridge',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const close = authentication.close();
    resolveAcquire({ state: 'owner', lease: { release }, recovered: false });

    await expect(close).resolves.toEqual({ status: 'closed' });
    await expect(start).resolves.toEqual({ status: 'closed' });
    expect(release).toHaveBeenCalledOnce();
    expect(persistence.stage).not.toHaveBeenCalled();
  });

  it('releases ownership acquired after bounded closure cleanup expires', async () => {
    vi.useFakeTimers();
    let resolveAcquire!: (value: {
      state: 'owner';
      lease: { release: () => Promise<{ state: 'stopped' }> };
      recovered: false;
    }) => void;
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const acquire = new Promise<{
      state: 'owner';
      lease: { release: () => Promise<{ state: 'stopped' }> };
      recovered: false;
    }>((resolve) => {
      resolveAcquire = resolve;
    });
    const authentication = new TemporaryAuthentication({ acquire: vi.fn(() => acquire) }, { stage: vi.fn() }, vi.fn(), {
      flowTimeoutMs: 1_000,
      cleanupTimeoutMs: 25,
    });
    const start = authentication.start({
      account: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'US',
      trustedDeviceName: 'Synthetic Homebridge',
    });
    await vi.advanceTimersByTimeAsync(0);
    const close = authentication.close();

    try {
      await vi.advanceTimersByTimeAsync(25);
      await expect(close).resolves.toEqual({ status: 'closed' });
      expect(release).not.toHaveBeenCalled();
      resolveAcquire({ state: 'owner', lease: { release }, recovered: false });
      await vi.advanceTimersByTimeAsync(0);
      await expect(start).resolves.toEqual({ status: 'closed' });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a concurrent challenge continuation without a second SDK call', async () => {
    let resolveCaptcha!: (result: Awaited<ReturnType<TemporaryAuthenticationClient['solveCaptcha']>>) => void;
    const captcha = new Promise<Awaited<ReturnType<TemporaryAuthenticationClient['solveCaptcha']>>>((resolve) => {
      resolveCaptcha = resolve;
    });
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const solveCaptcha = vi.fn(() => captcha);
    const authentication = new TemporaryAuthentication(
      {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release: vi.fn(async () => ({ state: 'stopped' as const })) },
          recovered: false,
        })),
      },
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(async () => ({ status: 'captcha', image: 'data:image/png;base64,c3ludGhldGlj', retry: false })),
        solveCaptcha,
        submitVerifyCode: vi.fn(),
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );
    await authentication.start({
      account: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'US',
      trustedDeviceName: 'Synthetic Homebridge',
    });

    const first = authentication.submitCaptcha('1234');
    await expect(authentication.submitCaptcha('5678')).resolves.toEqual({ status: 'failed' });
    expect(solveCaptcha).toHaveBeenCalledOnce();
    resolveCaptcha({ status: 'captcha', image: 'data:image/png;base64,bmV4dA==', retry: true });
    await expect(first).resolves.toEqual({ status: 'captcha', image: 'data:image/png;base64,bmV4dA==', retry: true });
    await authentication.close();
  });

  it('releases ownership when publishing an authenticated session fails', async () => {
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(async () => {
        throw new Error('synthetic publication failure');
      }),
      discard: vi.fn(async () => undefined),
    };
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
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(
      authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'failed' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('fails closed when its lease can no longer be released', async () => {
    const owner = { acquiredAt: '2026-08-11T12:00:00.000Z', kind: 'runtime' as const, pid: 4242 };
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(async () => undefined),
      discard: vi.fn(),
    };
    const authentication = new TemporaryAuthentication(
      {
        acquire: vi.fn(async () => ({
          state: 'owner' as const,
          lease: { release: vi.fn(async () => ({ state: 'owner-conflict' as const, owner })) },
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
        disconnect: vi.fn(async () => undefined),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 100 },
    );

    await expect(
      authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      }),
    ).resolves.toEqual({ status: 'failed' });
  });

  it.each(['disconnect', 'SIGHUP', 'SIGINT', 'SIGTERM'] as const)('cleans up on process %s', async (signal) => {
    const listeners = new Map<string, () => void>();
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    bindTemporaryAuthenticationProcessCleanup(
      {
        once(event, listener) {
          listeners.set(event, listener);
        },
        exit: exit as never,
      },
      close,
    );

    listeners.get(signal)?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds a stalled disconnect before discarding stores and releasing ownership', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => ({ state: 'stopped' as const }));
    const stores = {
      account: 'guest@example.invalid',
      session: { load: () => null, save: vi.fn(), clear: vi.fn() },
      push: { load: () => null, save: vi.fn(), clear: vi.fn() },
      commit: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
    const authentication = new TemporaryAuthentication(
      { acquire: vi.fn(async () => ({ state: 'owner' as const, lease: { release }, recovered: false })) },
      { stage: vi.fn(async () => stores) },
      () => ({
        login: vi.fn(async () => ({ status: 'captcha', image: 'data:image/png;base64,c3ludGhldGlj', retry: false })),
        solveCaptcha: vi.fn(),
        submitVerifyCode: vi.fn(),
        disconnect: vi.fn(() => new Promise(() => undefined)),
      }),
      { flowTimeoutMs: 1_000, cleanupTimeoutMs: 25 },
    );

    try {
      await authentication.start({
        account: 'guest@example.invalid',
        password: 'synthetic-password',
        country: 'US',
        trustedDeviceName: 'Synthetic Homebridge',
      });
      const close = authentication.close();
      await vi.advanceTimersByTimeAsync(25);

      await expect(close).resolves.toEqual({ status: 'closed' });
      expect(stores.discard).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats only a fresh active runtime tracker as blocking evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eufy-runtime-tracker-'));
    const path = join(directory, 'tracker.json');
    const now = Date.parse('2026-08-11T12:01:00.000Z');
    const tracker = new RuntimeTracker(path, 90_000, () => now);

    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          source: 'runtime',
          state: 'ready',
          updatedAt: '2026-08-11T12:00:00.000Z',
          snapshot: { ignored: true },
        }),
      );
      await expect(tracker.fresh()).resolves.toEqual({
        state: 'ready',
        updatedAt: '2026-08-11T12:00:00.000Z',
      });

      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          source: 'runtime',
          state: 'ready',
          updatedAt: '2026-08-11T11:59:00.000Z',
        }),
      );
      await expect(tracker.fresh()).resolves.toBeNull();
      await writeFile(path, '{malformed');
      await expect(tracker.fresh()).resolves.toBeNull();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
