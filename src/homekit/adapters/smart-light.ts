import {
  CapabilityNotSupportedError,
  type AnyDeviceEvent,
  type RgbColor,
  type SmartLightActions,
} from '@mega-yfue/eufy-sdk';

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
const SMART_LIGHT_COLOR_WRITE = {
  id: 'smart_light.setColor.momentary-action',
  kind: 'momentary-action',
} as const;

interface AcknowledgedColor {
  hue: number;
  saturation: number;
}

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
  colorWrites?: AcknowledgedColorWrites;
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
  member: 'power' | 'brightness' | 'color';
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

interface ColorRequest {
  settled: boolean;
  deadline: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: unknown): void;
}

interface ColorBatch {
  hue?: number;
  saturation?: number;
  requests: ColorRequest[];
}

/** Coalesces HomeKit's split color characteristics into one RGB publication and retains its acknowledgement. */
class AcknowledgedColorWrites {
  private pending?: ColorBatch;
  private active?: ColorBatch;
  private scheduled?: ReturnType<typeof setTimeout>;
  private acknowledged?: AcknowledgedColor;
  private detached = false;

  constructor(
    acknowledged: AcknowledgedColor | undefined,
    private readonly issue: (color: RgbColor) => Promise<void>,
    private readonly communicationFailure: () => unknown,
    private readonly incompleteColor: () => unknown,
    private readonly acknowledge: (color: AcknowledgedColor) => void,
    private readonly diagnose: (active: boolean, reason: 'operation-failure' | 'timeout' | 'recovered') => void,
  ) {
    this.acknowledged = acknowledged;
  }

  read(component: keyof AcknowledgedColor): number | undefined {
    return this.acknowledged?.[component];
  }

  request(component: keyof AcknowledgedColor, value: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = {
        settled: false,
        deadline: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve,
        reject,
      };
      request.deadline = setTimeout(() => this.timeout(request), OPERATION_DEADLINE_MS);
      this.pending ??= { requests: [] };
      this.pending[component] = value;
      this.pending.requests.push(request);
      this.schedule();
    });
  }

  detach(): void {
    this.detached = true;
    if (this.scheduled) {
      clearTimeout(this.scheduled);
    }
    for (const request of [...(this.active?.requests ?? []), ...(this.pending?.requests ?? [])]) {
      this.settle(request, 'reject', this.communicationFailure());
    }
    this.active = undefined;
    this.pending = undefined;
    this.scheduled = undefined;
  }

  private schedule(): void {
    if (this.detached || this.active || this.scheduled) {
      return;
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.flush();
    }, 0);
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = undefined;
    if (!batch) {
      return;
    }
    const color = {
      hue: batch.hue ?? this.acknowledged?.hue,
      saturation: batch.saturation ?? this.acknowledged?.saturation,
    };
    if (color.hue === undefined || color.saturation === undefined) {
      for (const request of batch.requests) {
        this.settle(request, 'reject', this.incompleteColor());
      }
      this.schedule();
      return;
    }
    const acknowledgedColor: AcknowledgedColor = { hue: color.hue, saturation: color.saturation };
    this.active = batch;
    Promise.resolve()
      .then(() => this.issue(hsvToRgb(acknowledgedColor.hue, acknowledgedColor.saturation)))
      .then(
        () => this.complete(batch, acknowledgedColor),
        () => this.fail(batch),
      );
  }

  private complete(batch: ColorBatch, color: AcknowledgedColor): void {
    if (this.active !== batch) {
      return;
    }
    this.acknowledged = color;
    this.acknowledge(color);
    this.diagnose(false, 'recovered');
    for (const request of batch.requests) {
      this.settle(request, 'resolve');
    }
    this.active = undefined;
    this.schedule();
  }

  private fail(batch: ColorBatch): void {
    if (this.active !== batch) {
      return;
    }
    const error = this.communicationFailure();
    for (const request of batch.requests) {
      this.settle(request, 'reject', error);
    }
    this.diagnose(true, 'operation-failure');
    this.active = undefined;
    this.schedule();
  }

  private timeout(request: ColorRequest): void {
    if (request.settled) {
      return;
    }
    this.settle(request, 'reject', this.communicationFailure());
    this.diagnose(true, 'timeout');
    if (this.pending) {
      this.pending.requests = this.pending.requests.filter(({ settled }) => !settled);
      if (this.pending.requests.length === 0) {
        this.pending = undefined;
      }
    }
  }

  private settle(request: ColorRequest, result: 'resolve' | 'reject', error?: unknown): void {
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

/** Convert HomeKit hue/saturation to full-value RGB while configured device brightness remains independent. */
function hsvToRgb(hue: number, saturation: number): RgbColor {
  const h = hue === 360 ? 0 : hue / 60;
  const s = saturation / 100;
  const chroma = s;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const [red, green, blue] =
    h < 1
      ? [chroma, x, 0]
      : h < 2
        ? [x, chroma, 0]
        : h < 3
          ? [0, chroma, x]
          : h < 4
            ? [0, x, chroma]
            : h < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = 1 - chroma;
  return {
    red: Math.round((red + match) * 255),
    green: Math.round((green + match) * 255),
    blue: Math.round((blue + match) * 255),
  };
}

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
  SMART_LIGHT_COLOR_WRITE,
].map(({ id }) => id);

