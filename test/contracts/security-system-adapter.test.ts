import { ArmingMode, CapabilityNotSupportedError, type AnyDeviceEvent, type ArmingActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  SECURITY_SYSTEM_ADAPTER,
  SECURITY_SYSTEM_ADAPTER_KEY,
  type SecuritySystemDiagnostic,
  type SecuritySystemSdkDevice,
} from '../../src/homekit/adapters/security-system.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const ARMING_EVIDENCE = new Map(SECURITY_SYSTEM_ADAPTER.requires.map((requirement) => [requirement.id, requirement]));

function accessory(): PlatformAccessory {
  return new Accessory(
    'Synthetic security system',
    uuid.generate('synthetic-security-system'),
  ) as unknown as PlatformAccessory;
}

function armingDevice(actions: Partial<ArmingActions>): SecuritySystemSdkDevice {
  return { arming: () => actions as ArmingActions };
}

function attach(
  device: SecuritySystemSdkDevice,
  target: PlatformAccessory,
  diagnose: (diagnostic: SecuritySystemDiagnostic) => void = vi.fn(),
) {
  return SECURITY_SYSTEM_ADAPTER.attach({
    device: device as never,
    evidence: ARMING_EVIDENCE,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
    persist: vi.fn(),
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

describe('security-system capability adapter', () => {
  it('maps authoritative Home, Away, and Disarmed modes and exposes only those targets', async () => {
    const target = accessory();
    const setMode = vi.fn(async () => undefined);
    const actions = { mode: 1, setMode };
    const adapter = attach(armingDevice(actions), target);
    const service = target.getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.SecuritySystemCurrentState);
    const desired = service.getCharacteristic(Characteristic.SecuritySystemTargetState);

    expect(adapter).toBeDefined();
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.STAY_ARM);
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemTargetState.STAY_ARM);
    expect(desired.props.validValues).toEqual([
      Characteristic.SecuritySystemTargetState.STAY_ARM,
      Characteristic.SecuritySystemTargetState.AWAY_ARM,
      Characteristic.SecuritySystemTargetState.DISARM,
    ]);

    await desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    expect(setMode).toHaveBeenCalledExactlyOnceWith(ArmingMode.away);

    actions.mode = 0;
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.AWAY_ARM);
    actions.mode = 63;
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.DISARMED);
  });

  it('faults unsupported observed modes while admitted controls remain available', async () => {
    const target = accessory();
    const diagnostics: SecuritySystemDiagnostic[] = [];
    const setMode = vi.fn(async () => undefined);
    const actions = { mode: 2, setMode };
    const adapter = attach(armingDevice(actions), target, (diagnostic) => diagnostics.push(diagnostic))!;
    const service = target.getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.SecuritySystemCurrentState);
    const desired = service.getCharacteristic(Characteristic.SecuritySystemTargetState);
    const fault = service.getCharacteristic(Characteristic.StatusFault);

    await expect(current.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(desired.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(fault.value).toBe(Characteristic.StatusFault.GENERAL_FAULT);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-arming-mode', member: 'mode', active: true }),
    );

    await desired.handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM);
    expect(setMode).toHaveBeenCalledExactlyOnceWith(ArmingMode.disarmed);
    await expect(desired.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    actions.mode = 63;
    expect(adapter.event?.({ eventName: 'armingModeChanged' } as AnyDeviceEvent)).toMatchObject({
      event: 'arming-mode-changed',
      observation: 'valid',
    });
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.DISARMED);
    expect(fault.value).toBe(Characteristic.StatusFault.NO_FAULT);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsupported-arming-mode', member: 'mode', active: false }),
    );
  });

  it.each(['delayed', 'triggered'] as const)(
    'reports a %s alarm immediately and clears it only after an authoritative arming observation',
    async (phase) => {
      vi.useFakeTimers();
      const target = accessory();
      const actions = { mode: 1, setMode: vi.fn(async () => undefined) };
      const adapter = attach(armingDevice(actions), target)!;
      const service = target.getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!;
      const current = service.getCharacteristic(Characteristic.SecuritySystemCurrentState);
      const alarmType = service.getCharacteristic(Characteristic.SecuritySystemAlarmType);

      expect(adapter.event?.({ eventName: 'alarm', phase } as AnyDeviceEvent)).toMatchObject({
        event: 'security-system-alarm',
        observation: 'valid',
      });
      await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
      expect(current.value).toBe(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
      expect(alarmType.value).toBe(Characteristic.SecuritySystemAlarmType.UNKNOWN);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);

      actions.mode = 0;
      adapter.event?.({ eventName: 'armingModeChanged' } as AnyDeviceEvent);
      await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.AWAY_ARM);
      expect(alarmType.value).toBe(Characteristic.SecuritySystemAlarmType.NO_ALARM);
      vi.useRealTimers();
    },
  );

  it('projects only the target until a matching or conflicting authoritative observation arrives', async () => {
    const target = accessory();
    const operation = deferred();
    const actions = { mode: 1, setMode: vi.fn(() => operation.promise) };
    const adapter = attach(armingDevice(actions), target)!;
    const service = target.getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.SecuritySystemCurrentState);
    const desired = service.getCharacteristic(Characteristic.SecuritySystemTargetState);

    const write = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    await vi.waitFor(() => expect(actions.setMode).toHaveBeenCalledExactlyOnceWith(ArmingMode.away));
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.STAY_ARM);
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    operation.resolve();
    await write;

    actions.mode = 63;
    adapter.event?.({ eventName: 'armingModeChanged' } as AnyDeviceEvent);
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.DISARMED);
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemTargetState.DISARM);

    await desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    actions.mode = 0;
    adapter.event?.({ eventName: 'armingModeChanged' } as AnyDeviceEvent);
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemCurrentState.AWAY_ARM);
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemTargetState.AWAY_ARM);
  });

  it('maps operation failures and blocks a typed absent operation until capability withdrawal', async () => {
    const failedTarget = accessory();
    const failure = vi.fn(async () => {
      throw new Error('synthetic operation failure');
    });
    attach(armingDevice({ mode: 1, setMode: failure }), failedTarget);
    const failedDesired = failedTarget
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);

    await expect(failedDesired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM)).rejects.toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );

    const target = accessory();
    const absent = vi.fn(async () => {
      throw new CapabilityNotSupportedError('synthetic-device', 'mode');
    });
    const firstAttachment = attach(armingDevice({ mode: 1, setMode: absent }), target)!;
    const desired = target
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);

    await expect(desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM)).rejects.toBe(
      HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
    );
    await expect(desired.handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM)).rejects.toBe(
      HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
    );
    expect(absent).toHaveBeenCalledOnce();

    const replacementSet = vi.fn(async () => undefined);
    const replacement = attach(armingDevice({ mode: 1, setMode: replacementSet }), target)!;
    firstAttachment.detach?.();
    await expect(desired.handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM)).rejects.toBe(
      HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
    );
    expect(replacementSet).not.toHaveBeenCalled();
    expect(
      target
        .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
        .getCharacteristic(Characteristic.StatusFault).value,
    ).toBe(Characteristic.StatusFault.GENERAL_FAULT);

    replacement.detach?.();
    attach(armingDevice({ mode: 1, setMode: replacementSet }), target);
    await target
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM);
    expect(replacementSet).toHaveBeenCalledOnce();
  });

  it('uses one eight-second attempt and faults an acknowledgement unreconciled after 60 seconds', async () => {
    vi.useFakeTimers();
    const timedOutTarget = accessory();
    const timedOutOperation = vi.fn(() => new Promise<void>(() => undefined));
    attach(armingDevice({ mode: 1, setMode: timedOutOperation }), timedOutTarget);
    const timedOutDesired = timedOutTarget
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);
    const timedOutWrite = expect(
      timedOutDesired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM),
    ).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(timedOutOperation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await timedOutWrite;
    expect(timedOutOperation).toHaveBeenCalledOnce();

    const target = accessory();
    const diagnostics: SecuritySystemDiagnostic[] = [];
    attach(armingDevice({ mode: 1, setMode: vi.fn(async () => undefined) }), target, (diagnostic) =>
      diagnostics.push(diagnostic),
    );
    const service = target.getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!;
    await service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(diagnostics.some(({ code, active }) => code === 'arming-reconciliation-expired' && active)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'arming-reconciliation-expired', member: 'mode', active: true }),
    );
    expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(Characteristic.StatusFault.GENERAL_FAULT);
    vi.useRealTimers();
  });

  it('serializes arming controls and coalesces queued requests to the newest target', async () => {
    const target = accessory();
    const operations = [deferred(), deferred()];
    const setMode = vi
      .fn<(mode: ArmingMode) => Promise<void>>()
      .mockImplementationOnce(() => operations[0]!.promise)
      .mockImplementationOnce(() => operations[1]!.promise);
    attach(armingDevice({ mode: 1, setMode }), target);
    const desired = target
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);

    const first = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    const superseded = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM);
    const newest = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.STAY_ARM);
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledTimes(1));

    operations[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(setMode).toHaveBeenCalledTimes(2));
    expect(setMode.mock.calls).toEqual([[ArmingMode.away], [ArmingMode.home]]);

    operations[1]!.resolve();
    await expect(Promise.all([superseded, newest])).resolves.toEqual([undefined, undefined]);
  });

  it('does not overlap a queued control with a timed-out SDK operation', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const operations = [deferred(), deferred()];
    const setMode = vi
      .fn<(mode: ArmingMode) => Promise<void>>()
      .mockImplementationOnce(() => operations[0]!.promise)
      .mockImplementationOnce(() => operations[1]!.promise);
    attach(armingDevice({ mode: 1, setMode }), target);
    const desired = target
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);

    const first = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    const firstFailure = expect(first).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM);
    await vi.advanceTimersByTimeAsync(7_000);
    await firstFailure;
    expect(setMode).toHaveBeenCalledExactlyOnceWith(ArmingMode.away);

    operations[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(setMode.mock.calls).toEqual([[ArmingMode.away], [ArmingMode.disarmed]]);
    operations[1]!.resolve();
    await queued;
    vi.useRealTimers();
  });

  it('keeps an in-flight control attached while a complete observation replaces the adapter handle', async () => {
    const target = accessory();
    const operation = deferred();
    const firstAttachment = attach(armingDevice({ mode: 1, setMode: vi.fn(() => operation.promise) }), target)!;
    const desired = target
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);
    const write = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);

    attach(armingDevice({ mode: 63, setMode: vi.fn(async () => undefined) }), target);
    firstAttachment.detach?.();
    operation.resolve();

    await expect(write).resolves.toBeUndefined();
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemTargetState.DISARM);
  });

  it('does not restore a queued projection reconciled by a later observation', async () => {
    const target = accessory();
    const operations = [deferred(), deferred()];
    const actions = {
      mode: 1,
      setMode: vi
        .fn<(mode: ArmingMode) => Promise<void>>()
        .mockImplementationOnce(() => operations[0]!.promise)
        .mockImplementationOnce(() => operations[1]!.promise),
    };
    const adapter = attach(armingDevice(actions), target)!;
    const desired = target
      .getServiceById(Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.SecuritySystemTargetState);
    const first = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.AWAY_ARM);
    const queued = desired.handleSetRequest(Characteristic.SecuritySystemTargetState.DISARM);

    actions.mode = 1;
    adapter.event?.({ eventName: 'armingModeChanged' } as AnyDeviceEvent);
    operations[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(actions.setMode).toHaveBeenCalledTimes(2));
    operations[1]!.resolve();
    await queued;

    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.SecuritySystemTargetState.STAY_ARM);
  });
});
