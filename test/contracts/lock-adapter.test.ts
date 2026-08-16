import { CapabilityNotSupportedError, type AnyDeviceEvent, type LockActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  LOCK_ADAPTER,
  LOCK_ADAPTER_KEY,
  type LockDiagnostic,
  type LockSdkDevice,
} from '../../src/homekit/adapters/lock.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const LOCK_EVIDENCE = new Map(LOCK_ADAPTER.requires.map((requirement) => [requirement.id, requirement]));

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic lock', uuid.generate('synthetic-lock')) as unknown as PlatformAccessory;
}

function lockDevice(actions: Partial<LockActions>): LockSdkDevice {
  return { lock: () => actions as LockActions };
}

function attach(
  device: LockSdkDevice,
  target: PlatformAccessory,
  diagnose: (diagnostic: LockDiagnostic) => void = vi.fn(),
) {
  return LOCK_ADAPTER.attach({
    device: device as never,
    evidence: LOCK_EVIDENCE,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
    persist: vi.fn(),
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('T8531 lock capability adapter', () => {
  it('exposes lock and unlock targets while current remains unknown after command delivery', async () => {
    const target = accessory();
    const lock = vi.fn(async () => undefined);
    const unlock = vi.fn(async () => undefined);
    const adapter = attach(lockDevice({ lock, unlock }), target)!;
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const desired = service.getCharacteristic(Characteristic.LockTargetState);

    expect(adapter).toBeDefined();
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);
    await expect(desired.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    await desired.handleSetRequest(Characteristic.LockTargetState.SECURED);
    expect(lock).toHaveBeenCalledOnce();
    expect(unlock).not.toHaveBeenCalled();
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.LockTargetState.SECURED);
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);

    await desired.handleSetRequest(Characteristic.LockTargetState.UNSECURED);
    expect(unlock).toHaveBeenCalledOnce();
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.LockTargetState.UNSECURED);
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);

    expect(adapter.event?.({ eventName: 'lockState', eventType: 262 } as AnyDeviceEvent)).toBeUndefined();
    expect(current.value).toBe(Characteristic.LockCurrentState.UNKNOWN);
  });

  it('uses one bounded attempt and never converts operation failure into physical state', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const lock = vi.fn(() => new Promise<void>(() => undefined));
    attach(lockDevice({ lock, unlock: vi.fn(async () => undefined) }), target);
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const desired = service.getCharacteristic(Characteristic.LockTargetState);
    const pending = expect(desired.handleSetRequest(Characteristic.LockTargetState.SECURED)).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );

    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    expect(lock).toHaveBeenCalledOnce();
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);

    const absentTarget = accessory();
    const absentLock = vi.fn(async () => undefined);
    const absentUnlock = vi.fn(async () => {
      throw new CapabilityNotSupportedError('synthetic-device', 'unlock');
    });
    const absentAdapter = attach(lockDevice({ lock: absentLock, unlock: absentUnlock }), absentTarget)!;
    const absentDesired = absentTarget
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockTargetState);
    await expect(absentDesired.handleSetRequest(Characteristic.LockTargetState.UNSECURED)).rejects.toBe(
      HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
    );
    expect(absentUnlock).toHaveBeenCalledOnce();
    await expect(absentDesired.handleSetRequest(Characteristic.LockTargetState.SECURED)).rejects.toBe(
      HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
    );
    expect(absentLock).not.toHaveBeenCalled();
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);

    absentAdapter.detach?.();
    const replacementLock = vi.fn(async () => undefined);
    attach(lockDevice({ lock: replacementLock, unlock: vi.fn(async () => undefined) }), absentTarget);
    await absentTarget
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockTargetState)
      .handleSetRequest(Characteristic.LockTargetState.SECURED);
    expect(replacementLock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('serializes controls and coalesces queued requests to the newest target', async () => {
    const target = accessory();
    const operations = [deferred(), deferred()];
    const lock = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => operations[0]!.promise)
      .mockImplementationOnce(() => operations[1]!.promise);
    const unlock = vi.fn(async () => undefined);
    attach(lockDevice({ lock, unlock }), target);
    const desired = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockTargetState);

    const first = desired.handleSetRequest(Characteristic.LockTargetState.SECURED);
    const superseded = desired.handleSetRequest(Characteristic.LockTargetState.UNSECURED);
    const newest = desired.handleSetRequest(Characteristic.LockTargetState.SECURED);
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(1));
    expect(unlock).not.toHaveBeenCalled();

    operations[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2));
    expect(unlock).not.toHaveBeenCalled();
    operations[1]!.resolve();

    await expect(Promise.all([superseded, newest])).resolves.toEqual([undefined, undefined]);
  });

  it('settles pending control without stale diagnostics when detached', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const operation = deferred();
    const diagnostics: LockDiagnostic[] = [];
    const adapter = attach(
      lockDevice({ lock: vi.fn(() => operation.promise), unlock: vi.fn(async () => undefined) }),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    )!;
    const desired = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockTargetState);
    const write = expect(desired.handleSetRequest(Characteristic.LockTargetState.SECURED)).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    adapter.detach?.();
    await write;
    await vi.advanceTimersByTimeAsync(8_000);
    operation.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(diagnostics.filter(({ code, active }) => code === 'lock-operation-failed' && active)).toEqual([]);
    vi.useRealTimers();
  });

  it('waits for a timed-out operation to settle before giving a queued manual request its own attempt', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const operations = [deferred(), deferred()];
    const lock = vi.fn(() => operations[0]!.promise);
    const unlock = vi.fn(() => operations[1]!.promise);
    attach(lockDevice({ lock, unlock }), target);
    const desired = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockTargetState);

    const first = expect(desired.handleSetRequest(Characteristic.LockTargetState.SECURED)).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = desired.handleSetRequest(Characteristic.LockTargetState.UNSECURED);
    await vi.advanceTimersByTimeAsync(7_000);
    await first;
    expect(unlock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(unlock).not.toHaveBeenCalled();
    operations[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlock).toHaveBeenCalledOnce();

    operations[1]!.resolve();
    await retry;
    vi.useRealTimers();
  });

  it('expires an unreconciled target projection without inventing current or jammed state', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const diagnostics: LockDiagnostic[] = [];
    attach(
      lockDevice({ lock: vi.fn(async () => undefined), unlock: vi.fn(async () => undefined) }),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
    );
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const desired = service.getCharacteristic(Characteristic.LockTargetState);

    await desired.handleSetRequest(Characteristic.LockTargetState.SECURED);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(desired.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);
    expect(current.value).not.toBe(Characteristic.LockCurrentState.JAMMED);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'lock-reconciliation-expired', active: true, reason: 'expired' }),
    );
    vi.useRealTimers();
  });
});
