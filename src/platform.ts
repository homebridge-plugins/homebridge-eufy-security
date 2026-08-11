import type { DynamicPlatformPlugin, PlatformAccessory, PlatformConfig } from 'homebridge';
import { join } from 'node:path';

import { AccountLease, AccountOwnership } from './account-ownership.js';
import { parseConfig } from './configuration.js';
import { createSyntheticSdkClient, type SdkClient, type SdkClientFactory } from './sdk-client.js';
import { RuntimeTracker } from './runtime-tracker.js';

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
    private readonly client: SdkClient;
    private startPromise?: Promise<void>;
    private stopPromise?: Promise<void>;
    private readonly runtimeTracker?: RuntimeTracker;
    private readonly ownership?: AccountOwnership;
    private readonly accountScope?: string;
    private runtimeLease?: AccountLease;

    constructor(
      private readonly log: PlatformLogger,
      config: PlatformConfig,
      api: PlatformApi,
    ) {
      const parsedConfig = parseConfig(config);
      this.client = clientFactory(parsedConfig);
      if (api.user && parsedConfig.username?.trim()) {
        const root = join(api.user.storagePath(), 'eufy-security');
        this.accountScope = parsedConfig.username.trim().toLowerCase();
        this.ownership = new AccountOwnership(join(root, 'ownership'));
        this.runtimeTracker = new RuntimeTracker(join(root, 'tracker.json'), 90_000, Date.now, (error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn(`Runtime status publication failed: ${message}`);
        });
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
        if (this.ownership && this.accountScope) {
          const ownership = await this.ownership.acquire(this.accountScope, 'runtime');
          if (ownership.state === 'owner-conflict') {
            this.log.error('Eufy SDK startup blocked by another live account owner');
            return;
          }
          this.runtimeLease = ownership.lease;
          if (!this.runtimeTracker?.start()) {
            await this.runtimeLease.release();
            this.runtimeLease = undefined;
            return;
          }
        }
        await this.client.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Eufy SDK startup failed: ${message}`);
        await this.stopWithinDeadline(false);
      }
    }

    private stop(): Promise<void> {
      this.stopPromise ??= this.stopWithinDeadline();
      return this.stopPromise;
    }

    private async stopClient(): Promise<'failed' | 'stopped'> {
      try {
        await this.client.stop();
        if (this.runtimeLease) {
          const release = await this.runtimeLease.release();
          if (release.state !== 'stopped') {
            return 'failed';
          }
          this.runtimeLease = undefined;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Eufy SDK shutdown failed: ${message}`);
        return 'failed';
      }

      return 'stopped';
    }

    private async stopWithinDeadline(waitForStart = true): Promise<void> {
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
        this.runtimeTracker?.stop();
      } else if (result === 'timeout') {
        this.log.warn(`Eufy SDK shutdown exceeded ${shutdownTimeoutMs}ms; Homebridge shutdown will continue`);
      }
    }

    configureAccessory(_accessory: PlatformAccessory): void {}
  };
}

export const EufyPlatform = createEufyPlatform(createSyntheticSdkClient);
