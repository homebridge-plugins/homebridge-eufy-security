import { createHash } from 'node:crypto';

import { CAPABILITY_MODULES, type CapabilityModule, type Member } from '@mega-yfue/eufy-sdk';

import type { AdapterCoverage } from './adapter.js';
import { INFORMATION_SDK_ROWS } from './adapters/information.js';
import { ADAPTER_REGISTRY } from './adapters/registry.js';

export type CoverageMemberKind = 'read' | 'event' | 'persistent-operation' | 'momentary-action';
export type CoverageDisposition = 'required-adapter' | 'diagnostic-only' | 'blocked-sdk-gap' | 'explicitly-deferred';

export interface CoverageVerification {
  file: string;
  behavior: string;
}

export interface CoverageRow {
  id: string;
  capability: string;
  member: string;
  memberKind: CoverageMemberKind;
  evidence: string[];
  hapFit: string;
  disposition: CoverageDisposition;
  adapter: string | null;
  representationStatus: 'represented' | 'not-represented';
  controlStatus: 'controllable' | 'not-controllable' | 'not-represented';
  identityEffect: string;
  diagnostics: string;
  verification: CoverageVerification[];
  followUp?: string;
}

export interface SdkHapCoverageMatrix {
  version: 1;
  sdkContract: string;
  hapContract: string;
  rows: CoverageRow[];
}

const COVERAGE_BY_ROW = new Map<string, { adapter: string; coverage: AdapterCoverage }>(
  Object.entries(ADAPTER_REGISTRY).flatMap(([adapter, registration]) =>
    registration.coverage.map((coverage) => [coverage.id, { adapter, coverage }] as const),
  ),
);

const REVIEWED_SDK_SURFACE_SHA256 = '817e1b0c0877fbd0fd18c39cba51b09879fc92fff15fbaf2f8d470052cf35bab';

function stableContractValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'function') {
    return '<function>';
  }
  if (value === undefined) {
    return '<undefined>';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stableContractValue(entry, ancestors));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    return '<cycle>';
  }
  ancestors.add(value);
  const normalized = Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableContractValue(entry, ancestors)]),
  );
  ancestors.delete(value);
  return normalized;
}

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
  'lock.lockState.event',
  'keypad.batteryLow.read',
  'keypad.charging.read',
  'storage.sdCard.read',
  'storage.free.read',
  'storage.total.read',
]);

const DEFERRED: Record<string, string> = {};

function defer(rows: readonly string[], issue: string, risk: string): void {
  for (const row of rows) {
    DEFERRED[row] = `${issue}: ${risk}`;
  }
}

defer(
  [
    'camera.enabled.read',
    'camera.statusLed.read',
    'camera.statusLed.persistent-operation',
    'light.isOn.read',
    'light.isOn.persistent-operation',
    'light.brightness.read',
    'light.brightness.persistent-operation',
    'audio.microphone.read',
    'audio.microphone.persistent-operation',
    'audio.speaker.read',
    'audio.speaker.persistent-operation',
    'audio.volume.read',
    'audio.volume.persistent-operation',
  ],
  '#996',
  'requires the camera and audio bundle contracts',
);
defer(['camera.live.momentary-action'], '#997', 'requires negotiated live media adaptation');
defer(['camera.recordFragments.momentary-action'], '#999', 'requires negotiated HKSV adaptation');
defer(
  ['camera.snapshotStored.momentary-action', 'camera.snapshotLive.momentary-action'],
  '#1002',
  'requires distinct stored-only and live snapshot policy',
);
defer(['camera.talkback.momentary-action'], '#1001', 'requires isolated return-audio adaptation');
defer(
  ['arming.mode.read', 'arming.mode.persistent-operation', 'arming.armingModeChanged.event', 'arming.alarm.event'],
  '#991',
  'requires explicit arming-mode and alarm fault policy',
);
defer(
  [
    'smart_light.power.read',
    'smart_light.power.persistent-operation',
    'smart_light.brightness.read',
    'smart_light.brightness.persistent-operation',
    'smart_light.smartLightState.event',
  ],
  '#989',
  'requires projection and partial-report reconciliation',
);
defer(
  ['lock.lock.momentary-action', 'lock.unlock.momentary-action'],
  '#992',
  'requires the T8531-only control boundary and unknown-current policy',
);
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
  const followUp = DEFERRED[id];
  const disposition: CoverageDisposition = represented
    ? 'required-adapter'
    : BLOCKED.has(id)
      ? 'blocked-sdk-gap'
      : followUp
        ? 'explicitly-deferred'
        : 'diagnostic-only';

  return {
    id,
    capability,
    member,
    memberKind,
    evidence: memberEvidence(CAPABILITY_MODULES[capability as keyof typeof CAPABILITY_MODULES], member, memberKind),
    hapFit:
      represented?.coverage.hapFit ??
      (disposition === 'blocked-sdk-gap'
        ? 'No HAP representation is permitted without verified SDK truth'
        : disposition === 'explicitly-deferred'
          ? 'A selected official HAP contract exists but its named adapter policy is not admitted by this matrix version'
          : 'No selected semantically matching official HAP contract'),
    disposition,
    adapter: represented?.adapter ?? null,
    representationStatus: represented ? 'represented' : 'not-represented',
    controlStatus: represented
      ? memberKind === 'persistent-operation' || memberKind === 'momentary-action'
        ? 'controllable'
        : 'not-controllable'
      : 'not-represented',
    identityEffect: represented?.coverage.identityEffect ?? 'No HomeKit service or accessory identity effect',
    diagnostics:
      represented?.coverage.diagnostics ??
      (disposition === 'blocked-sdk-gap'
        ? 'Report the SDK evidence gap without representation'
        : disposition === 'explicitly-deferred'
          ? 'Report the member as deferred without representation'
          : 'Report the member as diagnostic-only without representation'),
    verification: [
      {
        file: 'test/contracts/coverage-matrix.test.ts',
        behavior: 'classifies the complete current SDK member surface',
      },
      ...(represented?.coverage.verification ?? []),
    ],
    followUp,
  };
}

function reviewedRows(): CoverageRow[] {
  const surface = currentSdkSurface();
  const reviewedContract = stableContractValue({
    capabilityModules: CAPABILITY_MODULES,
    information: INFORMATION_SDK_ROWS,
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(reviewedContract)).digest('hex');
  if (fingerprint !== REVIEWED_SDK_SURFACE_SHA256) {
    throw new TypeError(`SDK member surface requires review: ${fingerprint}`);
  }
  const current = new Set(surface);
  const stalePolicy = [...BLOCKED, ...Object.keys(DEFERRED)].find((id) => !current.has(id));
  if (stalePolicy) {
    throw new TypeError(`coverage policy references a missing SDK member: ${stalePolicy}`);
  }
  return surface.map(makeRow);
}

export const SDK_HAP_COVERAGE_MATRIX: SdkHapCoverageMatrix = {
  version: 1,
  sdkContract: '@mega-yfue/eufy-sdk@0.1.0-beta.11',
  hapContract: 'Homebridge 2 HAP definitions',
  rows: reviewedRows(),
};
