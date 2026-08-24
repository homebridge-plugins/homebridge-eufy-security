import { join } from 'node:path';

import type { AnyDeviceEvent, AvailabilityObservation, Device, FcmStore, SessionStore } from '@mega-yfue/eufy-sdk';

import { AccountOwnership, type AccountOwnerEvidence, type AccountReleaseResult } from '../account/ownership.js';
import { AccountSessionPersistence } from '../account/persistence.js';
import type { EufyConfig } from '../configuration.js';
import { reportRuntimeNotice, type PlatformLogger, type RuntimeState } from '../diagnostics.js';
import { parseCompleteDeviceSnapshot, type CompleteDeviceSnapshot } from '../device/snapshot.js';
import type { SdkClient, SdkClientFactory, SdkStartResult } from './sdk-client.js';
import { RuntimeTracker, type RuntimeTrackerUpdate } from './tracker.js';

export type RuntimeLogger = Pick<PlatformLogger, 'error' | 'warn'> & Partial<Pick<PlatformLogger, 'debug' | 'info'>>;

export interface RuntimeOwnership {
  acquire(
    accountScope: string,
    kind: 'runtime',
  ): Promise<
    | { state: 'owner'; lease: RuntimeLease; recovered: boolean }
    | { state: 'owner-conflict'; owner: AccountOwnerEvidence }
  >;
}

type RuntimeOwnershipResult = Awaited<ReturnType<RuntimeOwnership['acquire']>>;

export interface RuntimeLease {
  release(onReleased?: () => void): Promise<AccountReleaseResult>;
}

export interface RuntimePersistence {
  active(): Promise<RuntimeActiveAccount | null>;
}

export interface RuntimeActiveAccount {
  account: string;
  generation: string;
  configuration: { load(): EufyConfig | null };
  session: SessionStore;
  push: FcmStore;
  snapshot: {
    load(): CompleteDeviceSnapshot | null;
    save(value: CompleteDeviceSnapshot): void;
  };
}

export interface RuntimeStatusPublisher {
  start(state?: RuntimeState, update?: RuntimeTrackerUpdate): boolean;
  update(state: RuntimeState, update?: RuntimeTrackerUpdate): boolean;
  stop(): void;
}

export interface RuntimeOwnerOptions {
  storageRoot?: string;
  shutdownTimeoutMs?: number;
  ownership?: RuntimeOwnership;
  persistence?: RuntimePersistence;
  statusPublisher?: RuntimeStatusPublisher;
}

export interface RuntimeRegistryView {
  readonly version: number;
  readonly generation: string;
  readonly registry: ReadonlyMap<string, Device>;
  readonly snapshot: CompleteDeviceSnapshot;
}

export type RuntimeRegistryListener = (view: RuntimeRegistryView) => void;
export type RuntimeEventListener = (event: AnyDeviceEvent) => void;
export type RuntimeStateListener = (state: RuntimeState) => void;

/** Owns the long-lived SDK session, canonical registry, and runtime state transitions. */
export class RuntimeOwner {
  private client?: SdkClient;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private statusPublisher?: RuntimeStatusPublisher;
  private statusPublisherActive = false;
  private ownership?: RuntimeOwnership;
  private accountScope?: string;
  private runtimeLease?: RuntimeLease;
  private pendingOwnership?: Promise<RuntimeOwnershipResult>;
  private runtimeState: RuntimeState = 'stopped';
  private registryView?: RuntimeRegistryView;
  private registryVersion = 0;
  private readonly registryListeners = new Set<RuntimeRegistryListener>();
  private readonly eventListeners = new Set<RuntimeEventListener>();
  private readonly stateListeners = new Set<RuntimeStateListener>();
  private stopping = false;
  private cleanupTerminalState?: 'authentication-required' | 'failed' | 'stopped';
  private readonly storageRoot?: string;
  private readonly persistence?: RuntimePersistence;
  private readonly shutdownTimeoutMs: number;

  constructor(
    private readonly log: RuntimeLogger,
    private readonly configuredConfig: EufyConfig,
    private readonly clientFactory: SdkClientFactory,
    options: RuntimeOwnerOptions = {},
  ) {
    this.storageRoot = options.storageRoot;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.ownership = options.ownership;
    this.statusPublisher = options.statusPublisher;
    if (this.storageRoot) {
      this.persistence = options.persistence ?? new AccountSessionPersistence(join(this.storageRoot, 'accounts'));
    } else {
      this.persistence = options.persistence;
      this.client = clientFactory(configuredConfig);
    }
  }

