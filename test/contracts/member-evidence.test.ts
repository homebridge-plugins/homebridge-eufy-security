import type { CapabilityDescriptor, DeviceManifest } from '@mega-yfue/eufy-sdk';
import { describe, expect, it } from 'vitest';

import {
  indexDeviceEvidence,
  indexDeviceMemberEvidence,
  satisfiesMemberRequirements,
  satisfiesProductRequirement,
} from '../../src/device/member-evidence.js';

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
      {
        id: 'contact.open.read',
        kind: 'read',
        type: 'bool',
        writable: false,
        property: 'synthetic_contact_open',
      },
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

  it('rejects one accessor the manifest maps to two flat property names', () => {
    const renamed = contactDetail();
    renamed.reads = [{ accessor: 'open', property: 'synthetic_contact_state', type: 'bool', writable: false }];

    expect(() => indexDeviceMemberEvidence(manifest([contactDetail(), renamed]))).toThrow(
      'device manifest contains conflicting member evidence: contact.open.read',
    );
  });

  it('matches a required member without constraining the flat property name it is announced under', () => {
    const evidence = indexDeviceMemberEvidence(manifest([contactDetail()]));

    expect(satisfiesMemberRequirements(evidence, [{ id: 'contact.open.read', kind: 'read', type: 'bool' }])).toBe(true);
    expect(evidence.get('contact.open.read')?.property).toBe('synthetic_contact_open');
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

  it('indexes exact product evidence without inferring from display model or codec', () => {
    const candidate = manifest([contactDetail()]);
    candidate.model = 'T8531';
    candidate.modelName = 'Synthetic unrelated display model';
    candidate.codec = 'lock';

    expect(satisfiesProductRequirement(indexDeviceEvidence(candidate).product, { model: 'T8531' })).toBe(true);
    expect(satisfiesProductRequirement(indexDeviceEvidence(candidate).product, { model: 'T85D0' })).toBe(false);
    delete candidate.model;
    candidate.modelName = 'T8531';
    expect(satisfiesProductRequirement(indexDeviceEvidence(candidate).product, { model: 'T8531' })).toBe(false);
  });
});
