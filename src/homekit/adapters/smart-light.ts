import { CapabilityNotSupportedError, type AnyDeviceEvent, type SmartLightActions } from '@mega-yfue/eufy-sdk';

import type {
  AdapterAttachmentContext,
  AdapterDiagnostic,
  AdapterEventTrace,
  AttachedAdapter,
  HomeKitAdapter,
} from '../adapter.js';

export const SMART_LIGHT_ADAPTER_KEY = 'smart-light.lightbulb';

const SMART_LIGHT_POWER_READ = {
  id: 'smart_light.power.read',
  kind: 'read',
  type: 'bool',
  writable: true,
} as const;
const SMART_LIGHT_POWER_WRITE = {
  id: 'smart_light.power.persistent-operation',
  kind: 'persistent-operation',
} as const;
const SMART_LIGHT_BRIGHTNESS_READ = {
  id: 'smart_light.brightness.read',
  kind: 'read',
  type: 'number',
  writable: true,
} as const;
const SMART_LIGHT_BRIGHTNESS_WRITE = {
  id: 'smart_light.brightness.persistent-operation',
  kind: 'persistent-operation',
} as const;
const SMART_LIGHT_STATE_EVENT = {
  id: 'smart_light.smartLightState.event',
  kind: 'event',
} as const;

interface SmartLightState {
  owner: symbol;
  power?: boolean;
  brightness?: number;
  invalidPower: boolean;
  invalidBrightness: boolean;
  powerBlocked: boolean;
  brightnessBlocked: boolean;
  powerWrites?: PersistentMemberWrites<boolean>;
  brightnessWrites?: PersistentMemberWrites<number>;
}

const SMART_LIGHT_STATES = new WeakMap<object, SmartLightState>();

/** The typed SDK smart-light accessor consumed by HomeKit. */
export interface SmartLightSdkDevice {
  smartLight?: () => SmartLightActions | undefined;
}

/** Structured conditions emitted by the smart-light adapter. */
export interface SmartLightDiagnostic extends AdapterDiagnostic {
  code:
    | 'smart-light-capability-unavailable'
    | 'invalid-smart-light-observation'
    | 'smart-light-operation-failed'
    | 'smart-light-reconciliation-expired';
  capability: 'smart_light';
  member: 'power' | 'brightness';
  active: boolean;
  reason:
    | 'missing'
    | 'malformed'
    | 'sdk-fault'
    | 'operation-failure'
    | 'capability-not-supported'
    | 'timeout'
    | 'expired'
    | 'recovered';
}

interface WriteRequest<T> {
  generation: number;
  value: T;
  settled: boolean;
  deadline: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: unknown): void;
}

interface WriteBatch<T> {
  generation: number;
  value: T;
  requests: WriteRequest<T>[];
  reconciled: boolean;
}

const OPERATION_DEADLINE_MS = 8_000;
const RECONCILIATION_WINDOW_MS = 60_000;

/** Serializes one persistent member while keeping operation acknowledgement separate from observation. */
class PersistentMemberWrites<T> {
  private generation = 0;
  private active?: WriteBatch<T>;
  private queued?: WriteBatch<T>;
  private reconciliation?: ReturnType<typeof setTimeout>;
  private blockedError?: unknown;
  private detached = false;

