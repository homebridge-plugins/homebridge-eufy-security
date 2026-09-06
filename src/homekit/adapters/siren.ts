import type { SirenActions } from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext, AdapterDiagnostic, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const SIREN_ADAPTER_KEY = 'siren.test';

const SIREN_ACTIVE_REQUIREMENT = {
  id: 'siren.active.read',
  kind: 'read',
  type: 'bool',
  writable: false,
} as const;
const SIREN_TEST_REQUIREMENT = {
  id: 'siren.test.momentary-action',
  kind: 'momentary-action',
} as const;
const SIREN_STOP_REQUIREMENT = {
  id: 'siren.stop.momentary-action',
  kind: 'momentary-action',
} as const;

interface SirenState {
  owner: symbol;
  reset?: ReturnType<typeof setTimeout>;
}

const SIREN_STATES = new WeakMap<object, SirenState>();

/** The typed SDK siren accessor consumed by HomeKit. */
export interface SirenSdkDevice {
  siren?: () => SirenActions | undefined;
}

/** Structured conditions emitted by the siren adapter. */
export interface SirenDiagnostic extends AdapterDiagnostic {
  code: 'siren-capability-unavailable' | 'invalid-siren-active-observation';
  capability: 'siren';
  member: 'active' | 'test' | 'stop';
  active: boolean;
  reason: 'missing' | 'malformed' | 'sdk-fault' | 'recovered';
}

/** Complete HomeKit policy for an evidenced indoor siren test action. */
export const SIREN_ADAPTER = {
  key: SIREN_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [SIREN_ACTIVE_REQUIREMENT, SIREN_TEST_REQUIREMENT, SIREN_STOP_REQUIREMENT],
  coverage: [SIREN_ACTIVE_REQUIREMENT.id, SIREN_TEST_REQUIREMENT.id, SIREN_STOP_REQUIREMENT.id],
  attach: attachSiren,
} as const satisfies HomeKitAdapter;

/** Attaches only the SDK's test action, conditional stop action, and authoritative sounding observation. */
function attachSiren(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as SirenSdkDevice;
  let siren: SirenActions | undefined;
  try {
    siren = device.siren?.();
  } catch {
    context.diagnose({
      code: 'siren-capability-unavailable',
      capability: 'siren',
      member: 'active',
      active: true,
      reason: 'sdk-fault',
    });
    return undefined;
  }
  if (!siren || typeof siren.test !== 'function' || typeof siren.stop !== 'function') {
    const member = !siren ? 'active' : typeof siren.test !== 'function' ? 'test' : 'stop';
    context.diagnose({
      code: 'siren-capability-unavailable',
      capability: 'siren',
      member,
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  for (const member of ['active', 'test', 'stop'] as const) {
    context.diagnose({
      code: 'siren-capability-unavailable',
      capability: 'siren',
      member,
      active: false,
      reason: 'recovered',
    });
  }

  const service =
    accessory.getServiceById(hap.Service.Switch, SIREN_ADAPTER_KEY) ??
    accessory.addService(hap.Service.Switch, accessory.displayName, SIREN_ADAPTER_KEY);
  const state: SirenState = { owner: Symbol('siren-owner') };
  SIREN_STATES.set(service, state);
  const on = service.getCharacteristic(hap.Characteristic.On);

  const readActive = (): boolean => {
    let active: unknown;
    try {
      active = siren.active;
    } catch {
      context.diagnose({
        code: 'invalid-siren-active-observation',
        capability: 'siren',
        member: 'active',
        active: true,
        reason: 'sdk-fault',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (typeof active !== 'boolean') {
      context.diagnose({
        code: 'invalid-siren-active-observation',
        capability: 'siren',
        member: 'active',
        active: true,
        reason: active === undefined ? 'missing' : 'malformed',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    context.diagnose({
      code: 'invalid-siren-active-observation',
      capability: 'siren',
      member: 'active',
      active: false,
      reason: 'recovered',
    });
    context.observed('invalid-siren-active-observation');
    return active;
  };

  on.onGet(readActive);

  on.onSet(async (value) => {
    if (value === false) {
      if (readActive()) {
        await siren.stop!();
      }
      return;
    }
    if (value !== true) {
      return;
    }
    try {
      await siren.test!();
    } finally {
      state.reset = setTimeout(() => {
        service.updateCharacteristic(hap.Characteristic.On, false);
      }, 0);
    }
  });

  return {
    detach(): void {
      if (SIREN_STATES.get(service)?.owner !== state.owner) {
        return;
      }
      if (state.reset) {
        clearTimeout(state.reset);
      }
      SIREN_STATES.delete(service);
      accessory.removeService(service);
    },
  };
}
