import { describe, expect, it, vi } from 'vitest';

import { SnapshotAcquisition } from '../../src/media/snapshot.js';
import type { LastSuccessfulImages } from '../../src/media/snapshot.js';
import type { StationLiveSessionRegistry } from '../../src/media/contracts.js';

function jpeg(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker, 'utf8'), Buffer.from([0xff, 0xd9])]);
}

/** A retained-image store that answers from memory, so every request is decided by refresh policy alone. */
function retainedImages(entries: readonly (readonly [string, Buffer])[]): LastSuccessfulImages {
  const retained = new Map(entries);
  return {
    read: async (serial) => retained.get(serial),
    write: vi.fn(async (serial: string, image: Buffer) => {
      retained.set(serial, image);
    }),
  };
}

/** One camera whose live still resolves immediately, so its refresh never stays in flight. */
function camera(marker: string) {
  return { snapshotLive: vi.fn(async () => ({ jpeg: jpeg(marker), width: 1280, height: 720 })) };
}

/**
 * The background live refresh of a `Refresh` camera is spread across hosts rather than run on a shared clock.
 *
 * Every camera answers its first request from its retained image and starts one refresh behind it, so a
 * controller that asks about every camera at once — which is what opening a camera list does — makes every
 * camera become due at the same instant. A fixed interval then keeps them due at the same instant for as
 * long as the plugin runs: each round trip costs an SDK pull and a decoder process per camera, so the peloton
 * is the load, not the individual refresh.
 *
 * The spread is drawn once per refresh and carried as the next due time. Drawing it while deciding a request
 * would let the smallest of many draws win, which collapses the interval back onto its floor precisely on the
 * cameras being asked about most.
 */
describe('live refresh spread', () => {
  const serials = ['SYNTHETIC0000000A', 'SYNTHETIC0000000B'] as const;

  it('gives two cameras that became due together different next due times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const images = retainedImages(serials.map((serial) => [serial, jpeg(`retained ${serial}`)]));
      const draws = [0, 1];
      const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => draws.shift() ?? 0);
      const cameras = serials.map((serial) => camera(`refreshed ${serial}`));
      const scopes = serials.map((serial) => ({ identity: {}, serial }));

      for (const [index, scope] of scopes.entries()) {
        await acquisition.acquire(scope, cameras[index]!, 'Refresh');
      }
      await vi.waitFor(() => expect(images.write).toHaveBeenCalledTimes(2));
      for (const source of cameras) {
        expect(source.snapshotLive).toHaveBeenCalledOnce();
      }

      vi.setSystemTime(Date.now() + 150_000);
      for (const [index, scope] of scopes.entries()) {
        await acquisition.acquire(scope, cameras[index]!, 'Refresh');
      }

      expect(
        cameras[0]!.snapshotLive,
        'the camera drawn at the bottom of the spread is due first and refreshes alone',
      ).toHaveBeenCalledTimes(2);
      expect(
        cameras[1]!.snapshotLive,
        'the camera drawn at the top of the spread is not due yet, so the two no longer move together',
      ).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a camera to its drawn due time however often it is asked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const [serial] = serials;
      const images = retainedImages([[serial, jpeg('retained')]]);
      const draws = [1, 0, 0, 0, 0];
      const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => draws.shift() ?? 0);
      const source = camera('refreshed');
      const scope = { identity: {}, serial };

      await acquisition.acquire(scope, source, 'Refresh');
      await vi.waitFor(() => expect(images.write).toHaveBeenCalledOnce());

      vi.setSystemTime(Date.now() + 150_000);
      for (let request = 0; request < 4; request += 1) {
        await acquisition.acquire(scope, source, 'Refresh');
      }

      expect(
        source.snapshotLive,
        'a later draw of zero must not shorten a window already committed to at the top of the spread',
      ).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A background refresh stands aside while its camera's station is serving a live session.
 *
 * A base fans several cameras over one session and serves them one at a time, so a burst opened here contends
 * with a live view a person is watching. This refresh exists to keep a still current, which has no claim on a
 * station against that. The request it was started from is unaffected either way: it answers from the retained
 * image.
 */
describe('live refresh against a busy station', () => {
  const BASE = 'T8010P0000000000';
  const SERIAL = 'SYNTHETIC0000000C';

  /**
   * A registry reporting exactly the stations named as serving a live view.
   *
   * A station held for a live view admits nothing else: a still ranks below it, and an equal claim does not
   * displace, so the whole set is refused there.
   */
  const stations = (...watched: readonly string[]): StationLiveSessionRegistry => ({
    admits: (stationSn: string) => !watched.includes(stationSn),
    hold: () => () => undefined,
  });

  it('does not open a burst while the station is serving a live session', async () => {
    const images = retainedImages([[SERIAL, jpeg('retained')]]);
    const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => 0, stations(BASE));
    const source = camera('refreshed');

    await acquisition.acquire({ identity: {}, serial: SERIAL, stationSn: BASE }, source, 'Refresh');

    expect(source.snapshotLive).not.toHaveBeenCalled();
  });

  it('still answers the request from the retained image', async () => {
    const retained = jpeg('retained');
    const images = retainedImages([[SERIAL, retained]]);
    const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => 0, stations(BASE));

    const answered = await acquisition.acquire(
      { identity: {}, serial: SERIAL, stationSn: BASE },
      camera('refreshed'),
      'Refresh',
    );

    expect(answered).toEqual(retained);
  });

  it('opens a burst when another station is the busy one', async () => {
    const images = retainedImages([[SERIAL, jpeg('retained')]]);
    const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => 0, stations('T9999P0000000000'));
    const source = camera('refreshed');

    await acquisition.acquire({ identity: {}, serial: SERIAL, stationSn: BASE }, source, 'Refresh');

    await vi.waitFor(() => expect(source.snapshotLive).toHaveBeenCalledOnce());
  });

  /** A camera whose station the SDK did not state cannot be placed, so nothing defers it. */
  it('opens a burst for a camera with no station stated', async () => {
    const images = retainedImages([[SERIAL, jpeg('retained')]]);
    const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => 0, stations(BASE));
    const source = camera('refreshed');

    await acquisition.acquire({ identity: {}, serial: SERIAL }, source, 'Refresh');

    await vi.waitFor(() => expect(source.snapshotLive).toHaveBeenCalledOnce());
  });
});

