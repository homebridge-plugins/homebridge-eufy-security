import type { AnyDeviceEvent, BatteryActions } from '@mega-yfue/eufy-sdk';

import { satisfiesMemberRequirements } from '../../device/member-evidence.js';
import type {
  AdapterAttachmentContext,
  AdapterDiagnostic,
  AdapterEventTrace,
  AttachedAdapter,
  HomeKitAdapter,
} from '../adapter.js';

export const BATTERY_ADAPTER_KEY = 'battery.status';

const BATTERY_LEVEL_REQUIREMENT = {
  id: 'battery.level.read',
  kind: 'read',
  type: 'number',
  writable: false,
} as const;
const BATTERY_CHARGING_EVIDENCE = 'battery.charging.read';
const BATTERY_LEVEL_EVENT_EVIDENCE = 'battery.batteryLevel.event';
const BATTERY_ALERT_EVENT_EVIDENCE = 'battery.batteryAlert.event';
const LOW_BATTERY_THRESHOLD = 20;

/**
 * Whether a device is powered by a battery, which the SDK proves by the device reporting a level at all.
 *
 * The camera bundle reads this to decide whether a camera may retain pre-event media, so the fact has one
 * owner rather than a copy beside every consumer. It is the same evidence the SDK derives every media
 * egress's power budget from, and a solar panel charges a battery rather than replacing it, so one answer
 * covers both.
 */
export function isBatteryPowered(evidence: AdapterAttachmentContext['evidence']): boolean {
  return satisfiesMemberRequirements(evidence, [BATTERY_LEVEL_REQUIREMENT]);
}

interface BatteryState {
  owner?: symbol;
  observedLevel?: number;
  lowAlert: boolean;
}

const BATTERY_STATES = new WeakMap<object, BatteryState>();

/** The typed SDK battery accessor consumed by HomeKit. */
export interface BatterySdkDevice {
  battery?: () => BatteryActions | undefined;
}

export type BatteryDiagnosticReason = 'missing' | 'malformed' | 'sdk-fault' | 'hot' | 'recovered';

/** Structured conditions emitted by the battery adapter. */
export interface BatteryDiagnostic extends AdapterDiagnostic {
  code: 'battery-capability-unavailable' | 'invalid-battery-observation' | 'battery-temperature-alert';
  capability: 'battery';
  member: 'level' | 'charging' | 'batteryAlert';
  active: boolean;
  reason: BatteryDiagnosticReason;
}

/** Complete supplemental HomeKit policy for verified battery evidence. */
export const BATTERY_ADAPTER = {
  key: BATTERY_ADAPTER_KEY,
  role: 'supplemental',
  requires: [BATTERY_LEVEL_REQUIREMENT],
  coverage: [
    {
      id: BATTERY_LEVEL_REQUIREMENT.id,
      hapFit: 'Battery Service BatteryLevel and StatusLowBattery at 20 percent or below',
      identityEffect:
        'Supplemental service uses stable semantic key battery.status and cannot establish representation',
      diagnostics: 'Fail closed for missing, malformed, or faulting battery observations',
    },
    {
      id: BATTERY_CHARGING_EVIDENCE,
      hapFit: 'Battery Service ChargingState from the SDK charging boolean',
      identityEffect: 'Supplemental characteristic has no accessory identity effect',
      diagnostics: 'Fail closed for missing, malformed, or faulting charging observations',
    },
    {
      id: BATTERY_LEVEL_EVENT_EVIDENCE,
      hapFit: 'Battery Service BatteryLevel and StatusLowBattery from later level evidence',
      identityEffect: 'Supplemental event has no accessory identity effect',
      diagnostics: 'Trace missing or malformed level events without fabricated state',
    },
    {
      id: BATTERY_ALERT_EVENT_EVIDENCE,
      hapFit: 'Battery Service StatusLowBattery latches low alerts; hot alerts remain diagnostic-only',
      identityEffect: 'Supplemental event has no accessory identity effect',
      diagnostics: 'Emit hot battery alerts as structured diagnostics without HomeKit state mutation',
    },
  ].map((coverage) => ({
    ...coverage,
    verification: [
      {
        file: 'test/contracts/battery-adapter.test.ts',
        behavior: 'latches a low alert until a later valid level above 20 percent',
      },
    ],
  })),
  attach: attachBattery,
} as const satisfies HomeKitAdapter;

function validLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Attaches battery evidence only to an accessory container already admitted by a primary-purpose adapter. */
function attachBattery(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as BatterySdkDevice;
  let battery: BatteryActions | undefined;
  try {
    battery = device.battery?.();
  } catch {
    context.diagnose({
      code: 'battery-capability-unavailable',
      capability: 'battery',
      member: 'level',
      active: true,
      reason: 'sdk-fault',
    });
    return undefined;
  }
  if (!battery) {
    context.diagnose({
      code: 'battery-capability-unavailable',
      capability: 'battery',
      member: 'level',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  context.diagnose({
    code: 'battery-capability-unavailable',
    capability: 'battery',
    member: 'level',
    active: false,
    reason: 'recovered',
  });

  const service =
    accessory.getServiceById(hap.Service.Battery, BATTERY_ADAPTER_KEY) ??
    accessory.addService(hap.Service.Battery, accessory.displayName, BATTERY_ADAPTER_KEY);
  const state = BATTERY_STATES.get(service) ?? { lowAlert: false };
  BATTERY_STATES.set(service, state);
  const owner = Symbol('battery-owner');
  state.owner = owner;

  const fail = (member: 'level' | 'charging', reason: BatteryDiagnosticReason): never => {
    context.diagnose({
      code: 'invalid-battery-observation',
      capability: 'battery',
      member,
      active: true,
      reason,
    });
    throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  };
  const recover = (member: 'level' | 'charging'): void => {
    context.diagnose({
      code: 'invalid-battery-observation',
      capability: 'battery',
      member,
      active: false,
      reason: 'recovered',
    });
  };
  const lowValue = (level: number): number =>
    level <= LOW_BATTERY_THRESHOLD
      ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  const updateLevel = (level: number): void => {
    state.observedLevel = level;
    state.lowAlert = level <= LOW_BATTERY_THRESHOLD;
    service.updateCharacteristic(hap.Characteristic.BatteryLevel, level);
    service.updateCharacteristic(hap.Characteristic.StatusLowBattery, lowValue(level));
  };
  const readLevel = (): number => {
    let level: unknown;
    try {
      level = battery.level;
    } catch {
      return fail('level', 'sdk-fault');
    }
    if (!validLevel(level)) {
      return fail('level', level === undefined ? 'missing' : 'malformed');
    }
    state.observedLevel = level;
    state.lowAlert = level <= LOW_BATTERY_THRESHOLD;
    service.updateCharacteristic(hap.Characteristic.StatusLowBattery, lowValue(level));
    recover('level');
    return level;
  };

  service.getCharacteristic(hap.Characteristic.BatteryLevel).onGet(readLevel);
  service.getCharacteristic(hap.Characteristic.StatusLowBattery).onGet(() => {
    if (state.lowAlert) {
      return hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    }
    return lowValue(state.observedLevel ?? readLevel());
  });

  if (context.evidence.has(BATTERY_CHARGING_EVIDENCE)) {
    service.getCharacteristic(hap.Characteristic.ChargingState).onGet(() => {
      let charging: unknown;
      try {
        charging = battery.charging;
      } catch {
        return fail('charging', 'sdk-fault');
      }
      if (typeof charging !== 'boolean') {
        return fail('charging', charging === undefined ? 'missing' : 'malformed');
      }
      recover('charging');
      return charging ? hap.Characteristic.ChargingState.CHARGING : hap.Characteristic.ChargingState.NOT_CHARGING;
    });
  } else if (service.testCharacteristic(hap.Characteristic.ChargingState)) {
    service.removeCharacteristic(service.getCharacteristic(hap.Characteristic.ChargingState));
  }

  return {
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      if (event.eventName === 'batteryLevel') {
        if (!context.evidence.has(BATTERY_LEVEL_EVENT_EVIDENCE)) {
          return undefined;
        }
        if (event.to === undefined) {
          return { event: 'battery-level', observation: 'missing' };
        }
        const level = Number(event.to);
        if (!validLevel(level) || event.to.trim() === '') {
          return { event: 'battery-level', observation: 'malformed' };
        }
        updateLevel(level);
        recover('level');
        return { event: 'battery-level', observation: 'valid' };
      }
      if (event.eventName !== 'batteryAlert' || !context.evidence.has(BATTERY_ALERT_EVENT_EVIDENCE)) {
        return undefined;
      }
      if (event.state === undefined) {
        return { event: 'battery-alert', observation: 'missing' };
      }
      if (event.state === 'low') {
        state.lowAlert = true;
        service.updateCharacteristic(
          hap.Characteristic.StatusLowBattery,
          hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
        );
        return { event: 'battery-alert', observation: 'valid' };
      }
      if (event.state === 'hot') {
        context.diagnose({
          code: 'battery-temperature-alert',
          capability: 'battery',
          member: 'batteryAlert',
          active: true,
          reason: 'hot',
        });
        return { event: 'battery-alert', observation: 'valid' };
      }
      if (event.state === 'full') {
        context.diagnose({
          code: 'battery-temperature-alert',
          capability: 'battery',
          member: 'batteryAlert',
          active: false,
          reason: 'recovered',
        });
        return { event: 'battery-alert', observation: 'valid' };
      }
      return { event: 'battery-alert', observation: 'malformed' };
    },
    detach(): void {
      if (state.owner === owner) {
        state.owner = undefined;
        BATTERY_STATES.delete(service);
        accessory.removeService(service);
      }
    },
  };
}