/** Complete HomeKit policy for evidenced Life smart-light power, brightness, and acknowledged color. */
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
  const colorEvidence = context.evidence.has(SMART_LIGHT_COLOR_WRITE.id) && typeof light.setColor === 'function';

  interface ColorContext {
    homebridgeEufySmartLightColor?: { version: 1; hue: number; saturation: number };
  }
  const accessoryContext = (accessory.context ?? {}) as ColorContext;
  accessory.context = accessoryContext;
  const storedColor = accessoryContext.homebridgeEufySmartLightColor;
  const acknowledgedColor =
    storedColor?.version === 1 &&
    Number.isFinite(storedColor.hue) &&
    storedColor.hue >= 0 &&
    storedColor.hue <= 360 &&
    Number.isFinite(storedColor.saturation) &&
    storedColor.saturation >= 0 &&
    storedColor.saturation <= 100
      ? { hue: storedColor.hue, saturation: storedColor.saturation }
      : undefined;
  if (!colorEvidence) {
    delete accessoryContext.homebridgeEufySmartLightColor;
    for (const characteristicType of [hap.Characteristic.Hue, hap.Characteristic.Saturation]) {
      if (service.testCharacteristic(characteristicType)) {
        service.removeCharacteristic(service.getCharacteristic(characteristicType));
      }
    }
  }

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

  if (colorEvidence) {
    service.addOptionalCharacteristic(hap.Characteristic.Hue);
    service.addOptionalCharacteristic(hap.Characteristic.Saturation);
    const hue = service.getCharacteristic(hap.Characteristic.Hue);
    const saturation = service.getCharacteristic(hap.Characteristic.Saturation);
    const readColor = (component: keyof AcknowledgedColor): number => {
      const value = state.colorWrites?.read(component);
      if (value === undefined) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return value;
    };
    state.colorWrites = new AcknowledgedColorWrites(
      acknowledgedColor,
      (color) => light.setColor!(color),
      () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      () => new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE),
      (color) => {
        accessoryContext.homebridgeEufySmartLightColor = { version: 1, ...color };
        hue.updateValue(color.hue);
        saturation.updateValue(color.saturation);
        context.persist();
      },
      (active, reason) => {
        context.diagnose({
          code: 'smart-light-operation-failed',
          capability: 'smart_light',
          member: 'color',
          active,
          reason,
        });
        if (!active) {
          context.observed('smart-light-operation-failed');
        }
      },
    );
    hue.onGet(() => readColor('hue'));
    saturation.onGet(() => readColor('saturation'));
    hue.onSet((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 360) {
        throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      return state.colorWrites!.request('hue', value);
    });
    saturation.onSet((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      return state.colorWrites!.request('saturation', value);
    });
  }

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
      state.colorWrites?.detach();
      SMART_LIGHT_STATES.delete(service);
      accessory.removeService(service);
    },
  };
}
