import { ArmingMode, CapabilityNotSupportedError, type ArmingActions } from '@mega-yfue/eufy-sdk';

import type {
  AdapterAttachmentContext,
  AdapterDiagnostic,
  AdapterEventTrace,
  AttachedAdapter,
  HomeKitAdapter,
} from '../adapter.js';

export const SECURITY_SYSTEM_ADAPTER_KEY = 'arming.security-system';

interface SecuritySystemState {
  owner: symbol;
  arming: ArmingActions;
  alarmTriggered: boolean;
  unsupportedFault: boolean;
  operationFault: boolean;
  reconciliationFault: boolean;
  writes?: SecurityModeWrites;
}

const SECURITY_SYSTEM_STATES = new WeakMap<object, SecuritySystemState>();

const ARMING_MODE_READ = {
  id: 'arming.mode.read',
  kind: 'read',
  type: 'enum',
  writable: true,
} as const;
const ARMING_MODE_WRITE = {
  id: 'arming.mode.persistent-operation',
  kind: 'persistent-operation',
} as const;
const ARMING_MODE_EVENT = {
  id: 'arming.armingModeChanged.event',
  kind: 'event',
} as const;
const ARMING_ALARM_EVENT = {
  id: 'arming.alarm.event',
  kind: 'event',
} as const;

const OPERATION_DEADLINE_MS = 8_000;
const RECONCILIATION_WINDOW_MS = 60_000;

interface ModeRequest {
  value: number;
  settled: boolean;
  deadline: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: unknown): void;
}

interface ModeBatch {
  value: number;
  requests: ModeRequest[];
  reconciled: boolean;
  abandoned: boolean;
}

/** Serializes arming writes while exposing only a bounded target projection. */
class SecurityModeWrites {
  private active?: ModeBatch;
  private queued?: ModeBatch;
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
      condition: 'operation' | 'reconciliation',
      active: boolean,
      reason: 'operation-failure' | 'capability-not-supported' | 'timeout' | 'expired' | 'recovered',
    ) => void,
    private readonly restore: () => void,
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
        deadline: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve,
        reject,
      };
      request.deadline = setTimeout(() => this.timeout(request), OPERATION_DEADLINE_MS);
      if (!this.active) {
        this.start({ value, requests: [request], reconciled: false, abandoned: false });
      } else if (this.queued) {
        this.queued.value = value;
        this.queued.reconciled = false;
        this.queued.requests.push(request);
      } else {
        this.queued = { value, requests: [request], reconciled: false, abandoned: false };
      }
    });
  }

  observe(): void {
    if (this.active) {
      this.active.reconciled = true;
    }
    if (this.queued) {
      this.queued.reconciled = true;
    }
    this.projection = undefined;
    if (this.reconciliation) {
      clearTimeout(this.reconciliation);
      this.reconciliation = undefined;
    }
    if (!this.blockedError) {
      this.diagnose('operation', false, 'recovered');
    }
    this.diagnose('reconciliation', false, 'recovered');
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

  private start(batch: ModeBatch): void {
    if (this.detached) {
      return;
    }
    if (this.reconciliation) {
      clearTimeout(this.reconciliation);
      this.reconciliation = undefined;
    }
    this.active = batch;
    Promise.resolve()
      .then(() => this.issue(batch.value))
      .then(
        () => this.complete(batch),
        (error) => this.fail(batch, error),
      );
  }

  private complete(batch: ModeBatch): void {
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
    this.diagnose('operation', false, 'recovered');
    if (!batch.reconciled) {
      this.reconciliation = setTimeout(() => {
        this.reconciliation = undefined;
        this.projection = undefined;
        this.restore();
        this.diagnose('reconciliation', true, 'expired');
      }, RECONCILIATION_WINDOW_MS);
    }
    this.active = undefined;
    this.startQueued();
  }

  private fail(batch: ModeBatch, cause: unknown): void {
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
    this.restore();
    if (batch.abandoned && !nonRetryable) {
      this.active = undefined;
      this.startQueued();
      return;
    }
    this.diagnose('operation', true, nonRetryable ? 'capability-not-supported' : 'operation-failure');
    this.active = undefined;
    this.startQueued();
  }

  private timeout(request: ModeRequest): void {
    if (request.settled) {
      return;
    }
    this.settle(request, 'reject', this.communicationFailure());
    this.diagnose('operation', true, 'timeout');
    if (this.active?.requests.every(({ settled }) => settled)) {
      this.active.abandoned = true;
      this.projection = this.queued?.value;
      this.restore();
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
      this.projection = queued.reconciled ? undefined : queued.value;
      this.start(queued);
    }
  }

  private settle(request: ModeRequest, result: 'resolve' | 'reject', error?: unknown): void {
    if (request.settled) {
      return;
    }
    request.settled = true;
    clearTimeout(request.deadline);
    if (result === 'resolve') {
      request.resolve();
    } else {
      request.reject(error);
    }
  }
}

