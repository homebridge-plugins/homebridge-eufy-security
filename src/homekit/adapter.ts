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
  MediaSessionBudget,
  StationLiveSessionRegistry,
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
  | { event: 'live-session-released' }
  /** The first adapted output reached the negotiated destination, which is when a picture can appear. */
  | { event: 'live-session-streaming' }
  /**
   * A started request reached neither a streaming outcome nor a failure.
   *
   * Every request is meant to end in one or the other, and a controller badges the camera either way. One
   * ending in neither leaves an operator looking at a failure the log has no record of, which nobody can
   * diagnose. This states that it happened and how long was waited; it says nothing about why, because the
   * path that dropped it left nothing to say.
   */
  | { event: 'live-request-unaccounted'; afterMs: number }
  /**
   * A stream request refused before it reached the source at all.
   *
   * Every one of these answers a controller instantly, and a controller badges the camera instantly with it.
   * None of them was recorded before, so the badge an operator saw at the moment of a switch had no counterpart
   * in a log, and five separate explanations for it were proposed and ruled out by measurement instead.
   *
   * `cancelled` and `at-capacity` are the two a fast switch produces: a controller prepares the next camera
   * before the last has given its port back, so the preparation is superseded or the declared ceiling is
   * momentarily full. Neither is a fault, and both are indistinguishable from one without this.
   */
  | { event: 'live-request-refused'; reason: 'disabled' | 'at-capacity' | 'cancelled' | 'prepare-failed' };

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
  /** The declared ceiling on concurrent media, absent when the operator declared none. */
  readonly mediaBudget?: MediaSessionBudget;
  /** Where a live session is recorded, so opportunistic media work elsewhere on its station stands aside. */
  readonly stationLiveSessions?: StationLiveSessionRegistry;
  readonly audioEnabled?: boolean;
  readonly snapshotMode?: SnapshotMode;
  /**
   * The largest geometry this camera's source has been observed producing, when it has been.
   *
   * Decides the resolution matrix advertised to a controller. Absent until a live session has announced one,
   * which keeps the standard matrix rather than publishing a shape nothing has established.
   */
  readonly sourceGeometry?: { readonly width: number; readonly height: number };
  /**
   * Record a geometry this camera's source announced, for the matrix a later start will advertise.
   *
   * The adapter reports; the caller decides what to keep and where. Only the LARGEST is useful: a camera runs
   * an adaptive ladder and a session may be served any rung of it, so keeping the latest would advertise a
   * ceiling below what the camera can produce and cap it there.
   */
  readonly observeSourceGeometry?: (geometry: { readonly width: number; readonly height: number }) => void;
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

/** The complete interface presented by one self-hosted capability adapter. */
export interface HomeKitAdapter {
  readonly key: string;
  readonly role: 'primary-purpose' | 'supplemental';
  readonly requiresProduct?: DeviceProductRequirement;
  readonly requires: readonly DeviceMemberRequirement[];
  readonly requiresAny?: readonly DeviceMemberRequirement[];
  /** The stable evidence ids of every SDK member this adapter represents. */
  readonly coverage: readonly string[];
  attach(context: AdapterAttachmentContext): AttachedAdapter | undefined;
}
