import type { AnyDeviceEvent } from '@mega-yfue/eufy-sdk';

import type { Service } from 'homebridge';

import type { AdapterAttachmentContext, AdapterEventTrace, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const DOORBELL_ADAPTER_KEY = 'doorbell.press';
const DOORBELL_OWNERS = new WeakMap<object, symbol>();

const DOORBELL_PRESS_REQUIREMENT = {
  id: 'doorbell.doorbellPress.event',
  kind: 'event',
} as const;

/** The event name a press arrives under, named once so a consumer does not restate it. */
export const DOORBELL_PRESS_EVENT = 'doorbellPress';

/** Whether a device reports the physical press event this adapter admits. */
export function hasAdmittedDoorbellPress(evidence: AdapterAttachmentContext['evidence']): boolean {
  return evidence.has(DOORBELL_PRESS_REQUIREMENT.id);
}

/**
 * This accessory's one doorbell service, created on first use under the stable key this adapter owns.
 *
 * A camera bundle configuring HomeKit Secure Video has to hand the same service to its controller, because
 * a press is only a recording trigger when the controller that advertises it owns the service carrying it.
 * Both callers resolve it here so one accessory can only ever carry one doorbell service, whichever
 * attaches first.
 */
export function doorbellPressService(context: Pick<AdapterAttachmentContext, 'accessory' | 'hap'>): Service {
  const { accessory, hap } = context;
  return (
    accessory.getServiceById(hap.Service.Doorbell, DOORBELL_ADAPTER_KEY) ??
    accessory.addService(hap.Service.Doorbell, accessory.displayName, DOORBELL_ADAPTER_KEY)
  );
}

/** Complete HomeKit policy for admitted physical doorbell presses. */
export const DOORBELL_ADAPTER = {
  key: DOORBELL_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [DOORBELL_PRESS_REQUIREMENT],
  coverage: [
    {
      id: DOORBELL_PRESS_REQUIREMENT.id,
      hapFit: 'Doorbell ProgrammableSwitchEvent emits one SINGLE_PRESS notification per SDK press',
      identityEffect: 'Primary-purpose service uses stable semantic key doorbell.press',
      diagnostics: 'Presses remain stateless and require no fabricated durable device state',
      verification: [
        {
          file: 'test/contracts/doorbell-adapter.test.ts',
          behavior: 'emits every admitted press as a stateless single-press notification',
        },
      ],
    },
  ],
  attach: attachDoorbell,
} as const satisfies HomeKitAdapter;

/** Attaches verified SDK press events to one official HomeKit Doorbell service. */
function attachDoorbell(context: AdapterAttachmentContext): AttachedAdapter {
  const { accessory, hap } = context;
  const service = doorbellPressService(context);
  const owner = Symbol('doorbell-owner');
  DOORBELL_OWNERS.set(service, owner);
  const characteristic = service.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent);

  return {
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      if (event.eventName !== 'doorbellPress') {
        return undefined;
      }
      characteristic.sendEventNotification(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
      return { event: 'doorbell-press', observation: 'valid' };
    },
    detach(): void {
      if (DOORBELL_OWNERS.get(service) === owner) {
        DOORBELL_OWNERS.delete(service);
        accessory.removeService(service);
      }
    },
  };
}
