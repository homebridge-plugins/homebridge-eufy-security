import { describe, expect, it, vi } from 'vitest';

import { SnapshotAcquisition } from '../../src/media/snapshot.js';
import type { LastSuccessfulImages } from '../../src/media/snapshot.js';
import { DeclaredMediaSessionBudget } from '../../src/media/session-budget.js';

const SERIAL = 'SYNTHETIC00000CAP';

function jpeg(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker, 'utf8'), Buffer.from([0xff, 0xd9])]);
}

function retainedImages(entries: readonly (readonly [string, Buffer])[]): LastSuccessfulImages {
  const retained = new Map(entries);
  return {
    read: async (serial) => retained.get(serial),
    write: vi.fn(async (serial: string, image: Buffer) => {
      retained.set(serial, image);
    }),
  };
}

/**
 * A still is media work, and it is counted against the same declared ceiling a live session is.
 *
 * Decoding a fresh still is one SDK pull and one decoder process, and on an idle camera it is the call that
 * opens the pull, so a controller asking about every camera at once costs as much as several viewers. The
 * ceiling therefore covers both, and a refused still is answered rather than failed: a camera list showing
 * real if older pictures is what a bounded host should look like.
 */
describe('snapshot acquisition under a declared ceiling', () => {
  const scope = () => ({ identity: {}, serial: SERIAL });
  const camera = (marker: string) => ({
    snapshotLive: vi.fn(async () => ({ jpeg: jpeg(marker), width: 1280, height: 720 })),
  });

  it('answers a Live request with the retained image rather than taking a still it has no room for', async () => {
    const retained = jpeg('retained');
    const budget = new DeclaredMediaSessionBudget(1);
    const acquisition = new SnapshotAcquisition(retainedImages([[SERIAL, retained]]), budget);
    const source = camera('fresh');
    const held = budget.claim();

    await expect(acquisition.acquire(scope(), source, 'Live')).resolves.toEqual(retained);
    expect(
      source.snapshotLive,
      'no decoder may be started for work the host declared no room for',
    ).not.toHaveBeenCalled();

    held!.release();
    await expect(acquisition.acquire(scope(), source, 'Live')).resolves.toEqual(jpeg('fresh'));
    expect(source.snapshotLive).toHaveBeenCalledOnce();
  });

  it('names the ceiling as the reason a camera with nothing retained went unanswered', async () => {
    const budget = new DeclaredMediaSessionBudget(1);
    const acquisition = new SnapshotAcquisition(retainedImages([]), budget);
    const onUnavailable = vi.fn();
    const held = budget.claim();

    await acquisition.acquire(scope(), camera('fresh'), 'Live', { onUnavailable }).catch(() => undefined);

    expect(
      onUnavailable,
      'a placeholder with no reason beside it is indistinguishable from a camera that is broken',
    ).toHaveBeenCalledWith('live-at-capacity');
    held!.release();
  });

  it('does not spend a refresh window on a refresh the ceiling refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const retained = jpeg('retained');
      const budget = new DeclaredMediaSessionBudget(1);
      const acquisition = new SnapshotAcquisition(retainedImages([[SERIAL, retained]]), budget, undefined, () => 0);
      const source = camera('fresh');
      const target = scope();
      const held = budget.claim();

      await expect(acquisition.acquire(target, source, 'Refresh')).resolves.toEqual(retained);
      expect(source.snapshotLive).not.toHaveBeenCalled();

      held!.release();
      await acquisition.acquire(target, source, 'Refresh');

      expect(
        source.snapshotLive,
        'a refused refresh never happened, so it cannot be what starts the next two-minute window',
      ).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the ceiling however the still ended', async () => {
    const budget = new DeclaredMediaSessionBudget(1);
    const acquisition = new SnapshotAcquisition(retainedImages([]), budget);
    const failing = { snapshotLive: vi.fn(async () => Promise.reject(new Error('synthetic decode failure'))) };

    await acquisition.acquire(scope(), failing, 'Live', {}).catch(() => undefined);

    expect(
      budget.claim(),
      'a still that failed still released the host, or one bad camera would consume the ceiling forever',
    ).toBeDefined();
  });

  it('spends one share of the ceiling on concurrent requests it coalesced', async () => {
    const budget = new DeclaredMediaSessionBudget(2);
    const acquisition = new SnapshotAcquisition(retainedImages([]), budget);
    const source = camera('fresh');
    const target = scope();

    const requests = [acquisition.acquire(target, source, 'Live'), acquisition.acquire(target, source, 'Live')];
    const spare = budget.claim();
    await Promise.all(requests);

    expect(source.snapshotLive).toHaveBeenCalledOnce();
    expect(spare, 'two requests answered by one decoder process cost one share, not two').toBeDefined();
  });
});
