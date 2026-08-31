import type { FragmentRecordingHandle, LiveStreamConsumer, TalkbackHandle } from '@mega-yfue/eufy-sdk';

import type { SnapshotMode } from '../configuration.js';

export type { SnapshotMode } from '../configuration.js';

export interface LiveMediaSource {
  live(options?: { signal?: AbortSignal }): Promise<LiveStreamConsumer>;
  talkback?(): Promise<TalkbackHandle>;
}

export interface LiveMediaTarget {
  readonly port: number;
  readonly srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80' | 'AES_CM_256_HMAC_SHA1_80';
  readonly srtpKey: Buffer;
  readonly srtpSalt: Buffer;
}

export interface NegotiatedLiveVideo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly maxBitRate: number;
  readonly profile: 'baseline' | 'main' | 'high';
  readonly level: '3.1' | '3.2' | '4.0';
  readonly payloadType: number;
  readonly ssrc: number;
  readonly mtu: number;
  readonly rtcpInterval: number;
}

export interface NegotiatedLiveAudio {
  readonly codec: 'AAC-eld';
  readonly channels: number;
  readonly sampleRate: 16 | 24;
  readonly maxBitRate: number;
  readonly payloadType: number;
  readonly ssrc: number;
}

export interface NegotiatedLiveMedia {
  readonly video: NegotiatedLiveVideo;
  readonly audio?: NegotiatedLiveAudio;
}

/**
 * Why one live session ended without usable video, in a bounded plugin-owned vocabulary.
 *
 * `source-audio-only` names what the SDK source did rather than why: it answered the start, delivered
 * audio, and never a video frame. That is a switched-off camera's signature, and also that of a camera
 * whose video this build cannot read, so the reason states the observation and leaves the diagnosis to
 * whatever else is known about the camera.
 *
 * The three adaptation reasons are distinct because they have distinct causes and distinct fixes. A process
 * that never started names a binary that is missing, unreadable or not executable; one that exited before
 * producing output names an encoder, argument or format the resolved build does not have; one that exited
 * mid-session names a run that was working and stopped. `adaptation-failed` is what remains when none of
 * those describes it, which is the output pipe failing while the process itself is still reported as alive.
 */
export type LiveSessionFailure =
  /**
   * The station was serving another of its cameras and did not free it in time.
   *
   * Distinct from every other failure here because nothing is broken: a base serves one camera at a time and
   * the SDK refuses a second rather than degrading both. Collapsing it into `source-error` made a camera that
   * was merely waiting its turn read as a camera that failed, and left no way to tell the two apart in a log.
   */
  | 'station-busy'
  | 'source-acquisition-timeout'
  | 'no-video-within-backstop'
  | 'source-audio-only'
  | 'source-error'
  | 'source-stopped'
  | 'rtcp-timeout'
  | 'adaptation-spawn-failed'
  | 'adaptation-exited-before-output'
  | 'adaptation-exited-while-streaming'
  | 'adaptation-failed';

/** The live-start boundary at which a bounded session failure became observable. */
export type LiveSessionFailureStage =
  | 'sdk-source-acquisition'
  | 'first-source-keyframe'
  | 'first-adapted-output'
  | 'controller-rtcp';

/** One live session lifecycle outcome, carrying no device identity, address, key, or media material. */
export type LiveSessionOutcome =
  | { readonly outcome: 'streaming' }
  | { readonly outcome: 'failed'; readonly reason: LiveSessionFailure; readonly stage: LiveSessionFailureStage };

/** Why one return-audio lifecycle ended without usable device audio. */
export type TalkbackFailure = 'source-unavailable' | 'unsupported-selection' | 'adaptation-failed' | 'device-audio-failed';

/** One isolated return-audio outcome, carrying no media, address, key, or device identity. */
export type TalkbackOutcome =
  | { readonly outcome: 'talking' }
  | { readonly outcome: 'failed'; readonly reason: TalkbackFailure };

/**
 * Which adaptation process one bounded FFmpeg notice came from.
 *
 * These are the processes this domain owns. Whoever records a notice may recognise more — the SDK runs FFmpeg
 * of its own — so its allowlist is a superset of this one, and nothing here may claim a role it does not own.
 */
