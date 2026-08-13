import type { DeviceManifest, PropertyValueType } from '@mega-yfue/eufy-sdk';

export type DeviceMemberKind = 'read' | 'event' | 'persistent-operation' | 'momentary-action';

/** Installed SDK member evidence indexed by its stable semantic row identifier. */
export interface DeviceMemberEvidence {
  readonly id: string;
  readonly kind: DeviceMemberKind;
  readonly type?: PropertyValueType;
  readonly writable?: boolean;
}

/** Exact SDK evidence an adapter requires before it may attach. */
export interface DeviceMemberRequirement extends DeviceMemberEvidence {}

function addEvidence(evidence: Map<string, DeviceMemberEvidence>, member: DeviceMemberEvidence): void {
  const previous = evidence.get(member.id);
  if (previous) {
    if (previous.kind !== member.kind || previous.type !== member.type || previous.writable !== member.writable) {
      throw new TypeError(`device manifest contains conflicting member evidence: ${member.id}`);
    }
    return;
  }
  evidence.set(member.id, member);
}

/** Indexes one described device without assigning HomeKit meaning to its members. */
export function indexDeviceMemberEvidence(manifest: DeviceManifest): ReadonlyMap<string, DeviceMemberEvidence> {
  const evidence = new Map<string, DeviceMemberEvidence>();
  for (const detail of manifest.details) {
    for (const read of detail.reads) {
      const id = `${detail.capability}.${read.accessor}.read`;
      addEvidence(evidence, { id, kind: 'read', type: read.type, writable: read.writable });
    }
    for (const action of detail.actions) {
      let kind: 'persistent-operation' | 'momentary-action';
      switch (action.form) {
        case 'stateful':
          kind = 'persistent-operation';
          break;
        case 'momentary':
          kind = 'momentary-action';
          break;
        default:
          throw new TypeError(`device manifest contains an unsupported action form: ${String(action.form)}`);
      }
      const id = `${detail.capability}.${action.name}.${kind}`;
      addEvidence(evidence, { id, kind });
    }
    for (const event of detail.events) {
      const id = `${detail.capability}.${event}.event`;
      addEvidence(evidence, { id, kind: 'event' });
    }
  }
  return evidence;
}

/** Matches every required member plus at least one alternative when alternatives are declared. */
export function satisfiesMemberRequirements(
  evidence: ReadonlyMap<string, DeviceMemberEvidence>,
  requirements: readonly DeviceMemberRequirement[],
  alternatives: readonly DeviceMemberRequirement[] = [],
): boolean {
  const matches = (requirement: DeviceMemberRequirement): boolean => {
    const installed = evidence.get(requirement.id);
    return (
      installed?.kind === requirement.kind &&
      (requirement.type === undefined || installed.type === requirement.type) &&
      (requirement.writable === undefined || installed.writable === requirement.writable)
    );
  };
  return requirements.every(matches) && (alternatives.length === 0 || alternatives.some(matches));
}
