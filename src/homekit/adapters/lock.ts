import { CapabilityNotSupportedError, type LockActions } from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext, AdapterDiagnostic, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const LOCK_ADAPTER_KEY = 'lock.mechanism';

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

interface LockState {
  owner: symbol;
  actions: LockActions;
  diagnose: (
    code: 'lock-operation-failed' | 'lock-reconciliation-expired',
    active: boolean,
    reason: LockDiagnostic['reason'],
  ) => void;
  writes?: LockTargetWrites;
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
    this.reconciliation = setTimeout(() => {
      this.reconciliation = undefined;
      this.projection = undefined;
      this.diagnose('lock-reconciliation-expired', true, 'expired');
    }, RECONCILIATION_WINDOW_MS);
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
  code: 'lock-capability-unavailable' | 'lock-operation-failed' | 'lock-reconciliation-expired';
  capability: 'lock';
  member: 'target';
  active: boolean;
  reason:
    'missing' | 'sdk-fault' | 'operation-failure' | 'capability-not-supported' | 'timeout' | 'expired' | 'recovered';
}

const COVERAGE = [LOCK_ACTION, UNLOCK_ACTION].map(({ id }) => ({
  id,
  hapFit: 'Lock Mechanism exposes explicit secured and unsecured targets without fabricating current state',
  identityEffect: 'Primary-purpose service uses stable semantic key lock.mechanism',
  diagnostics: 'Fail closed for unavailable, failed, or unreconciled lock targets',
  verification: [
    {
      file: 'test/contracts/lock-adapter.test.ts',
      behavior: 'exposes lock and unlock targets while current remains unknown after command delivery',
    },
    {
      file: 'test/contracts/homekit-reconciler.test.ts',
      behavior: 'represents lock targets only for the exact evidenced T8531 boundary',
    },
  ],
}));

/** Complete HomeKit policy for the exact evidenced T8531 lock-control boundary. */
export const LOCK_ADAPTER = {
  key: LOCK_ADAPTER_KEY,
  role: 'primary-purpose',
  requiresProduct: { model: 'T8531' },
  requires: [LOCK_ACTION, UNLOCK_ACTION],
  coverage: COVERAGE,
  attach: attachLock,
} as const satisfies HomeKitAdapter;

/** Attaches target-only lock controls while physical state remains unknown without admitted evidence. */
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
  current.updateValue(hap.Characteristic.LockCurrentState.UNKNOWN);

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

  current.onGet(() => hap.Characteristic.LockCurrentState.UNKNOWN);
  target.onGet(() => {
    const projection = state.writes!.read();
    if (projection === undefined) {
      throw communicationFailure();
    }
    return projection;
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

  return {
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
