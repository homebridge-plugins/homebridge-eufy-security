import type { AnyDeviceEvent } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import { DOORBELL_ADAPTER, DOORBELL_ADAPTER_KEY } from '../../src/homekit/adapters/doorbell.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic doorbell', uuid.generate('synthetic-doorbell')) as unknown as PlatformAccessory;
}

describe('doorbell event adapter', () => {
  it('emits every admitted press as a stateless single-press notification', () => {
    const target = accessory();
    const adapter = DOORBELL_ADAPTER.attach({
      device: {} as never,
      evidence: new Map(DOORBELL_ADAPTER.requires.map((requirement) => [requirement.id, requirement])),
      accessory: target,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
    })!;
    const event = target
      .getServiceById(Service.Doorbell, DOORBELL_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent);
    const notify = vi.spyOn(event, 'sendEventNotification');

    expect(adapter.event?.({ eventName: 'doorbellPress' } as AnyDeviceEvent)).toEqual({
      event: 'doorbell-press',
      observation: 'valid',
    });
    adapter.event?.({ eventName: 'doorbellPress' } as AnyDeviceEvent);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    expect(notify).toHaveBeenNthCalledWith(2, Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    expect(adapter.event?.({ eventName: 'motion' } as AnyDeviceEvent)).toBeUndefined();
  });
});
