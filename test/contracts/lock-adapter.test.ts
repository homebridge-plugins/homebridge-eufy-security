import { CapabilityNotSupportedError, LockPushEvent, type AnyDeviceEvent, type LockActions } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import {
  CLASSIFIED_LOCK_CODES,
  LOCK_ADAPTER,
  LOCK_ADAPTER_KEY,
  LOCK_STATE_EVENT_ROW,
  type LockDiagnostic,
  type LockSdkDevice,
} from '../../src/homekit/adapters/lock.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
const LOCK_EVIDENCE = new Map<string, { id: string; kind: 'momentary-action' | 'event' }>(
  LOCK_ADAPTER.requires.map((requirement) => [requirement.id, requirement]),
);
LOCK_EVIDENCE.set(LOCK_STATE_EVENT_ROW, { id: LOCK_STATE_EVENT_ROW, kind: 'event' });

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic lock', uuid.generate('synthetic-lock')) as unknown as PlatformAccessory;
}

function lockDevice(actions: Partial<LockActions>): LockSdkDevice {
  return { lock: () => actions as LockActions };
}

/** One `lockState` announcement, as the SDK emits it: a named push code and nothing else. */
function announced(eventType?: number): AnyDeviceEvent {
  return { eventName: 'lockState', ...(eventType === undefined ? {} : { eventType }) } as AnyDeviceEvent;
}

function attach(
  device: LockSdkDevice,
  target: PlatformAccessory,
  diagnose: (diagnostic: LockDiagnostic) => void = vi.fn(),
  evidence: ReadonlyMap<string, { id: string; kind: string }> = LOCK_EVIDENCE,
) {
  return LOCK_ADAPTER.attach({
    device: device as never,
    evidence: evidence as never,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
    persist: vi.fn(),
  });
}