/** The typed SDK arming accessor consumed by HomeKit. */
export interface SecuritySystemSdkDevice {
  arming?: () => ArmingActions | undefined;
}

/** Structured conditions emitted by the security-system adapter. */
export interface SecuritySystemDiagnostic extends AdapterDiagnostic {
  code:
    | 'arming-capability-unavailable'
    | 'unsupported-arming-mode'
    | 'arming-operation-failed'
    | 'arming-reconciliation-expired';
  capability: 'arming';
  member: 'mode' | 'alarm';
  active: boolean;
  reason:
    | 'missing'
    | 'malformed'
    | 'unsupported'
    | 'sdk-fault'
    | 'operation-failure'
    | 'capability-not-supported'
    | 'timeout'
    | 'expired'
    | 'recovered';
}

const COVERAGE = [ARMING_MODE_READ, ARMING_MODE_WRITE, ARMING_MODE_EVENT, ARMING_ALARM_EVENT].map(({ id }) => ({
  id,
  hapFit: 'Security System exposes explicit Stay, Away, Disarm, and alarm state',
  identityEffect: 'Primary-purpose service uses stable semantic key arming.security-system',
  diagnostics: 'Fail closed for unavailable, unsupported, failed, or unreconciled arming state',
  verification: [
    {
      file: 'test/contracts/security-system-adapter.test.ts',
      behavior: 'maps authoritative Home, Away, and Disarmed modes and exposes only those targets',
    },
    {
      file: 'test/contracts/homekit-reconciler.test.ts',
      behavior: 'routes arming events and withdraws the stable Security System service only from complete evidence',
    },
  ],
}));

/** Complete HomeKit policy for evidenced arming modes and alarm events. */
export const SECURITY_SYSTEM_ADAPTER = {
  key: SECURITY_SYSTEM_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [ARMING_MODE_READ, ARMING_MODE_WRITE, ARMING_MODE_EVENT, ARMING_ALARM_EVENT],
  coverage: COVERAGE,
  attach: attachSecuritySystem,
} as const satisfies HomeKitAdapter;

