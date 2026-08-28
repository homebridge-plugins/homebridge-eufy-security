import { CapabilityNotSupportedError, LockPushEvent, type AnyDeviceEvent, type LockActions } from '@mega-yfue/eufy-sdk';

import type {
  AdapterAttachmentContext,
  AdapterDiagnostic,
  AdapterEventTrace,
  AttachedAdapter,
  HomeKitAdapter,
} from '../adapter.js';

export const LOCK_ADAPTER_KEY = 'lock.mechanism';

/**
 * The announcement this adapter presents the lock's physical state from.
 *
 * The lock holds no state param worth reading — the SDK's `locked` member sits on a placeholder id with
 * `guessed` provenance and is normally not even installed — so this event is the only evidence of what the
 * bolt did. It is required before any state is presented, so the code cannot claim a state it never receives.
 */
export const LOCK_STATE_EVENT_ROW = 'lock.lockState.event';

const LOCK_ACTION = {
  id: 'lock.lock.momentary-action',
  kind: 'momentary-action',
} as const;
const UNLOCK_ACTION = {
  id: 'lock.unlock.momentary-action',
  kind: 'momentary-action',
} as const;
const OPERATION_DEADLINE_MS = 8_000;
const RECONCILIATION_WINDOW_MS = 60_000;

/** What one announcement says the bolt did, where it says anything about the bolt at all. */
type AnnouncedLockState = 'secured' | 'unsecured' | 'jammed';

/**
 * The HomeKit meaning of each lock push code the SDK names, and only those.
 *
 * The SDK collapses the whole `LockPushEvent` range into one `lockState` event carrying the raw code, so the
 * code is the only thing the announcement says. Translating a named code into a characteristic value is this
 * plugin's own concern — the SDK states what happened, HomeKit decides how a lock is presented — and the
 * names are the evidence being read, not the numbers: `LockPushEvent` states its provenance as cross-checked
 * against the v6 app, so `MANUAL_LOCK` means the deadbolt was thrown by hand.
 *
 * `MECHANICAL_ANOMALY`, `LOCK_MECHANICAL_ANOMALY` and `DOOR_STATE_ERROR` are the jam: the lock reporting that
 * its own mechanism did not do what it was told, which HomeKit has a state for and which must never be
 * rounded to locked.
 *
 * Not verified against a physical lock: this plugin's maintainers have none. That is why every code is
 * carried by name and an unnamed one presents no state at all rather than a plausible meaning.
 */
const ANNOUNCED_LOCK_STATES: ReadonlyMap<number, AnnouncedLockState> = new Map([
  [LockPushEvent.MANUAL_LOCK, 'secured'],
  [LockPushEvent.KEYPAD_LOCK, 'secured'],
  [LockPushEvent.APP_LOCK, 'secured'],
  [LockPushEvent.AUTO_LOCK, 'secured'],
  [LockPushEvent.PW_LOCK, 'secured'],
  [LockPushEvent.FINGER_LOCK, 'secured'],
  [LockPushEvent.TEMPORARY_PW_LOCK, 'secured'],
  [LockPushEvent.MANUAL_UNLOCK, 'unsecured'],
  [LockPushEvent.AUTO_UNLOCK, 'unsecured'],
  [LockPushEvent.PW_UNLOCK, 'unsecured'],
  [LockPushEvent.FINGERPRINT_UNLOCK, 'unsecured'],
  [LockPushEvent.APP_UNLOCK, 'unsecured'],
  [LockPushEvent.TEMPORARY_PW_UNLOCK, 'unsecured'],
  [LockPushEvent.MECHANICAL_ANOMALY, 'jammed'],
  [LockPushEvent.LOCK_MECHANICAL_ANOMALY, 'jammed'],
  [LockPushEvent.DOOR_STATE_ERROR, 'jammed'],
]);

