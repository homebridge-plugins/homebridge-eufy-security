import { CapabilityNotSupportedError } from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext } from './adapter.js';

/**
 * How long one HomeKit-initiated SDK operation is given before HomeKit is told it failed.
 *
 * HomeKit expects a write to be answered promptly, and an SDK operation reaches a device over a session
 * that may be asleep, so the bound exists to answer HomeKit rather than to bound the device: the operation
 * itself is not cancelled, and the authoritative observation still decides what the characteristic reads
 * afterwards.
 */
export const OPERATION_DEADLINE_MS = 8_000;

/** The diagnostic code every bounded camera-control operation failure is reported under. */
export const OPERATION_FAILED_CONDITION = 'camera-control-operation-failed';

/** The diagnostic code an authoritative observation this plugin cannot read is reported under. */
export const INVALID_OBSERVATION_CONDITION = 'invalid-camera-control-observation';

const OPERATION_TIMEOUT = Symbol('camera-control-operation-timeout');

/**
 * The announcements both camera bundles follow for the camera's power, and what each one means happened.
 *
 * `cameraEnabledChanged` is the SDK reflecting a write this plugin issued; `cameraEnabled` is a cloud poll
 * seeing the value move, which means something other than this plugin changed it — the vendor app, or a
 * physical switch. Declared here because both bundles act on the same two events: one ends a session watching
 * a camera that just went off, the other keeps its switch honest, and a copy beside either would drift.
 */
export const ENABLEMENT_ANNOUNCEMENTS: Readonly<Record<string, 'write' | 'poll'>> = {
  cameraEnabledChanged: 'write',
  cameraEnabled: 'poll',
};

/** Operation lifetime retained across adapter replacement, so a write in flight survives reconciliation. */
export interface DeviceOperationState {
  owner: symbol;
  activeOperations: Map<string, Promise<void>>;
  blockedOperations: Set<string>;
}

/**
 * Issues one persistent HomeKit-initiated SDK operation under bounded, single-flight discipline.
 *
 * Every camera control HomeKit can write shares this, because they share the same three hazards: a device
 * that never answers, a member this device does not support at all, and a HomeKit value that must not be
 * left claiming a state the device never reached. A successful command acknowledges delivery and nothing
 * more, so the caller's `restore` re-reads the authoritative observation once the operation settles.
 *
 * A member whose operation the SDK refuses as unsupported is latched, so a camera that cannot do something
 * is asked exactly once rather than on every HomeKit write, and the refusal is reported once as well.
 */
export interface DeviceOperationIssuer {
  (capability: string, member: string, operation: () => Promise<void>, restore: () => void): Promise<void>;
}

/**
 * Builds that issuer for one attachment, bound to the operation lifetime the attachment retains and to the
 * ownership test that decides whether this attachment is still the one HomeKit is talking to.
 */
export function deviceOperationIssuer({
  context,
  state,
  owned,
  detached,
  detachRejectors,
}: {
  readonly context: Pick<AdapterAttachmentContext, 'diagnose' | 'hap'>;
  readonly state: DeviceOperationState;
  /** Whether this attachment still owns the operation state, which a replacement takes over. */
  readonly owned: () => boolean;
  readonly detached: () => boolean;
  /** Rejectors woken when the attachment detaches, so a pending write does not outlive it. */
  readonly detachRejectors: Set<(error: unknown) => void>;
}): DeviceOperationIssuer {
  const { hap } = context;
  return async (capability, member, operation, restore) => {
    const key = `${capability}.${member}`;
    if (state.blockedOperations.has(key)) {
      throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    if (state.activeOperations.has(key)) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const operationPromise = Promise.resolve().then(operation);
    state.activeOperations.set(key, operationPromise);
    void operationPromise.then(
      () => state.activeOperations.delete(key),
      (error) => {
        state.activeOperations.delete(key);
        if (error instanceof CapabilityNotSupportedError) {
          state.blockedOperations.add(key);
        }
      },
    );
    let rejectDetached!: (error: unknown) => void;
    const detachedPromise = new Promise<never>((_, reject) => {
      rejectDetached = reject;
    });
    detachRejectors.add(rejectDetached);
    try {
      await Promise.race([
        operationPromise,
        detachedPromise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(OPERATION_TIMEOUT), OPERATION_DEADLINE_MS);
        }),
      ]);
      if (!detached() && owned()) {
        context.diagnose({
          code: OPERATION_FAILED_CONDITION,
          capability,
          member,
          active: false,
          reason: 'recovered',
        });
        queueMicrotask(() => {
          if (!detached() && owned()) {
            restore();
          }
        });
      }
    } catch (error) {
      const unsupported = error instanceof CapabilityNotSupportedError;
      if (unsupported) {
        state.blockedOperations.add(key);
      }
      if (!detached() && owned()) {
        context.diagnose({
          code: OPERATION_FAILED_CONDITION,
          capability,
          member,
          active: true,
          reason: unsupported
            ? 'capability-not-supported'
            : error === OPERATION_TIMEOUT
              ? 'timeout'
              : 'operation-failure',
        });
      }
      throw new hap.HapStatusError(
        unsupported ? hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE : hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    } finally {
      detachRejectors.delete(rejectDetached);
      if (deadline) {
        clearTimeout(deadline);
      }
    }
  };
}

/**
 * Reads one authoritative SDK observation for a HomeKit characteristic, failing closed.
 *
 * A camera control answers HomeKit from the device's own reading, so a reading that is absent, of another
 * shape, or faults must make HomeKit show no response rather than borrow a plausible value from somewhere
 * else: a guessed control state is a control the user cannot trust. Each outcome is reported once under its
 * own reason, and a later readable value withdraws it.
 *
 * The expected shape is stated by the caller rather than inferred, because the SDK stores an enum member as
 * a number and a caller that accepted whatever arrived would present one member's value under another
 * member's meaning.
 */
export function observationReader<T extends 'boolean' | 'number'>(
  context: Pick<AdapterAttachmentContext, 'diagnose' | 'hap'>,
  expected: T,
): (capability: string, member: string, read: () => unknown) => T extends 'boolean' ? boolean : number {
  const { hap } = context;
  return (capability, member, read) => {
    let value: unknown;
    try {
      value = read();
    } catch {
      context.diagnose({
        code: INVALID_OBSERVATION_CONDITION,
        capability,
        member,
        active: true,
        reason: 'sdk-fault',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (typeof value !== expected || (expected === 'number' && !Number.isFinite(value))) {
      context.diagnose({
        code: INVALID_OBSERVATION_CONDITION,
        capability,
        member,
        active: true,
        reason: value === undefined ? 'missing' : 'malformed',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    context.diagnose({
      code: INVALID_OBSERVATION_CONDITION,
      capability,
      member,
      active: false,
      reason: 'recovered',
    });
    return value as T extends 'boolean' ? boolean : number;
  };
}
