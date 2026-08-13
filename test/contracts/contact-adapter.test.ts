import type { AnyDeviceEvent, ContactActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  CONTACT_ADAPTER,
  CONTACT_ADAPTER_KEY,
  type ContactDiagnostic,
  type ContactSdkDevice,
} from '../../src/homekit/adapters/contact.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic contact', uuid.generate('synthetic-contact')) as unknown as PlatformAccessory;
}

function contactDevice(read: () => unknown, extra: Partial<ContactActions> = {}): ContactSdkDevice {
  return {
    contact: () => ({
      ...extra,
      get open(): boolean | undefined {
        return read() as boolean | undefined;
      },
    }),
  };
}

function attach(
  device: ContactSdkDevice,
  target: PlatformAccessory,
  diagnose: (diagnostic: ContactDiagnostic) => void = vi.fn(),
) {
  return CONTACT_ADAPTER.attach({
    device: device as never,
    evidence: new Map(),
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
  });
}

describe('contact capability adapter', () => {
  it('maps authoritative SDK contact polarity through real HAP definitions', async () => {
    let open: unknown = false;
    const target = accessory();
    const adapter = attach(
      contactDevice(() => open),
      target,
    )!;
    const service = target.getServiceById(Service.ContactSensor, CONTACT_ADAPTER_KEY)!;
    const state = service.getCharacteristic(Characteristic.ContactSensorState);

    await expect(state.handleGetRequest()).resolves.toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    open = true;
    await expect(state.handleGetRequest()).resolves.toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

    adapter.event({ eventName: 'contactState', open: false } as AnyDeviceEvent);
    expect(state.value).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    adapter.event({ eventName: 'contactState', open: true } as AnyDeviceEvent);
    expect(state.value).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  });

  it.each([
    ['missing', () => undefined],
    ['malformed', () => 'open'],
    [
      'faulting',
      () => {
        throw new Error('synthetic SDK read failure');
      },
    ],
  ])('fails %s reads instead of supplying a closed default', async (_case, read) => {
    const target = accessory();
    const diagnostics: ContactDiagnostic[] = [];
    attach(contactDevice(read), target, (diagnostic) => diagnostics.push(diagnostic));
    const service = target.getServiceById(Service.ContactSensor, CONTACT_ADAPTER_KEY)!;

    await expect(service.getCharacteristic(Characteristic.ContactSensorState).handleGetRequest()).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await expect(service.getCharacteristic(Characteristic.StatusFault).handleGetRequest()).resolves.toBe(
      Characteristic.StatusFault.GENERAL_FAULT,
    );
    expect(diagnostics.filter(({ code }) => code === 'invalid-contact-observation')).toHaveLength(1);
  });

  it('ignores omitted events and recovers only from valid contact evidence', async () => {
    const target = accessory();
    const diagnostics: ContactDiagnostic[] = [];
    const adapter = attach(
      contactDevice(() => undefined),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const service = target.getServiceById(Service.ContactSensor, CONTACT_ADAPTER_KEY)!;
    const state = service.getCharacteristic(Characteristic.ContactSensorState);

    await expect(state.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(adapter.event({ eventName: 'contactState' } as AnyDeviceEvent)).toMatchObject({ observation: 'missing' });
    expect(adapter.event({ eventName: 'contactState', open: 'malformed' } as unknown as AnyDeviceEvent)).toMatchObject({
      observation: 'malformed',
    });
    expect(adapter.event({ eventName: 'contactState', open: false } as AnyDeviceEvent)).toMatchObject({
      observation: 'valid',
    });

    expect(state.value).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    expect(diagnostics.filter(({ code }) => code === 'invalid-contact-observation')).toEqual([
      expect.objectContaining({ active: true, reason: 'missing' }),
      expect.objectContaining({ active: true, reason: 'malformed' }),
      expect.objectContaining({ active: false, reason: 'recovered' }),
    ]);
  });

  it('does not create a service when the SDK contact capability is absent', () => {
    const target = accessory();
    const diagnostics: ContactDiagnostic[] = [];

    expect(attach({}, target, (diagnostic) => diagnostics.push(diagnostic))).toBeUndefined();
    expect(target.getServiceById(Service.ContactSensor, CONTACT_ADAPTER_KEY)).toBeUndefined();
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'contact-capability-unavailable', active: true })]);
  });
});
