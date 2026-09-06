import { CAPABILITY_MODULES, type CapabilityModule, type Member } from '@mega-yfue/eufy-sdk';

import { INFORMATION_SDK_ROWS } from './adapters/information.js';
import { ADAPTER_REGISTRY } from './adapters/registry.js';

export type CoverageMemberKind = 'read' | 'event' | 'persistent-operation' | 'momentary-action';
export type CoverageDisposition = 'required-adapter' | 'diagnostic-only' | 'blocked-sdk-gap';

export interface CoverageRow {
  id: string;
  capability: string;
  member: string;
  memberKind: CoverageMemberKind;
  evidence: string[];
  disposition: CoverageDisposition;
  adapter: string | null;
  representationStatus: 'represented' | 'not-represented';
  controlStatus: 'controllable' | 'not-controllable' | 'not-represented';
}

export interface SdkHapCoverageMatrix {
  version: 1;
  hapContract: string;
  rows: CoverageRow[];
}

const COVERAGE_BY_ROW = new Map<string, { adapter: string; productEvidence?: string }>(
  Object.entries(ADAPTER_REGISTRY).flatMap(([adapter, registration]) => {
    const requiresProduct = 'requiresProduct' in registration ? registration.requiresProduct : undefined;
    return registration.coverage.map(
      (id) =>
        [
          id,
          {
            adapter,
            ...(requiresProduct
              ? { productEvidence: `@mega-yfue/eufy-sdk DeviceManifest.model ${requiresProduct.model}` }
              : {}),
          },
        ] as const,
    );
  }),
);

const BLOCKED = new Set([
  'person_detection.detectionEnabled.read',
  'person_detection.detected.read',
  'ptz.rotationSpeed.read',
  'ptz.panAngle.read',
  'ptz.tiltAngle.read',
  'camera.imageFlipped.persistent-operation',
  'leak.leakDetected.read',
  'smoke.smokeDetected.read',
  'co.coDetected.read',
  'lock.locked.read',
  'lock.locked.persistent-operation',
  'keypad.batteryLow.read',
  'keypad.charging.read',
  'storage.sdCard.read',
  'storage.free.read',
  'storage.total.read',
]);

/** Derives the current semantic member inventory directly from the pinned SDK contract. */
function currentSdkSurface(): string[] {
  const rows: string[] = [];
  for (const [capability, module] of Object.entries(CAPABILITY_MODULES)) {
    for (const [name, member] of Object.entries(module.members ?? {})) {
      if ('type' in member) {
        if (!member.writeOnly) {
          rows.push(`${capability}.${name}.read`);
        }
        if (member.write || member.unverified || member.writtenElsewhere) {
          rows.push(`${capability}.${name}.persistent-operation`);
        }
      } else if ('action' in member) {
        rows.push(`${capability}.${name}.momentary-action`);
      } else if ('method' in member || 'provided' in member) {
        rows.push(`${capability}.${name}.${member.answers ? 'read' : 'momentary-action'}`);
      } else {
        throw new TypeError(`unrecognized SDK member contract: ${capability}.${name}`);
      }
    }
    const events = new Set([...(module.events ?? []).map((event) => event.emit), ...(module.emits ?? [])]);
    for (const event of events) {
      rows.push(`${capability}.${event}.event`);
    }
  }
  rows.push(...INFORMATION_SDK_ROWS);
  return rows.sort();
}

function parseRowId(id: string): { capability: string; member: string; memberKind: CoverageMemberKind } {
  const [capability, member, memberKind] = id.split('.');
  if (!capability || !member || !memberKind) {
    throw new TypeError(`invalid coverage row id: ${id}`);
  }
  return { capability, member, memberKind: memberKind as CoverageMemberKind };
}

function memberEvidence(module: CapabilityModule | undefined, memberName: string, kind: CoverageMemberKind): string[] {
  if (!module) {
    return [`@mega-yfue/eufy-sdk DeviceInfo.${memberName}`];
  }
  if (kind === 'event') {
    return [`@mega-yfue/eufy-sdk CAPABILITY_MODULES.${module.capability} semantic event ${memberName}`];
  }
  const member = module.members?.[memberName] as Member | undefined;
  const description = member?.description;
  return description
    ? [`@mega-yfue/eufy-sdk CAPABILITY_MODULES.${module.capability}.members.${memberName}`, description]
    : [`@mega-yfue/eufy-sdk CAPABILITY_MODULES.${module.capability}.members.${memberName}`];
}

function makeRow(id: string): CoverageRow {
  const { capability, member, memberKind } = parseRowId(id);
  const represented = COVERAGE_BY_ROW.get(id);
  const disposition: CoverageDisposition = represented
    ? 'required-adapter'
    : BLOCKED.has(id)
      ? 'blocked-sdk-gap'
      : 'diagnostic-only';

  return {
    id,
    capability,
    member,
    memberKind,
    evidence: [
      ...memberEvidence(CAPABILITY_MODULES[capability as keyof typeof CAPABILITY_MODULES], member, memberKind),
      ...(represented?.productEvidence ? [represented.productEvidence] : []),
    ],
    disposition,
    adapter: represented?.adapter ?? null,
    representationStatus: represented ? 'represented' : 'not-represented',
    controlStatus: represented
      ? memberKind === 'persistent-operation' || memberKind === 'momentary-action'
        ? 'controllable'
        : 'not-controllable'
      : 'not-represented',
  };
}

function reviewedRows(): CoverageRow[] {
  const surface = currentSdkSurface();
  const current = new Set(surface);
  const stalePolicy = [...BLOCKED].find((id) => !current.has(id));
  if (stalePolicy) {
    throw new TypeError(`coverage policy references a missing SDK member: ${stalePolicy}`);
  }
  return surface.map(makeRow);
}

export const SDK_HAP_COVERAGE_MATRIX: SdkHapCoverageMatrix = {
  version: 1,
  hapContract: 'Homebridge 2 HAP definitions',
  rows: reviewedRows(),
};
