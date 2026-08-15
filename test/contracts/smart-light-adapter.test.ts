import { CapabilityNotSupportedError, type AnyDeviceEvent, type SmartLightActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  SMART_LIGHT_ADAPTER,
  SMART_LIGHT_ADAPTER_KEY,
  type SmartLightDiagnostic,
  type SmartLightSdkDevice,
} from '../../src/homekit/adapters/smart-light.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const SMART_LIGHT_EVIDENCE = new Map(SMART_LIGHT_ADAPTER.requires.map((requirement) => [requirement.id, requirement]));
const SMART_LIGHT_COLOR_EVIDENCE = new Map([
  ...SMART_LIGHT_EVIDENCE,
  [
    'smart_light.setColor.momentary-action',
    { id: 'smart_light.setColor.momentary-action', kind: 'momentary-action' as const },
  ] as const,
]);

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic smart light', uuid.generate('synthetic-smart-light')) as unknown as PlatformAccessory;
}

function lightDevice(actions: Partial<SmartLightActions>): SmartLightSdkDevice {
  return { smartLight: () => actions as SmartLightActions };
}

function attach(
  device: SmartLightSdkDevice,
  target: PlatformAccessory,
  diagnose: (diagnostic: SmartLightDiagnostic) => void = vi.fn(),
  evidence = SMART_LIGHT_EVIDENCE,
  persist: () => void = vi.fn(),
) {
  return SMART_LIGHT_ADAPTER.attach({
    device: device as never,
    evidence,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
    persist,
  });
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('smart-light capability adapter', () => {
  it('exposes authoritative power and brightness through one real HAP Lightbulb', async () => {
    const target = accessory();
    const adapter = attach(
      lightDevice({
        power: false,
        brightness: 35,
        set: vi.fn(async () => undefined),
        setBrightness: vi.fn(async () => undefined),
      }),
      target,
    )!;
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const power = service.getCharacteristic(Characteristic.On);
    const brightness = service.getCharacteristic(Characteristic.Brightness);

    await expect(power.handleGetRequest()).resolves.toBe(false);
    await expect(brightness.handleGetRequest()).resolves.toBe(35);

    adapter.event?.({ eventName: 'smartLightState', power: true } as AnyDeviceEvent);
    expect(power.value).toBe(true);
    expect(brightness.value).toBe(35);
    adapter.event?.({ eventName: 'smartLightState', brightness: 72 } as AnyDeviceEvent);
    expect(power.value).toBe(true);
    expect(brightness.value).toBe(72);
  });

  it('exposes color only from SDK evidence and acknowledges the sent Hue and Saturation after publication', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const publication = deferred();
    const setColor = vi.fn(() => publication.promise);
    const persist = vi.fn();
    attach(
      lightDevice({
        power: true,
        brightness: 50,
        set: vi.fn(async () => undefined),
        setBrightness: vi.fn(async () => undefined),
        setColor,
      }),
      target,
      vi.fn(),
      SMART_LIGHT_COLOR_EVIDENCE,
      persist,
    );
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const hue = service.getCharacteristic(Characteristic.Hue);
    const saturation = service.getCharacteristic(Characteristic.Saturation);

    await expect(hue.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(saturation.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    const hueWrite = hue.handleSetRequest(30);
    const saturationWrite = saturation.handleSetRequest(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(setColor).toHaveBeenCalledExactlyOnceWith({ red: 255, green: 128, blue: 0 });
    await expect(hue.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    publication.resolve();
    await Promise.all([hueWrite, saturationWrite]);
    await expect(hue.handleGetRequest()).resolves.toBe(30);
    await expect(saturation.handleGetRequest()).resolves.toBe(100);
    expect(target.context).toMatchObject({
      homebridgeEufySmartLightColor: { version: 1, hue: 30, saturation: 100 },
    });
    expect(persist).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not expose color characteristics without SDK color evidence', () => {
    const target = accessory();
    attach(
      lightDevice({
        power: true,
        brightness: 50,
        set: vi.fn(async () => undefined),
        setBrightness: vi.fn(async () => undefined),
        setColor: vi.fn(async () => undefined),
      }),
      target,
    );
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;

    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);
  });

  it('reuses the acknowledged counterpart for one-component color writes and retains it on failure', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const setColor = vi
      .fn<(color: { red: number; green: number; blue: number }) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic publication failure'));
    attach(
      lightDevice({
        power: true,
        brightness: 50,
        set: vi.fn(),
        setBrightness: vi.fn(),
        setColor,
      }),
      target,
      vi.fn(),
      SMART_LIGHT_COLOR_EVIDENCE,
    );
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const hue = service.getCharacteristic(Characteristic.Hue);
    const saturation = service.getCharacteristic(Characteristic.Saturation);

    const first = Promise.all([hue.handleSetRequest(120), saturation.handleSetRequest(50)]);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(setColor).toHaveBeenNthCalledWith(1, { red: 128, green: 255, blue: 128 });

    const failed = expect(hue.handleSetRequest(240)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(setColor).toHaveBeenNthCalledWith(2, { red: 128, green: 128, blue: 255 });
    await expect(hue.handleGetRequest()).resolves.toBe(120);
    await expect(saturation.handleGetRequest()).resolves.toBe(50);
    vi.useRealTimers();
  });

  it('rejects an incomplete first color request without dispatch', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const setColor = vi.fn(async () => undefined);
    attach(
      lightDevice({
        power: true,
        brightness: 50,
        set: vi.fn(),
        setBrightness: vi.fn(),
        setColor,
      }),
      target,
      vi.fn(),
      SMART_LIGHT_COLOR_EVIDENCE,
    );
    const hue = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.Hue);

    const write = expect(hue.handleSetRequest(90)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    await vi.advanceTimersByTimeAsync(0);
    await write;
    expect(setColor).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('maps a synchronous SDK color failure without leaving the scheduler active', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const setColor = vi.fn((): Promise<void> => {
      throw new Error('synthetic synchronous failure');
    });
    attach(
      lightDevice({ power: true, brightness: 50, set: vi.fn(), setBrightness: vi.fn(), setColor }),
      target,
      vi.fn(),
      SMART_LIGHT_COLOR_EVIDENCE,
    );
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const failed = Promise.all([
      expect(service.getCharacteristic(Characteristic.Hue).handleSetRequest(180)).rejects.toBe(
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      ),
      expect(service.getCharacteristic(Characteristic.Saturation).handleSetRequest(100)).rejects.toBe(
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      ),
    ]);

    await vi.advanceTimersByTimeAsync(0);
    await failed;
    expect(setColor).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('retains a late successful publication as acknowledged color after the HomeKit deadline', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const publication = deferred();
    const persist = vi.fn();
    attach(
      lightDevice({
        power: true,
        brightness: 50,
        set: vi.fn(),
        setBrightness: vi.fn(),
        setColor: vi.fn(() => publication.promise),
      }),
      target,
      vi.fn(),
      SMART_LIGHT_COLOR_EVIDENCE,
      persist,
    );
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const hue = service.getCharacteristic(Characteristic.Hue);
    const saturation = service.getCharacteristic(Characteristic.Saturation);
    const hueFailure = expect(hue.handleSetRequest(60)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    const saturationFailure = expect(saturation.handleSetRequest(100)).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.all([hueFailure, saturationFailure]);

    publication.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await expect(hue.handleGetRequest()).resolves.toBe(60);
    await expect(saturation.handleGetRequest()).resolves.toBe(100);
    expect(persist).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('restores acknowledged color from accessory context after adapter replacement', async () => {
    const target = accessory();
    target.context = { homebridgeEufySmartLightColor: { version: 1, hue: 210, saturation: 75 } };
    attach(
      lightDevice({
        power: true,
        brightness: 50,
        set: vi.fn(),
        setBrightness: vi.fn(),
        setColor: vi.fn(),
      }),
      target,
      vi.fn(),
      SMART_LIGHT_COLOR_EVIDENCE,
    );
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;

    await expect(service.getCharacteristic(Characteristic.Hue).handleGetRequest()).resolves.toBe(210);
    await expect(service.getCharacteristic(Characteristic.Saturation).handleGetRequest()).resolves.toBe(75);
  });

  it('clears acknowledged color when a complete attachment no longer has SDK color evidence', () => {
    const target = accessory();
    target.context = { homebridgeEufySmartLightColor: { version: 1, hue: 210, saturation: 75 } };
    const device = lightDevice({
      power: true,
      brightness: 50,
      set: vi.fn(),
      setBrightness: vi.fn(),
      setColor: vi.fn(),
    });
    attach(device, target, vi.fn(), SMART_LIGHT_COLOR_EVIDENCE);

    attach(device, target);

    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);
    expect(target.context).not.toHaveProperty('homebridgeEufySmartLightColor');
  });

  it('retains authoritative values until a post-request observation matches or conflicts', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const operation = deferred();
    const set = vi.fn(() => operation.promise);
    const adapter = attach(
      lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn(async () => undefined) }),
      target,
    )!;
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const power = service.getCharacteristic(Characteristic.On);

    const write = power.handleSetRequest(true);
    await vi.waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith(true));
    await expect(power.handleGetRequest()).resolves.toBe(false);
    operation.resolve();
    await write;
    await vi.advanceTimersByTimeAsync(0);
    await expect(power.handleGetRequest()).resolves.toBe(false);

    adapter.event?.({ eventName: 'smartLightState', power: false } as AnyDeviceEvent);
    await expect(power.handleGetRequest()).resolves.toBe(false);

    await power.handleSetRequest(true);
    adapter.event?.({ eventName: 'smartLightState', power: true } as AnyDeviceEvent);
    await expect(power.handleGetRequest()).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('serializes each member and coalesces queued writes to the newest generation', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const operations = [deferred(), deferred()];
    const set = vi
      .fn<(value: boolean) => Promise<void>>()
      .mockImplementationOnce(() => operations[0]!.promise)
      .mockImplementationOnce(() => operations[1]!.promise);
    attach(lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }), target);
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    const first = power.handleSetRequest(true);
    const superseded = power.handleSetRequest(false);
    const newest = power.handleSetRequest(true);
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    operations[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls).toEqual([[true], [true]]);

    operations[1]!.resolve();
    await expect(Promise.all([superseded, newest])).resolves.toEqual([undefined, undefined]);
    vi.useRealTimers();
  });

  it('ignores an older timed-out generation completion while a newer generation is active', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const diagnostics: SmartLightDiagnostic[] = [];
    const operations = [deferred(), deferred()];
    const set = vi
      .fn<(value: boolean) => Promise<void>>()
      .mockImplementationOnce(() => operations[0]!.promise)
      .mockImplementationOnce(() => operations[1]!.promise);
    attach(lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }), target, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    const older = power.handleSetRequest(true);
    const olderRejection = expect(older).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(1_000);
    const newer = power.handleSetRequest(false);
    let newerSettled = false;
    void newer.finally(() => {
      newerSettled = true;
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await olderRejection;
    expect(set.mock.calls).toEqual([[true], [false]]);

    operations[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(newerSettled).toBe(false);
    operations[1]!.resolve();
    await newer;
    expect(newerSettled).toBe(true);
    vi.useRealTimers();
  });

  it('keeps power and brightness operation queues independent', async () => {
    const target = accessory();
    const powerOperation = deferred();
    const set = vi.fn(() => powerOperation.promise);
    const setBrightness = vi.fn(async () => undefined);
    attach(lightDevice({ power: false, brightness: 35, set, setBrightness }), target);
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;

    const powerWrite = service.getCharacteristic(Characteristic.On).handleSetRequest(true);
    await service.getCharacteristic(Characteristic.Brightness).handleSetRequest(70);

    expect(set).toHaveBeenCalledOnce();
    expect(setBrightness).toHaveBeenCalledExactlyOnceWith(70);
    powerOperation.resolve();
    await powerWrite;
  });

  it('counts queue wait inside each request deadline', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const set = vi.fn(() => new Promise<void>(() => undefined));
    attach(lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }), target);
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    const first = power.handleSetRequest(true);
    const firstRejection = expect(first).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = power.handleSetRequest(false);
    const queuedRejection = expect(queued).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(7_000);
    await firstRejection;
    expect(set.mock.calls).toEqual([[true], [false]]);
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(1);
    await queuedRejection;
    expect(set).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('reconciles the current queued generation from a post-request observation', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const diagnostics: SmartLightDiagnostic[] = [];
    const operations = [deferred(), deferred()];
    const set = vi
      .fn<(value: boolean) => Promise<void>>()
      .mockImplementationOnce(() => operations[0]!.promise)
      .mockImplementationOnce(() => operations[1]!.promise);
    const adapter = attach(
      lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    const first = power.handleSetRequest(true);
    const queued = power.handleSetRequest(false);
    adapter.event?.({ eventName: 'smartLightState', power: false } as AnyDeviceEvent);
    operations[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    operations[1]!.resolve();
    await queued;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      diagnostics.some(
        ({ code, member, active }) => code === 'smart-light-reconciliation-expired' && member === 'power' && active,
      ),
    ).toBe(false);
    vi.useRealTimers();
  });

  it('fails one operation after eight seconds without retrying or polling', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const set = vi.fn(() => new Promise<void>(() => undefined));
    attach(lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }), target);
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    const write = power.handleSetRequest(true);
    const rejectedWrite = expect(write).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(set).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await rejectedWrite;
    expect(set).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('maps a typed absent SDK operation without classifying error text', async () => {
    const target = accessory();
    const diagnostics: SmartLightDiagnostic[] = [];
    const set = vi.fn(async () => {
      throw new CapabilityNotSupportedError('synthetic-device', 'power');
    });
    const adapter = attach(
      lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    await expect(power.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    await expect(power.handleSetRequest(false)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(set).toHaveBeenCalledOnce();
    const fault = diagnostics.findLastIndex(
      ({ code, member, active }) => code === 'smart-light-operation-failed' && member === 'power' && active,
    );
    adapter.event?.({ eventName: 'smartLightState', power: true } as AnyDeviceEvent);
    expect(
      diagnostics
        .slice(fault + 1)
        .some(({ code, member, active }) => code === 'smart-light-operation-failed' && member === 'power' && !active),
    ).toBe(false);

    const replacementSet = vi.fn(async () => undefined);
    const unchanged = attach(
      lightDevice({
        power: true,
        brightness: 35,
        set: replacementSet,
        setBrightness: vi.fn(async () => undefined),
      }),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    expect(
      diagnostics
        .slice(fault + 1)
        .some(({ code, member, active }) => code === 'smart-light-operation-failed' && member === 'power' && !active),
    ).toBe(false);
    await expect(power.handleSetRequest(false)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(replacementSet).not.toHaveBeenCalled();

    unchanged.detach?.();
    expect(
      attach(
        lightDevice({ power: true, brightness: 35, set: replacementSet, setBrightness: vi.fn() }),
        target,
        (diagnostic) => diagnostics.push(diagnostic),
      ),
    ).toBeDefined();
    expect(
      diagnostics
        .slice(fault + 1)
        .some(({ code, member, active }) => code === 'smart-light-operation-failed' && member === 'power' && !active),
    ).toBe(true);
  });

  it('reports operation failure and expires unreconciled acknowledgement after 60 seconds', async () => {
    vi.useFakeTimers();
    const failedTarget = accessory();
    const failedDiagnostics: SmartLightDiagnostic[] = [];
    const set = vi.fn(async () => {
      throw new Error('synthetic operation failure');
    });
    attach(lightDevice({ power: false, brightness: 35, set, setBrightness: vi.fn() }), failedTarget, (diagnostic) =>
      failedDiagnostics.push(diagnostic),
    );
    const failedPower = failedTarget
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);

    await expect(failedPower.handleSetRequest(true)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(set).toHaveBeenCalledOnce();
    expect(failedDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'smart-light-operation-failed', member: 'power', active: true }),
    );

    const target = accessory();
    const diagnostics: SmartLightDiagnostic[] = [];
    const adapter = attach(
      lightDevice({
        power: false,
        brightness: 35,
        set: vi.fn(async () => undefined),
        setBrightness: vi.fn(async () => undefined),
      }),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const power = target
      .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.On);
    await power.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(diagnostics.some(({ code, active }) => code === 'smart-light-reconciliation-expired' && active)).toBe(false);
    adapter.event?.({ eventName: 'smartLightState', power: 'malformed' } as unknown as AnyDeviceEvent);
    await expect(power.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'smart-light-reconciliation-expired', member: 'power', active: true }),
    );
    const expiry = diagnostics.findLastIndex(
      ({ code, member, active }) => code === 'smart-light-reconciliation-expired' && member === 'power' && active,
    );

    adapter.event?.({ eventName: 'smartLightState', brightness: 80 } as AnyDeviceEvent);
    expect(
      diagnostics
        .slice(expiry + 1)
        .some(
          ({ code, member, active }) => code === 'smart-light-reconciliation-expired' && member === 'power' && !active,
        ),
    ).toBe(false);
    adapter.event?.({ eventName: 'smartLightState', power: true } as AnyDeviceEvent);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'smart-light-reconciliation-expired', member: 'power', active: false }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-smart-light-observation', member: 'power', active: false }),
    );
    vi.useRealTimers();
  });

  it('fails missing and malformed member reads without treating omitted event members as withdrawn', async () => {
    const target = accessory();
    const adapter = attach(
      lightDevice({
        power: undefined,
        brightness: 40,
        set: vi.fn(async () => undefined),
        setBrightness: vi.fn(async () => undefined),
      }),
      target,
    )!;
    const service = target.getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!;
    const power = service.getCharacteristic(Characteristic.On);
    const brightness = service.getCharacteristic(Characteristic.Brightness);

    await expect(power.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(brightness.handleGetRequest()).resolves.toBe(40);
    adapter.event?.({ eventName: 'smartLightState', power: 'malformed' } as unknown as AnyDeviceEvent);
    await expect(power.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(brightness.handleGetRequest()).resolves.toBe(40);

    adapter.event?.({ eventName: 'smartLightState', power: false } as AnyDeviceEvent);
    await expect(power.handleGetRequest()).resolves.toBe(false);

    expect(
      adapter.event?.({
        eventName: 'smartLightState',
        power: 'malformed',
        brightness: 60,
      } as unknown as AnyDeviceEvent),
    ).toMatchObject({ observation: 'malformed' });
  });

  it('rejects out-of-range brightness observations', async () => {
    const target = accessory();
    attach(
      lightDevice({
        power: false,
        brightness: 101,
        set: vi.fn(async () => undefined),
        setBrightness: vi.fn(async () => undefined),
      }),
      target,
    );

    await expect(
      target
        .getServiceById(Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY)!
        .getCharacteristic(Characteristic.Brightness)
        .handleGetRequest(),
    ).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('clears capability-unavailable diagnostics after a later valid attachment', () => {
    const target = accessory();
    const diagnostics: SmartLightDiagnostic[] = [];
    const diagnose = (diagnostic: SmartLightDiagnostic): void => {
      diagnostics.push(diagnostic);
    };

    expect(attach({}, target, diagnose)).toBeUndefined();
    expect(
      attach(
        lightDevice({
          power: false,
          brightness: 50,
          set: vi.fn(async () => undefined),
          setBrightness: vi.fn(async () => undefined),
        }),
        target,
        diagnose,
      ),
    ).toBeDefined();

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'smart-light-capability-unavailable', member: 'power', active: true }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'smart-light-capability-unavailable', member: 'power', active: false }),
    );
  });
});
