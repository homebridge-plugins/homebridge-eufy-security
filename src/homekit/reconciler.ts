import type { AnyDeviceEvent, Device, DeviceEventMap } from '@mega-yfue/eufy-sdk';
import type { Characteristic, HapStatusError, PlatformAccessory, Service } from 'homebridge';

import type { CompleteDeviceSnapshot } from '../device/snapshot.js';
import {
  adaptContact,
  CONTACT_ADAPTER_KEY,
  HapReadError,
  type ContactDiagnostic,
  type ContactHapDefinitions,
  type ContactHapRecorder,
  type HapCharacteristicDefinition,
  type HapServiceDefinition,
} from './adapters/contact.js';
import { adaptInformation, type InformationRecorder } from './adapters/information.js';
import { ADAPTER_REGISTRY, type AdapterAttachmentContext } from './adapters/registry.js';

export interface HomeKitRegistryView {
  readonly version: number;
  readonly generation: string;
  readonly registry: ReadonlyMap<string, Device>;
  readonly snapshot: CompleteDeviceSnapshot;
}

export type HomeKitRegistryListener = (view: HomeKitRegistryView) => void;

export interface HomeKitRegistrySource {
  currentRegistry(): HomeKitRegistryView | undefined;
  subscribeRegistry(listener: HomeKitRegistryListener): () => void;
  subscribeEvents(listener: (event: AnyDeviceEvent) => void): () => void;
}

export interface HomeKitDefinitions {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly HAPStatus: { readonly SERVICE_COMMUNICATION_FAILURE: number };
  readonly HapStatusError: typeof HapStatusError;
}

export interface HomeKitAccessoryStore {
  readonly hap: HomeKitDefinitions;
  generateUuid(input: string): string;
  createAccessory(name: string, uuid: string): PlatformAccessory;
  register(accessories: PlatformAccessory[]): void;
  update(accessories: PlatformAccessory[]): void;
  unregister(accessories: PlatformAccessory[]): void;
}

export interface RepresentationDiagnostic {
  code: 'recognized-device-not-represented';
  active: boolean;
  reason: 'no-primary-purpose-member' | 'primary-adapter-unavailable' | 'recovered';
}

export type HomeKitDiagnostic = (RepresentationDiagnostic | ContactDiagnostic) & {
  affectedDeviceCount: number;
};
export type HomeKitDiagnosticSink = (diagnostic: HomeKitDiagnostic) => void;

interface AccessoryContext {
  homebridgeEufy?: {
    version: 1;
    serial: string;
  };
  device?: {
    uniqueId?: string;
  };
}

/** Reconciles complete runtime registry publications into stable HomeKit accessory containers. */
export class HomeKitReconciler {
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly representedSerials = new Set<string>();
  private readonly contactHandles = new Map<string, { observe(event: DeviceEventMap['contactState']): void }>();
  private readonly representationDiagnostics = new Map<
    string,
    Exclude<RepresentationDiagnostic['reason'], 'recovered'>
  >();
  private readonly adapterDiagnostics = new Map<string, { serial: string; diagnostic: ContactDiagnostic }>();
  private unsubscribeRegistry?: () => void;
  private unsubscribeEvents?: () => void;
  private lastPublication?: string;

  constructor(
    private readonly source: HomeKitRegistrySource,
    private readonly store: HomeKitAccessoryStore,
    private readonly diagnose: HomeKitDiagnosticSink,
    cachedAccessories: readonly PlatformAccessory[] = [],
  ) {
    for (const accessory of cachedAccessories) {
      this.accessories.set(accessory.UUID, accessory);
      const context = accessory.context as AccessoryContext;
      const serial = context.homebridgeEufy?.version === 1 ? context.homebridgeEufy.serial : context.device?.uniqueId;
      if (serial && accessory.UUID === this.store.generateUuid(`d1_${serial}`)) {
        this.representedSerials.add(serial);
      }
    }
  }

  start(): void {
    if (this.unsubscribeRegistry) {
      return;
    }
    this.unsubscribeRegistry = this.source.subscribeRegistry((view) => this.reconcile(view));
    this.unsubscribeEvents = this.source.subscribeEvents((event) => this.observe(event));
    const current = this.source.currentRegistry();
    if (current) {
      this.reconcile(current);
    }
  }

  stop(): void {
    this.unsubscribeRegistry?.();
    this.unsubscribeEvents?.();
    this.unsubscribeRegistry = undefined;
    this.unsubscribeEvents = undefined;
  }