export type AdaptationRole = 'live-video' | 'live-audio' | 'return-audio' | 'recording';

/**
 * What one adaptation process did, at the granularity that decides where to look next.
 *
 * `exited-before-output` and `exited-while-streaming` are separated because the process's own exit status
 * means opposite things either side of first output: before it, the run never worked and the exit names a
 * build that cannot satisfy the arguments it was given; after it, the run did work and something ended it.
 *
 * `output` is a process that ended as its session intended, reported only because it had written diagnostics
 * of its own. A build that warns its way through a working session is what a "live view is unwatchable"
 * report needs, and it is not a failure, so no reason is raised for it.
 */
export type AdaptationEvent = 'started' | 'spawn-failed' | 'exited-before-output' | 'exited-while-streaming' | 'output';

/**
 * One bounded FFmpeg fact a media session observed, in the terms a support archive may keep.
 *
 * `stderr` is the tail the process last wrote, which is the only place an encoder-level cause is stated
 * outright. It is passed on verbatim and reduced by whoever records it, because the argument list this
 * domain builds carries SRTP key material and an output address, and either can be echoed back on that
 * same pipe.
 */
export interface AdaptationNotice {
  readonly role: AdaptationRole;
  readonly event: AdaptationEvent;
  readonly code?: number;
  readonly signal?: string;
  readonly stderr?: readonly string[];
  /**
   * How many source fragments a recording wrote to this process.
   *
   * A recording whose source delivered nothing closes an empty input, and FFmpeg reports that in the same
   * words it uses for malformed input — so the count is what separates a source that never answered from an
   * adaptation that could not read what it was given.
   */
  readonly sourceFragments?: number;
}

/** Where a media adaptation reports what its FFmpeg process did, without owning how it is recorded. */
export interface AdaptationDiagnostics {
  report(notice: AdaptationNotice): void;
}

/**
 * One held share of the host's declared media capacity, released exactly once however its work ended.
 *
 * Release is idempotent because the work it covers can end by more paths than any one of them knows about: a
 * controller stopping a stream, a source failing, a preparation being cancelled, and an accessory being
 * detached all tear the same session down. Counting a second release would hand the host a share it does not
 * have, and every one of those paths has to be safe to run.
 */
export interface MediaSessionClaim {
  release(): void;
}

/**
 * The declared ceiling on concurrent media work, asked before work that would exceed it is started.
 *
 * A claim is refused rather than queued. HomeKit bounds a snapshot request at twenty-five seconds and cannot
 * renegotiate a live selection at all, so waiting for capacity presents as a camera that has broken rather
 * than one that is busy, and answering now with the older truth is worth more than answering later with the
 * newer one.
 *
 * Nothing here can reach the work it admitted, which is deliberate: admission may refuse a new session but
 * may never end an established one, because a viewer cannot tell an eviction from a failure.
 */
export interface MediaSessionBudget {
  claim(): MediaSessionClaim | undefined;
}

/**
 * Which stations are serving a live session, asked before opportunistic live work is started elsewhere on one.
 *
 * A HomeBase fans several cameras over one session and serves them one at a time, so a live burst opened on
 * one of its cameras contends with a live view running on another. A standalone camera is its own station and
 * contends with nobody.
 *
 * Distinct from {@link MediaSessionBudget}, which counts concurrent work against a ceiling an operator
 * declared and refuses what exceeds it. This answers where the work would land, and it refuses nothing: a
 * caller decides whether its own work is worth deferring.
 */
/**
 * What a caller holds a station's one live channel for.
 *
 * The order between them is this plugin's product policy and lives with the registry that applies it. The SDK
 * reports only that a station serves one camera at a time; it does not rank the callers, because the ranking
 * depends on what a host shows at once.
 */
export type StationLiveClaim = 'live' | 'recording' | 'snapshot';

