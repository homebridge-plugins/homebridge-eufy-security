import type { SirenActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  SIREN_ADAPTER,
  SIREN_ADAPTER_KEY,
  type SirenDiagnostic,
  type SirenSdkDevice,
} from '../../src/homekit/adapters/siren.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const SIREN_EVIDENCE = new Map(SIREN_ADAPTER.requires.map((requirement) => [requirement.id, requirement]));

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic indoor siren', uuid.generate('synthetic-siren')) as unknown as PlatformAccessory;
}

function sirenDevice(actions: Partial<SirenActions>): SirenSdkDevice {
  return { siren: () => actions as SirenActions };
}

function attach(
  device: SirenSdkDevice,
  target: PlatformAccessory,
  diagnose: (diagnostic: SirenDiagnostic) => void = vi.fn(),
) {
  return SIREN_ADAPTER.attach({
    device: device as never,
    evidence: SIREN_EVIDENCE,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
  });
}

describe('indoor siren capability adapter', () => {
  it('resets the test control after the momentary action settles without synthesizing alarm state', async () => {
    vi.useFakeTimers();
    const target = accessory();
    let settleTest!: () => void;
    const test = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleTest = resolve;
        }),
    );
    const stop = vi.fn(async () => undefined);
    attach(sirenDevice({ active: false, test, stop }), target);
    const service = target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)!;
    const on = service.getCharacteristic(Characteristic.On);

    const write = on.handleSetRequest(true);
    await vi.waitFor(() => expect(test).toHaveBeenCalledOnce());
    expect(on.value).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    settleTest();
    await write;
    await vi.runAllTimersAsync();

    expect(on.value).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(target.services.some(({ UUID }) => UUID === Service.SecuritySystem.UUID)).toBe(false);
    vi.useRealTimers();
  });

  it('reads authoritative active state and invokes stop only for an explicit false write while active', async () => {
    let active: unknown = true;
    const test = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const target = accessory();
    attach(
      sirenDevice({
        get active(): boolean | undefined {
          return active as boolean | undefined;
        },
        test,
        stop,
      }),
      target,
    );
    const on = target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)!.getCharacteristic(Characteristic.On);

    await expect(on.handleGetRequest()).resolves.toBe(true);
    await on.handleSetRequest(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(test).not.toHaveBeenCalled();

    active = false;
    await expect(on.handleGetRequest()).resolves.toBe(false);
    await on.handleSetRequest(false);
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', () => undefined],
    ['malformed', () => 'sounding'],
    [
      'faulting',
      () => {
        throw new Error('synthetic SDK read failure');
      },
    ],
  ])('fails closed without stopping for %s active observations', async (_case, read) => {
    const stop = vi.fn(async () => undefined);
    const target = accessory();
    attach(
      sirenDevice({
        get active(): boolean | undefined {
          return read() as boolean | undefined;
        },
        test: vi.fn(async () => undefined),
        stop,
      }),
      target,
    );
    const on = target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)!.getCharacteristic(Characteristic.On);

    await expect(on.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(on.handleSetRequest(false)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(stop).not.toHaveBeenCalled();
  });

  it('resets an unsettled test after adapter replacement and preserves replacement service ownership', async () => {
    vi.useFakeTimers();
    const target = accessory();
    let settleTest!: () => void;
    const original = attach(
      sirenDevice({
        active: false,
        test: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              settleTest = resolve;
            }),
        ),
        stop: vi.fn(async () => undefined),
      }),
      target,
    )!;
    const on = target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)!.getCharacteristic(Characteristic.On);
    const write = on.handleSetRequest(true);
    await vi.waitFor(() => expect(settleTest).toBeTypeOf('function'));

    const replacement = attach(
      sirenDevice({ active: false, test: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }),
      target,
    )!;
    original.detach?.();
    expect(target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)).toBeDefined();

    settleTest();
    await write;
    await vi.runAllTimersAsync();
    expect(on.value).toBe(false);

    replacement.detach?.();
    expect(target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)).toBeUndefined();
    vi.useRealTimers();
  });

  it('does not attach when the evidenced typed siren operations are unavailable', () => {
    for (const [device, member] of [
      [{}, 'active'],
      [sirenDevice({ active: false, stop: vi.fn(async () => undefined) }), 'test'],
      [sirenDevice({ active: false, test: vi.fn(async () => undefined) }), 'stop'],
    ] as const) {
      const target = accessory();
      const diagnostics: SirenDiagnostic[] = [];
      expect(attach(device, target, (diagnostic) => diagnostics.push(diagnostic))).toBeUndefined();
      expect(target.getServiceById(Service.Switch, SIREN_ADAPTER_KEY)).toBeUndefined();
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: 'siren-capability-unavailable', member, active: true }),
      );
    }
  });

  it('clears each recovered operation diagnostic when the complete typed capability becomes available', () => {
    const diagnostics: SirenDiagnostic[] = [];
    const diagnose = (diagnostic: SirenDiagnostic): void => diagnostics.push(diagnostic);

    expect(
      attach(sirenDevice({ active: false, stop: vi.fn(async () => undefined) }), accessory(), diagnose),
    ).toBeUndefined();
    attach(
      sirenDevice({ active: false, test: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }),
      accessory(),
      diagnose,
    );

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'siren-capability-unavailable', member: 'test', active: true }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'siren-capability-unavailable', member: 'test', active: false }),
    );
  });
});
