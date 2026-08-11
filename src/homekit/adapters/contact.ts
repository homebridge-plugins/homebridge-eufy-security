import type { ContactActions, DeviceEventMap } from '@mega-yfue/eufy-sdk';

export const CONTACT_ADAPTER_KEY = 'contact.sensor';

export interface HapServiceDefinition {
  readonly UUID: string;
}

export interface HapCharacteristicDefinition {
  readonly UUID: string;
}

interface ContactSensorStateDefinition extends HapCharacteristicDefinition {
  readonly CONTACT_DETECTED: number;
  readonly CONTACT_NOT_DETECTED: number;
}

interface StatusFaultDefinition extends HapCharacteristicDefinition {
  readonly NO_FAULT: number;
  readonly GENERAL_FAULT: number;
}

export interface ContactHapDefinitions {
  readonly ContactSensor: HapServiceDefinition;
  readonly ContactSensorState: ContactSensorStateDefinition;
  readonly StatusFault: StatusFaultDefinition;
  readonly serviceCommunicationFailure: number;
}

export interface ContactHapRecorder {
  addService(definition: HapServiceDefinition, key: string): object;
  onGet(service: object, characteristic: HapCharacteristicDefinition, handler: () => number): void;
  update(service: object, characteristic: HapCharacteristicDefinition, value: number): void;
}

export interface ContactSdkDevice {
  contact?: () => ContactActions | undefined;
}

export type ContactDiagnosticReason = 'missing' | 'malformed' | 'sdk-fault' | 'recovered';

export interface ContactDiagnostic {
  code: 'contact-capability-unavailable' | 'invalid-contact-observation';
  capability: 'contact';
  member: 'open';
  active: boolean;
  reason: ContactDiagnosticReason;
}

export type ContactDiagnosticSink = (diagnostic: ContactDiagnostic) => void;

export class HapReadError extends Error {
  constructor(
    readonly hapStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'HapReadError';
  }
}

export interface ContactAdapterHandle {
  observe(event: DeviceEventMap['contactState']): void;
}

/** Adapts verified SDK contact observations to one official HAP Contact Sensor service. */
export function adaptContact(
  device: ContactSdkDevice,
  definitions: ContactHapDefinitions,
  recorder: ContactHapRecorder,
  diagnose: ContactDiagnosticSink,
): ContactAdapterHandle | undefined {
  const contact = device.contact?.();
  if (!contact) {
    diagnose({
      code: 'contact-capability-unavailable',
      capability: 'contact',
      member: 'open',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  diagnose({
    code: 'contact-capability-unavailable',
    capability: 'contact',
    member: 'open',
    active: false,
    reason: 'recovered',
  });

  const service = recorder.addService(definitions.ContactSensor, CONTACT_ADAPTER_KEY);
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
    recorder.update(service, definitions.StatusFault, definitions.StatusFault.GENERAL_FAULT);
    diagnose({
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
    recorder.update(service, definitions.StatusFault, definitions.StatusFault.NO_FAULT);
    if (reportedFault) {
      reportedFault = false;
      faultReason = undefined;
      diagnose({
        code: 'invalid-contact-observation',
        capability: 'contact',
        member: 'open',
        active: false,
        reason: 'recovered',
      });
    }
  };

  const hapValue = (open: boolean): number =>
    open ? definitions.ContactSensorState.CONTACT_NOT_DETECTED : definitions.ContactSensorState.CONTACT_DETECTED;

  const read = (): number => {
    if (eventObservationInvalid) {
      setFault('malformed');
      throw new HapReadError(definitions.serviceCommunicationFailure, 'SDK contact observation is malformed');
    }

    let open: unknown;
    try {
      open = observedOpen ?? contact.open;
    } catch {
      setFault('sdk-fault');
      throw new HapReadError(definitions.serviceCommunicationFailure, 'SDK contact observation failed');
    }

    if (open === undefined) {
      setFault('missing');
      throw new HapReadError(definitions.serviceCommunicationFailure, 'SDK contact observation is unavailable');
    }
    if (typeof open !== 'boolean') {
      setFault('malformed');
      throw new HapReadError(definitions.serviceCommunicationFailure, 'SDK contact observation is malformed');
    }

    recover();
    return hapValue(open);
  };

  recorder.onGet(service, definitions.ContactSensorState, read);
  recorder.onGet(service, definitions.StatusFault, () =>
    faulted ? definitions.StatusFault.GENERAL_FAULT : definitions.StatusFault.NO_FAULT,
  );

  return {
    observe(event): void {
      if (event.open === undefined) {
        return;
      }
      if (typeof event.open !== 'boolean') {
        observedOpen = undefined;
        eventObservationInvalid = true;
        setFault('malformed');
        return;
      }

      eventObservationInvalid = false;
      observedOpen = event.open;
      recover();
      recorder.update(service, definitions.ContactSensorState, hapValue(event.open));
    },
  };
}