/**
 * A still holds the station while it captures, and yields it to a live view opened on a sibling.
 *
 * Deferring before it starts is not enough: a burst already in flight goes on asking the base for its channel,
 * which is the contention the hold exists to remove. Measured on one base, a still on a sibling halved a live
 * view's frame rate for as long as it ran. Yielding aborts the acquisition, and the last good image answers the
 * request in its place.
 */
describe('a still asked to yield the station', () => {
  const BASE = 'T8010P0000000000';
  const SERIAL = 'SYNTHETIC0000000D';

  /** A registry that hands back the abandonment it was given, so a spec can trigger the yield. */
  const yieldable = () => {
    let abandon: (() => void) | undefined;
    const registry: StationLiveSessionRegistry = {
      admits: () => true,
      hold: (_stationSn, _camera, _claim, onAbandon) => {
        abandon = onAbandon;
        return () => undefined;
      },
    };
    return { registry, yieldNow: () => abandon?.() };
  };

  it('is told to abandon through the signal it passed the source', async () => {
    const { registry, yieldNow } = yieldable();
    const images = retainedImages([[SERIAL, jpeg('retained')]]);
    const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => 0, registry);
    let observed: AbortSignal | undefined;
    const source = {
      snapshotLive: vi.fn(async (options?: { signal?: AbortSignal }) => {
        observed = options?.signal;
        yieldNow();
        throw new Error('aborted');
      }),
    };

    await acquisition
      .acquire({ identity: {}, serial: SERIAL, stationSn: BASE }, source, 'Refresh')
      .catch(() => undefined);

    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(true);
  });

  it('releases the station once its capture has settled, so nothing stays held', async () => {
    let released = 0;
    const registry: StationLiveSessionRegistry = {
      admits: () => true,
      hold: () => () => {
        released += 1;
      },
    };
    const images = retainedImages([[SERIAL, jpeg('retained')]]);
    const acquisition = new SnapshotAcquisition(images, undefined, undefined, () => 0, registry);

    await acquisition
      .acquire({ identity: {}, serial: SERIAL, stationSn: BASE }, camera('refreshed'), 'Refresh')
      .catch(() => undefined);

    await vi.waitFor(() => expect(released).toBe(1));
  });
});
