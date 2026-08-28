import type { DeviceManifest, PropertyValueType } from '@mega-yfue/eufy-sdk';

export type DeviceMemberKind = 'read' | 'event' | 'persistent-operation' | 'momentary-action';

/** Installed SDK member evidence indexed by its stable semantic row identifier. */
export interface DeviceMemberEvidence {
  readonly id: string;
  readonly kind: DeviceMemberKind;
  readonly type?: PropertyValueType;
  readonly writable?: boolean;
  /**
   * The name this read carries in the device's flat property namespace, for a read that has one.
   *
   * Retained because it is the join key for the SDK's generic property announcement: that announcement
   * names the property, while a row id and an adapter requirement name the capability accessor, and the
   * two are not always the same string. Keeping the manifest's own pairing here is what lets an adapter
   * follow an announcement for a member it already declares without matching on a guessed name.
   */
  readonly property?: string;
}

/** Exact SDK evidence an adapter requires before it may attach. */
export interface DeviceMemberRequirement extends DeviceMemberEvidence {}

/** Product identity evidence retained without deriving capability meaning from presentation fields. */
export interface DeviceProductEvidence {
  readonly model?: string;
}

/** Exact product evidence an adapter requires in addition to semantic members. */
export interface DeviceProductRequirement {
  readonly model: string;
}

/** One device's product and member evidence indexed from the same complete manifest. */
export interface DeviceEvidenceIndex {
  readonly product: DeviceProductEvidence;
  readonly members: ReadonlyMap<string, DeviceMemberEvidence>;
}

function addEvidence(evidence: Map<string, DeviceMemberEvidence>, member: DeviceMemberEvidence): void {
  const previous = evidence.get(member.id);
  if (previous) {
    if (
      previous.kind !== member.kind ||
      previous.type !== member.type ||
      previous.writable !== member.writable ||
      previous.property !== member.property
    ) {
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
      addEvidence(evidence, { id, kind: 'read', type: read.type, writable: read.writable, property: read.property });
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
      const member = kind === 'persistent-operation' ? (action.reflects ?? action.name) : action.name;
      const id = `${detail.capability}.${member}.${kind}`;
      addEvidence(evidence, { id, kind });
    }
    for (const event of detail.events) {
      const id = `${detail.capability}.${event}.event`;
      addEvidence(evidence, { id, kind: 'event' });
    }
  }
  return evidence;
}

/** Indexes product identity and semantic members once from one complete SDK manifest. */
export function indexDeviceEvidence(manifest: DeviceManifest): DeviceEvidenceIndex {
  return {
    product: { ...(manifest.model === undefined ? {} : { model: manifest.model }) },
    members: indexDeviceMemberEvidence(manifest),
  };
}

/** Matches an exact SDK product model without consulting display or transport fields. */
export function satisfiesProductRequirement(
  evidence: DeviceProductEvidence,
  requirement: DeviceProductRequirement | undefined,
): boolean {
  return requirement === undefined || evidence.model === requirement.model;
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
