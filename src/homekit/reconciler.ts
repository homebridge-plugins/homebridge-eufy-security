import type { AnyDeviceEvent, AvailabilityObservation, Device } from '@mega-yfue/eufy-sdk';
import type { PlatformAccessory } from 'homebridge';

import type { CompleteDeviceSnapshot } from '../device/snapshot.js';
import { indexDeviceEvidence } from '../device/member-evidence.js';
import type {
  LiveMediaAdapter,
  MediaSessionBudget,
  RecordingMediaAdapter,
  SnapshotMediaAdapter,
  SnapshotMode,
} from '../media/contracts.js';
import type {
  AdapterDetachmentReason,
  AdapterDiagnostic,
  AdapterTrace,
  AttachedAdapter,
  HomeKitDefinitions,
} from './adapter.js';
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
  currentAvailability?(serial: string): AvailabilityObservation | undefined;
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

export type HomeKitDiagnostic = RepresentationDiagnostic | AdapterDiagnostic;
export type HomeKitDiagnosticSink = (diagnostic: HomeKitDiagnostic, affectedDeviceIds: readonly string[]) => void;

/** Redacted debug evidence that an SDK event reached one self-hosted adapter. */
export type HomeKitEventReport = { adapter: string } & AdapterTrace;

export type HomeKitEventReportSink = (trace: HomeKitEventReport) => void;

export type HomeKitEntityPreferences = Readonly<
  Record<string, { represented?: boolean; audio?: boolean; snapshotMode?: SnapshotMode }>
