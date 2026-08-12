import type { AnyDeviceEvent, ContactActions } from '@mega-yfue/eufy-sdk';

import type {
  AdapterAttachmentContext,
  AdapterDiagnostic,
  AdapterEventTrace,
  AttachedAdapter,
  HomeKitAdapter,
} from '../adapter.js';

export const CONTACT_ADAPTER_KEY = 'contact.sensor';

const CONTACT_OPEN_REQUIREMENT = {
  id: 'contact.open.read',
  kind: 'read',
  type: 'bool',
  writable: false,
} as const;

/** The typed SDK contact accessor consumed by HomeKit. */
export interface ContactSdkDevice {
  contact?: () => ContactActions | undefined;
}

export type ContactDiagnosticReason = 'missing' | 'malformed' | 'sdk-fault' | 'recovered';

/** Structured conditions emitted by the contact adapter. */
export interface ContactDiagnostic extends AdapterDiagnostic {
  code: 'contact-capability-unavailable' | 'invalid-contact-observation';
  capability: 'contact';
  member: 'open';
  active: boolean;
  reason: ContactDiagnosticReason;
}

/** Complete HomeKit policy for the contact capability. */
export const CONTACT_ADAPTER = {
  key: CONTACT_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [CONTACT_OPEN_REQUIREMENT],
  coverage: [CONTACT_OPEN_REQUIREMENT.id, 'contact.contactState.event'].map((id) => ({
    id,
    hapFit: 'Contact Sensor ContactSensorState; SDK open=true maps to HAP contact not detected',
    identityEffect: 'Primary-purpose service uses stable semantic key contact.sensor',
    diagnostics: 'Emit and clear a structured invalid-contact-observation condition',
    verification: [
      {
        file: 'test/contracts/contact-adapter.test.ts',
        behavior: 'maps authoritative SDK contact polarity through real HAP definitions',
      },
    ],
  })),
  attach: attachContact,
} as const satisfies HomeKitAdapter;

/** Attaches verified SDK contact semantics to one official HomeKit Contact Sensor service. */
function attachContact(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as ContactSdkDevice;
  const contact = device.contact?.();
  if (!contact) {
    context.diagnose({
      code: 'contact-capability-unavailable',
      capability: 'contact',
      member: 'open',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  context.diagnose({
    code: 'contact-capability-unavailable',
    capability: 'contact',
    member: 'open',
    active: false,
    reason: 'recovered',
  });

  const service =
    accessory.getServiceById(hap.Service.ContactSensor, CONTACT_ADAPTER_KEY) ??
    accessory.addService(hap.Service.ContactSensor, accessory.displayName, CONTACT_ADAPTER_KEY);
  let observedOpen: boolean | undefined;
  let eventObservationInvalid = false;
  let faulted = true;
  let reportedFault = false;
  let faultReason: Exclude<ContactDiagnosticReason, 'recovered'> | undefined;

  const setFault = (reason: Exclude<ContactDiagnosticReason, 'recovered'>): void => {
    faulted = true;
    if (reportedFault && faultReason === reason) {
      return;
    }
    reportedFault = true;
    faultReason = reason;
    service.updateCharacteristic(hap.Characteristic.StatusFault, hap.Characteristic.StatusFault.GENERAL_FAULT);
    context.diagnose({
      code: 'invalid-contact-observation',
      capability: 'contact',
      member: 'open',
      active: true,
      reason,
    });
  };

  const recover = (): void => {
    if (!faulted) {
      return;
    }
    faulted = false;
    service.updateCharacteristic(hap.Characteristic.StatusFault, hap.Characteristic.StatusFault.NO_FAULT);
    if (reportedFault) {
      reportedFault = false;
      faultReason = undefined;
      context.diagnose({
        code: 'invalid-contact-observation',
        capability: 'contact',
        member: 'open',
        active: false,
        reason: 'recovered',
      });
    }
  };

  const hapValue = (open: boolean): number =>
    open
      ? hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_DETECTED;

  service.getCharacteristic(hap.Characteristic.ContactSensorState).onGet(() => {
    if (eventObservationInvalid) {
      setFault('malformed');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    let open: unknown;
    try {
      open = observedOpen ?? contact.open;
    } catch {
      setFault('sdk-fault');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (open === undefined || typeof open !== 'boolean') {
      setFault(open === undefined ? 'missing' : 'malformed');
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    recover();
    context.observed('invalid-contact-observation');
    return hapValue(open);
  });
  service
    .getCharacteristic(hap.Characteristic.StatusFault)
    .onGet(() => (faulted ? hap.Characteristic.StatusFault.GENERAL_FAULT : hap.Characteristic.StatusFault.NO_FAULT));

  return {
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      if (event.eventName !== 'contactState') {
        return undefined;
      }
      if (event.open === undefined) {
        return { event: 'contact-state', observation: 'missing' };
      }
      if (typeof event.open !== 'boolean') {
        observedOpen = undefined;
        eventObservationInvalid = true;
        setFault('malformed');
        return { event: 'contact-state', observation: 'malformed' };
      }
      eventObservationInvalid = false;
      observedOpen = event.open;
      recover();
      service.updateCharacteristic(hap.Characteristic.ContactSensorState, hapValue(event.open));
      context.observed('invalid-contact-observation');
      return { event: 'contact-state', observation: 'valid' };
    },
  };
}