function workingLock(): Partial<LockActions> {
  return { lock: vi.fn(async () => undefined), unlock: vi.fn(async () => undefined) };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('T8531 lock capability adapter', () => {
  it('presents no lock state until the SDK announces one, and never from command delivery alone', async () => {
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
    await expect(
      current.handleGetRequest(),
      'a delivered command acknowledges delivery, not that the bolt moved',
    ).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);

    await desired.handleSetRequest(Characteristic.LockTargetState.UNSECURED);
    expect(unlock).toHaveBeenCalledOnce();
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.LockTargetState.UNSECURED);
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);
  });

  it.each([
    ['MANUAL_LOCK', LockPushEvent.MANUAL_LOCK, Characteristic.LockCurrentState.SECURED],
    ['KEYPAD_LOCK', LockPushEvent.KEYPAD_LOCK, Characteristic.LockCurrentState.SECURED],
    ['APP_LOCK', LockPushEvent.APP_LOCK, Characteristic.LockCurrentState.SECURED],
    ['AUTO_LOCK', LockPushEvent.AUTO_LOCK, Characteristic.LockCurrentState.SECURED],
    ['PW_LOCK', LockPushEvent.PW_LOCK, Characteristic.LockCurrentState.SECURED],
    ['FINGER_LOCK', LockPushEvent.FINGER_LOCK, Characteristic.LockCurrentState.SECURED],
    ['TEMPORARY_PW_LOCK', LockPushEvent.TEMPORARY_PW_LOCK, Characteristic.LockCurrentState.SECURED],
    ['MANUAL_UNLOCK', LockPushEvent.MANUAL_UNLOCK, Characteristic.LockCurrentState.UNSECURED],
    ['AUTO_UNLOCK', LockPushEvent.AUTO_UNLOCK, Characteristic.LockCurrentState.UNSECURED],
    ['PW_UNLOCK', LockPushEvent.PW_UNLOCK, Characteristic.LockCurrentState.UNSECURED],
    ['FINGERPRINT_UNLOCK', LockPushEvent.FINGERPRINT_UNLOCK, Characteristic.LockCurrentState.UNSECURED],
    ['APP_UNLOCK', LockPushEvent.APP_UNLOCK, Characteristic.LockCurrentState.UNSECURED],
    ['TEMPORARY_PW_UNLOCK', LockPushEvent.TEMPORARY_PW_UNLOCK, Characteristic.LockCurrentState.UNSECURED],
    ['MECHANICAL_ANOMALY', LockPushEvent.MECHANICAL_ANOMALY, Characteristic.LockCurrentState.JAMMED],
    ['LOCK_MECHANICAL_ANOMALY', LockPushEvent.LOCK_MECHANICAL_ANOMALY, Characteristic.LockCurrentState.JAMMED],
    ['DOOR_STATE_ERROR', LockPushEvent.DOOR_STATE_ERROR, Characteristic.LockCurrentState.JAMMED],
  ])('follows the %s announcement to its HomeKit state', (_name, eventType, expected) => {
    const target = accessory();
    const adapter = attach(lockDevice(workingLock()), target)!;
    const current = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockCurrentState);

    expect(adapter.event?.(announced(eventType))).toEqual({ event: 'lock-state', observation: 'valid' });
    expect(current.value).toBe(expected);
  });

  it('pushes the announced state to HomeKit rather than only answering the next read', () => {
    const target = accessory();
    const adapter = attach(lockDevice(workingLock()), target)!;
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const desired = service.getCharacteristic(Characteristic.LockTargetState);
    const pushedCurrent: unknown[] = [];
    const pushedTarget: unknown[] = [];
    current.on('change', ({ newValue }) => pushedCurrent.push(newValue));
    desired.on('change', ({ newValue }) => pushedTarget.push(newValue));

    adapter.event?.(announced(LockPushEvent.KEYPAD_LOCK));
    adapter.event?.(announced(LockPushEvent.MANUAL_UNLOCK));

    expect(
      pushedCurrent,
      'HomeKit subscribes to notifications and otherwise reads only while the Home app is open, so a state that is answered and never pushed shows the old value indefinitely',
    ).toEqual([Characteristic.LockCurrentState.SECURED, Characteristic.LockCurrentState.UNSECURED]);
    expect(pushedTarget, 'the tile would otherwise stay stuck on Locking').toEqual([
      Characteristic.LockTargetState.SECURED,
      Characteristic.LockTargetState.UNSECURED,
    ]);

    adapter.event?.(announced(LockPushEvent.MANUAL_UNLOCK));
    expect(pushedCurrent, 'a repeated announcement is not a change, so it is not a notification').toEqual([
      Characteristic.LockCurrentState.SECURED,
      Characteristic.LockCurrentState.UNSECURED,
    ]);
  });

  it.each([
    ['LOW_POWER', LockPushEvent.LOW_POWER],
    ['LOCK_OFFLINE', LockPushEvent.LOCK_OFFLINE],
    ['DOOR_TAMPER', LockPushEvent.DOOR_TAMPER],
    ['STATUS_CHANGE', LockPushEvent.STATUS_CHANGE],
    ['OTA_STATUS', LockPushEvent.OTA_STATUS],
    ['LOCK_ONLINE', LockPushEvent.LOCK_ONLINE],
  ])('leaves the known state alone for the %s announcement, which carries none', (_name, eventType) => {
    const target = accessory();
    const diagnostics: LockDiagnostic[] = [];
    const adapter = attach(lockDevice(workingLock()), target, (diagnostic) => diagnostics.push(diagnostic))!;
    const current = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockCurrentState);

    adapter.event?.(announced(LockPushEvent.APP_LOCK));
    expect(
      adapter.event?.(announced(eventType)),
      'this member did not report, so there is nothing to record about it',
    ).toBeUndefined();

    expect(current.value, 'this lock is still locked; the announcement was about something else').toBe(
      Characteristic.LockCurrentState.SECURED,
    );
    expect(diagnostics.filter(({ member, active }) => member === 'state' && active)).toEqual([]);
  });

  it('reads every lock push code the SDK names, so a code it has not is a failure and not a guess', () => {
    const unread = Object.values(LockPushEvent)
      .filter((code): code is number => typeof code === 'number')
      .filter((code) => !CLASSIFIED_LOCK_CODES.has(code))
      .map((code) => `${LockPushEvent[code]} (${code})`);

    expect(
      unread,
      'a code this build has not read presents no state, so an SDK that adds one has to be read here rather than silently keep showing the last state',
    ).toEqual([]);
  });

  it.each([
    ['an in-range code this build has not read', 300, 'malformed'],
    ['a code from outside the range the SDK announces', 9999, 'malformed'],
    ['a code that is not a number', 'MANUAL_LOCK', 'malformed'],
    ['no code at all', undefined, 'missing'],
  ])('withdraws the state it can no longer vouch for when %s arrives', (_case, eventType, reason) => {
    const target = accessory();
    const diagnostics: LockDiagnostic[] = [];
    const adapter = attach(lockDevice(workingLock()), target, (diagnostic) => diagnostics.push(diagnostic))!;
    const current = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockCurrentState);

    adapter.event?.(announced(LockPushEvent.APP_LOCK));
    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED);

    expect(adapter.event?.({ eventName: 'lockState', eventType } as never)).toEqual({
      event: 'lock-state',
      observation: reason === 'missing' ? 'missing' : 'malformed',
    });

    expect(
      current.value,
      'something happened to this lock that this build has not read, so the last state is no longer a claim it can make',
    ).toBe(Characteristic.LockCurrentState.UNKNOWN);
    expect(diagnostics).toContainEqual({
      code: 'unusable-lock-announcement',
      capability: 'lock',
      member: 'state',
      active: true,
      reason,
    });
  });

  it('presents no state and says why for a lock whose manifest announces none', async () => {
    const target = accessory();
    const diagnostics: LockDiagnostic[] = [];
    const adapter = attach(
      lockDevice(workingLock()),
      target,
      (diagnostic) => diagnostics.push(diagnostic),
      new Map(LOCK_ADAPTER.requires.map((requirement) => [requirement.id, requirement])),
    )!;
    const current = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockCurrentState);

    expect(
      adapter.event?.(announced(LockPushEvent.APP_LOCK)),
      'the code cannot claim a state from an event this device is not evidenced to send',
    ).toBeUndefined();
    await expect(current.handleGetRequest()).resolves.toBe(Characteristic.LockCurrentState.UNKNOWN);
    expect(
      diagnostics,
      'a lock that announces no state is reported as an unavailable member, not as a fault a later observation could clear',
    ).toContainEqual({
      code: 'lock-capability-unavailable',
      capability: 'lock',
      member: 'state',
      active: true,
      reason: 'missing-evidence',
    });
  });

  it('reports nothing about the announced state until one actually arrives', () => {
    const target = accessory();
    const diagnostics: LockDiagnostic[] = [];
    const observed: string[] = [];
    LOCK_ADAPTER.attach({
      device: lockDevice(workingLock()) as never,
      evidence: LOCK_EVIDENCE as never,
      accessory: target,
      hap: HAP,
      diagnose: (diagnostic) => diagnostics.push(diagnostic as LockDiagnostic),
      observed: (code) => observed.push(code),
      persist: vi.fn(),
    });

    expect(
      diagnostics.filter(({ member }) => member === 'state'),
      'the manifest row says an announcement may come, not that the state is known',
    ).toEqual([]);
    expect(observed).not.toContain('unusable-lock-announcement');
  });

  it('treats the announcement as authoritative over a target this plugin asked for', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const diagnostics: LockDiagnostic[] = [];
    const adapter = attach(lockDevice(workingLock()), target, (diagnostic) => diagnostics.push(diagnostic))!;
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const desired = service.getCharacteristic(Characteristic.LockTargetState);

    await desired.handleSetRequest(Characteristic.LockTargetState.SECURED);
    adapter.event?.(announced(LockPushEvent.MANUAL_UNLOCK));

    expect(current.value, 'someone turned the key the other way').toBe(Characteristic.LockCurrentState.UNSECURED);
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.LockTargetState.UNSECURED);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      diagnostics.filter(({ code, active }) => code === 'lock-reconciliation-expired' && active),
      'the device answered, so there is nothing left unreconciled to report',
    ).toEqual([]);
    await expect(desired.handleGetRequest()).resolves.toBe(Characteristic.LockTargetState.UNSECURED);
    vi.useRealTimers();
  });

  it('keeps the last requested target while presenting a jam', async () => {
    const target = accessory();
    const adapter = attach(lockDevice(workingLock()), target)!;
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const desired = service.getCharacteristic(Characteristic.LockTargetState);

    adapter.event?.(announced(LockPushEvent.APP_LOCK));
    adapter.event?.(announced(LockPushEvent.MECHANICAL_ANOMALY));

    expect(current.value).toBe(Characteristic.LockCurrentState.JAMMED);
    await expect(
      desired.handleGetRequest(),
      'a jam says the bolt did not reach the target, not that the target changed',
    ).resolves.toBe(Characteristic.LockTargetState.SECURED);
  });

  it('presents a jam that arrives before anything established a target, without inventing one', async () => {
    const target = accessory();
    const adapter = attach(lockDevice(workingLock()), target)!;
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;

    adapter.event?.(announced(LockPushEvent.LOCK_MECHANICAL_ANOMALY));

    expect(service.getCharacteristic(Characteristic.LockCurrentState).value).toBe(
      Characteristic.LockCurrentState.JAMMED,
    );
    await expect(
      service.getCharacteristic(Characteristic.LockTargetState).handleGetRequest(),
      'nothing has asked this lock for a state, and a target invented here would read as one the user chose',
    ).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('retains the announced state across the reconciliation that replaces the attachment', async () => {
    const target = accessory();
    const first = attach(lockDevice(workingLock()), target)!;
    first.event?.(announced(LockPushEvent.KEYPAD_LOCK));

    const replacement = attach(lockDevice(workingLock()), target)!;
    first.detach?.('replacement');
    const service = target.getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!;

    expect(replacement).toBeDefined();
    await expect(
      service.getCharacteristic(Characteristic.LockCurrentState).handleGetRequest(),
      'a republished registry is not the lock moving',
    ).resolves.toBe(Characteristic.LockCurrentState.SECURED);
    expect(service.getCharacteristic(Characteristic.LockCurrentState).value).toBe(
      Characteristic.LockCurrentState.SECURED,
    );
  });

  it('ignores an event that is not this lock announcing its state', () => {
    const target = accessory();
    const adapter = attach(lockDevice(workingLock()), target)!;
    const current = target
      .getServiceById(Service.LockMechanism, LOCK_ADAPTER_KEY)!
      .getCharacteristic(Characteristic.LockCurrentState);

    adapter.event?.(announced(LockPushEvent.APP_LOCK));
    expect(adapter.event?.({ eventName: 'motion' } as AnyDeviceEvent)).toBeUndefined();
    expect(current.value).toBe(Characteristic.LockCurrentState.SECURED);
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

  it('reports a lock whose typed operations are absent as an unavailable capability', () => {
    const target = accessory();
    const diagnose = vi.fn();

    expect(attach({ lock: () => ({}) as never }, target, diagnose)).toBeUndefined();

    expect(diagnose).toHaveBeenCalledWith({
      code: 'lock-capability-unavailable',
      capability: 'lock',
      member: 'target',
      active: true,
      reason: 'missing',
    });
  });

  it('reports a lock accessor that throws as an unavailable capability', () => {
    const target = accessory();
    const diagnose = vi.fn();

    expect(
      attach(
        {
          lock: () => {
            throw new Error('synthetic lock accessor fault');
          },
        },
        target,
        diagnose,
      ),
    ).toBeUndefined();

    expect(diagnose).toHaveBeenCalledWith({
      code: 'lock-capability-unavailable',
      capability: 'lock',
      member: 'target',
      active: true,
      reason: 'sdk-fault',
    });
  });
});