/**
 * The lock push codes this plugin has read and deliberately presents nothing for.
 *
 * A lock reports its battery, its radio, a tamper and its firmware through the same one event, and a lock that
 * has gone offline or been tampered with has not thereby become unlocked, so these leave the presented state
 * exactly as it was.
 *
 * Listed rather than inferred from the absence of a state mapping, so that the two sets together are exhaustive
 * over `LockPushEvent` and a code a later SDK adds is a code this build has not read. A contract test holds
 * that exhaustiveness, which is what makes an unlisted code a loud failure here instead of a silent decision
 * to keep showing a state nobody checked.
 */
const NON_STATE_LOCK_CODES: ReadonlySet<number> = new Set([
  LockPushEvent.LOW_POWER,
  LockPushEvent.VERY_LOW_POWER,
  LockPushEvent.MULTIPLE_ERRORS,
  LockPushEvent.LOCK_OFFLINE,
  LockPushEvent.VIOLENT_DESTRUCTION,
  LockPushEvent.DOOR_OPEN_LEFT,
  LockPushEvent.DOOR_TAMPER,
  LockPushEvent.STATUS_CHANGE,
  LockPushEvent.OTA_STATUS,
  LockPushEvent.LOCK_ONLINE,
]);

/** Every lock push code this build has read, for the contract test that holds the two sets exhaustive. */
export const CLASSIFIED_LOCK_CODES: ReadonlySet<number> = new Set([
  ...ANNOUNCED_LOCK_STATES.keys(),
  ...NON_STATE_LOCK_CODES,
]);

/** The identity-free trace one lock announcement records. */
const LOCK_STATE_TRACE = 'lock-state';

interface LockState {
  owner: symbol;
  actions: LockActions;
  diagnose: (
    code: 'lock-operation-failed' | 'lock-reconciliation-expired',
    active: boolean,
    reason: LockDiagnostic['reason'],
  ) => void;
  writes?: LockTargetWrites;
  /** The last state an announcement established, retained across the reconciliation that replaces a handle. */
  announced?: AnnouncedLockState;
  /** The target that same announcement implies, which a jam does not move. */
  announcedTarget?: 'secured' | 'unsecured';
}

const LOCK_STATES = new WeakMap<object, LockState>();

interface TargetRequest {
  value: number;
  settled: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: unknown): void;
}

interface TargetBatch {
  value: number;
  requests: TargetRequest[];
  abandoned: boolean;
}

/** Serializes physical lock actions while retaining only the newest bounded target projection. */
class LockTargetWrites {
  private active?: TargetBatch;
  private queued?: TargetBatch;
  private reconciliation?: ReturnType<typeof setTimeout>;
  private projection?: number;
  private blockedError?: unknown;
  private detached = false;

  constructor(
    private readonly issue: (value: number) => Promise<void>,
    private readonly communicationFailure: () => unknown,
    private readonly operationFailure: (error: unknown) => unknown,
    private readonly isNonRetryable: (error: unknown) => boolean,
    private readonly diagnose: (
      code: 'lock-operation-failed' | 'lock-reconciliation-expired',
      active: boolean,
      reason: LockDiagnostic['reason'],
    ) => void,
  ) {}

  read(): number | undefined {
    return this.projection;
  }

  /**
   * Settles the window a write opened, because the device has since said what it actually did.
   *
   * A successful command acknowledges delivery and nothing more, so this projection exists only to answer
   * HomeKit until the lock reports. Once it has, the projection is not merely confirmed but superseded — the
   * announcement is authoritative even when it contradicts what was asked for, which is what happens when
   * someone turns the key the other way — and there is nothing left unreconciled to warn about.
   */
  observed(): void {
    if (this.reconciliation) {
      clearTimeout(this.reconciliation);
      this.reconciliation = undefined;
    }
    this.projection = undefined;
  }