  start(): Promise<void> {
    if (this.stopPromise) {
      return Promise.resolve();
    }
    this.startPromise ??= this.startClient();
    return this.startPromise;
  }

  currentRegistry(): RuntimeRegistryView | undefined {
    return this.registryView;
  }

  currentState(): RuntimeState {
    return this.runtimeState;
  }

  currentAvailability(serial: string): AvailabilityObservation | undefined {
    return this.client?.deviceAvailability?.(serial);
  }

  subscribeRegistry(listener: RuntimeRegistryListener): () => void {
    this.registryListeners.add(listener);
    return () => this.registryListeners.delete(listener);
  }

  subscribeEvents(listener: RuntimeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeState(listener: RuntimeStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  stop(): Promise<void> {
    this.cleanupTerminalState = 'stopped';
    if (!this.stopPromise) {
      this.stopping = true;
      if (this.runtimeState !== 'owner-conflict') {
        this.transitionTo('stopping');
        if (this.statusPublisherActive) {
          this.statusPublisher?.update('stopping');
        }
      }
      this.stopPromise = this.cleanupWithinDeadline('stopped');
    } else if (
      this.runtimeState !== 'owner-conflict' &&
      this.runtimeState !== 'failed' &&
      this.runtimeState !== 'stopping'
    ) {
      this.transitionTo('stopping');
      if (this.statusPublisherActive) {
        this.statusPublisher?.update('stopping');
      }
    }
    return this.stopPromise.then(() => {
      if (this.runtimeState !== 'owner-conflict' && this.runtimeState !== 'failed' && this.runtimeState !== 'stopped') {
        if (this.statusPublisherActive) {
          this.statusPublisher?.stop();
        }
        this.transitionTo('stopped');
      }
    });
  }

  private async startClient(): Promise<void> {
    try {
      const { active, config } = await this.activeAccount();
      if (this.stopping) {
        return;
      }
      if (this.storageRoot && !active) {
        this.statusPublisher ??= this.createStatusPublisher();
        this.statusPublisherActive = this.statusPublisher.update('authentication-required');
        this.transitionTo('authentication-required');
        return;
      }
      if (this.storageRoot && config.username?.trim()) {
        this.accountScope = config.username.trim().toLowerCase();
        this.ownership ??= new AccountOwnership(join(this.storageRoot, 'ownership'));
        this.statusPublisher ??= this.createStatusPublisher();
      }
      if (this.ownership && this.accountScope && active) {
        this.transitionTo('acquiring-ownership');
        const pendingOwnership = this.ownership.acquire(this.accountScope, 'runtime');
        this.pendingOwnership = pendingOwnership;
        const ownership = await pendingOwnership;
        if (this.stopping) {
          return;
        }
        this.pendingOwnership = undefined;
        if (ownership.state === 'owner-conflict') {
          this.transitionTo('owner-conflict');
          return;
        }
        this.runtimeLease = ownership.lease;
        const previousSnapshot = active.snapshot.load() ?? undefined;
        if (
          !this.statusPublisher?.start('starting', {
            generation: active.generation,
            complete: false,
            snapshot: previousSnapshot,
          })
        ) {
          throw new Error('runtime status tracker could not be started');
        }
        this.statusPublisherActive = true;
        this.transitionTo('starting');
        if (!active.session.load()) {
          this.transitionTo('authentication-required');
          await this.beginCleanup('authentication-required', {
            generation: active.generation,
            complete: false,
            snapshot: previousSnapshot,
          });
          return;
        }
        this.client = this.clientFactory(config, active, this.log);
        this.client.onEvent?.((event) => this.publishEvent(event));
        this.client.onInventory?.((result) => {
          void this.applyRuntimeResult(active, result).catch((error: unknown) => this.failRuntime(error));
        });
        const result = await this.client.start();
        if (result) {
          await this.applyRuntimeResult(active, result);
        }
        return;
      }
      this.client ??= this.clientFactory(config, active ?? undefined, this.log);
      await this.client.start();
    } catch (error) {
      void error;
      await this.beginCleanup('failed');
    }
  }

  private async activeAccount(): Promise<{ active: RuntimeActiveAccount | null; config: EufyConfig }> {
    const active = await this.persistence?.active();
    const configuration = active?.configuration.load();
    if (!active) {
      return { active: null, config: this.configuredConfig };
    }
    if (!configuration) {
      if (this.configuredConfig.username?.trim().toLowerCase() !== active.account) {
        throw new Error('legacy active account generation does not match Homebridge configuration');
      }
      return { active, config: this.configuredConfig };
    }
    if (configuration.username?.trim().toLowerCase() !== active.account) {
      throw new Error('active account generation has mismatched configuration');
    }
    return { active, config: configuration };
  }

  private createStatusPublisher(): RuntimeStatusPublisher {
    return new RuntimeTracker(join(this.storageRoot!, 'tracker.json'), 90_000, Date.now, (error) => {
      void error;
      reportRuntimeNotice(this.log, 'status-publication-failed');
    });
  }

  private async applyRuntimeResult(active: RuntimeActiveAccount, result: SdkStartResult): Promise<void> {
    if (
      this.stopping ||
      (this.runtimeState === 'authentication-required' && result.state !== 'authentication-required')
    ) {
      return;
    }
    const previousSnapshot = active.snapshot.load() ?? undefined;
    if (result.state === 'authentication-required') {
      if (this.runtimeState === 'authentication-required') {
        return;
      }
      this.transitionTo('authentication-required');
      await this.beginCleanup('authentication-required', {
        generation: active.generation,
        complete: false,
        snapshot: previousSnapshot,
      });
      return;
    }
    if (result.state === 'degraded') {
      let latestSnapshot = previousSnapshot;
      const completeTopology = result.complete === true;
      if (completeTopology) {
        this.acceptCompleteRegistry(active, result.registry, result.snapshot);
        latestSnapshot = result.snapshot;
      }
      this.statusPublisher?.update('degraded', {
        generation: active.generation,
        complete: completeTopology,
        snapshot: latestSnapshot,
        status: completeTopology ? 'transport-degraded' : 'incomplete-inventory',
      });
      this.transitionTo('degraded');
      return;
    }
    this.acceptCompleteRegistry(active, result.registry, result.snapshot);
    if (
      !this.statusPublisher?.update('ready', {
        generation: active.generation,
        complete: true,
        snapshot: result.snapshot,
      })
    ) {
      throw new Error('complete runtime snapshot could not be published');
    }
    this.transitionTo('ready');
  }

  private acceptCompleteRegistry(
    active: RuntimeActiveAccount,
    registry: ReadonlyMap<string, Device>,
    snapshot: CompleteDeviceSnapshot,
  ): void {
    const registrySerials = [...registry.keys()].sort();
    const snapshotSerials = snapshot.devices.map((device) => device.sn).sort();
    if (JSON.stringify(registrySerials) !== JSON.stringify(snapshotSerials)) {
      throw new Error('canonical registry does not match its complete device snapshot');
    }
    active.snapshot.save(snapshot);
    this.publishRegistry(active.generation, registry, snapshot);
  }

  private async releaseRuntimeLease(onReleased: () => void = () => undefined): Promise<boolean> {
    const lease = this.runtimeLease;
    this.runtimeLease = undefined;
    if (!lease) {
      onReleased();
      return true;
    }
    try {
      let finalized = false;
      const release = await lease.release(() => {
        finalized = true;
        onReleased();
      });
      if (release.state !== 'stopped') {
        return false;
      }
      if (!finalized) {
        reportRuntimeNotice(this.log, 'ownership-release-not-finalized');
        return false;
      }
    } catch (error) {
      void error;
      reportRuntimeNotice(this.log, 'ownership-release-failed');
      return false;
    }
    return true;
  }

  private async stopRuntimeClient(): Promise<boolean> {
    const client = this.client;
    this.client = undefined;
    try {
      await client?.stop();
    } catch (error) {
      void error;
      reportRuntimeNotice(this.log, 'shutdown-failed');
      return false;
    }
    return true;
  }

  private async failRuntime(error: unknown): Promise<void> {
    void error;
    await this.beginCleanup('failed');
  }

  private beginCleanup(
    completedState: 'authentication-required' | 'failed' | 'stopped',
    update?: RuntimeTrackerUpdate,
  ): Promise<void> {
    this.stopping = true;
    if (!this.stopPromise) {
      this.cleanupTerminalState = completedState;
      this.stopPromise = this.cleanupWithinDeadline(completedState, update);
    }
    return this.stopPromise;
  }

  private async cleanupWithinDeadline(
    completedState: 'authentication-required' | 'failed' | 'stopped',
    update?: RuntimeTrackerUpdate,
  ): Promise<void> {
    if (this.runtimeState === 'owner-conflict') {
      return;
    }
    const deadline = Date.now() + this.shutdownTimeoutMs;
    const clientStopped = await this.boundedCleanup(this.stopRuntimeClient(), deadline);
    const ownershipSettled = await this.settlePendingOwnership(deadline);
    const cleanupFailedBeforeRelease = clientStopped !== true || ownershipSettled !== true;
    let publishedTerminalState = cleanupFailedBeforeRelease ? 'failed' : (this.cleanupTerminalState ?? completedState);
    const leaseReleased = await this.boundedCleanup(
      this.releaseRuntimeLease(() => this.publishTerminalState(publishedTerminalState, update)),
      deadline,
    );
    const timedOut = clientStopped === 'timeout' || ownershipSettled === 'timeout' || leaseReleased === 'timeout';
    if (timedOut) {
      reportRuntimeNotice(this.log, 'shutdown-timeout', { durationMs: this.shutdownTimeoutMs });
    }
    if (leaseReleased === 'timeout') {
      publishedTerminalState = 'failed';
      this.publishTerminalState('failed');
    }
    const terminalState = leaseReleased === true ? publishedTerminalState : 'failed';
    this.transitionTo(terminalState);
  }

  private publishTerminalState(
    terminalState: 'authentication-required' | 'failed' | 'stopped',
    update?: RuntimeTrackerUpdate,
  ): void {
    if (terminalState === 'stopped') {
      if (this.statusPublisherActive) {
        this.statusPublisher?.stop();
      }
    } else if (this.statusPublisherActive) {
      if (terminalState === 'authentication-required') {
        this.statusPublisher?.update(terminalState, update);
      } else {
        this.statusPublisher?.update(terminalState);
      }
    }
  }

  private async boundedCleanup(operation: Promise<boolean>, deadline: number): Promise<boolean | 'timeout'> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      timer.unref();
    });
    const result = await Promise.race([operation, timeout]);
    clearTimeout(timer!);
    return result;
  }

  private async settlePendingOwnership(deadline: number): Promise<boolean | 'timeout'> {
    const pendingOwnership = this.pendingOwnership;
    if (!pendingOwnership) {
      return true;
    }
    const acquisition = pendingOwnership
      .then((ownership) => {
        if (this.pendingOwnership === pendingOwnership) {
          this.pendingOwnership = undefined;
        }
        if (ownership.state === 'owner') {
          this.runtimeLease = ownership.lease;
        }
        return true;
      })
      .catch((error: unknown) => {
        void error;
        reportRuntimeNotice(this.log, 'ownership-acquisition-failed');
        return false;
      });
    const settled = await this.boundedCleanup(acquisition, deadline);
    if (settled === 'timeout') {
      void acquisition.then(async (acquired) => {
        if (!acquired) {
          return;
        }
        const released = await this.boundedCleanup(this.releaseRuntimeLease(), Date.now() + this.shutdownTimeoutMs);
        if (released !== true) {
          reportRuntimeNotice(this.log, 'ownership-release-incomplete');
        }
      });
    }
    return settled;
  }

  private publishRegistry(
    generation: string,
    registry: ReadonlyMap<string, Device>,
    snapshot: CompleteDeviceSnapshot,
  ): void {
    const view = Object.freeze({
      version: ++this.registryVersion,
      generation,
      registry: new Map(registry),
      snapshot: parseCompleteDeviceSnapshot(snapshot),
    });
    this.registryView = view;
    for (const listener of this.registryListeners) {
      try {
        listener(view);
      } catch {
        reportRuntimeNotice(this.log, 'registry-subscriber-failed');
      }
    }
  }

  private publishEvent(event: AnyDeviceEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        reportRuntimeNotice(this.log, 'event-subscriber-failed');
      }
    }
  }

  private transitionTo(state: RuntimeState): void {
    if (this.runtimeState === state) {
      return;
    }
    this.runtimeState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        reportRuntimeNotice(this.log, 'state-subscriber-failed');
      }
    }
  }
}
