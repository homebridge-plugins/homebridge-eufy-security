import type { DeviceManifest } from '@mega-yfue/eufy-sdk';

import {
  indexDeviceEvidence,
  satisfiesMemberRequirements,
  satisfiesProductRequirement,
  type DeviceEvidenceIndex,
} from '../device/member-evidence.js';
import type { HomeKitAdapter } from './adapter.js';
import { ADAPTER_REGISTRY } from './adapters/registry.js';

export type AdmittedHomeKitAdapter = readonly [key: string, adapter: HomeKitAdapter];

/** Applies the closed adapter registry to one complete SDK manifest. */
export function admittedHomeKitAdapters(
  manifest: DeviceManifest,
  evidence: DeviceEvidenceIndex = indexDeviceEvidence(manifest),
): AdmittedHomeKitAdapter[] {
  return (Object.entries(ADAPTER_REGISTRY) as Array<[string, HomeKitAdapter]>).filter(
    ([, adapter]) =>
      satisfiesProductRequirement(evidence.product, adapter.requiresProduct) &&
      satisfiesMemberRequirements(evidence.members, adapter.requires, adapter.requiresAny),
  );
}

/** Summarizes the same HomeKit admission policy used by reconciliation. */
export function describeHomeKitRepresentation(manifest: DeviceManifest): {
  represented: boolean;
  controllable: boolean;
} {
  const primary = admittedHomeKitAdapters(manifest).filter(([, adapter]) => adapter.role === 'primary-purpose');
  return {
    represented: primary.length > 0,
    controllable: primary.some(([, adapter]) =>
      adapter.coverage.some((id) => id.endsWith('.persistent-operation') || id.endsWith('.momentary-action')),
    ),
  };
}