  request(value: number): Promise<void> {
    if (this.blockedError) {
      return Promise.reject(this.blockedError);
    }
    this.projection = value;
    return new Promise<void>((resolve, reject) => {
      const request = {
        value,
        settled: false,
        resolve,
        reject,
      };
      if (!this.active) {
        this.start({ value, requests: [request], abandoned: false });
      } else if (this.queued) {
        this.queued.value = value;
        this.queued.requests.push(request);
      } else {
        this.queued = { value, requests: [request], abandoned: false };
      }
    });
  }

  detach(): void {
    this.detached = true;
    if (this.reconciliation) {
      clearTimeout(this.reconciliation);
    }
    for (const request of [...(this.active?.requests ?? []), ...(this.queued?.requests ?? [])]) {
      this.settle(request, 'reject', this.communicationFailure());
    }
    this.active = undefined;
    this.queued = undefined;
    this.projection = undefined;
    this.reconciliation = undefined;
  }

  private start(batch: TargetBatch): void {
    if (this.detached) {
      return;
    }
    if (this.reconciliation) {
      clearTimeout(this.reconciliation);
      this.reconciliation = undefined;
    }
    this.active = batch;
    for (const request of batch.requests) {
      request.deadline = setTimeout(() => this.timeout(request), OPERATION_DEADLINE_MS);
    }
    Promise.resolve()
      .then(() => this.issue(batch.value))
      .then(
        () => this.complete(batch),
        (error) => this.fail(batch, error),
      );
  }

  private complete(batch: TargetBatch): void {
    if (this.active !== batch) {
      return;
    }
    if (batch.abandoned) {
      this.active = undefined;
      this.startQueued();
      return;
    }
    for (const request of batch.requests) {
      this.settle(request, 'resolve');
    }
    this.diagnose('lock-operation-failed', false, 'recovered');
    if (this.projection !== undefined) {
      this.reconciliation = setTimeout(() => {
        this.reconciliation = undefined;
        this.projection = undefined;
        this.diagnose('lock-reconciliation-expired', true, 'expired');
      }, RECONCILIATION_WINDOW_MS);
    }
    this.active = undefined;
    this.startQueued();
  }

  private fail(batch: TargetBatch, cause: unknown): void {
    if (this.active !== batch) {
      return;
    }
    const error = this.operationFailure(cause);
    for (const request of batch.requests) {
      this.settle(request, 'reject', error);
    }
    const nonRetryable = this.isNonRetryable(cause);
    if (nonRetryable) {
      this.blockedError = error;
      for (const request of this.queued?.requests ?? []) {
        this.settle(request, 'reject', error);
      }
      this.queued = undefined;
    }
    this.projection = this.queued?.value;
    if (batch.abandoned && !nonRetryable) {
      this.active = undefined;
      this.startQueued();
      return;
    }
    this.diagnose('lock-operation-failed', true, nonRetryable ? 'capability-not-supported' : 'operation-failure');
    this.active = undefined;
    this.startQueued();
  }

  private timeout(request: TargetRequest): void {
    if (request.settled) {
      return;
    }
    this.settle(request, 'reject', this.communicationFailure());
    this.diagnose('lock-operation-failed', true, 'timeout');
    if (this.active?.requests.every(({ settled }) => settled)) {
      this.active.abandoned = true;
      this.projection = this.queued?.value;
      return;
    }
    if (this.queued) {
      this.queued.requests = this.queued.requests.filter(({ settled }) => !settled);
      if (this.queued.requests.length === 0) {
        this.queued = undefined;
        this.projection = this.active?.value;
      } else {
        this.queued.value = this.queued.requests.at(-1)!.value;
      }
    }
  }

  private startQueued(): void {
    const queued = this.queued;
    this.queued = undefined;
    if (!queued) {
      return;
    }
    queued.requests = queued.requests.filter(({ settled }) => !settled);
    if (queued.requests.length > 0) {
      queued.value = queued.requests.at(-1)!.value;
      this.projection = queued.value;
      this.start(queued);
    }
  }

