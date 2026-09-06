import type { AnyDeviceEvent } from '@mega-yfue/eufy-sdk';

import type { Service } from 'homebridge';

import type { AdapterAttachmentContext, AdapterEventTrace, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const MOTION_ADAPTER_KEY = 'motion.sensor';

const MOTION_HOLD_MS = 10_000;
interface MotionHold {
  deadline?: number;
  owner?: symbol;
  timer?: ReturnType<typeof setTimeout>;
}
const MOTION_HOLDS = new WeakMap<object, MotionHold>();
/**
 * The admitted SDK detection events that drive this accessory's one motion service.
 *
 * The camera bundle reads this to decide whether a camera has a recording trigger at all, so the set has
 * one owner rather than a copy beside every consumer.
 */
export const MOTION_EVENT_REQUIREMENTS = [
  { capability: 'motion', eventName: 'motion' },
  { capability: 'motion', eventName: 'cryingDetected' },
  { capability: 'motion', eventName: 'soundDetected' },
  { capability: 'motion', eventName: 'vehicleDetected' },
  { capability: 'motion', eventName: 'dogDetected' },
  { capability: 'person_detection', eventName: 'personDetected' },
  { capability: 'person_detection', eventName: 'strangerDetected' },
  { capability: 'doorbell', eventName: 'petDetection' },
] as const satisfies readonly { capability: string; eventName: AnyDeviceEvent['eventName'] }[];

/** Whether a device reports at least one detection event this adapter admits as motion. */
export function hasAdmittedMotionEvents(evidence: AdapterAttachmentContext['evidence']): boolean {
  return MOTION_EVENT_REQUIREMENTS.some(({ capability, eventName }) =>
    evidence.has(`${capability}.${eventName}.event`),
  );
}

/**
 * This accessory's one motion service, created on first use under the stable key this adapter owns.
 *
 * A camera bundle configuring HomeKit Secure Video has to hand the same service to its controller, because
 * HomeKit links the sensor that triggers a recording to the recording management service. Both callers
 * resolve it here so one accessory can only ever carry one motion service, whichever attaches first.
 */
export function motionSensorService(context: Pick<AdapterAttachmentContext, 'accessory' | 'hap'>): Service {
  const { accessory, hap } = context;
  return (
    accessory.getServiceById(hap.Service.MotionSensor, MOTION_ADAPTER_KEY) ??
    accessory.addService(hap.Service.MotionSensor, accessory.displayName, MOTION_ADAPTER_KEY)
  );
}

/** Complete HomeKit policy for admitted detection pulses. */
export const MOTION_ADAPTER = {
  key: MOTION_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [],
  requiresAny: MOTION_EVENT_REQUIREMENTS.map(({ capability, eventName }) => ({
    id: `${capability}.${eventName}.event`,
    kind: 'event' as const,
  })),
  coverage: MOTION_EVENT_REQUIREMENTS.map(({ capability, eventName }) => `${capability}.${eventName}.event`),
  attach: attachMotion,
} as const satisfies HomeKitAdapter;

/** Attaches admitted SDK detection pulses to one official HomeKit Motion Sensor service. */
function attachMotion(context: AdapterAttachmentContext): AttachedAdapter {
  const { accessory, hap } = context;
  const service = motionSensorService(context);
  const hold = MOTION_HOLDS.get(service) ?? {};
  MOTION_HOLDS.set(service, hold);
  const owner = Symbol('motion-hold-owner');
  hold.owner = owner;
  const admittedEvents = new Set<AnyDeviceEvent['eventName']>(
    MOTION_EVENT_REQUIREMENTS.filter(({ capability, eventName }) =>
      context.evidence.has(`${capability}.${eventName}.event`),
    ).map(({ eventName }) => eventName),
  );
  const clear = (): void => {
    hold.deadline = undefined;
    hold.timer = undefined;
    service.updateCharacteristic(hap.Characteristic.MotionDetected, false);
  };
  const schedule = (): void => {
    if (hold.timer) {
      clearTimeout(hold.timer);
    }
    if (hold.deadline === undefined) {
      return;
    }
    const remaining = hold.deadline - Date.now();
    if (remaining <= 0) {
      clear();
      return;
    }
    service.updateCharacteristic(hap.Characteristic.MotionDetected, true);
    hold.timer = setTimeout(clear, remaining);
  };
  schedule();

  return {
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      if (!admittedEvents.has(event.eventName)) {
        return undefined;
      }
      service.updateCharacteristic(hap.Characteristic.MotionDetected, true);
      hold.deadline = Date.now() + MOTION_HOLD_MS;
      schedule();
      return { event: 'motion-detection', observation: 'valid' };
    },
    detach(): void {
      if (hold.owner === owner) {
        if (hold.timer) {
          clearTimeout(hold.timer);
        }
        clear();
        hold.owner = undefined;
        accessory.removeService(service);
      }
    },
  };
}
