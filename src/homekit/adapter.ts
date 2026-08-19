import type { AnyDeviceEvent, Device, LiveStreamHandle } from '@mega-yfue/eufy-sdk';
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

/** Camera-owned media adaptation requested without exposing its concrete FFmpeg implementation. */
export interface LiveMediaAdapter {
  prepare(transport: {
    addressVersion: 'ipv4' | 'ipv6';
    targetAddress: string;
    video: LiveMediaTarget;
    audio?: LiveMediaTarget;
    onVideoFailure?(): void;
  }): Promise<PreparedLiveMedia>;
}

export type SnapshotMode = 'Cloud' | 'Live' | 'Refresh';

export interface SnapshotMediaSource {
  snapshotStored?(): Promise<Buffer>;
  snapshotLive?(): Promise<{ jpeg: Buffer; width: number; height: number }>;
}

/** Stable camera-local identity that preserves concurrent acquisition lifetime across source replacement. */
export interface SnapshotAcquisitionScope {
  readonly identity: object;
}

/** Snapshot acquisition requested without exposing the concrete media policy implementation. */
export interface SnapshotMediaAdapter {
  acquire(
    scope: SnapshotAcquisitionScope,
    source: SnapshotMediaSource,
    mode: Exclude<SnapshotMode, 'Refresh'>,
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