>;

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
    private readonly trace?: HomeKitEventReportSink,
    private readonly entityPreferences: HomeKitEntityPreferences = {},
    private readonly liveMedia?: LiveMediaAdapter,
    private readonly snapshotMedia?: SnapshotMediaAdapter,
    private readonly recordingMedia?: RecordingMediaAdapter,
    private readonly mediaBudget?: MediaSessionBudget,
  ) {
    for (const accessory of cachedAccessories) {
      this.accessories.set(accessory.UUID, accessory);
      const context = accessory.context as AccessoryContext;
      const serial = context.homebridgeEufy?.version === 1 ? context.homebridgeEufy.serial : context.device?.uniqueId;
      if (serial && accessory.UUID === this.store.generateUuid(`d1_${serial}`)) {
        this.representedSerials.add(serial);
      }
    }
    for (const [serial, preference] of Object.entries(this.entityPreferences)) {
      if (preference.represented === false) {
        this.snapshotMedia?.discard?.(serial);
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
      this.detachAdapters(serial, 'shutdown');
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
    this.snapshotMedia?.reconcile?.(manifests.keys());

    const nextRepresented = new Set<string>();
    for (const [serial, device] of view.registry) {
      const previousHandles = this.attachedAdapters.get(serial);
      const manifest = manifests.get(serial)!;
      const evidence = indexDeviceEvidence(manifest);
      const admittedAdapters = admittedHomeKitAdapters(manifest, evidence);
      const admittedKeys = new Set(admittedAdapters.map(([key]) => key));
      for (const previousKey of this.activeAdapters.get(serial) ?? []) {
        if (!admittedKeys.has(previousKey)) {
          this.clearAdapterDiagnostics(serial, undefined, previousKey);
        }
      }
      this.activeAdapters.set(serial, admittedKeys);
      if (this.entityPreferences[serial]?.represented === false) {
        this.snapshotMedia?.discard?.(serial);
        this.detachHandles(previousHandles);
        this.attachedAdapters.delete(serial);
        this.clearRepresentationDiagnostic(serial);
        continue;
      }
      const admittedPrimaryAdapters = admittedAdapters.filter(([, adapter]) => adapter.role === 'primary-purpose');
      if (admittedPrimaryAdapters.length === 0) {
        this.snapshotMedia?.discard?.(serial);
        this.detachHandles(previousHandles);
        this.attachedAdapters.delete(serial);
        this.setRepresentationDiagnostic(serial, 'no-primary-purpose-member');
        continue;
      }

      const uuid = this.store.generateUuid(`d1_${serial}`);
      const existing = this.accessories.get(uuid);
      const accessory = existing ?? this.store.createAccessory(manifest.name, uuid);
      const handles = new Map<string, AttachedAdapter>();
      const attachOrRetain = (key: string, adapter: (typeof admittedAdapters)[number][1]): boolean => {
        const handle = adapter.attach({
          device,
          evidence: evidence.members,
          accessory,
          hap: this.store.hap,
          liveMedia: this.liveMedia,
          recordingMedia: this.recordingMedia,
          snapshotMedia: this.snapshotMedia,
          ...(this.mediaBudget ? { mediaBudget: this.mediaBudget } : {}),
          audioEnabled: this.entityPreferences[serial]?.audio !== false,
          snapshotMode: this.entityPreferences[serial]?.snapshotMode ?? 'Refresh',
          availability: () => this.source.currentAvailability?.(serial),
          diagnose: (diagnostic) => this.setAdapterDiagnostic(serial, key, diagnostic),
          observed: (code) => this.clearAdapterDiagnostics(serial, code, key),
          trace: (trace) => this.trace?.({ adapter: key, ...trace }),
          persist: () => this.store.update([accessory]),
        });
        if (handle) {
          handles.set(key, handle);
        } else {
          const previous = previousHandles?.get(key);
          if (previous) {
            handles.set(key, previous);
          }
        }
        return handles.has(key);
      };
      let primaryAvailable = false;
      for (const [key, adapter] of admittedPrimaryAdapters) {
        primaryAvailable = attachOrRetain(key, adapter) || primaryAvailable;
      }
      if (!primaryAvailable) {
        this.snapshotMedia?.discard?.(serial);
        this.detachReplacedHandles(previousHandles, handles);
        this.attachedAdapters.set(serial, handles);
        this.setRepresentationDiagnostic(serial, 'primary-adapter-unavailable');
        continue;
      }

      accessory.updateDisplayName(manifest.name);
      (accessory.context as AccessoryContext).homebridgeEufy = { version: 1, serial };
      for (const [key, adapter] of admittedAdapters) {
        if (adapter.role === 'supplemental') {
          attachOrRetain(key, adapter);
        }
      }
      this.detachReplacedHandles(previousHandles, handles);
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

  private detachAdapters(serial: string, reason: AdapterDetachmentReason = 'withdrawal'): void {
    const handles = this.attachedAdapters.get(serial);
    this.detachHandles(handles, reason);
    this.attachedAdapters.delete(serial);
  }

  private detachHandles(
    handles: ReadonlyMap<string, AttachedAdapter> | undefined,
    reason: AdapterDetachmentReason = 'withdrawal',
  ): void {
    if (!handles) {
      return;
    }
    for (const handle of handles.values()) {
      handle.detach?.(reason);
    }
  }

  private detachReplacedHandles(
    previous: ReadonlyMap<string, AttachedAdapter> | undefined,
    next: ReadonlyMap<string, AttachedAdapter>,
  ): void {
    if (!previous) {
      return;
    }
    for (const [key, handle] of previous) {
      if (next.get(key) !== handle) {
        handle.detach?.('replacement');
      }
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
    const aggregateReason = [...this.representationDiagnostics.values()].sort()[0]!;
    this.diagnose(
      {
        code: 'recognized-device-not-represented',
        active: true,
        reason: aggregateReason,
      },
      [...this.representationDiagnostics.keys()],
    );
  }

  private clearRepresentationDiagnostic(serial: string): void {
    if (!this.representationDiagnostics.delete(serial)) {
      return;
    }
    const remainingReason = [...this.representationDiagnostics.values()].sort()[0];
    this.diagnose(
      {
        code: 'recognized-device-not-represented',
        active: remainingReason !== undefined,
        reason: remainingReason ?? 'recovered',
      },
      [...this.representationDiagnostics.keys()],
    );
  }

  private setAdapterDiagnostic(serial: string, adapter: string, diagnostic: AdapterDiagnostic): void {
    const key = `${serial}:${adapter}:${diagnostic.code}:${diagnostic.capability}:${diagnostic.member}`;
    if (diagnostic.active) {
      if (this.adapterDiagnostics.get(key)?.diagnostic.reason === diagnostic.reason) {
        return;
      }
      this.adapterDiagnostics.set(key, { serial, adapter, diagnostic });
      this.publishAdapterDiagnostic(diagnostic);
      return;
    }
    if (this.adapterDiagnostics.delete(key)) {
      this.publishAdapterDiagnostic(diagnostic);
    }
  }

  private adapterDiagnosticDeviceIds(condition: AdapterDiagnostic): string[] {
    return [
      ...new Set(
        [...this.adapterDiagnostics.values()]
          .filter(({ diagnostic }) => this.sameAdapterCondition(diagnostic, condition))
          .map(({ serial }) => serial),
      ),
    ];
  }

  private sameAdapterCondition(left: AdapterDiagnostic, right: AdapterDiagnostic): boolean {
    return left.code === right.code && left.capability === right.capability && left.member === right.member;
  }

  private publishAdapterDiagnostic(changed: AdapterDiagnostic): void {
    const remaining = [...this.adapterDiagnostics.values()]
      .map(({ diagnostic }) => diagnostic)
      .filter((diagnostic) => this.sameAdapterCondition(diagnostic, changed))
      .sort((left, right) => left.reason.localeCompare(right.reason))[0];
    const affectedDeviceIds = this.adapterDiagnosticDeviceIds(changed);
    this.diagnose(
      {
        ...(remaining ?? changed),
        active: remaining !== undefined,
      },
      affectedDeviceIds,
    );
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
        removed.set(
          `${entry.diagnostic.code}:${entry.diagnostic.capability}:${entry.diagnostic.member}`,
          entry.diagnostic,
        );
      }
    }
    for (const removedDiagnostic of removed.values()) {
      this.publishAdapterDiagnostic({ ...removedDiagnostic, reason: 'recovered', active: false });
    }
  }
}
