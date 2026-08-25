import { readFileSync } from 'node:fs';

import type { LiveSnapshotUnavailableReason, StoredSnapshotUnavailableReason } from '@mega-yfue/eufy-sdk';
import { LiveSnapshotUnavailableError, StoredSnapshotUnavailableError } from '@mega-yfue/eufy-sdk';

import type {
  SnapshotAcquisitionScope,
  SnapshotFailure,
  SnapshotMediaAdapter,
  SnapshotMediaSource,
  SnapshotMode,
  SnapshotPresentation,
} from './contracts.js';

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
  offline: new URL('../../media/camera-offline.jpg', import.meta.url),
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

/** Which acquisition produced a retained image, which decides whether a later image may replace it. */
export type SnapshotProvenance = 'stored-only' | 'live';

/**
 * One acquisition outcome that left a request unanswered, carrying which acquisition it was rather than a
 * message a consumer would have to parse. The cause stays as the message, because a bounded vocabulary is
 * the only thing that may leave this domain.
 */
class UnansweredSnapshot extends Error {
  constructor(readonly failure: SnapshotFailure, message: string) {
    super(message);
  }
}

/**
 * The plugin reason for each reason the SDK's stored acquisition reports.
 *
 * The SDK owns why its own acquisition could not answer, so these are its words under a prefix naming the
 * acquisition rather than a plugin re-interpretation of them. The tables are exhaustive by type, so an SDK
 * that declares a new reason fails this build; one that reports a reason outside its declared union at
 * runtime is treated as the acquisition having failed without saying more.
 */
const STORED_FAILURES = {
  'not-observed': 'stored-not-observed',
  pending: 'stored-pending',
  'download-failed': 'stored-download-failed',
  'invalid-image': 'stored-invalid-image',
} as const satisfies Record<StoredSnapshotUnavailableReason, SnapshotFailure>;

/** The plugin reason for each reason the SDK's live still acquisition reports. */
const LIVE_FAILURES = {
  'no-keyframe': 'live-no-keyframe',
  'source-failed': 'live-source-failed',
  'undecodable-burst': 'live-undecodable-burst',
  'decoder-unavailable': 'live-decoder-unavailable',
} as const satisfies Record<LiveSnapshotUnavailableReason, SnapshotFailure>;

/**
 * Why the stored acquisition produced no usable image. An SDK refusal carries its own bounded reason; any
 * other outcome, including bytes this plugin refused to accept as an image, is the acquisition having
 * failed without saying more than that.
 */
function storedFailure(error: unknown): SnapshotFailure {
  return error instanceof StoredSnapshotUnavailableError && Object.hasOwn(STORED_FAILURES, error.reason)
    ? STORED_FAILURES[error.reason]
    : 'stored-failed';
}

/** Why the live still acquisition produced no usable image, under the same rule as the stored one. */
function liveFailure(error: unknown): SnapshotFailure {
  return error instanceof LiveSnapshotUnavailableError && Object.hasOwn(LIVE_FAILURES, error.reason)
    ? LIVE_FAILURES[error.reason]
    : 'live-failed';
}

/**
 * Which acquisition left a request unanswered. An outcome this domain did not classify is reported as no
 * acquisition having answered, because that is the only claim it can still make truthfully.
 */
function unansweredBy(error: unknown): SnapshotFailure {
  return error instanceof UnansweredSnapshot ? error.failure : 'no-acquisition';
}

/** The plugin-owned last successful image required by every snapshot acquisition policy. */
export interface LastSuccessfulImages {
  read(serial: string): Buffer | undefined;
  write(serial: string, jpeg: Buffer, provenance: SnapshotProvenance): void;
  discard?(serial: string): void;
  reconcile?(serials: Iterable<string>): void;
  discardAll?(): void;
}

