import type { AnyDeviceEvent, BatteryActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  BATTERY_ADAPTER,
  BATTERY_ADAPTER_KEY,
  type BatteryDiagnostic,
  type BatterySdkDevice,
} from '../../src/homekit/adapters/battery.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const ALL_BATTERY_EVIDENCE = new Map(BATTERY_ADAPTER.coverage.map(({ id }) => [id, { id, kind: 'event' as const }]));
ALL_BATTERY_EVIDENCE.set('battery.level.read', BATTERY_ADAPTER.requires[0]);
ALL_BATTERY_EVIDENCE.set('battery.charging.read', {
  id: 'battery.charging.read',
  kind: 'read',
  type: 'bool',
  writable: false,
});

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic battery device', uuid.generate('synthetic-battery')) as unknown as PlatformAccessory;
}

function batteryDevice(level: () => unknown, charging: () => unknown = () => false): BatterySdkDevice {
  return {
    battery: () =>
      ({
        get level(): number | undefined {
          return level() as number | undefined;
        },
        get charging(): boolean | undefined {
          return charging() as boolean | undefined;
        },
      }) as BatteryActions,
  };
}

function attach(
  device: BatterySdkDevice,
  target: PlatformAccessory,
  evidence = ALL_BATTERY_EVIDENCE,
  diagnose: (diagnostic: BatteryDiagnostic) => void = vi.fn(),
) {
  return BATTERY_ADAPTER.attach({
    device: device as never,
    evidence,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
    persist: vi.fn(),
  });
}

