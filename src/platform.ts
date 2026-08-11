import type { DynamicPlatformPlugin, PlatformAccessory, PlatformConfig } from 'homebridge';
import { join } from 'node:path';

import { AccountLease, AccountOwnership } from './account-ownership.js';
import { parseConfig, type EufyConfig } from './configuration.js';
import { createPersistedSdkClient, type SdkClient, type SdkClientFactory, type SdkStartResult } from './sdk-client.js';
import { AccountSessionPersistence, type ActiveAccountStores } from './session-persistence.js';
import { RuntimeTracker, type RuntimeState } from './runtime-tracker.js';

export type PlatformLifecycleEvent = 'didFinishLaunching' | 'shutdown';

export interface PlatformLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface PlatformApi {
  on(event: PlatformLifecycleEvent, listener: () => void): void;
  user?: { storagePath(): string };
}

export interface EufyPlatformConstructor {
  new (log: PlatformLogger, config: PlatformConfig, api: PlatformApi): DynamicPlatformPlugin;
}

export function createEufyPlatform(
  clientFactory: SdkClientFactory,
  shutdownTimeoutMs = 10_000,
): EufyPlatformConstructor {
  return class EufyPlatform implements DynamicPlatformPlugin {
    private client?: SdkClient;
    private startPromise?: Promise<void>;
    private stopPromise?: Promise<void>;
    private runtimeTracker?: RuntimeTracker;
    private ownership?: AccountOwnership;
    private accountScope?: string;
    private runtimeLease?: AccountLease;
    private runtimeState: RuntimeState = 'stopped';
    private stopping = false;
    private readonly configuredConfig: EufyConfig;
    private readonly storageRoot?: string;
    private readonly persistence?: AccountSessionPersistence;

    constructor(
      private readonly log: PlatformLogger,
      config: PlatformConfig,
      api: PlatformApi,
    ) {
      this.configuredConfig = parseConfig(config);
      if (api.user) {
        this.storageRoot = join(api.user.storagePath(), 'eufy-security');
        this.persistence = new AccountSessionPersistence(join(this.storageRoot, 'accounts'));
      } else {
        this.client = clientFactory(this.configuredConfig);
      }
      api.on('didFinishLaunching', () => {
        void this.start();
      });
      api.on('shutdown', () => {
        void this.stop();
      });
    }

    private start(): Promise<void> {
      if (this.stopPromise) {
        return Promise.resolve();
      }

      this.startPromise ??= this.startClient();
      return this.startPromise;
    }

    private async startClient(): Promise<void> {
      try {
        const { active, config } = await this.activeAccount();
        if (this.storageRoot && !active) {
          return;
        }
        if (this.storageRoot && config.username?.trim()) {
          this.accountScope = config.username.trim().toLowerCase();
          this.ownership = new AccountOwnership(join(this.storageRoot, 'ownership'));
          this.runtimeTracker = new RuntimeTracker(
            join(this.storageRoot, 'tracker.json'),
            90_000,
            Date.now,
            (error) => {
              const message = error instanceof Error ? error.message : String(error);
              this.log.warn(`Runtime status publication failed: ${message}`);
            },
          );
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
            !this.runtimeTracker?.start('starting', {
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
            this.runtimeTracker.update('authentication-required', {
              generation: active.generation,
              snapshot: previousSnapshot,
            });
            this.runtimeState = 'authentication-required';
            return;
          }
          this.client = clientFactory(config, active);
          this.client.onInventory?.((result) => {
            void this.applyRuntimeResult(active, result).catch((error: unknown) => this.failRuntime(error));
          });
          const result = await this.client.start();
          if (!result) {
            return;
          }
          await this.applyRuntimeResult(active, result);
          return;
        }
        this.client ??= clientFactory(config, active ?? undefined);
        await this.client.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Eufy SDK startup failed: ${message}`);
        this.stopping = true;
        await this.stopWithinDeadline(false, 'failed');
      }
    }

    private stop(): Promise<void> {
      this.stopping = true;
      if (this.runtimeState !== 'owner-conflict') {
        this.runtimeState = 'stopping';
        this.runtimeTracker?.update('stopping');
      }
      this.stopPromise ??= this.stopWithinDeadline();
      return this.stopPromise;
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

    private async activeAccount(): Promise<{ active: ActiveAccountStores | null; config: EufyConfig }> {
      const active = await this.persistence?.active();
      const configuration = active?.configuration.load();
      if (!active) {
        if (this.storageRoot) {
          this.runtimeTracker ??= new RuntimeTracker(join(this.storageRoot, 'tracker.json'));
          this.runtimeTracker.update('authentication-required');
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

    private async applyRuntimeResult(active: ActiveAccountStores, result: SdkStartResult): Promise<void> {
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
        this.runtimeTracker?.update('authentication-required', {
          generation: active.generation,
          complete: false,
          snapshot: previousSnapshot,
        });
        return;
      }
      if (result.state === 'degraded') {
        this.runtimeTracker?.update('degraded', {
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
        !this.runtimeTracker?.update('ready', {
          generation: active.generation,
          complete: true,
          snapshot: result.snapshot,
        })
      ) {
        throw new Error('complete runtime snapshot could not be published');
      }
      this.runtimeState = 'ready';
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
        timer = setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
        timer.unref();
      });
      const result = await Promise.race([stop, timeout]);
      clearTimeout(timer!);

      if (result === 'stopped') {
        if (this.runtimeState === 'owner-conflict') {
          return;
        }
        if (completedState === 'stopped') {
          this.runtimeTracker?.stop();
          this.runtimeState = 'stopped';
        } else {
          this.runtimeTracker?.update('failed');
          this.runtimeState = 'failed';
        }
      } else if (result === 'timeout') {
        this.log.warn(`Eufy SDK shutdown exceeded ${shutdownTimeoutMs}ms; Homebridge shutdown will continue`);
      }
    }

    configureAccessory(_accessory: PlatformAccessory): void {}
  };
}

export const EufyPlatform = createEufyPlatform(createPersistedSdkClient);
