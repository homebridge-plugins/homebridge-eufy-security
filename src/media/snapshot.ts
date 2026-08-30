import { readFile } from 'node:fs/promises';

import type { LiveSnapshotUnavailableReason, StoredSnapshotUnavailableReason } from '@mega-yfue/eufy-sdk';
import { LiveSnapshotUnavailableError, StoredSnapshotUnavailableError } from '@mega-yfue/eufy-sdk';

import type {
  MediaSessionBudget,
  MediaSessionClaim,
  SnapshotAcquisitionScope,
  SnapshotFailure,
  SnapshotMediaAdapter,
  SnapshotMediaSource,
  SnapshotMode,
  SnapshotPresentation,
} from './contracts.js';

const LIVE_REFRESH_INTERVAL_MS = 120_000;
/**
 * How much later than the interval a refresh may fall due, drawn independently per camera per refresh.
 *
 * The spread only ever delays a refresh, because the interval is a floor on what this policy is allowed to
 * cost rather than a target. Half the interval separates the cameras of one household within a few rounds, and
 * makes a retained image only that much staler than the interval already allows.
 */
const LIVE_REFRESH_SPREAD_MS = LIVE_REFRESH_INTERVAL_MS / 2;

/** The largest image this plugin will accept or retain, which keeps one inside the Homebridge backup limit. */
export const MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;

/** The pixel geometry of a camera's own frame, as distinct from any geometry HomeKit negotiated. */
export interface ImageGeometry {
  readonly width: number;
  readonly height: number;
}

/**
 * The geometry a JPEG's start-of-frame declares, or nothing when the bytes do not state one.
 *
 * The only account of a camera's native picture shape available before a stream runs. The SDK publishes none
 * at discovery — no cloud field carries it and the video-quality member is a tier label rather than a shape —
 * while a retained image is a real frame from that camera and survives restarts.
 *
 * Every start-of-frame marker is accepted, not only the baseline one, because which of them a camera sends is
 * its choice and they all declare the geometry in the same place. The scan is bounded and refuses anything it
 * cannot read: a segment length that would not advance, one that walks past the end, a header truncated
 * before its geometry, or a zero dimension. This reads bytes a device produced, so the answer is a geometry
 * or nothing — a wrong one would have HomeKit told the wrong shape for the life of the accessory.
 */