describe('battery capability adapter', () => {
  it.each([
    [20, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW],
    [21, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL],
  ])('maps level %s and charging through real HAP definitions', async (level, lowState) => {
    const target = accessory();
    const adapter = attach(
      batteryDevice(
        () => level,
        () => true,
      ),
      target,
    );
    const service = target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)!;

    expect(adapter).toBeDefined();
    await expect(service.getCharacteristic(Characteristic.BatteryLevel).handleGetRequest()).resolves.toBe(level);
    await expect(service.getCharacteristic(Characteristic.StatusLowBattery).handleGetRequest()).resolves.toBe(lowState);
    await expect(service.getCharacteristic(Characteristic.ChargingState).handleGetRequest()).resolves.toBe(
      Characteristic.ChargingState.CHARGING,
    );
  });

  it('latches a low alert until a later valid level above 20 percent', async () => {
    let level = 80;
    const target = accessory();
    const adapter = attach(
      batteryDevice(() => level),
      target,
    )!;
    const service = target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)!;
    const batteryLevel = service.getCharacteristic(Characteristic.BatteryLevel);
    const lowBattery = service.getCharacteristic(Characteristic.StatusLowBattery);

    await expect(batteryLevel.handleGetRequest()).resolves.toBe(80);

    expect(adapter.event?.({ eventName: 'batteryAlert', state: 'low' } as AnyDeviceEvent)).toEqual({
      event: 'battery-alert',
      observation: 'valid',
    });
    expect(lowBattery.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(batteryLevel.value).toBe(80);

    expect(adapter.event?.({ eventName: 'batteryAlert', state: 'full' } as AnyDeviceEvent)?.observation).toBe('valid');
    expect(lowBattery.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(adapter.event?.({ eventName: 'batteryLevel', to: '20' } as AnyDeviceEvent)?.observation).toBe('valid');
    expect(lowBattery.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);

    level = 21;
    expect(adapter.event?.({ eventName: 'batteryLevel', to: '21' } as AnyDeviceEvent)?.observation).toBe('valid');
    expect(batteryLevel.value).toBe(21);
    expect(lowBattery.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  });

  it('keeps hot alerts diagnostic-only', async () => {
    const target = accessory();
    const diagnostics: BatteryDiagnostic[] = [];
    const adapter = attach(
      batteryDevice(() => 75),
      target,
      ALL_BATTERY_EVIDENCE,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const service = target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)!;
    const level = service.getCharacteristic(Characteristic.BatteryLevel);
    const low = service.getCharacteristic(Characteristic.StatusLowBattery);

    await expect(level.handleGetRequest()).resolves.toBe(75);
    adapter.event?.({ eventName: 'batteryAlert', state: 'low' } as AnyDeviceEvent);

    expect(adapter.event?.({ eventName: 'batteryAlert', state: 'hot' } as AnyDeviceEvent)?.observation).toBe('valid');
    expect(level.value).toBe(75);
    expect(low.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'battery-temperature-alert', active: true }));
  });

  it.each([
    ['missing', () => undefined],
    ['malformed', () => 'unknown'],
    ['out of range', () => 101],
    [
      'faulting',
      () => {
        throw new Error('synthetic SDK read failure');
      },
    ],
  ])('fails closed for %s level reads', async (_case, read) => {
    const target = accessory();
    attach(batteryDevice(read), target);
    const service = target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)!;

    await expect(service.getCharacteristic(Characteristic.BatteryLevel).handleGetRequest()).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await expect(service.getCharacteristic(Characteristic.StatusLowBattery).handleGetRequest()).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  it('rejects malformed events and ignores events absent from manifest evidence', () => {
    const target = accessory();
    const levelEvidence = new Map([['battery.level.read', BATTERY_ADAPTER.requires[0]]]);
    const adapter = attach(
      batteryDevice(() => 60),
      target,
      levelEvidence,
    )!;
    const service = target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)!;

    expect(service.testCharacteristic(Characteristic.ChargingState)).toBe(false);
    expect(adapter.event?.({ eventName: 'batteryLevel', to: '10' } as AnyDeviceEvent)).toBeUndefined();
    expect(adapter.event?.({ eventName: 'batteryAlert', state: 'low' } as AnyDeviceEvent)).toBeUndefined();

    const eventAdapter = attach(
      batteryDevice(() => 60),
      target,
    )!;
    expect(eventAdapter.event?.({ eventName: 'batteryLevel' } as AnyDeviceEvent)?.observation).toBe('missing');
    expect(eventAdapter.event?.({ eventName: 'batteryLevel', to: 'invalid' } as AnyDeviceEvent)?.observation).toBe(
      'malformed',
    );
    expect(
      eventAdapter.event?.({ eventName: 'batteryAlert', state: 'unknown' } as unknown as AnyDeviceEvent)?.observation,
    ).toBe('malformed');
  });

  it('publishes a later level read and recovers diagnostics only for that member', async () => {
    let level = 10;
    const target = accessory();
    const diagnostics: BatteryDiagnostic[] = [];
    const adapter = attach(
      batteryDevice(
        () => level,
        () => 'malformed',
      ),
      target,
      ALL_BATTERY_EVIDENCE,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const service = target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)!;
    const batteryLevel = service.getCharacteristic(Characteristic.BatteryLevel);
    const low = service.getCharacteristic(Characteristic.StatusLowBattery);

    adapter.event?.({ eventName: 'batteryAlert', state: 'low' } as AnyDeviceEvent);
    await expect(service.getCharacteristic(Characteristic.ChargingState).handleGetRequest()).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    level = 60;
    await expect(batteryLevel.handleGetRequest()).resolves.toBe(60);

    expect(low.value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ member: 'charging', active: true, reason: 'malformed' }),
    );
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ member: 'charging', active: false }));
  });

  it('requires the typed capability and removes only the service owned by the current handle', () => {
    const missingTarget = accessory();
    expect(attach({}, missingTarget)).toBeUndefined();
    expect(missingTarget.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)).toBeUndefined();

    const faultingTarget = accessory();
    const diagnostics: BatteryDiagnostic[] = [];
    expect(
      attach(
        {
          battery: () => {
            throw new Error('synthetic SDK accessor failure');
          },
        },
        faultingTarget,
        ALL_BATTERY_EVIDENCE,
        (diagnostic) => diagnostics.push(diagnostic),
      ),
    ).toBeUndefined();
    expect(faultingTarget.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)).toBeUndefined();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'battery-capability-unavailable', active: true, reason: 'sdk-fault' }),
    );

    const target = accessory();
    const original = attach(
      batteryDevice(() => 50),
      target,
    )!;
    const replacement = attach(
      batteryDevice(() => 40),
      target,
    )!;
    original.detach?.();
    expect(target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)).toBeDefined();
    replacement.detach?.();
    expect(target.getServiceById(Service.Battery, BATTERY_ADAPTER_KEY)).toBeUndefined();
  });

  it('reports an unreadable battery level as an invalid observation', async () => {
    const target = accessory();
    const diagnose = vi.fn();
    attach(
      batteryDevice(() => {
        throw new Error('synthetic battery read fault');
      }),
      target,
      ALL_BATTERY_EVIDENCE,
      diagnose,
    );
    const level = target.getService(Service.Battery)!.getCharacteristic(Characteristic.BatteryLevel);

    await expect(level.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(diagnose).toHaveBeenCalledWith({
      code: 'invalid-battery-observation',
      capability: 'battery',
      member: 'level',
      active: true,
      reason: 'sdk-fault',
    });
  });
});
