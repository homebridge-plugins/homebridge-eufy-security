import type { CameraActions } from '@mega-yfue/eufy-sdk';

import type { SnapshotMode } from '../configuration.js';

const LIVE_REFRESH_INTERVAL_MS = 120_000;

interface SnapshotSource {
  snapshotStored?(): ReturnType<NonNullable<CameraActions['snapshotStored']>>;
  snapshotLive?(): ReturnType<NonNullable<CameraActions['snapshotLive']>>;
}

interface SnapshotScope {
  readonly identity: object;
  readonly serial: string;
}

/** Which acquisition produced a retained image, which decides whether a later image may replace it. */
export type SnapshotProvenance = 'stored-only' | 'live';

/** The plugin-owned last successful image required by every snapshot acquisition policy. */
export interface LastSuccessfulImages {
  read(serial: string): Buffer | undefined;
  write(serial: string, jpeg: Buffer, provenance: SnapshotProvenance): void;
}

/** Applies externally distinct stored-only, fresh-live, and retained-image acquisition policies. */
export class SnapshotAcquisition {
  private readonly pendingLive = new WeakMap<object, Promise<Buffer>>();
  private readonly liveRefreshedAtMs = new Map<string, number>();

  constructor(private readonly images?: LastSuccessfulImages) {}

  acquire(scope: SnapshotScope, source: SnapshotSource, mode: SnapshotMode): Promise<Buffer> {
    if (mode === 'Cloud') {
      return this.stored(scope, source) ?? Promise.reject(new Error('stored camera snapshot is unavailable'));
    }
    if (mode === 'Live') {
      return this.live(scope, source) ?? Promise.reject(new Error('live camera snapshot is unavailable'));
    }
    if (mode === 'Refresh') {
      this.refreshLiveWhenDue(scope, source);
      const retained = this.images?.read(scope.serial);
      if (retained) {
        return Promise.resolve(retained);
      }
      return this.stored(scope, source) ?? Promise.reject(new Error('no camera snapshot image is available'));
    }
    throw new TypeError(`unsupported snapshot acquisition mode: ${mode satisfies never}`);
  }

  private stored(scope: SnapshotScope, source: SnapshotSource): Promise<Buffer> | undefined {
    const snapshotStored = source.snapshotStored;
    if (!snapshotStored) {
      return undefined;
    }
    return Promise.resolve()
      .then(snapshotStored)
      .then((jpeg) => {
        this.images?.write(scope.serial, jpeg, 'stored-only');
        return jpeg;
      });
  }

  private live(scope: SnapshotScope, source: SnapshotSource): Promise<Buffer> | undefined {
    const snapshotLive = source.snapshotLive;
    if (!snapshotLive) {
      return undefined;
    }
    const current = this.pendingLive.get(scope.identity);
    if (current) {
      return current;
    }
    const pending = Promise.resolve()
      .then(snapshotLive)
      .then(({ jpeg }) => {
        this.images?.write(scope.serial, jpeg, 'live');
        return jpeg;
      })
      .finally(() => {
        if (this.pendingLive.get(scope.identity) === pending) {
          this.pendingLive.delete(scope.identity);
        }
      });
    this.pendingLive.set(scope.identity, pending);
    return pending;
  }

  /** Refresh acquires live imagery only on request, at most once every two minutes, and never polls. */
  private refreshLiveWhenDue(scope: SnapshotScope, source: SnapshotSource): void {
    const previous = this.liveRefreshedAtMs.get(scope.serial);
    if (previous !== undefined && Date.now() - previous < LIVE_REFRESH_INTERVAL_MS) {
      return;
    }
    if (this.pendingLive.has(scope.identity)) {
      return;
    }
    const refresh = this.live(scope, source);
    if (!refresh) {
      return;
    }
    this.liveRefreshedAtMs.set(scope.serial, Date.now());
    refresh.catch(() => undefined);
  }
}