/** Applies externally distinct stored-only, fresh-live, and retained-image acquisition policies. */
export class SnapshotAcquisition implements SnapshotMediaAdapter {
  private readonly pendingLive = new WeakMap<object, Promise<Buffer>>();
  private readonly liveRefreshedAtMs = new Map<string, number>();
  private readonly retentionGenerations = new Map<string, number>();
  private readonly failedLive = new Map<string, SnapshotFailure>();

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
   * After a permitted acquisition fails, a last successful real image wins over an explicit offline
   * presentation. Offline is shown only from a typed unavailable observation with no retained image; all
   * other empty states use the packaged unavailable image. A missing or malformed packaged image leaves the
   * request failing rather than serving bytes HomeKit cannot decode.
   *
   * Every request no camera image could answer names the acquisition that left it unanswered through
   * `onUnavailable`, whether a placeholder was substituted or nothing could be served at all. An intended
   * disabled or offline presentation names nothing, because that image is the answer rather than a
   * substitution for a missing one; a disabled camera whose packaged image this package does not carry
   * therefore fails silently here, because the fault is the installation rather than the camera.
   */
  acquire(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    mode: SnapshotMode,
    presentation: SnapshotPresentation = {},
  ): Promise<Buffer> {
    if (presentation.enabled === false) {
      const disabled = this.presentable('disabled');
      if (disabled) {
        return Promise.resolve(disabled);
      }
      return Promise.reject(new Error('disabled camera presentation is unavailable'));
    }
    return this.acquired(scope, source, mode, presentation).catch((error: unknown) => {
      const retained = this.images?.read(scope.serial);
      if (retained) {
        return retained;
      }
      if (presentation.availability === 'unavailable') {
        const offline = this.presentable('offline');
        if (offline) {
          return offline;
        }
      }
      presentation.onUnavailable?.(unansweredBy(error));
      const unavailable = this.presentable('unavailable');
      if (!unavailable) {
        throw error;
      }
      return unavailable;
    });
  }

  /** Retains one real image from a source another successful HomeKit live session already holds open. */
  async captureFromWarmLive(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): Promise<void> {
    const capture = this.live(scope, source);
    if (capture) {
      await capture;
    }
  }

  discard(serial: string): void {
    this.retentionGenerations.set(serial, this.retentionGeneration(serial) + 1);
    this.failedLive.delete(serial);
    this.images?.discard?.(serial);
  }

  reconcile(serials: Iterable<string>): void {
    const current = new Set(serials);
    for (const serial of this.retentionGenerations.keys()) {
      if (!current.has(serial)) {
        this.retentionGenerations.set(serial, this.retentionGeneration(serial) + 1);
      }
    }
    for (const serial of this.failedLive.keys()) {
      if (!current.has(serial)) {
        this.failedLive.delete(serial);
      }
    }
    this.images?.reconcile?.(current);
  }

  discardAll(): void {
    for (const serial of this.retentionGenerations.keys()) {
      this.retentionGenerations.set(serial, this.retentionGeneration(serial) + 1);
    }
    this.failedLive.clear();
    this.images?.discardAll?.();
  }

  /** One packaged image, or nothing when this package does not carry a decodable one under that name. */
  private presentable(name: PackagedImage): Buffer | undefined {
    const image = this.packaged(name);
    return image && isBoundedJpeg(image) ? image : undefined;
  }

  /**
   * The acquisition each mode is entitled to, rejecting with the one that left the request unanswered.
   *
   * A `Refresh` camera with nothing retained and no stored acquisition is answered by the live refresh it
   * just started, so it has no retained image yet; once that refresh has failed, the failure it reported is
   * the honest reason for every later request until one succeeds.
   */
  private acquired(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    mode: SnapshotMode,
    presentation: SnapshotPresentation,
  ): Promise<Buffer> {
    if (mode === 'Cloud') {
      return (
        this.stored(scope, source) ??
        Promise.reject(new UnansweredSnapshot('stored-unavailable', 'stored camera snapshot is unavailable'))
      );
    }
    if (mode === 'Live') {
      return (
        this.live(scope, source) ??
        Promise.reject(new UnansweredSnapshot('live-unavailable', 'live camera snapshot is unavailable'))
      );
    }
    if (mode === 'Refresh') {
      if (presentation.availability !== 'unavailable') {
        this.refreshLiveWhenDue(scope, source, presentation);
      }
      const retained = this.images?.read(scope.serial);
      if (retained) {
        return Promise.resolve(retained);
      }
      return (
        this.stored(scope, source) ??
        Promise.reject(
          new UnansweredSnapshot(
            this.pendingRefreshFailure(scope, source),
            'no camera snapshot image is available',
          ),
        )
      );
    }
    throw new TypeError(`unsupported snapshot acquisition mode: ${mode satisfies never}`);
  }

