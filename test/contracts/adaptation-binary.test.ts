import { describe, expect, it, vi } from 'vitest';

import { PersistedSdkClient } from '../../src/runtime/sdk-client.js';
import { parseConfig } from '../../src/configuration.js';

/** Every option this plugin hands the SDK constructor, captured in order. */
const constructed: Record<string, unknown>[] = [];

vi.mock('@mega-yfue/eufy-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mega-yfue/eufy-sdk')>();
  return {
    ...actual,
    EufyMega: class {
      readonly loggedIn = false;
      readonly on = vi.fn();
      readonly off = vi.fn();
      readonly login = vi.fn();
      constructor(options: Record<string, unknown>) {
        constructed.push(options);
      }
    },
  };
});

/**
 * One resolved adaptation binary serves every media path, this plugin's and the SDK's alike.
 *
 * The plugin ships a build precisely because a Homebridge host frequently has no system FFmpeg, and it lets
 * an administrator name another. The SDK shells out too — a live snapshot is an Annex-B burst decoded to
 * JPEG — and resolves the bare name on `PATH` unless it is told otherwise. Leaving it untold splits one
 * decision in two: live view and recording run the binary that was resolved, while snapshots run whatever
 * the host happens to have. On a host with no system FFmpeg that reads as a camera whose live view works and
 * whose still never updates, because the reason the SDK reports for a decoder it could not run is the one
 * failure it declares non-retryable.
 */
describe('adaptation binary', () => {
  const stores = () => ({
    account: 'runtime@example.invalid',
    session: { load: () => ({ authToken: 'synthetic' }) as never, save: vi.fn(), clear: vi.fn() },
    push: { load: () => null, save: vi.fn(), clear: vi.fn() } as never,
  });

  const resolvedBy = async (ffmpegPath?: string): Promise<unknown> => {
    constructed.length = 0;
    const client = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
        username: 'runtime@example.invalid',
        password: 'synthetic',
        ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
      }),
      stores(),
    );
    await expect(client.start()).resolves.toEqual({ state: 'authentication-required' });
    expect(constructed, 'the constructor has to have run for this to mean anything').toHaveLength(1);
    return constructed[0]!.ffmpegPath;
  };

  it('hands the SDK the binary an administrator named', async () => {
    expect(
      await resolvedBy('/synthetic/host/ffmpeg'),
      'an administrator who names a build has named it for every media path, not only the plugin-owned ones',
    ).toBe('/synthetic/host/ffmpeg');
  });

  it('hands the SDK the bundled build when no administrator named one', async () => {
    const { default: bundled } = await import('ffmpeg-for-homebridge');
    expect(
      await resolvedBy(),
      'the bundled build is why a host with no system FFmpeg works at all, so snapshot decoding gets it too',
    ).toBe(bundled);
  });
});