/** Attaches authoritative arming state to one official Security System service. */
function attachSecuritySystem(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as SecuritySystemSdkDevice;
  let arming: ArmingActions | undefined;
  try {
    arming = device.arming?.();
  } catch {
    context.diagnose({
      code: 'arming-capability-unavailable',
      capability: 'arming',
      member: 'mode',
      active: true,
      reason: 'sdk-fault',
    });
    return undefined;
  }
  if (!arming || typeof arming.setMode !== 'function') {
    context.diagnose({
      code: 'arming-capability-unavailable',
      capability: 'arming',
      member: 'mode',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  context.diagnose({
    code: 'arming-capability-unavailable',
    capability: 'arming',
    member: 'mode',
    active: false,
    reason: 'recovered',
  });
  context.observed('arming-capability-unavailable');

  const service =
    accessory.getServiceById(hap.Service.SecuritySystem, SECURITY_SYSTEM_ADAPTER_KEY) ??
    accessory.addService(hap.Service.SecuritySystem, accessory.displayName, SECURITY_SYSTEM_ADAPTER_KEY);
  const previousState = SECURITY_SYSTEM_STATES.get(service);
  const owner = Symbol('security-system-owner');
  const state: SecuritySystemState = previousState ?? {
    owner,
    arming,
    alarmTriggered: false,
    unsupportedFault: false,
    operationFault: false,
    reconciliationFault: false,
  };
  state.owner = owner;
  state.arming = arming;
  SECURITY_SYSTEM_STATES.set(service, state);
  const current = service.getCharacteristic(hap.Characteristic.SecuritySystemCurrentState);
  const target = service.getCharacteristic(hap.Characteristic.SecuritySystemTargetState);
  const statusFault = service.getCharacteristic(hap.Characteristic.StatusFault);
  service.addOptionalCharacteristic(hap.Characteristic.SecuritySystemAlarmType);
  const alarmType = service.getCharacteristic(hap.Characteristic.SecuritySystemAlarmType);
  target.setProps({
    validValues: [
      hap.Characteristic.SecuritySystemTargetState.STAY_ARM,
      hap.Characteristic.SecuritySystemTargetState.AWAY_ARM,
      hap.Characteristic.SecuritySystemTargetState.DISARM,
    ],
  });

  const homeKitMode = (value: unknown): number | undefined => {
    if (value === 1) {
      return hap.Characteristic.SecuritySystemCurrentState.STAY_ARM;
    }
    if (value === 0) {
      return hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }
    if (value === 63) {
      return hap.Characteristic.SecuritySystemCurrentState.DISARMED;
    }
    return undefined;
  };
  const sdkMode = (value: unknown): ArmingMode => {
    if (value === hap.Characteristic.SecuritySystemTargetState.STAY_ARM) {
      return ArmingMode.home;
    }
    if (value === hap.Characteristic.SecuritySystemTargetState.AWAY_ARM) {
      return ArmingMode.away;
    }
    if (value === hap.Characteristic.SecuritySystemTargetState.DISARM) {
      return ArmingMode.disarmed;
    }
    throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
  };

  const updateStatusFault = (): void => {
    statusFault.updateValue(
      state.unsupportedFault || state.operationFault || state.reconciliationFault
        ? hap.Characteristic.StatusFault.GENERAL_FAULT
        : hap.Characteristic.StatusFault.NO_FAULT,
    );
  };
  const diagnoseMode = (
    active: boolean,
    reason: 'missing' | 'malformed' | 'unsupported' | 'sdk-fault' | 'recovered',
  ) => {
    state.unsupportedFault = active;
    context.diagnose({
      code: 'unsupported-arming-mode',
      capability: 'arming',
      member: 'mode',
      active,
      reason,
    });
    updateStatusFault();
    if (!active) {
      context.observed('unsupported-arming-mode');
    }
  };
  const readMode = (): number => {
    let value: unknown;
    try {
      value = state.arming.mode;
    } catch {
      diagnoseMode(true, 'sdk-fault');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const mapped = homeKitMode(value);
    if (mapped === undefined) {
      diagnoseMode(true, value === undefined ? 'missing' : typeof value === 'number' ? 'unsupported' : 'malformed');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    diagnoseMode(false, 'recovered');
    return mapped;
  };
  const observeMode = (): AdapterEventTrace => {
    try {
      const value = readMode();
      state.alarmTriggered = false;
      state.writes?.observe();
      current.updateValue(value);
      target.updateValue(value);
      alarmType.updateValue(hap.Characteristic.SecuritySystemAlarmType.NO_ALARM);
      return { event: 'arming-mode-changed', observation: 'valid' };
    } catch {
      return { event: 'arming-mode-changed', observation: 'malformed' };
    }
  };

  state.writes ??= new SecurityModeWrites(
    (value) => state.arming.setMode(sdkMode(value)),
    () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
    (error) =>
      new hap.HapStatusError(
        error instanceof CapabilityNotSupportedError
          ? hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
          : hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      ),
    (error) => error instanceof CapabilityNotSupportedError,
    (condition, active, reason) => {
      const code = condition === 'operation' ? 'arming-operation-failed' : 'arming-reconciliation-expired';
      if (condition === 'operation') {
        state.operationFault = active;
      } else {
        state.reconciliationFault = active;
      }
      updateStatusFault();
      context.diagnose({ code, capability: 'arming', member: 'mode', active, reason });
      if (!active) {
        context.observed(code);
      }
    },
    () => {
      try {
        target.updateValue(readMode());
      } catch {}
    },
  );
  updateStatusFault();
  observeMode();
  current.onGet(() =>
    state.alarmTriggered ? hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED : readMode(),
  );
  target.onGet(() => {
    const observed = readMode();
    return state.writes!.read() ?? observed;
  });
  target.onSet((value) => {
    sdkMode(value);
    target.updateValue(value);
    return state.writes!.request(value as number);
  });

  return {
    event(event): AdapterEventTrace | undefined {
      if (event.eventName === 'armingModeChanged') {
        return observeMode();
      }
      if (event.eventName !== 'alarm') {
        return undefined;
      }
      if (event.phase !== 'delayed' && event.phase !== 'triggered') {
        return { event: 'security-system-alarm', observation: event.phase === undefined ? 'missing' : 'malformed' };
      }
      state.alarmTriggered = true;
      current.updateValue(hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
      alarmType.updateValue(hap.Characteristic.SecuritySystemAlarmType.UNKNOWN);
      return { event: 'security-system-alarm', observation: 'valid' };
    },
    detach(): void {
      if (SECURITY_SYSTEM_STATES.get(service)?.owner !== owner) {
        return;
      }
      state.writes?.detach();
      SECURITY_SYSTEM_STATES.delete(service);
      accessory.removeService(service);
    },
  };
}