  /**
   * Whether a `Refresh` camera has nothing yet, nothing since its live still acquisition failed, or
   * nothing ever. The remembered failure is the acquisition's own, whichever call made it: a still a warm
   * live session was asked for is the same acquisition a refresh performs, so its failure explains a later
   * unanswered request just as well.
   */
  private pendingRefreshFailure(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): SnapshotFailure {
    if (!source.snapshotLive) {
      return 'no-acquisition';
    }
    return this.failedLive.get(scope.serial) ?? 'no-retained-image';
  }

  private stored(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): Promise<Buffer> | undefined {
    const snapshotStored = source.snapshotStored;
    if (!snapshotStored) {
      return undefined;
    }
    const generation = this.retentionGeneration(scope.serial);
    return Promise.resolve()
      .then(snapshotStored)
      .then((jpeg) => {
        return this.retain(scope, jpeg, 'stored-only', generation);
      })
      .catch((error: unknown) => {
        throw new UnansweredSnapshot(storedFailure(error), errorMessage(error));
      });
  }

  private live(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): Promise<Buffer> | undefined {
    const snapshotLive = source.snapshotLive;
    if (!snapshotLive) {
      return undefined;
    }
    const current = this.pendingLive.get(scope.identity);
    if (current) {
      return current;
    }
    const generation = this.retentionGeneration(scope.serial);
    const pending = Promise.resolve()
      .then(snapshotLive)
      .then(({ jpeg }) => {
        const retained = this.retain(scope, jpeg, 'live', generation);
        this.failedLive.delete(scope.serial);
        return retained;
      })
      .catch((error: unknown) => {
        const failure = liveFailure(error);
        this.failedLive.set(scope.serial, failure);
        throw new UnansweredSnapshot(failure, errorMessage(error));
      })
      .finally(() => {
        if (this.pendingLive.get(scope.identity) === pending) {
          this.pendingLive.delete(scope.identity);
        }
      });
    this.pendingLive.set(scope.identity, pending);
    return pending;
  }

  /** Only validated source images may be presented as camera imagery or retained for later requests. */
  private retain(
    scope: SnapshotAcquisitionScope,
    jpeg: Buffer,
    provenance: SnapshotProvenance,
    generation: number,
  ): Buffer {
    if (!isBoundedJpeg(jpeg)) {
      throw new Error('camera snapshot is not a bounded JPEG');
    }
    if (generation === this.retentionGeneration(scope.serial)) {
      this.images?.write(scope.serial, jpeg, provenance);
    }
    return jpeg;
  }

  private retentionGeneration(serial: string): number {
    return this.retentionGenerations.get(serial) ?? 0;
  }

  /**
   * Refresh acquires live imagery only on request, at most once every two minutes, and never polls.
   *
   * A refresh that fails while the camera still has nothing retained explains the placeholder that camera
   * is showing, so it is reported through the request that started it. A camera whose retained image
   * already answers its requests reports nothing, because a stale real image is still a camera image.
   */
  private refreshLiveWhenDue(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    presentation: SnapshotPresentation,
  ): void {
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
    refresh.catch((error: unknown) => {
      if (!this.images?.read(scope.serial)) {
        presentation.onUnavailable?.(unansweredBy(error));
      }
    });
  }
}

/** The cause of one failed acquisition, kept inside this domain as a message rather than a claim. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
