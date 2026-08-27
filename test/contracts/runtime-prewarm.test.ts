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
 * The speculative pre-warm is the SDK's to offer and this plugin's to choose, and the choice has to be pinned.
 *
 * It shipped on by default and then off, so a plugin that names nothing inherits whichever the SDK last decided
 * — and the version bump that flipped it would have removed doorbell pre-warm here without a line of diff. What
 * the option costs is a standalone battery camera held awake for its whole idle window, so the set has to stay
 * deliberate rather than drift with the dependency.
 */
describe('runtime pre-warm policy', () => {
  const stores = () => ({
    account: 'runtime@example.invalid',
    session: { load: () => ({ authToken: 'synthetic' }) as never, save: vi.fn(), clear: vi.fn() },
    push: { load: () => null, save: vi.fn(), clear: vi.fn() } as never,
  });

  const warmedBy = async (warmUpEvents?: string[]): Promise<unknown> => {
    constructed.length = 0;
    const client = new PersistedSdkClient(
      parseConfig({
        platform: 'HomebridgeEufy',
        username: 'runtime@example.invalid',
        password: 'synthetic',
        ...(warmUpEvents === undefined ? {} : { warmUpEvents }),
      }),
      stores(),
    );
    await expect(client.start()).resolves.toEqual({ state: 'authentication-required' });
    expect(constructed, 'the constructor has to have run for this to mean anything').toHaveLength(1);
    return constructed[0]!.prewarmEvents;
  };

  it('warms a doorbell press and nothing else by default', async () => {
    expect(
      await warmedBy(),
      'a press is a person waiting; a detection nobody watched is a battery held awake for minutes',
    ).toEqual(['doorbellPress']);
  });

  it('warms nothing when the user chose nothing', async () => {
    expect(await warmedBy([])).toEqual([]);
  });

  it('hands the SDK the names the user chose, without translating them', async () => {
    expect(
      await warmedBy(['motion', 'personDetected', 'someLaterSdkEvent']),
      'the SDK owns this vocabulary, so an event it gains needs no change here',
    ).toEqual(['motion', 'personDetected', 'someLaterSdkEvent']);
  });

  it('leaves both station power tiers eligible, whatever the choice', async () => {
    await warmedBy(['motion']);
    expect(
      constructed[0]!.prewarmTiers,
      'sparing the battery tier would spare exactly the cameras this setting exists for',
    ).toBeUndefined();
  });
});