export function jpegGeometry(jpeg: Buffer): ImageGeometry | undefined {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return undefined;
  }
  for (let offset = 2; offset + 9 < jpeg.length; ) {
    if (jpeg[offset] !== 0xff) {
      return undefined;
    }
    // Any number of 0xff fill bytes may precede a marker, so the marker is the first byte that is not one.
    while (offset + 1 < jpeg.length && jpeg[offset + 1] === 0xff) {
      offset++;
    }
    if (offset + 9 >= jpeg.length) {
      return undefined;
    }
    const marker = jpeg[offset + 1]!;
    const length = jpeg.readUInt16BE(offset + 2);
    // A start-of-frame is any of SOF0..SOF3 / SOF5..SOF7 / SOF9..; the four-marker span below covers the
    // codings a camera sends, and each states height then width at the same offset.
    if (marker >= 0xc0 && marker <= 0xc3) {
      if (offset + 9 >= jpeg.length || length < 8) {
        return undefined;
      }
      const height = jpeg.readUInt16BE(offset + 5);
      const width = jpeg.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (length < 2) {
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

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

const packagedImages = new Map<PackagedImage, Promise<Buffer | undefined>>();

/**
 * Reads one packaged image at most once per process, and answers nothing at all when this package does not
 * carry it.
 *
 * The read in progress is what is retained rather than its result, so concurrent requests for the same
 * placeholder share one read instead of each starting another.
 */
function packagedImage(name: PackagedImage): Promise<Buffer | undefined> {
  let pending = packagedImages.get(name);
  if (!pending) {
    pending = readFile(PACKAGED_IMAGES[name]).catch(() => undefined);
    packagedImages.set(name, pending);
  }
  return pending;
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

/**
 * The share held by work whose cost the declared ceiling has already admitted somewhere else.
 *
 * Exactly two cases qualify, and both would be charged twice by a claim of their own. A request that joins an
 * acquisition already in flight is answered by that acquisition's decoder rather than one of its own; a still
 * taken from a source a live session is holding open adds a decode to a pull that session already paid for. A
 * ceiling of one would otherwise refuse a camera a still while it was streaming, which is the case sharing a
 * warm source exists to serve.
 */
const UNBILLED: MediaSessionClaim = { release: () => undefined };

/**
 * What an acquisition counts against when no ceiling was declared: nothing.
 *
 * Normalising the absent budget to one that admits everything keeps a single encoding of "no ceiling". Reading
 * the absence at each decision instead would make one `undefined` mean both "nothing was declared" and "the
 * host has no room", which are opposite answers.
 */
const UNBOUNDED_MEDIA: MediaSessionBudget = { claim: () => UNBILLED };

/** The plugin-owned last successful image required by every snapshot acquisition policy. */
export interface LastSuccessfulImages {
  read(serial: string): Promise<Buffer | undefined>;
  write(serial: string, jpeg: Buffer, provenance: SnapshotProvenance): Promise<void>;
  discard?(serial: string): Promise<void>;
  reconcile?(serials: Iterable<string>): Promise<void>;
  discardAll?(): Promise<void>;
}

/** Applies externally distinct stored-only, fresh-live, and retained-image acquisition policies. */
export class SnapshotAcquisition implements SnapshotMediaAdapter {
  private readonly pendingLive = new WeakMap<object, Promise<Buffer>>();
  private readonly liveRefreshDueAtMs = new Map<string, number>();
  private readonly retentionGenerations = new Map<string, number>();
  private readonly failedLive = new Map<string, SnapshotFailure>();

  constructor(
    private readonly images?: LastSuccessfulImages,
    private readonly budget?: MediaSessionBudget,
    private readonly packaged: (name: PackagedImage) => Promise<Buffer | undefined> = packagedImage,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * The native geometry of the image retained for `serial`, or nothing when none is retained or its bytes
   * state none.
   *
   * A camera's own picture shape, which nothing else can answer before a stream runs. Read from disk on
   * demand rather than cached here: it is asked once per accessory at setup, and the retained image is
   * replaced by a later snapshot whose shape is the one that then matters.
   */
  async retainedGeometry(serial: string): Promise<ImageGeometry | undefined> {
    const retained = await this.images?.read(serial);
    return retained ? jpegGeometry(retained) : undefined;
  }

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
      return this.presentable('disabled').then((disabled) => {
        if (disabled) {
          return disabled;
        }
        throw new Error('disabled camera presentation is unavailable');
      });
    }
    return this.acquired(scope, source, mode, presentation).catch(async (error: unknown) => {
      const retained = await this.images?.read(scope.serial);
      if (retained) {
        return retained;
      }
      if (presentation.availability === 'unavailable') {
        const offline = await this.presentable('offline');
        if (offline) {
          return offline;
        }
      }
      presentation.onUnavailable?.(unansweredBy(error));
      const unavailable = await this.presentable('unavailable');
      if (!unavailable) {
        throw error;
      }
      return unavailable;
    });
  }

  /** Retains one real image from a source another successful HomeKit live session already holds open. */
  async captureFromWarmLive(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): Promise<void> {
    const capture = this.live(scope, source, UNBILLED);
    if (capture) {
      await capture;
    }
  }

  discard(serial: string): void {
    this.retentionGenerations.set(serial, this.retentionGeneration(serial) + 1);
    this.failedLive.delete(serial);
    void this.images?.discard?.(serial);
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
    void this.images?.reconcile?.(current);
  }

  discardAll(): void {
    for (const serial of this.retentionGenerations.keys()) {
      this.retentionGenerations.set(serial, this.retentionGeneration(serial) + 1);
    }
    this.failedLive.clear();
    void this.images?.discardAll?.();
  }

  /** One packaged image, or nothing when this package does not carry a decodable one under that name. */
  private async presentable(name: PackagedImage): Promise<Buffer | undefined> {
    const image = await this.packaged(name);
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
      if (!source.snapshotLive) {
        return Promise.reject(new UnansweredSnapshot('live-unavailable', 'live camera snapshot is unavailable'));
      }
      const claim = this.claimForLive(scope);
      if (!claim) {
        return Promise.reject(
          new UnansweredSnapshot('live-at-capacity', 'the declared concurrent media limit is reached'),
        );
      }
      return this.live(scope, source, claim)!;
    }
    if (mode === 'Refresh') {
      if (presentation.availability !== 'unavailable') {
        this.refreshLiveWhenDue(scope, source, presentation);
      }
      return this.refreshed(scope, source);
    }
    throw new TypeError(`unsupported snapshot acquisition mode: ${mode satisfies never}`);
  }

  /** What a `Refresh` camera can answer with now: its retained image, or the stored acquisition instead. */
  private async refreshed(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): Promise<Buffer> {
    const retained = await this.images?.read(scope.serial);
    if (retained) {
      return retained;
    }
    const stored = this.stored(scope, source);
    if (stored) {
      return stored;
    }
    throw new UnansweredSnapshot(this.pendingRefreshFailure(scope, source), 'no camera snapshot image is available');
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

  /**
   * One share of the declared ceiling for a still, or nothing when the host has no room for another.
   *
   * A request joining an acquisition already in flight rides that acquisition's share, because it is answered
   * by the same decoder.
   */
  private claimForLive(scope: SnapshotAcquisitionScope): MediaSessionClaim | undefined {
    if (this.pendingLive.has(scope.identity)) {
      return UNBILLED;
    }
    return (this.budget ?? UNBOUNDED_MEDIA).claim();
  }

  private live(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    claim: MediaSessionClaim,
  ): Promise<Buffer> | undefined {
    const snapshotLive = source.snapshotLive;
    if (!snapshotLive) {
      claim.release();
      return undefined;
    }
    const current = this.pendingLive.get(scope.identity);
    if (current) {
      claim.release();
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
        claim.release();
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
      void this.images?.write(scope.serial, jpeg, provenance);
    }
    return jpeg;
  }

  private retentionGeneration(serial: string): number {
    return this.retentionGenerations.get(serial) ?? 0;
  }

  /**
   * Refresh acquires live imagery only on request, no more than once per spread interval, and never polls.
   *
   * The next due time is committed when a refresh starts rather than derived when a request is decided, so
   * the spread each camera drew holds however often that camera is asked about. Deriving it per request would
   * take the shortest of many draws and return the busiest cameras to a shared clock.
   *
   * A refresh the declared ceiling had no room for never happened, so it commits no window: the camera keeps
   * answering from its retained image and the next request tries again. Spending the window on a refusal would
   * let a busy host push every camera's refresh further away precisely while they are all being asked for.
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
    const dueAt = this.liveRefreshDueAtMs.get(scope.serial);
    if (dueAt !== undefined && Date.now() < dueAt) {
      return;
    }
    if (this.pendingLive.has(scope.identity) || !source.snapshotLive) {
      return;
    }
    const claim = this.claimForLive(scope);
    if (!claim) {
      return;
    }
    const refresh = this.live(scope, source, claim);
    if (!refresh) {
      return;
    }
    this.liveRefreshDueAtMs.set(
      scope.serial,
      Date.now() + LIVE_REFRESH_INTERVAL_MS + this.random() * LIVE_REFRESH_SPREAD_MS,
    );
    refresh.catch(async (error: unknown) => {
      if (!(await this.images?.read(scope.serial))) {
        presentation.onUnavailable?.(unansweredBy(error));
      }
    });
  }
}

/** The cause of one failed acquisition, kept inside this domain as a message rather than a claim. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
