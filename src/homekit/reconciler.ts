import type { AnyDeviceEvent, Device } from '@mega-yfue/eufy-sdk';
import type { PlatformAccessory } from 'homebridge';

import type { CompleteDeviceSnapshot } from '../device/snapshot.js';
import { indexDeviceMemberEvidence } from '../device/member-evidence.js';
import type { AdapterDiagnostic, AdapterEventTrace, AttachedAdapter, HomeKitDefinitions } from './adapter.js';
import { admittedHomeKitAdapters } from './representation.js';

/** One complete canonical registry and snapshot published from the same discovery pass. */
export interface HomeKitRegistryView {
  readonly version: number;
  readonly generation: string;
  readonly registry: ReadonlyMap<string, Device>;
  readonly snapshot: CompleteDeviceSnapshot;
}

export type HomeKitRegistryListener = (view: HomeKitRegistryView) => void;

/** The retained complete-registry seam consumed independently from runtime availability. */
export interface HomeKitRegistrySource {
  currentRegistry(): HomeKitRegistryView | undefined;
  subscribeRegistry(listener: HomeKitRegistryListener): () => void;
  subscribeEvents(listener: (event: AnyDeviceEvent) => void): () => void;
}

/** Homebridge operations used to create and persist accessory containers. */
export interface HomeKitAccessoryStore {
  readonly hap: HomeKitDefinitions;
  generateUuid(input: string): string;
  createAccessory(name: string, uuid: string): PlatformAccessory;
  register(accessories: PlatformAccessory[]): void;
  update(accessories: PlatformAccessory[]): void;
  unregister(accessories: PlatformAccessory[]): void;
}

/** Aggregate condition for recognized devices that cannot be represented. */
export interface RepresentationDiagnostic {
  code: 'recognized-device-not-represented';
  active: boolean;
  reason: 'no-primary-purpose-member' | 'primary-adapter-unavailable' | 'recovered';
}

export type HomeKitDiagnostic = (RepresentationDiagnostic | AdapterDiagnostic) & {
  affectedDeviceCount: number;
};
export type HomeKitDiagnosticSink = (diagnostic: HomeKitDiagnostic) => void;

/** Redacted debug evidence that an SDK event reached one self-hosted adapter. */
export interface HomeKitEventTrace {
  adapter: string;
  event: string;
  observation: AdapterEventTrace['observation'];
}

export type HomeKitEventTraceSink = (trace: HomeKitEventTrace) => void;

