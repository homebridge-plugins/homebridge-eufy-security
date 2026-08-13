import type { AnyDeviceEvent } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MOTION_ADAPTER, MOTION_ADAPTER_KEY } from '../../src/homekit/adapters/motion.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const ALL_MOTION_EVIDENCE = new Map(MOTION_ADAPTER.requiresAny.map((requirement) => [requirement.id, requirement]));

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic detector', uuid.generate('synthetic-detector')) as unknown as PlatformAccessory;
}

describe('motion event adapter', () => {
  afterEach(() => vi.useRealTimers());

  it('holds motion for 10 seconds after the final admitted detection event', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const adapter = MOTION_ADAPTER.attach({
      device: {} as never,
      evidence: ALL_MOTION_EVIDENCE,
      accessory: target,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
    })!;
    const state = target
      .getServiceById(Service.MotionSensor, MOTION_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.MotionDetected);
    const changes: boolean[] = [];
    state.on('change', ({ newValue }) => changes.push(newValue as boolean));

    expect(adapter.event?.({ eventName: 'motion' } as AnyDeviceEvent)).toEqual({
      event: 'motion-detection',
      observation: 'valid',
    });
    expect(state.value).toBe(true);

    await vi.advanceTimersByTimeAsync(6_000);
    adapter.event?.({ eventName: 'personDetected' } as AnyDeviceEvent);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.value).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes.filter((value) => value === false)).toHaveLength(1);
  });

  it.each([
    'motion',
    'cryingDetected',
    'soundDetected',
    'vehicleDetected',
    'dogDetected',
    'personDetected',
    'strangerDetected',
    'petDetection',
  ] as const)('admits %s as motion while ignoring unrelated events', (eventName) => {
    vi.useFakeTimers();
    const target = accessory();
    const adapter = MOTION_ADAPTER.attach({
      device: {} as never,
      evidence: ALL_MOTION_EVIDENCE,
      accessory: target,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
    })!;
    const state = target
      .getServiceById(Service.MotionSensor, MOTION_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.MotionDetected);

    expect(adapter.event?.({ eventName } as AnyDeviceEvent)?.observation).toBe('valid');
    expect(state.value).toBe(true);
    expect(adapter.event?.({ eventName: 'doorbellPress' } as AnyDeviceEvent)).toBeUndefined();
  });

  it('preserves the hold deadline while adapter ownership is replaced', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const adapter = MOTION_ADAPTER.attach({
      device: {} as never,
      evidence: ALL_MOTION_EVIDENCE,
      accessory: target,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
    })!;
    const state = target
      .getServiceById(Service.MotionSensor, MOTION_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.MotionDetected);

    adapter.event?.({ eventName: 'motion' } as AnyDeviceEvent);
    await vi.advanceTimersByTimeAsync(3_000);
    const replacement = MOTION_ADAPTER.attach({
      device: {} as never,
      evidence: ALL_MOTION_EVIDENCE,
      accessory: target,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
    });
    adapter.detach?.();
    await vi.advanceTimersByTimeAsync(6_999);

    expect(state.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.value).toBe(false);
    replacement?.detach?.();
  });

  it('ignores detection events absent from the admitted device evidence', () => {
    vi.useFakeTimers();
    const target = accessory();
    const requirement = MOTION_ADAPTER.requiresAny.find(({ id }) => id === 'person_detection.personDetected.event')!;
    const adapter = MOTION_ADAPTER.attach({
      device: {} as never,
      evidence: new Map([[requirement.id, requirement]]),
      accessory: target,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
    })!;
    const state = target
      .getServiceById(Service.MotionSensor, MOTION_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.MotionDetected);

    expect(adapter.event?.({ eventName: 'petDetection' } as AnyDeviceEvent)).toBeUndefined();
    expect(state.value).toBe(false);
    expect(adapter.event?.({ eventName: 'personDetected' } as AnyDeviceEvent)?.observation).toBe('valid');
    expect(state.value).toBe(true);
  });
});