export interface StationLiveSessionRegistry {
  /** The strongest claim currently held on `stationSn`, or `undefined` where nothing holds it. */
  heldFor(stationSn: string): StationLiveClaim | undefined;
  /**
   * Whether `camera` may take `stationSn` for `claim` now.
   *
   * A camera the station is already serving is always admitted, whatever the claim: work on one camera shares
   * a single pull, so a recording and a live view of the same camera cost the station nothing extra. This is
   * the shape a motion notification produces, and it is the common one.
   *
   * Between DIFFERENT cameras of one station the claim decides, and equal claims do not displace: a second
   * live view does not evict the first.
   */
  admits(stationSn: string, camera: string, claim: StationLiveClaim): boolean;
  /**
   * Record one session on `stationSn` for `camera`, asking anything weaker on another camera to yield first,
   * and answer the release that ends it.
   *
   * `abandon` is how this session gives the station back early; a session that cannot be stopped cleanly omits
   * it and is never asked. A session is never asked to yield for another claim on its own camera.
   */
  hold(stationSn: string, camera: string, claim: StationLiveClaim, abandon?: () => void): () => void;
}

export interface LiveMediaTransport {
  readonly addressVersion: 'ipv4' | 'ipv6';
  readonly targetAddress: string;
  readonly video: LiveMediaTarget;
  readonly audio?: LiveMediaTarget;
  readonly onVideoFailure?: () => void;
  readonly onSessionOutcome?: (outcome: LiveSessionOutcome) => void;
  readonly onSessionReleased?: () => void;
  readonly onTalkbackOutcome?: (outcome: TalkbackOutcome) => void;
  /**
   * The coded configuration the SDK announced for this camera's source, each time it changes.
   *
   * The authoritative account of what the camera produces — read from the parameter sets in force rather than
   * inferred from an image — and the only one available without a second guess. A consumer records it to
   * decide what to offer a controller next time; the session itself needs nothing from the answer.
   */
  readonly onSourceConfiguration?: (config: { readonly width: number; readonly height: number }) => void;
}

export interface PreparedLiveMedia {
  readonly videoPort: number;
  readonly audioPort?: number;
  start(source: LiveMediaSource, negotiated: NegotiatedLiveMedia): Promise<void>;
  reconfigure(video: NegotiatedLiveVideo): void;
  stop(): void;
}

/** Camera-owned media adaptation requested without exposing its concrete FFmpeg implementation. */
export interface LiveMediaAdapter {
  prepare(transport: LiveMediaTransport): Promise<PreparedLiveMedia>;
}

export interface NegotiatedRecordedAudio {
  readonly codec: 'AAC-lc' | 'AAC-eld';
  readonly channels: number;
  readonly sampleRate: 16 | 24 | 32 | 48;
  readonly maxBitRate: number;
}

/**
 * The complete recording contract one HomeKit controller selected. Audio is absent both when the controller
 * negotiated none and when it withdrew recording audio, because either way the output carries no audio track.
 *
 * `prebufferLengthMs` is the pre-event media this recording asks its source for, already reduced to what
 * its camera retains, so zero asks for none. How much of it exists is the source's own answer: a source
 * carrying less hands over less, and one carrying a whole retained window may hand over all of it.
 */
export interface NegotiatedRecording {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly maxBitRate: number;
  readonly profile: 'baseline' | 'main' | 'high';
  readonly level: '3.1' | '3.2' | '4.0';
  readonly iFrameIntervalMs: number;
  readonly fragmentLengthMs: number;
  readonly prebufferLengthMs: number;
  readonly audio?: NegotiatedRecordedAudio;
}

/** Why one recording produced no further usable output, in the bounded vocabulary the media domain owns. */
export type RecordingFailure =
  | 'source-unavailable'
  | 'source-error'
  | 'no-output-within-backstop'
  | 'adaptation-failed'
  /**
   * The station was serving another of its cameras to something this recording does not outrank.
   *
   * Not a fault. A base serves one camera at a time and the SDK refuses a second rather than degrading both,
   * so this says the recording could not have the station, not that anything is broken. HomeKit tries again on
   * the next trigger.
   */
  | 'station-busy';

/** One recording lifecycle outcome, carrying no device identity, address, key, or media material. */
export type RecordingOutcome =
  | { readonly outcome: 'recording' }
  | { readonly outcome: 'failed'; readonly reason: RecordingFailure };

/** One adapted recording output unit: the initialization segment, or one complete media fragment. */
export interface RecordedFragment {
  readonly data: Buffer;
  readonly last: boolean;
}

