import type { CameraActions } from '@mega-yfue/eufy-sdk';
import { readFileSync } from 'node:fs';

import type { SnapshotMode } from '../configuration.js';

const LIVE_REFRESH_INTERVAL_MS = 120_000;

/** The largest image this plugin will accept or retain, which keeps one inside the Homebridge backup limit. */
export const MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;

/** A bounded non-empty payload delimited by the JPEG start-of-image and end-of-image markers. */
export function isBoundedJpeg(jpeg: Buffer): boolean {
  return (
    jpeg.length > 5 &&
    jpeg.length <= MAXIMUM_IMAGE_BYTES &&
    jpeg[0] === 0xff &&
    jpeg[1] === 0xd8 &&
    jpeg[2] === 0xff &&
    jpeg[jpeg.length - 2] === 0xff &&
    jpeg[jpeg.length - 1] === 0xd9
  );
}

/**
 * The images served when a camera cannot supply one. They ship beside the package as baseline JPEGs at the
 * largest resolution HomeKit asks for, because a controller scales what it is given and these paths must not
 * depend on an encoder being available.
 *
 * Resolving them relative to this module reaches the same packaged files whether the module was loaded from
 * `src/` or from `dist/`, both of which sit one directory below the package root.
 */
const PACKAGED_IMAGES = {
  disabled: new URL('../../media/camera-disabled.jpg', import.meta.url),
  unavailable: new URL('../../media/Snapshot-Unavailable.jpg', import.meta.url),
} as const;

/** Which packaged image a presentation decision calls for. */
export type PackagedImage = keyof typeof PACKAGED_IMAGES;

const packagedImages = new Map<PackagedImage, Buffer | null>();

/** Reads one packaged image once, and nothing at all when this package does not carry it. */
function packagedImage(name: PackagedImage): Buffer | undefined {
  if (!packagedImages.has(name)) {
    try {
      packagedImages.set(name, readFileSync(PACKAGED_IMAGES[name]));
    } catch {
      packagedImages.set(name, null);
    }
  }
  return packagedImages.get(name) ?? undefined;
}

interface SnapshotSource {
  snapshotStored?(): ReturnType<NonNullable<CameraActions['snapshotStored']>>;
  snapshotLive?(): ReturnType<NonNullable<CameraActions['snapshotLive']>>;
}

/** What HomeKit knows about a camera that changes how its snapshot must be presented. */
export interface SnapshotPresentation {
  /** Whether the camera is enabled, when an admitted observation reports it, and nothing otherwise. */
  readonly enabled?: boolean;
  /** Called when the packaged unavailable image was served in place of a camera image. */
  onPlaceholder?(): void;
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

  constructor(
    private readonly images?: LastSuccessfulImages,
    private readonly packaged: (name: PackagedImage) => Buffer | undefined = packagedImage,
  ) {}

  /**
   * Answers one snapshot request under the selected policy.
   *
   * A camera an admitted observation reports as disabled is presented with the packaged disabled image and
   * nothing else: no acquisition is attempted, and its retained image is kept but never served, because a
   * real frame from before the camera was switched off would misrepresent what it is doing now. An absent or
   * malformed observation is not a disabled one and falls through to the normal policy.
   *
   * When the selected policy produces nothing at all, the packaged unavailable image is served instead and
   * the substitution is announced through `onPlaceholder`, so its consumer can report that no acquisition
   * answered rather than leaving a served placeholder indistinguishable from a served camera image. A missing
   * or malformed packaged image leaves the request failing as it did before either image existed, rather than
   * serving bytes HomeKit cannot decode.
   */
  acquire(
    scope: SnapshotScope,
    source: SnapshotSource,
    mode: SnapshotMode,
    presentation: SnapshotPresentation = {},
  ): Promise<Buffer> {
    if (presentation.enabled === false) {
      const disabled = this.presentable('disabled');
      if (disabled) {
        return Promise.resolve(disabled);
      }
    }
    return this.acquired(scope, source, mode).catch((error: unknown) => {
      const unavailable = this.presentable('unavailable');
      if (!unavailable) {
        throw error;
      }
      presentation.onPlaceholder?.();
      return unavailable;
    });
  }

  /** One packaged image, or nothing when this package does not carry a decodable one under that name. */
  private presentable(name: PackagedImage): Buffer | undefined {
    const image = this.packaged(name);
    return image && isBoundedJpeg(image) ? image : undefined;
  }

  private acquired(scope: SnapshotScope, source: SnapshotSource, mode: SnapshotMode): Promise<Buffer> {
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
