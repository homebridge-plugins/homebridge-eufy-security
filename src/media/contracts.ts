import type { FragmentRecordingHandle, LiveStreamHandle, TalkbackHandle } from '@mega-yfue/eufy-sdk';

import type { SnapshotMode } from '../configuration.js';

export type { SnapshotMode } from '../configuration.js';

export interface LiveMediaSource {
  live(): Promise<LiveStreamHandle>;
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
 */
export type LiveSessionFailure =
  | 'source-acquisition-timeout'
  | 'no-video-within-backstop'
  | 'source-audio-only'
  | 'source-error'
  | 'source-stopped'
  | 'rtcp-timeout'
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

export interface LiveMediaTransport {
  readonly addressVersion: 'ipv4' | 'ipv6';
  readonly targetAddress: string;
  readonly video: LiveMediaTarget;
  readonly audio?: LiveMediaTarget;
  readonly onVideoFailure?: () => void;
  readonly onSessionOutcome?: (outcome: LiveSessionOutcome) => void;
  readonly onSessionReleased?: () => void;
  readonly onTalkbackOutcome?: (outcome: TalkbackOutcome) => void;
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
  | 'adaptation-failed';

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
  recordFragments?(options?: { fragmentSeconds?: number; preBufferSeconds?: number }): FragmentRecordingHandle;
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
  snapshotLive?(): Promise<{ jpeg: Buffer; width: number; height: number }>;
}

/** Stable camera-local identity that preserves concurrent acquisition lifetime across source replacement. */
export interface SnapshotAcquisitionScope {
  readonly identity: object;
  readonly serial: string;
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
