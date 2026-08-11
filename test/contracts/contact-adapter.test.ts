import type { ContactActions, DeviceEventMap } from '@mega-yfue/eufy-sdk';
import { Characteristic, HAPStatus, Service } from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';

import {
  adaptContact,
  CONTACT_ADAPTER_KEY,
  HapReadError,
  type ContactDiagnostic,
  type ContactHapDefinitions,
  type ContactHapRecorder,
  type ContactSdkDevice,
  type HapCharacteristicDefinition,
  type HapServiceDefinition,
} from '../../src/adapters/contact.js';

const HAP: ContactHapDefinitions = {
  ContactSensor: Service.ContactSensor,
  ContactSensorState: Characteristic.ContactSensorState,
  StatusFault: Characteristic.StatusFault,
  serviceCommunicationFailure: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
};

class RecordingHap implements ContactHapRecorder {
  readonly services: Array<{ definition: HapServiceDefinition; key: string }> = [];
  readonly getters = new Map<string, () => number>();
  readonly updates: Array<{ characteristic: HapCharacteristicDefinition; value: number }> = [];

  addService(definition: HapServiceDefinition, key: string): object {
    this.services.push({ definition, key });
    return {};
  }

  onGet(_service: object, characteristic: HapCharacteristicDefinition, handler: () => number): void {
    this.getters.set(characteristic.UUID, handler);
  }

  update(_service: object, characteristic: HapCharacteristicDefinition, value: number): void {
    this.updates.push({ characteristic, value });
  }

  read(characteristic: HapCharacteristicDefinition): number {
    const getter = this.getters.get(characteristic.UUID);
    if (!getter) {
      throw new Error(`missing getter for ${characteristic.UUID}`);
    }
    return getter();
  }
}

function contactDevice(read: () => unknown, extra: Partial<ContactActions> = {}): ContactSdkDevice {
  const contact = {
    ...extra,
    get open(): boolean | undefined {
      return read() as boolean | undefined;
    },
  } satisfies ContactActions;
  return { contact: () => contact };
}

describe('contact capability adapter', () => {
  it('maps authoritative SDK contact polarity through real HAP definitions', () => {
    let open: unknown = false;
    const hap = new RecordingHap();
    const adapter = adaptContact(
      contactDevice(() => open),
      HAP,
      hap,
      vi.fn(),
    )!;

    expect(hap.read(Characteristic.ContactSensorState)).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    open = true;
    expect(hap.read(Characteristic.ContactSensorState)).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

    adapter.observe({ open: false });
    adapter.observe({ open: true });
    expect(hap.updates.filter(({ characteristic }) => characteristic === Characteristic.ContactSensorState)).toEqual([
      { characteristic: Characteristic.ContactSensorState, value: Characteristic.ContactSensorState.CONTACT_DETECTED },
      {
        characteristic: Characteristic.ContactSensorState,
        value: Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      },
    ]);
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
  ])('fails %s reads instead of supplying a closed default', (_case, read) => {
    const hap = new RecordingHap();
    const diagnostics: ContactDiagnostic[] = [];
    adaptContact(contactDevice(read), HAP, hap, (diagnostic) => diagnostics.push(diagnostic));

    expect(() => hap.read(Characteristic.ContactSensorState)).toThrowError(HapReadError);
    try {
      hap.read(Characteristic.ContactSensorState);
    } catch (error) {
      expect(error).toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    }
    expect(hap.read(Characteristic.StatusFault)).toBe(Characteristic.StatusFault.GENERAL_FAULT);
    const observationDiagnostics = diagnostics.filter(({ code }) => code === 'invalid-contact-observation');
    expect(observationDiagnostics.at(-1)).toMatchObject({ active: true });
    expect(observationDiagnostics).toHaveLength(1);
  });

  it('ignores omitted event state and clears a fault only after a valid observation', () => {
    const hap = new RecordingHap();
    const diagnostics: ContactDiagnostic[] = [];
    const adapter = adaptContact(
      contactDevice(() => undefined),
      HAP,
      hap,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;

    expect(() => hap.read(Characteristic.ContactSensorState)).toThrowError(HapReadError);
    adapter.observe({});
    expect(hap.updates).toEqual([
      { characteristic: Characteristic.StatusFault, value: Characteristic.StatusFault.GENERAL_FAULT },
    ]);

    adapter.observe({ open: 'malformed' } as unknown as DeviceEventMap['contactState']);
    expect(() => hap.read(Characteristic.ContactSensorState)).toThrowError(HapReadError);
    adapter.observe({ open: false });

    expect(hap.read(Characteristic.ContactSensorState)).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    expect(hap.read(Characteristic.StatusFault)).toBe(Characteristic.StatusFault.NO_FAULT);
    expect(diagnostics.filter(({ code }) => code === 'invalid-contact-observation')).toEqual([
      expect.objectContaining({ active: true, reason: 'missing' }),
      expect.objectContaining({ active: true, reason: 'malformed' }),
      expect.objectContaining({ active: false, reason: 'recovered' }),
    ]);
  });

  it('omits contact representation when the SDK capability is absent', () => {
    const hap = new RecordingHap();
    const diagnostics: ContactDiagnostic[] = [];

    const adapter = adaptContact({}, HAP, hap, (diagnostic) => diagnostics.push(diagnostic));

    expect(adapter).toBeUndefined();
    expect(hap.services).toEqual([]);
    adaptContact(
      contactDevice(() => false),
      HAP,
      hap,
      (diagnostic) => diagnostics.push(diagnostic),
    );
    expect(diagnostics.filter(({ code }) => code === 'contact-capability-unavailable')).toEqual([
      expect.objectContaining({ active: true, reason: 'missing' }),
      expect.objectContaining({ active: false, reason: 'recovered' }),
    ]);
  });

  it('uses one stable semantic service key and omits diagnostic-only contact members', () => {
    const hap = new RecordingHap();
    const setAlarmSoundType = vi.fn().mockResolvedValue(undefined);
    const setAlarmVolume = vi.fn().mockResolvedValue(undefined);
    adaptContact(
      contactDevice(() => false, {
        lastSeen: 1_786_000_000,
        rssi: -61,
        alarmSoundType: 2,
        alarmVolume: 20,
        setAlarmSoundType,
        setAlarmVolume,
      }),
      HAP,
      hap,
      vi.fn(),
    );

    expect(hap.services).toEqual([{ definition: Service.ContactSensor, key: CONTACT_ADAPTER_KEY }]);
    expect([...hap.getters.keys()].sort()).toEqual(
      [Characteristic.ContactSensorState.UUID, Characteristic.StatusFault.UUID].sort(),
    );
    expect(setAlarmSoundType).not.toHaveBeenCalled();
    expect(setAlarmVolume).not.toHaveBeenCalled();
  });
});