export interface RecordingMediaSource {
  recordFragments?(options?: {
    fragmentSeconds?: number;
    preBufferSeconds?: number;
    signal?: AbortSignal;
  }): FragmentRecordingHandle;
}

/** One recording in progress: the units it produces, and the one call that ends it. */
export interface AdaptedRecording extends AsyncIterable<RecordedFragment> {
  stop(): void;
}

export interface RecordingLifecycle {
  onOutcome?(outcome: RecordingOutcome): void;
}

/** Camera-owned recording adaptation requested without exposing its concrete FFmpeg implementation. */
export interface RecordingMediaAdapter {
  record(
    source: RecordingMediaSource,
    negotiated: NegotiatedRecording,
    lifecycle?: RecordingLifecycle,
  ): AdaptedRecording;
}

export interface SnapshotMediaSource {
  snapshotStored?(): Promise<Buffer>;
  snapshotLive?(options?: { signal?: AbortSignal }): Promise<{
    jpeg: Buffer;
    width: number;
    height: number;
    retained?: true;
  }>;
}

/** Stable camera-local identity that preserves concurrent acquisition lifetime across source replacement. */
export interface SnapshotAcquisitionScope {
  readonly identity: object;
  readonly serial: string;
  /**
   * The station this camera's traffic belongs to — its parent base, or its own serial when it has none.
   *
   * Absent when the SDK stated none, which leaves opportunistic work unable to tell where it would land and so
   * ungoverned, exactly as it was before the station was known.
   */
  readonly stationSn?: string;
}

/**
 * Which acquisition left a camera with no image to present, in a bounded plugin-owned vocabulary.
 *
 * `no-acquisition` is the camera offering neither acquisition at all, so nothing can ever answer; it is
 * also what an outcome this domain could not classify reports, because that is the only claim left that
 * stays true. `no-retained-image` is a `Refresh` camera whose only acquisition is the live refresh it just
 * started, so it has nothing yet rather than nothing ever. Every other reason names one acquisition and
 * then either that the camera declines to offer it, the reason the SDK gave for refusing it, or that it
 * failed without a reason of its own. Naming the acquisition and its cause together is what distinguishes
 * an intermittently failing camera from a permanently unequipped one.
 *
 * `live-at-capacity` is the one reason that is about the host rather than the camera: the still was never
 * attempted, because the declared ceiling on concurrent media had no room for it.
 */
export type SnapshotFailure =
  | 'no-acquisition'
  | 'no-retained-image'
  | 'stored-unavailable'
  | 'stored-failed'
  | 'stored-not-observed'
  | 'stored-pending'
  | 'stored-download-failed'
  | 'stored-invalid-image'
  | 'live-unavailable'
  | 'live-at-capacity'
  | 'live-failed'
  | 'live-no-keyframe'
  | 'live-source-failed'
  | 'live-undecodable-burst'
  | 'live-decoder-unavailable';

/** What HomeKit knows about a camera that changes how its snapshot must be presented. */
export interface SnapshotPresentation {
  /** Whether the camera is enabled, when an admitted observation reports it, and nothing otherwise. */
  readonly enabled?: boolean;
  /** The latest explicit SDK availability state, and nothing when no authoritative observation exists. */
  readonly availability?: 'available' | 'unavailable';
  /**
   * Called with the acquisition that left this camera without an image of its own, both when the packaged
   * unavailable image was served in place of one and when no presentation could be served at all. A live
   * refresh that fails later while the camera still has nothing retained reports through the same seam,
   * because it explains the placeholder the camera is still showing.
   */
  onUnavailable?(failure: SnapshotFailure): void;
}

/** Snapshot acquisition requested without exposing its concrete media policy implementation. */
export interface SnapshotMediaAdapter {
  acquire(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    mode: SnapshotMode,
    presentation?: SnapshotPresentation,
  ): Promise<Buffer>;
  captureFromWarmLive?(scope: SnapshotAcquisitionScope, source: SnapshotMediaSource): Promise<void>;
  discard?(serial: string): void;
  reconcile?(serials: Iterable<string>): void;
  discardAll?(): void;
}