  constructor(
    private readonly issue: (value: T) => Promise<void>,
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

  request(value: T): Promise<void> {
    if (this.blockedError) {
      return Promise.reject(this.blockedError);
    }
    const generation = ++this.generation;
    return new Promise<void>((resolve, reject) => {
      const request = {
        generation,
        value,
        settled: false,
        deadline: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve,
        reject,
      };
      request.deadline = setTimeout(() => this.timeout(request), OPERATION_DEADLINE_MS);
      if (!this.active) {
        this.start({ generation, value, requests: [request], reconciled: false });
        return;
      }
      if (this.queued) {
        this.queued.generation = generation;
        this.queued.value = value;
        this.queued.reconciled = false;
        this.queued.requests.push(request);
      } else {
        this.queued = { generation, value, requests: [request], reconciled: false };
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
    this.reconciliation = undefined;
  }

  private start(batch: WriteBatch<T>): void {
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

  private complete(batch: WriteBatch<T>): void {
    if (this.active !== batch) {
      return;
    }
    for (const request of batch.requests) {
      this.settle(request, 'resolve');
    }
    this.diagnose('operation', false, 'recovered');
    if (!batch.reconciled) {
      this.reconciliation = setTimeout(() => {
        this.reconciliation = undefined;
        this.diagnose('reconciliation', true, 'expired');
      }, RECONCILIATION_WINDOW_MS);
    }
    this.active = undefined;
    queueMicrotask(this.restore);
    this.startQueued();
  }

  private fail(batch: WriteBatch<T>, cause: unknown): void {
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
    this.diagnose('operation', true, nonRetryable ? 'capability-not-supported' : 'operation-failure');
    this.active = undefined;
    queueMicrotask(this.restore);
    this.startQueued();
  }

  private timeout(request: WriteRequest<T>): void {
    if (request.settled) {
      return;
    }
    this.settle(request, 'reject', this.communicationFailure());
    this.diagnose('operation', true, 'timeout');
    if (this.active?.requests.every(({ settled }) => settled)) {
      this.active = undefined;
      queueMicrotask(this.restore);
      this.startQueued();
      return;
    }
    if (this.queued) {
      this.queued.requests = this.queued.requests.filter(({ settled }) => !settled);
      if (this.queued.requests.length === 0) {
        this.queued = undefined;
      } else {
        const newest = this.queued.requests.at(-1)!;
        this.queued.generation = newest.generation;
        this.queued.value = newest.value;
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
      const newest = queued.requests.at(-1)!;
      queued.generation = newest.generation;
      queued.value = newest.value;
      this.start(queued);
    }
  }

  private settle(request: WriteRequest<T>, result: 'resolve' | 'reject', error?: unknown): void {
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

const COVERAGE = [
  SMART_LIGHT_POWER_READ,
  SMART_LIGHT_POWER_WRITE,
  SMART_LIGHT_BRIGHTNESS_READ,
  SMART_LIGHT_BRIGHTNESS_WRITE,
  SMART_LIGHT_STATE_EVENT,
].map(({ id }) => ({
  id,
  hapFit: 'Lightbulb On and Brightness expose authoritative smart-light state and evidenced persistent operations',
  identityEffect: 'Primary-purpose service uses stable semantic key smart-light.lightbulb',
  diagnostics: 'Fail closed for unavailable, malformed, failed, or unreconciled smart-light members',
  verification: [
    {
      file: 'test/contracts/smart-light-adapter.test.ts',
      behavior: 'exposes authoritative power and brightness through one real HAP Lightbulb',
    },
  ],
}));

/** Complete HomeKit policy for evidenced Life smart-light power and brightness. */
export const SMART_LIGHT_ADAPTER = {
  key: SMART_LIGHT_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [
    SMART_LIGHT_POWER_READ,
    SMART_LIGHT_POWER_WRITE,
    SMART_LIGHT_BRIGHTNESS_READ,
    SMART_LIGHT_BRIGHTNESS_WRITE,
    SMART_LIGHT_STATE_EVENT,
  ],
  coverage: COVERAGE,
  attach: attachSmartLight,
} as const satisfies HomeKitAdapter;

/** Attaches authoritative power and configured brightness to one official Lightbulb service. */
function attachSmartLight(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as SmartLightSdkDevice;
  let light: SmartLightActions | undefined;
  try {
    light = device.smartLight?.();
  } catch {
    context.diagnose({
      code: 'smart-light-capability-unavailable',
      capability: 'smart_light',
      member: 'power',
      active: true,
      reason: 'sdk-fault',
    });
    return undefined;
  }
  if (!light || typeof light.set !== 'function' || typeof light.setBrightness !== 'function') {
    context.diagnose({
      code: 'smart-light-capability-unavailable',
      capability: 'smart_light',
      member: !light || typeof light.set !== 'function' ? 'power' : 'brightness',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  const service =
    accessory.getServiceById(hap.Service.Lightbulb, SMART_LIGHT_ADAPTER_KEY) ??
    accessory.addService(hap.Service.Lightbulb, accessory.displayName, SMART_LIGHT_ADAPTER_KEY);
  const previousState = SMART_LIGHT_STATES.get(service);
  for (const member of ['power', 'brightness'] as const) {
    context.diagnose({
      code: 'smart-light-capability-unavailable',
      capability: 'smart_light',
      member,
      active: false,
      reason: 'recovered',
    });
    const codes = previousState?.[member === 'power' ? 'powerBlocked' : 'brightnessBlocked']
      ? (['smart-light-reconciliation-expired'] as const)
      : (['smart-light-operation-failed', 'smart-light-reconciliation-expired'] as const);
    for (const code of codes) {
      context.diagnose({
        code,
        capability: 'smart_light',
        member,
        active: false,
        reason: 'recovered',
      });
      context.observed(code);
    }
  }
  service.addOptionalCharacteristic(hap.Characteristic.Brightness);
  const state: SmartLightState = {
    owner: Symbol('smart-light-owner'),
    invalidPower: false,
    invalidBrightness: false,
    powerBlocked: previousState?.powerBlocked ?? false,
    brightnessBlocked: previousState?.brightnessBlocked ?? false,
  };
  SMART_LIGHT_STATES.set(service, state);
  const power = service.getCharacteristic(hap.Characteristic.On);
  const brightness = service.getCharacteristic(hap.Characteristic.Brightness);

  const diagnoseObservation = (
    member: 'power' | 'brightness',
    active: boolean,
    reason: 'missing' | 'malformed' | 'sdk-fault' | 'recovered',
  ): void => {
    context.diagnose({
      code: 'invalid-smart-light-observation',
      capability: 'smart_light',
      member,
      active,
      reason,
    });
    if (!active) {
      context.observed('invalid-smart-light-observation');
    }
  };

  const read = (member: 'power' | 'brightness'): boolean | number => {
    let value: unknown;
    try {
      value = state[member] ?? light[member];
    } catch {
      diagnoseObservation(member, true, 'sdk-fault');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const valid =
      member === 'power'
        ? typeof value === 'boolean'
        : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
    if (state[member === 'power' ? 'invalidPower' : 'invalidBrightness'] || !valid) {
      diagnoseObservation(member, true, value === undefined ? 'missing' : 'malformed');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    diagnoseObservation(member, false, 'recovered');
    return value as boolean | number;
  };

  power.onGet(() => read('power'));
  brightness.onGet(() => read('brightness'));

  const writes = <T>(
    member: 'power' | 'brightness',
    issue: (value: T) => Promise<void>,
    restore: () => void,
  ): PersistentMemberWrites<T> =>
    new PersistentMemberWrites(
      issue,
      () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      (error) =>
        new hap.HapStatusError(
          error instanceof CapabilityNotSupportedError
            ? hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
            : hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        ),
      (error) => error instanceof CapabilityNotSupportedError,
      (condition, active, reason) => {
        const code =
          condition === 'reconciliation' ? 'smart-light-reconciliation-expired' : 'smart-light-operation-failed';
        if (condition === 'operation') {
          const blocked = member === 'power' ? 'powerBlocked' : 'brightnessBlocked';
          if (active && reason === 'capability-not-supported') {
            state[blocked] = true;
          } else if (!active) {
            state[blocked] = false;
          }
        }
        context.diagnose({ code, capability: 'smart_light', member, active, reason });
        if (!active) {
          context.observed(code);
        }
      },
      restore,
    );
  state.powerWrites = writes(
    'power',
    (value) => light.set(value),
    () => {
      try {
        power.updateValue(read('power'));
      } catch {}
    },
  );
  state.brightnessWrites = writes(
    'brightness',
    (value) => light.setBrightness(value),
    () => {
      try {
        brightness.updateValue(read('brightness'));
      } catch {}
    },
  );

  power.onSet((value) => {
    if (typeof value !== 'boolean') {
      throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    if (state.powerBlocked) {
      throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    return state.powerWrites!.request(value);
  });
  brightness.onSet((value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    if (state.brightnessBlocked) {
      throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    return state.brightnessWrites!.request(value);
  });

  return {
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      if (event.eventName !== 'smartLightState') {
        return undefined;
      }
      let valid = false;
      let malformed = false;
      if (event.power !== undefined) {
        if (typeof event.power === 'boolean') {
          state.power = event.power;
          state.invalidPower = false;
          state.powerWrites?.observe();
          power.updateValue(event.power);
          diagnoseObservation('power', false, 'recovered');
          valid = true;
        } else {
          state.invalidPower = true;
          diagnoseObservation('power', true, 'malformed');
          malformed = true;
        }
      }
      if (event.brightness !== undefined) {
        if (
          typeof event.brightness === 'number' &&
          Number.isInteger(event.brightness) &&
          event.brightness >= 0 &&
          event.brightness <= 100
        ) {
          state.brightness = event.brightness;
          state.invalidBrightness = false;
          state.brightnessWrites?.observe();
          brightness.updateValue(event.brightness);
          diagnoseObservation('brightness', false, 'recovered');
          valid = true;
        } else {
          state.invalidBrightness = true;
          diagnoseObservation('brightness', true, 'malformed');
          malformed = true;
        }
      }
      return { event: 'smart-light-state', observation: malformed ? 'malformed' : valid ? 'valid' : 'missing' };
    },
    detach(): void {
      if (SMART_LIGHT_STATES.get(service)?.owner !== state.owner) {
        return;
      }
      state.powerWrites?.detach();
      state.brightnessWrites?.detach();
      SMART_LIGHT_STATES.delete(service);
      accessory.removeService(service);
    },
  };
}