  private reconcile(view: HomeKitRegistryView): void {
    const publication = `${view.generation}:${view.version}`;
    if (publication === this.lastPublication) {
      return;
    }

    const manifests = new Map(view.snapshot.devices.map((manifest) => [manifest.sn, manifest]));
    if (manifests.size !== view.registry.size || [...manifests.keys()].some((serial) => !view.registry.has(serial))) {
      throw new TypeError('HomeKit registry view does not match its complete snapshot');
    }

    const nextRepresented = new Set<string>();
    for (const [serial, device] of view.registry) {
      const manifest = manifests.get(serial)!;
      if (!ADAPTER_REGISTRY[CONTACT_ADAPTER_KEY].admits(manifest)) {
        this.contactHandles.delete(serial);
        this.clearAdapterDiagnostics(serial);
      }
      const admittedPrimaryAdapters = Object.values(ADAPTER_REGISTRY).filter(
        (adapter) => adapter.role === 'primary-purpose' && adapter.admits(manifest),
      );
      if (admittedPrimaryAdapters.length === 0) {
        this.setRepresentationDiagnostic(serial, 'no-primary-purpose-member');
        continue;
      }

      const uuid = this.store.generateUuid(`d1_${serial}`);
      const existing = this.accessories.get(uuid);
      const accessory = existing ?? this.store.createAccessory(manifest.name, uuid);
      const context: AdapterAttachmentContext = {
        contact: () => {
          const handle = adaptContact(
            device,
            this.contactDefinitions(),
            this.contactRecorder(accessory, serial),
            (diagnostic) => this.setAdapterDiagnostic(serial, diagnostic),
          );
          if (handle) {
            this.contactHandles.set(serial, handle);
          }
          return handle;
        },
        information: () => adaptInformation(device, this.informationRecorder(accessory)),
      };
      let primaryAttached = false;
      for (const adapter of admittedPrimaryAdapters) {
        primaryAttached = Boolean(adapter.attach(context)) || primaryAttached;
      }
      if (!primaryAttached) {
        this.setRepresentationDiagnostic(serial, 'primary-adapter-unavailable');
        continue;
      }

      accessory.updateDisplayName(manifest.name);
      (accessory.context as AccessoryContext).homebridgeEufy = { version: 1, serial };
      for (const adapter of Object.values(ADAPTER_REGISTRY)) {
        if (adapter.role === 'supplemental' && adapter.admits(manifest)) {
          adapter.attach(context);
        }
      }
      this.accessories.set(uuid, accessory);
      nextRepresented.add(serial);
      this.clearRepresentationDiagnostic(serial);
      if (existing) {
        this.store.update([accessory]);
      } else {
        this.store.register([accessory]);
      }
    }

    for (const serial of this.representedSerials) {
      if (nextRepresented.has(serial)) {
        continue;
      }
      const uuid = this.store.generateUuid(`d1_${serial}`);
      const accessory = this.accessories.get(uuid);
      if (accessory) {
        this.store.unregister([accessory]);
        this.accessories.delete(uuid);
      }
      this.contactHandles.delete(serial);
      this.clearAdapterDiagnostics(serial);
    }
    for (const serial of this.representationDiagnostics.keys()) {
      if (!manifests.has(serial)) {
        this.clearRepresentationDiagnostic(serial);
      }
    }
    const removedDiagnosticSerials = new Set(
      [...this.adapterDiagnostics.values()].map(({ serial }) => serial).filter((serial) => !manifests.has(serial)),
    );
    for (const serial of removedDiagnosticSerials) {
      this.clearAdapterDiagnostics(serial);
    }
    this.representedSerials.clear();
    for (const serial of nextRepresented) {
      this.representedSerials.add(serial);
    }
    this.lastPublication = publication;
  }

  private observe(event: AnyDeviceEvent): void {
    if (event.eventName !== 'contactState' || !event.deviceSn) {
      return;
    }
    this.contactHandles.get(event.deviceSn)?.observe(event);
    if (typeof event.open === 'boolean') {
      this.clearAdapterDiagnostics(event.deviceSn, 'invalid-contact-observation');
    }
  }

  private contactDefinitions(): ContactHapDefinitions {
    return {
      ContactSensor: this.store.hap.Service.ContactSensor,
      ContactSensorState: this.store.hap.Characteristic.ContactSensorState,
      StatusFault: this.store.hap.Characteristic.StatusFault,
      serviceCommunicationFailure: this.store.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    };
  }

  private contactRecorder(accessory: PlatformAccessory, serial: string): ContactHapRecorder {
    return {
      addService: (definition, key) =>
        accessory.getServiceById(this.serviceDefinition(definition), key) ??
        accessory.addService(this.serviceDefinition(definition), accessory.displayName, key),
      onGet: (service, characteristic, handler) => {
        (service as Service).getCharacteristic(this.characteristicDefinition(characteristic)).onGet(() => {
          try {
            const value = handler();
            if (characteristic.UUID === this.store.hap.Characteristic.ContactSensorState.UUID) {
              this.clearAdapterDiagnostics(serial, 'invalid-contact-observation');
            }
            return value;
          } catch (error) {
            if (error instanceof HapReadError) {
              throw new this.store.hap.HapStatusError(error.hapStatus);
            }
            throw error;
          }
        });
      },
      update: (service, characteristic, value) => {
        (service as Service).updateCharacteristic(this.characteristicDefinition(characteristic), value);
      },
    } satisfies ContactHapRecorder;
  }

