import type { CapabilityDescriptor, DeviceManifest } from '@mega-yfue/eufy-sdk';
import { describe, expect, it } from 'vitest';

import { indexDeviceMemberEvidence, satisfiesMemberRequirements } from '../../src/device/member-evidence.js';

function manifest(details: CapabilityDescriptor[]): DeviceManifest {
  return {
    sn: 'synthetic-evidence',
    name: 'Synthetic evidence device',
    modelName: 'Synthetic model',
    codec: 'unknown',
    source: 'security',
    bound: true,
    capabilities: details.map(({ capability }) => capability),
    details,
  };
}

function contactDetail(writable = false): CapabilityDescriptor {
  return {
    capability: 'contact',
    accessor: 'contact',
    reads: [{ accessor: 'open', property: 'synthetic_contact_open', type: 'bool', writable }],
    actions: [],
    undescribedActions: [],
    events: ['contactState'],
  };
}

describe('device member evidence', () => {
  it('indexes semantic members without assigning HomeKit meaning', () => {
    const evidence = indexDeviceMemberEvidence(manifest([contactDetail()]));

    expect([...evidence.values()]).toEqual([
      { id: 'contact.open.read', kind: 'read', type: 'bool', writable: false },
      { id: 'contact.contactState.event', kind: 'event' },
    ]);
    expect(
      satisfiesMemberRequirements(evidence, [{ id: 'contact.open.read', kind: 'read', type: 'bool', writable: false }]),
    ).toBe(true);
  });

  it('rejects conflicting duplicate semantic evidence', () => {
    expect(() => indexDeviceMemberEvidence(manifest([contactDetail(), contactDetail(true)]))).toThrow(
      'device manifest contains conflicting member evidence: contact.open.read',
    );
  });

  it('rejects an SDK action form the plugin has not reviewed', () => {
    const detail = contactDetail();
    detail.actions.push({ name: 'synthetic', form: 'future-form' } as never);

    expect(() => indexDeviceMemberEvidence(manifest([detail]))).toThrow(
      'device manifest contains an unsupported action form: future-form',
    );
  });

  it('requires every fixed member and at least one declared alternative', () => {
    const evidence = indexDeviceMemberEvidence(manifest([contactDetail()]));
    const required = [{ id: 'contact.open.read', kind: 'read' as const }];

    expect(
      satisfiesMemberRequirements(evidence, required, [
        { id: 'motion.motion.event', kind: 'event' },
        { id: 'contact.contactState.event', kind: 'event' },
      ]),
    ).toBe(true);
    expect(
      satisfiesMemberRequirements(evidence, required, [
        { id: 'motion.motion.event', kind: 'event' },
        { id: 'doorbell.doorbellPress.event', kind: 'event' },
      ]),
    ).toBe(false);
  });
});