  private settle(request: TargetRequest, result: 'resolve' | 'reject', error?: unknown): void {
    if (request.settled) {
      return;
    }
    request.settled = true;
    if (request.deadline) {
      clearTimeout(request.deadline);
    }
    if (result === 'resolve') {
      request.resolve();
    } else {
      request.reject(error);
    }
  }
}

/** The typed SDK lock accessor consumed by HomeKit. */
export interface LockSdkDevice {
  lock?: () => LockActions | undefined;
}

/** Structured conditions emitted by the evidence-bounded lock adapter. */
export interface LockDiagnostic extends AdapterDiagnostic {
  code:
    | 'lock-capability-unavailable'
    | 'lock-operation-failed'
    | 'lock-reconciliation-expired'
    | 'unusable-lock-announcement';
  capability: 'lock';
  member: 'target' | 'state';
  active: boolean;
  reason:
    | 'missing'
    | 'malformed'
    | 'missing-evidence'
    | 'sdk-fault'
    | 'operation-failure'
    | 'capability-not-supported'
    | 'timeout'
    | 'expired'
    | 'recovered';
}

const COVERAGE = [
  ...[LOCK_ACTION, UNLOCK_ACTION].map(({ id }) => ({
    id,
    hapFit: 'Lock Mechanism exposes explicit secured and unsecured targets, reconciled by a later announcement',
    identityEffect: 'Primary-purpose service uses stable semantic key lock.mechanism',
    diagnostics: 'Fail closed for unavailable, failed, or unreconciled lock targets',
    verification: [
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'presents no lock state until the SDK announces one, and never from command delivery alone',
      },
      {
        file: 'test/contracts/homekit-reconciler.test.ts',
        behavior: 'represents lock targets only for the exact evidenced T8531 boundary',
      },
    ],
  })),
  {
    id: LOCK_STATE_EVENT_ROW,
    hapFit:
      'Lock Mechanism LockCurrentState follows the pushed lockState announcement, translating only the lock push codes the SDK names: the lock codes to secured, the unlock codes to unsecured, and the mechanism faults to jammed; it is pushed rather than only answered, because HomeKit subscribes to notifications and otherwise reads only while the Home app is open',
    identityEffect: 'Presents state on the same primary-purpose service under the stable semantic key lock.mechanism',
    diagnostics:
      'A code this build cannot name, an announcement carrying no code, and a lock whose manifest announces none each present no state rather than a guessed one, and say which under unusable-lock-announcement; a named code that carries no bolt state leaves the presented state untouched',
    verification: [
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'follows the %s announcement to its HomeKit state',
      },
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'reads every lock push code the SDK names, so a code it has not is a failure and not a guess',
      },
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'pushes the announced state to HomeKit rather than only answering the next read',
      },
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'withdraws the state it can no longer vouch for when %s arrives',
      },
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'presents no state and says why for a lock whose manifest announces none',
      },
      {
        file: 'test/contracts/lock-adapter.test.ts',
        behavior: 'keeps the last requested target while presenting a jam',
      },
      {
        file: 'test/contracts/homekit-reconciler.test.ts',
        behavior: 'the state follows the announcement the SDK pushes',
      },
    ],
  },
];

/** Complete HomeKit policy for the exact evidenced T8531 lock-control boundary. */
export const LOCK_ADAPTER = {
  key: LOCK_ADAPTER_KEY,
  role: 'primary-purpose',
  requiresProduct: { model: 'T8531' },
  requires: [LOCK_ACTION, UNLOCK_ACTION],
  coverage: COVERAGE,
  attach: attachLock,
} as const satisfies HomeKitAdapter;

/**
 * Attaches the lock's controls, and its physical state where the device announces one.
 *
 * The controls and the state are deliberately gated apart: a lock that reports no state announcement is still
 * worth locking from HomeKit, so the two momentary actions admit the accessory and the announcement only
 * decides whether a state is presented beside them.
 */
