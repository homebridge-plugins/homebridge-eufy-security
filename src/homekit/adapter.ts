import type { AnyDeviceEvent, AvailabilityObservation, Device } from '@mega-yfue/eufy-sdk';
import type { Characteristic, HAP, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type {
  DeviceMemberEvidence,
  DeviceMemberRequirement,
  DeviceProductRequirement,
} from '../device/member-evidence.js';
import type {
  LiveMediaAdapter,
  LiveSessionOutcome,
  NegotiatedLiveVideo,
  RecordingMediaAdapter,
  SnapshotMediaAdapter,
  SnapshotMode,
} from '../media/contracts.js';

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
  /**
   * What announced the change, where the adapter follows more than one announcement for the same state.
   *
   * `write` is the SDK reflecting a write this plugin issued; `poll` is the SDK's generic property
   * announcement seeing the value move, which means something other than this plugin changed it. That
   * announcement reaches the plugin on whichever inbound path saw the value — a cloud poll, a realtime
   * report, or the read-through cache's own re-read — and the SDK deliberately does not distinguish them,
   * because it cannot tell its own write's echo from a change made in the vendor app. Both reach the same
   * handler and produced the same record until now, so a support case could not tell "we did this" from
   * "the user did this in the vendor app" — the first question anyone asks about a camera that turned
   * itself off.
   */
  announcedBy?: 'write' | 'poll';
}

/** An identity-free account of one live video selection made by a HomeKit controller. */
export type AdapterLiveVideoTrace = Pick<NegotiatedLiveVideo, 'profile' | 'level' | 'width' | 'height' | 'fps'> & {
  event: 'live-video-selected';
  operation: 'start' | 'reconfigure';
};

/** An identity-free live-session failure or release milestone. */
export type AdapterLiveSessionTrace =
  | (Extract<LiveSessionOutcome, { outcome: 'failed' }> & { event: 'live-session-failed' })
  | { event: 'live-session-released' };

export type AdapterTrace = AdapterEventTrace | AdapterLiveVideoTrace | AdapterLiveSessionTrace;

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
  readonly availability?: () => AvailabilityObservation | undefined;
  diagnose(diagnostic: AdapterDiagnostic): void;
  observed(code: string): void;
  trace?(trace: AdapterTrace): void;
  persist(): void;
}

/** Why an attachment is releasing runtime work; shutdown preserves HomeKit's persisted service state. */
export type AdapterDetachmentReason = 'replacement' | 'withdrawal' | 'shutdown';

/** Successful attachment state, optionally retaining typed SDK event behavior. */
export interface AttachedAdapter {
  event?(event: AnyDeviceEvent): AdapterEventTrace | undefined;
  detach?(reason?: AdapterDetachmentReason): void;
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
