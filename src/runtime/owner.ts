import { join } from 'node:path';

import type { FcmStore, SessionStore } from '@mega-yfue/eufy-sdk';

import { AccountOwnership, type AccountOwnerEvidence, type AccountReleaseResult } from '../account/ownership.js';
import { AccountSessionPersistence } from '../account/persistence.js';
import type { EufyConfig } from '../configuration.js';
import type { CompleteDeviceSnapshot } from '../device/snapshot.js';
import type { SdkClient, SdkClientFactory, SdkStartResult } from './sdk-client.js';
import { RuntimeTracker, type RuntimeState, type RuntimeTrackerUpdate } from './tracker.js';

export interface RuntimeLogger {
  error(message: string): void;
  warn(message: string): void;
}

export interface RuntimeOwnership {
  acquire(
    accountScope: string,
    kind: 'runtime',
  ): Promise<
    | { state: 'owner'; lease: RuntimeLease; recovered: boolean }
    | { state: 'owner-conflict'; owner: AccountOwnerEvidence }
  >;
}

export interface RuntimeLease {
  release(): Promise<AccountReleaseResult>;
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

/** Owns the long-lived SDK session, canonical registry, and runtime state transitions. */
export class RuntimeOwner {
  private client?: SdkClient;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private statusPublisher?: RuntimeStatusPublisher;
  private ownership?: RuntimeOwnership;
  private accountScope?: string;
  private runtimeLease?: RuntimeLease;
  private runtimeState: RuntimeState = 'stopped';
  private stopping = false;
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

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true;
      if (this.runtimeState !== 'owner-conflict') {
        this.runtimeState = 'stopping';
        this.statusPublisher?.update('stopping');
      }
      this.stopPromise = this.stopWithinDeadline();
    }
    return this.stopPromise;
  }

  private async startClient(): Promise<void> {
    try {
      const { active, config } = await this.activeAccount();
      if (this.storageRoot && !active) {
        return;
      }
      if (this.storageRoot && config.username?.trim()) {
        this.accountScope = config.username.trim().toLowerCase();
        this.ownership ??= new AccountOwnership(join(this.storageRoot, 'ownership'));
        this.statusPublisher ??= this.createStatusPublisher();
      }
      if (this.ownership && this.accountScope && active) {
        this.runtimeState = 'acquiring-ownership';
        const ownership = await this.ownership.acquire(this.accountScope, 'runtime');
        if (ownership.state === 'owner-conflict') {
          this.runtimeState = 'owner-conflict';
          this.log.error('Eufy SDK startup blocked by another live account owner');
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
          await this.runtimeLease.release();
          this.runtimeLease = undefined;
          return;
        }
        this.runtimeState = 'starting';
        if (!active.session.load()) {
          await this.releaseRuntimeLease();
          this.statusPublisher.update('authentication-required', {
            generation: active.generation,
            snapshot: previousSnapshot,
          });
          this.runtimeState = 'authentication-required';
          return;
        }
        this.client = this.clientFactory(config, active);
        this.client.onInventory?.((result) => {
          void this.applyRuntimeResult(active, result).catch((error: unknown) => this.failRuntime(error));
        });
        const result = await this.client.start();
        if (result) {
          await this.applyRuntimeResult(active, result);
        }
        return;
      }
      this.client ??= this.clientFactory(config, active ?? undefined);
      await this.client.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Eufy SDK startup failed: ${message}`);
      this.stopping = true;
      await this.stopWithinDeadline(false, 'failed');
    }
  }

  private async activeAccount(): Promise<{ active: RuntimeActiveAccount | null; config: EufyConfig }> {
    const active = await this.persistence?.active();
    const configuration = active?.configuration.load();
    if (!active) {
      if (this.storageRoot) {
        this.statusPublisher ??= this.createStatusPublisher();
        this.statusPublisher.update('authentication-required');
        this.runtimeState = 'authentication-required';
      }
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
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Runtime status publication failed: ${message}`);
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
      this.runtimeState = 'authentication-required';
      await this.client?.stop();
      await this.releaseRuntimeLease();
      this.statusPublisher?.update('authentication-required', {
        generation: active.generation,
        complete: false,
        snapshot: previousSnapshot,
      });
      return;
    }
    if (result.state === 'degraded') {
      this.statusPublisher?.update('degraded', {
        generation: active.generation,
        complete: false,
        snapshot: previousSnapshot,
      });
      this.runtimeState = 'degraded';
      return;
    }
    const registrySerials = [...result.registry.keys()].sort();
    const snapshotSerials = result.snapshot.devices.map((device) => device.sn).sort();
    if (JSON.stringify(registrySerials) !== JSON.stringify(snapshotSerials)) {
      throw new Error('canonical registry does not match its complete device snapshot');
    }
    active.snapshot.save(result.snapshot);
    if (
      !this.statusPublisher?.update('ready', {
        generation: active.generation,
        complete: true,
        snapshot: result.snapshot,
      })
    ) {
      throw new Error('complete runtime snapshot could not be published');
    }
    this.runtimeState = 'ready';
  }

  private async releaseRuntimeLease(): Promise<boolean> {
    if (!this.runtimeLease) {
      return true;
    }
    const release = await this.runtimeLease.release();
    if (release.state !== 'stopped') {
      return false;
    }
    this.runtimeLease = undefined;
    return true;
  }

  private async stopClient(): Promise<'failed' | 'stopped'> {
    try {
      await this.client?.stop();
      if (!(await this.releaseRuntimeLease())) {
        return 'failed';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Eufy SDK shutdown failed: ${message}`);
      return 'failed';
    }
    return 'stopped';
  }

  private async failRuntime(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error(`Eufy SDK runtime failed: ${message}`);
    this.stopping = true;
    await this.stopWithinDeadline(false, 'failed');
  }

  private async stopWithinDeadline(
    waitForStart = true,
    completedState: 'failed' | 'stopped' = 'stopped',
  ): Promise<void> {
    const stop =
      waitForStart && this.startPromise ? this.startPromise.then(() => this.stopClient()) : this.stopClient();
    let timer: NodeJS.Timeout;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.shutdownTimeoutMs);
      timer.unref();
    });
    const result = await Promise.race([stop, timeout]);
    clearTimeout(timer!);

    if (result === 'stopped') {
      if (this.runtimeState === 'owner-conflict') {
        return;
      }
      if (completedState === 'stopped') {
        this.statusPublisher?.stop();
        this.runtimeState = 'stopped';
      } else {
        this.statusPublisher?.update('failed');
        this.runtimeState = 'failed';
      }
    } else if (result === 'timeout') {
      this.log.warn(`Eufy SDK shutdown exceeded ${this.shutdownTimeoutMs}ms; Homebridge shutdown will continue`);
    }
  }
}