function attachLock(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as LockSdkDevice;
  let actions: LockActions | undefined;
  try {
    actions = device.lock?.();
  } catch {
    context.diagnose({
      code: 'lock-capability-unavailable',
      capability: 'lock',
      member: 'target',
      active: true,
      reason: 'sdk-fault',
    });
    return undefined;
  }
  if (!actions || typeof actions.lock !== 'function' || typeof actions.unlock !== 'function') {
    context.diagnose({
      code: 'lock-capability-unavailable',
      capability: 'lock',
      member: 'target',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  context.diagnose({
    code: 'lock-capability-unavailable',
    capability: 'lock',
    member: 'target',
    active: false,
    reason: 'recovered',
  });
  context.observed('lock-capability-unavailable');

  const service =
    accessory.getServiceById(hap.Service.LockMechanism, LOCK_ADAPTER_KEY) ??
    accessory.addService(hap.Service.LockMechanism, accessory.displayName, LOCK_ADAPTER_KEY);
  const previousState = LOCK_STATES.get(service);
  const owner = Symbol('lock-owner');
  const state: LockState = previousState ?? {
    owner,
    actions,
    diagnose: () => undefined,
  };
  state.owner = owner;
  state.actions = actions;
  LOCK_STATES.set(service, state);

  const current = service.getCharacteristic(hap.Characteristic.LockCurrentState);
  const target = service.getCharacteristic(hap.Characteristic.LockTargetState);
  const announces = context.evidence.has(LOCK_STATE_EVENT_ROW);
  const diagnoseState = (active: boolean, reason: LockDiagnostic['reason']): void => {
    context.diagnose({ code: 'unusable-lock-announcement', capability: 'lock', member: 'state', active, reason });
    if (!active) {
      context.observed('unusable-lock-announcement');
    }
  };
  if (!announces) {
    state.announced = undefined;
    state.announcedTarget = undefined;
    context.diagnose({
      code: 'lock-capability-unavailable',
      capability: 'lock',
      member: 'state',
      active: true,
      reason: 'missing-evidence',
    });
  }

  const CURRENT_STATE: Readonly<Record<AnnouncedLockState, number>> = {
    secured: hap.Characteristic.LockCurrentState.SECURED,
    unsecured: hap.Characteristic.LockCurrentState.UNSECURED,
    jammed: hap.Characteristic.LockCurrentState.JAMMED,
  };
  const currentValue = (): number =>
    state.announced === undefined ? hap.Characteristic.LockCurrentState.UNKNOWN : CURRENT_STATE[state.announced];
  const targetValue = (): number | undefined =>
    state.announcedTarget === undefined
      ? undefined
      : state.announcedTarget === 'secured'
        ? hap.Characteristic.LockTargetState.SECURED
        : hap.Characteristic.LockTargetState.UNSECURED;
  current.updateValue(currentValue());

  state.diagnose = (
    code: 'lock-operation-failed' | 'lock-reconciliation-expired',
    active: boolean,
    reason: LockDiagnostic['reason'],
  ): void => {
    context.diagnose({ code, capability: 'lock', member: 'target', active, reason });
    if (!active) {
      context.observed(code);
    }
  };
  const communicationFailure = (): InstanceType<typeof hap.HapStatusError> =>
    new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  state.writes ??= new LockTargetWrites(
    (value) => (value === hap.Characteristic.LockTargetState.SECURED ? state.actions.lock() : state.actions.unlock()),
    communicationFailure,
    (error) =>
      new hap.HapStatusError(
        error instanceof CapabilityNotSupportedError
          ? hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
          : hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      ),
    (error) => error instanceof CapabilityNotSupportedError,
    (code, active, reason) => state.diagnose(code, active, reason),
  );

  current.onGet(currentValue);
  /**
   * Answers the target from the newest thing that established one: a write still in flight, else the last
   * settled announcement.
   *
   * Unanswerable until one of those exists, which includes a jam announced before this plugin has seen either
   * — HomeKit's target is what the lock was asked for, and nothing has asked. Left failing closed rather than
   * defaulted, because a target invented here reads in the Home app as a state the user chose.
   */
  target.onGet(() => {
    const requested = state.writes!.read() ?? targetValue();
    if (requested === undefined) {
      throw communicationFailure();
    }
    return requested;
  });
  target.onSet((value) => {
    if (
      value !== hap.Characteristic.LockTargetState.SECURED &&
      value !== hap.Characteristic.LockTargetState.UNSECURED
    ) {
      throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    return state.writes!.request(value as number);
  });

  /**
   * Presents what one announcement established, pushing only what moved.
   *
   * Both characteristics are pushed because HomeKit is not told a value changed unless the accessory says so:
   * a lock that answers reads and never notifies leaves the Home app showing what it last believed, which for
   * a lock is a claim about whether the house is locked. The target follows a settled state as well as the
   * current one, or the tile stays on "Locking…" after someone locks the door with a key.
   */
  const present = (announced: AnnouncedLockState): void => {
    state.announced = announced;
    if (announced !== 'jammed') {
      state.announcedTarget = announced;
    }
    state.writes?.observed();
    const nextCurrent = currentValue();
    if (current.value !== nextCurrent) {
      current.updateValue(nextCurrent);
    }
    const nextTarget = targetValue();
    if (nextTarget !== undefined && target.value !== nextTarget) {
      target.updateValue(nextTarget);
    }
  };

  /**
   * Withdraws a state this plugin can no longer vouch for.
   *
   * Something happened to the lock inside the announced range that this build has not read, so the last state
   * is no longer a claim it can make: HomeKit is told the state is unknown rather than left showing a value
   * that may now be wrong. The target is left alone — an unreadable announcement says nothing about what the
   * lock was asked to do.
   */
  const withdraw = (reason: 'missing' | 'malformed'): void => {
    state.announced = undefined;
    if (current.value !== hap.Characteristic.LockCurrentState.UNKNOWN) {
      current.updateValue(hap.Characteristic.LockCurrentState.UNKNOWN);
    }
    diagnoseState(true, reason);
  };

  return {
    /**
     * Presents what one `lockState` announcement says about the bolt.
     *
     * `eventType` is read as `unknown` rather than as the number it is declared to be, because the SDK folds
     * the raw push body into this payload: the declared type is what the event promises, not what every
     * announcement will carry, and a lock is the wrong accessory on which to trust a shape.
     *
     * A code this build has read and deliberately presents nothing for — a battery warning, a tamper, a
     * firmware update — is not this member reporting at all, so it records no trace and leaves the state
     * alone. Anything else in the range is unread: the state is withdrawn rather than kept, because the
     * announcement was about this lock and this build cannot say what it meant.
     */
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      if (event.eventName !== 'lockState' || !announces) {
        return undefined;
      }
      const code: unknown = event.eventType;
      if (code === undefined) {
        withdraw('missing');
        return { event: LOCK_STATE_TRACE, observation: 'missing' };
      }
      if (typeof code === 'number' && NON_STATE_LOCK_CODES.has(code)) {
        return undefined;
      }
      const announced = typeof code === 'number' ? ANNOUNCED_LOCK_STATES.get(code) : undefined;
      if (announced === undefined) {
        withdraw('malformed');
        return { event: LOCK_STATE_TRACE, observation: 'malformed' };
      }
      present(announced);
      diagnoseState(false, 'recovered');
      return { event: LOCK_STATE_TRACE, observation: 'valid' };
    },
    detach(): void {
      if (LOCK_STATES.get(service)?.owner !== owner) {
        return;
      }
      state.writes?.detach();
      LOCK_STATES.delete(service);
      accessory.removeService(service);
    },
  };
}
