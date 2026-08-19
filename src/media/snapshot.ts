import type { CameraActions } from '@mega-yfue/eufy-sdk';

interface SnapshotSource {
  snapshotStored?(): ReturnType<NonNullable<CameraActions['snapshotStored']>>;
  snapshotLive?(): ReturnType<NonNullable<CameraActions['snapshotLive']>>;
}

interface SnapshotScope {
  readonly identity: object;
}

/** Applies externally distinct stored-only and fresh-live acquisition policies. */
export class SnapshotAcquisition {
  private readonly pendingLive = new WeakMap<object, Promise<Buffer>>();

  acquire(scope: SnapshotScope, source: SnapshotSource, mode: 'Cloud' | 'Live'): Promise<Buffer> {
    if (mode === 'Cloud') {
      const snapshotStored = source.snapshotStored;
      return snapshotStored
        ? Promise.resolve().then(snapshotStored)
        : Promise.reject(new Error('stored camera snapshot is unavailable'));
    }
    if (mode === 'Live') {
      const snapshotLive = source.snapshotLive;
      if (!snapshotLive) {
        return Promise.reject(new Error('live camera snapshot is unavailable'));
      }
      const current = this.pendingLive.get(scope.identity);
      if (current) {
        return current;
      }
      const pending = Promise.resolve()
        .then(snapshotLive)
        .then(({ jpeg }) => jpeg)
        .finally(() => {
          if (this.pendingLive.get(scope.identity) === pending) {
            this.pendingLive.delete(scope.identity);
          }
        });
      this.pendingLive.set(scope.identity, pending);
      return pending;
    }
    throw new TypeError(`unsupported snapshot acquisition mode: ${mode satisfies never}`);
  }
}