export type HomeKitEntityPreferences = Readonly<Record<string, { represented?: boolean }>>;

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
  private readonly attachedAdapters = new Map<string, ReadonlyMap<string, AttachedAdapter>>();
  private readonly activeAdapters = new Map<string, ReadonlySet<string>>();
  private readonly representationDiagnostics = new Map<
    string,
    Exclude<RepresentationDiagnostic['reason'], 'recovered'>
  >();
  private readonly adapterDiagnostics = new Map<
    string,
    { serial: string; adapter: string; diagnostic: AdapterDiagnostic }
  >();
  private unsubscribeRegistry?: () => void;
  private unsubscribeEvents?: () => void;
  private lastPublication?: string;

  constructor(
    private readonly source: HomeKitRegistrySource,
    private readonly store: HomeKitAccessoryStore,
    private readonly diagnose: HomeKitDiagnosticSink,
    cachedAccessories: readonly PlatformAccessory[] = [],
    private readonly trace?: HomeKitEventTraceSink,
    private readonly entityPreferences: HomeKitEntityPreferences = {},
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
    for (const serial of this.attachedAdapters.keys()) {
      this.detachAdapters(serial);
    }
    this.lastPublication = undefined;
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
      const previousHandles = this.attachedAdapters.get(serial);
      const manifest = manifests.get(serial)!;
      const evidence = indexDeviceMemberEvidence(manifest);
      const admittedAdapters = admittedHomeKitAdapters(manifest);
      const admittedKeys = new Set(admittedAdapters.map(([key]) => key));
      for (const previousKey of this.activeAdapters.get(serial) ?? []) {
        if (!admittedKeys.has(previousKey)) {
          this.clearAdapterDiagnostics(serial, undefined, previousKey);
        }
      }
      this.activeAdapters.set(serial, admittedKeys);
      if (this.entityPreferences[serial]?.represented === false) {
        this.detachHandles(previousHandles);
        this.attachedAdapters.delete(serial);
        this.clearRepresentationDiagnostic(serial);
        continue;
      }
      const admittedPrimaryAdapters = admittedAdapters.filter(([, adapter]) => adapter.role === 'primary-purpose');
      if (admittedPrimaryAdapters.length === 0) {
        this.detachHandles(previousHandles);
        this.attachedAdapters.delete(serial);
        this.setRepresentationDiagnostic(serial, 'no-primary-purpose-member');
        continue;
      }

      const uuid = this.store.generateUuid(`d1_${serial}`);
      const existing = this.accessories.get(uuid);
      const accessory = existing ?? this.store.createAccessory(manifest.name, uuid);
      const handles = new Map<string, AttachedAdapter>();
      const attach = (key: string, adapter: (typeof admittedAdapters)[number][1]): boolean => {
        const handle = adapter.attach({
          device,
          evidence,
          accessory,
          hap: this.store.hap,
          diagnose: (diagnostic) => this.setAdapterDiagnostic(serial, key, diagnostic),
          observed: (code) => this.clearAdapterDiagnostics(serial, code, key),
          persist: () => this.store.update([accessory]),
        });
        if (handle) {
          handles.set(key, handle);
        }
        return handle !== undefined;
      };
      let primaryAttached = false;
      for (const [key, adapter] of admittedPrimaryAdapters) {
        primaryAttached = attach(key, adapter) || primaryAttached;
      }
      if (!primaryAttached) {
        this.detachHandles(previousHandles);
        this.attachedAdapters.set(serial, handles);
        this.setRepresentationDiagnostic(serial, 'primary-adapter-unavailable');
        continue;
      }

      accessory.updateDisplayName(manifest.name);
      (accessory.context as AccessoryContext).homebridgeEufy = { version: 1, serial };
      for (const [key, adapter] of admittedAdapters) {
        if (adapter.role === 'supplemental') {
          attach(key, adapter);
        }
      }
      this.detachHandles(previousHandles);
      this.attachedAdapters.set(serial, handles);
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
      this.detachAdapters(serial);
      this.activeAdapters.delete(serial);
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
    for (const serial of this.activeAdapters.keys()) {
      if (!manifests.has(serial)) {
        this.activeAdapters.delete(serial);
        this.detachAdapters(serial);
      }
    }
    this.representedSerials.clear();
    for (const serial of nextRepresented) {
      this.representedSerials.add(serial);
    }
    this.lastPublication = publication;
  }

  private observe(event: AnyDeviceEvent): void {
    if (!event.deviceSn) {
      return;
    }
    for (const [adapter, handle] of this.attachedAdapters.get(event.deviceSn) ?? []) {
      const result = handle.event?.(event);
      if (result) {
        this.trace?.({ adapter, ...result });
      }
    }
  }

  private detachAdapters(serial: string): void {
    const handles = this.attachedAdapters.get(serial);
    this.detachHandles(handles);
    this.attachedAdapters.delete(serial);
  }

  private detachHandles(handles: ReadonlyMap<string, AttachedAdapter> | undefined): void {
    if (!handles) {
      return;
    }
    for (const handle of handles.values()) {
      handle.detach?.();
    }
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

  private setAdapterDiagnostic(serial: string, adapter: string, diagnostic: AdapterDiagnostic): void {
    const key = `${serial}:${adapter}:${diagnostic.code}:${diagnostic.capability}:${diagnostic.member}`;
    if (diagnostic.active) {
      if (this.adapterDiagnostics.get(key)?.diagnostic.reason === diagnostic.reason) {
        return;
      }
      this.adapterDiagnostics.set(key, { serial, adapter, diagnostic });
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

  private adapterDiagnosticCount(code: string): number {
    return [...this.adapterDiagnostics.values()].filter(({ diagnostic }) => diagnostic.code === code).length;
  }

  private clearAdapterDiagnostics(serial: string, onlyCode?: string, onlyAdapter?: string): void {
    const prefix = `${serial}:`;
    const removed = new Map<string, AdapterDiagnostic>();
    for (const [key, entry] of this.adapterDiagnostics) {
      if (
        key.startsWith(prefix) &&
        (onlyCode === undefined || entry.diagnostic.code === onlyCode) &&
        (onlyAdapter === undefined || entry.adapter === onlyAdapter)
      ) {
        this.adapterDiagnostics.delete(key);
        removed.set(entry.diagnostic.code, entry.diagnostic);
      }
    }
    for (const [code, removedDiagnostic] of removed) {
      const remaining = [...this.adapterDiagnostics.values()]
        .map((entry) => entry.diagnostic)
        .find((diagnostic) => diagnostic.code === code);
      this.diagnose({
        ...(remaining ?? { ...removedDiagnostic, reason: 'recovered', active: false }),
        active: remaining !== undefined,
        affectedDeviceCount: this.adapterDiagnosticCount(code),
      });
    }
  }
}