  private serviceDefinition(definition: HapServiceDefinition): typeof Service.ContactSensor {
    if (definition.UUID !== this.store.hap.Service.ContactSensor.UUID) {
      throw new TypeError('unsupported HomeKit service definition');
    }
    return this.store.hap.Service.ContactSensor;
  }

  private characteristicDefinition(
    definition: HapCharacteristicDefinition,
  ): typeof Characteristic.ContactSensorState | typeof Characteristic.StatusFault {
    if (definition.UUID === this.store.hap.Characteristic.ContactSensorState.UUID) {
      return this.store.hap.Characteristic.ContactSensorState;
    }
    if (definition.UUID === this.store.hap.Characteristic.StatusFault.UUID) {
      return this.store.hap.Characteristic.StatusFault;
    }
    throw new TypeError('unsupported HomeKit characteristic definition');
  }

  private informationRecorder(accessory: PlatformAccessory): InformationRecorder {
    const service = accessory.getService(this.store.hap.Service.AccessoryInformation)!;
    return {
      set: (characteristic, value) => {
        service.updateCharacteristic(this.store.hap.Characteristic[characteristic], value);
      },
    };
  }

  private setRepresentationDiagnostic(
    serial: string,
    reason: Exclude<RepresentationDiagnostic['reason'], 'recovered'>,
  ): void {
    if (this.representationDiagnostics.get(serial) === reason) {
      return;
    }
    this.representationDiagnostics.set(serial, reason);
    this.diagnose({
      code: 'recognized-device-not-represented',
      active: true,
      reason,
      affectedDeviceCount: this.representationDiagnostics.size,
    });
  }

  private clearRepresentationDiagnostic(serial: string): void {
    if (!this.representationDiagnostics.delete(serial)) {
      return;
    }
    const remainingReason = this.representationDiagnostics.values().next().value;
    this.diagnose({
      code: 'recognized-device-not-represented',
      active: remainingReason !== undefined,
      reason: remainingReason ?? 'recovered',
      affectedDeviceCount: this.representationDiagnostics.size,
    });
  }

  private setAdapterDiagnostic(serial: string, diagnostic: ContactDiagnostic): void {
    const key = `${serial}:${diagnostic.code}:${diagnostic.capability}:${diagnostic.member}`;
    if (diagnostic.active) {
      if (this.adapterDiagnostics.get(key)?.diagnostic.reason === diagnostic.reason) {
        return;
      }
      this.adapterDiagnostics.set(key, { serial, diagnostic });
      this.diagnose({ ...diagnostic, affectedDeviceCount: this.adapterDiagnosticCount(diagnostic.code) });
      return;
    }
    if (this.adapterDiagnostics.delete(key)) {
      const remaining = [...this.adapterDiagnostics.values()]
        .map((entry) => entry.diagnostic)
        .find(({ code }) => code === diagnostic.code);
      this.diagnose({
        ...(remaining ?? diagnostic),
        active: remaining !== undefined,
        affectedDeviceCount: this.adapterDiagnosticCount(diagnostic.code),
      });
    }
  }

  private adapterDiagnosticCount(code: ContactDiagnostic['code']): number {
    return [...this.adapterDiagnostics.values()].filter(({ diagnostic }) => diagnostic.code === code).length;
  }

  private clearAdapterDiagnostics(serial: string, onlyCode?: ContactDiagnostic['code']): void {
    const prefix = `${serial}:`;
    const removedCodes = new Set<ContactDiagnostic['code']>();
    for (const [key, entry] of this.adapterDiagnostics) {
      if (key.startsWith(prefix) && (onlyCode === undefined || entry.diagnostic.code === onlyCode)) {
        this.adapterDiagnostics.delete(key);
        removedCodes.add(entry.diagnostic.code);
      }
    }
    for (const code of removedCodes) {
      const remaining = [...this.adapterDiagnostics.values()]
        .map((entry) => entry.diagnostic)
        .find((diagnostic) => diagnostic.code === code);
      this.diagnose({
        ...(remaining ?? {
          code,
          capability: 'contact',
          member: 'open',
          reason: 'recovered',
          active: false,
        }),
        active: remaining !== undefined,
        affectedDeviceCount: this.adapterDiagnosticCount(code),
      });
    }
  }
}
