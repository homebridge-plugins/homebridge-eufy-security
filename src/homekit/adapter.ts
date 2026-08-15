import type { AnyDeviceEvent, Device } from '@mega-yfue/eufy-sdk';
import type { Characteristic, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { DeviceMemberEvidence, DeviceMemberRequirement } from '../device/member-evidence.js';

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
  readonly requires: readonly DeviceMemberRequirement[];
  readonly requiresAny?: readonly DeviceMemberRequirement[];
  readonly coverage: readonly AdapterCoverage[];
  attach(context: AdapterAttachmentContext): AttachedAdapter | undefined;
}
