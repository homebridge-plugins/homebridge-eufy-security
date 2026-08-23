import type { AnyDeviceEvent, Device, FragmentRecordingHandle, LiveStreamHandle } from '@mega-yfue/eufy-sdk';
import type { Characteristic, HAP, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type {
  DeviceMemberEvidence,
  DeviceMemberRequirement,
  DeviceProductRequirement,
} from '../device/member-evidence.js';

/** The HAP definitions required by any self-hosted capability adapter. */
export interface HomeKitDefinitions {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly HAPStatus: {
    readonly SERVICE_COMMUNICATION_FAILURE: number;
    readonly INVALID_VALUE_IN_REQUEST: number;
    readonly NOT_ALLOWED_IN_CURRENT_STATE: number;
  };
  readonly HapStatusError: typeof HapStatusError;
  readonly CameraController: HAP['CameraController'];
  readonly H264Profile: HAP['H264Profile'];
  readonly H264Level: HAP['H264Level'];
  readonly AudioStreamingCodecType: HAP['AudioStreamingCodecType'];
  readonly AudioStreamingSamplerate: HAP['AudioStreamingSamplerate'];
  readonly SRTPCryptoSuites: HAP['SRTPCryptoSuites'];
  readonly VideoCodecType: HAP['VideoCodecType'];
  readonly MediaContainerType: HAP['MediaContainerType'];
  readonly AudioRecordingCodecType: HAP['AudioRecordingCodecType'];
  readonly AudioRecordingSamplerate: HAP['AudioRecordingSamplerate'];
  readonly AudioBitrate: HAP['AudioBitrate'];
  readonly EventTriggerOption: HAP['EventTriggerOption'];
  readonly HDSProtocolError: HAP['HDSProtocolError'];
  readonly HDSProtocolSpecificErrorReason: HAP['HDSProtocolSpecificErrorReason'];
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

export interface PreparedLiveMedia {
  readonly videoPort: number;
  readonly audioPort?: number;
  start(
    source: { live(): Promise<LiveStreamHandle> },
    negotiated: {
      video: NegotiatedLiveVideo;
      audio?: {
        codec: 'AAC-eld';
        channels: number;
        sampleRate: 16 | 24;
        maxBitRate: number;
        payloadType: number;
        ssrc: number;
      };
    },
  ): Promise<void>;
  reconfigure(video: NegotiatedLiveVideo): void;
  stop(): void;
}

/** Why one live session ended without usable video, in the bounded vocabulary the media domain owns. */
export type LiveSessionFailure =
  | 'source-acquisition-timeout'
  | 'no-video-within-backstop'
  | 'source-error'
  | 'source-stopped'
  | 'rtcp-timeout'
  | 'adaptation-failed';

/** One live session lifecycle outcome, carrying no device identity, address, key, or media material. */
export type LiveSessionOutcome =
  { readonly outcome: 'streaming' } | { readonly outcome: 'failed'; readonly reason: LiveSessionFailure };

/** Camera-owned media adaptation requested without exposing its concrete FFmpeg implementation. */
export interface LiveMediaAdapter {
  prepare(transport: {
    addressVersion: 'ipv4' | 'ipv6';
    targetAddress: string;
    video: LiveMediaTarget;
    audio?: LiveMediaTarget;
    onVideoFailure?(): void;
    onSessionOutcome?(outcome: LiveSessionOutcome): void;
  }): Promise<PreparedLiveMedia>;
}

export interface NegotiatedRecordedAudio {
  readonly codec: 'AAC-lc' | 'AAC-eld';
  readonly channels: number;
  readonly sampleRate: 16 | 24 | 32 | 48;
  readonly maxBitRate: number;
}

/**
 * The complete recording contract a HomeKit controller selected. Audio is absent both when the controller
 * negotiated none and when it withdrew recording audio, because either way the output carries no audio
 * track at all.
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
  readonly audio?: NegotiatedRecordedAudio;
}

/** Why one recording produced no further usable output, in the bounded vocabulary the media domain owns. */
export type RecordingFailure =
  'source-unavailable' | 'source-error' | 'no-output-within-backstop' | 'adaptation-failed';

/** One recording lifecycle outcome, carrying no device identity, address, key, or media material. */
export type RecordingOutcome =
  { readonly outcome: 'recording' } | { readonly outcome: 'failed'; readonly reason: RecordingFailure };

/** One adapted recording output unit: the initialization segment, or one complete media fragment. */
export interface RecordedFragment {
  readonly data: Buffer;
  readonly last: boolean;
}

export interface RecordingMediaSource {
  recordFragments?(options?: { fragmentSeconds?: number }): FragmentRecordingHandle;
}

/** One recording in progress: the units it produces, and the one call that ends it. */
export interface AdaptedRecording extends AsyncIterable<RecordedFragment> {
  stop(): void;
}

/** Camera-owned recording adaptation requested without exposing its concrete FFmpeg implementation. */
export interface RecordingMediaAdapter {
  record(
    source: RecordingMediaSource,
    negotiated: NegotiatedRecording,
    lifecycle?: { onOutcome?(outcome: RecordingOutcome): void },
  ): AdaptedRecording;
}

export type SnapshotMode = 'Cloud' | 'Live' | 'Refresh';

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
 * Snapshot acquisition requested without exposing the concrete media policy implementation. `enabled` carries
 * the admitted enablement observation, because a disabled camera is presented rather than photographed, and
 * `onPlaceholder` reports that no acquisition answered, so a served placeholder is never mistaken for a
 * served camera image.
 */
export interface SnapshotMediaAdapter {
  acquire(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    mode: SnapshotMode,
    presentation?: { readonly enabled?: boolean; onPlaceholder?(): void },
  ): Promise<Buffer>;
}

/** An allowlisted capability condition emitted without physical-device identity. */
export interface AdapterDiagnostic {
  code: string;
  capability: string;
  member: string;
  active: boolean;
  reason: string;
}

/** A redacted account of one capability event handled in debug mode. */
export interface AdapterEventTrace {
  event: string;
  observation: 'valid' | 'missing' | 'malformed';
}

/** Dependencies supplied by the reconciler when an adapter attaches to one accessory container. */
export interface AdapterAttachmentContext {
  readonly device: Device;
  readonly evidence: ReadonlyMap<string, DeviceMemberEvidence>;
  readonly accessory: PlatformAccessory;
  readonly hap: HomeKitDefinitions;
  readonly liveMedia?: LiveMediaAdapter;
  readonly recordingMedia?: RecordingMediaAdapter;
  readonly snapshotMedia?: SnapshotMediaAdapter;
  readonly audioEnabled?: boolean;
  readonly snapshotMode?: SnapshotMode;
  diagnose(diagnostic: AdapterDiagnostic): void;
  observed(code: string): void;
  persist(): void;
}

/** Successful attachment state, optionally retaining typed SDK event behavior. */
export interface AttachedAdapter {
  event?(event: AnyDeviceEvent): AdapterEventTrace | undefined;
  detach?(): void;
}

/** HomeKit policy and executable evidence owned by one represented SDK member. */
export interface AdapterCoverage {
  readonly id: string;
  readonly hapFit: string;
  readonly identityEffect: string;
  readonly diagnostics: string;
  readonly verification: readonly { file: string; behavior: string }[];
}

/** The complete interface presented by one self-hosted capability adapter. */
export interface HomeKitAdapter {
  readonly key: string;
  readonly role: 'primary-purpose' | 'supplemental';
  readonly requiresProduct?: DeviceProductRequirement;
  readonly requires: readonly DeviceMemberRequirement[];
  readonly requiresAny?: readonly DeviceMemberRequirement[];
  readonly coverage: readonly AdapterCoverage[];
  attach(context: AdapterAttachmentContext): AttachedAdapter | undefined;
}
