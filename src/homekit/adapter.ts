import type { AnyDeviceEvent, Device, DeviceManifest } from '@mega-yfue/eufy-sdk';
import type { Characteristic, HapStatusError, PlatformAccessory, Service } from 'homebridge';

/** The HAP definitions required by any self-hosted capability adapter. */
export interface HomeKitDefinitions {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly HAPStatus: { readonly SERVICE_COMMUNICATION_FAILURE: number };
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
  readonly accessory: PlatformAccessory;
  readonly hap: HomeKitDefinitions;
  diagnose(diagnostic: AdapterDiagnostic): void;
  observed(code: string): void;
}

/** Successful attachment state, optionally retaining typed SDK event behavior. */
export interface AttachedAdapter {
  event?(event: AnyDeviceEvent): AdapterEventTrace | undefined;
}

/** The complete interface presented by one self-hosted capability adapter. */
export interface HomeKitAdapter {
  readonly key: string;
  readonly role: 'primary-purpose' | 'supplemental';
  readonly primaryRows: readonly string[];
  readonly rows: readonly string[];
  admits(manifest: DeviceManifest): boolean;
  attach(context: AdapterAttachmentContext): AttachedAdapter | undefined;
}
