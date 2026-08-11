import type { DynamicPlatformPlugin, PlatformAccessory, PlatformConfig } from 'homebridge';

import { createSyntheticSdkClient, type SdkClient, type SdkClientFactory } from './sdk-client.js';

export type PlatformLifecycleEvent = 'didFinishLaunching' | 'shutdown';

export interface PlatformLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface PlatformApi {
  on(event: PlatformLifecycleEvent, listener: () => void): void;
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

    constructor(
      private readonly log: PlatformLogger,
      _config: PlatformConfig,
      api: PlatformApi,
    ) {
      this.client = clientFactory();
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
        await this.client.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Eufy SDK startup failed: ${message}`);
      }
    }

    private stop(): Promise<void> {
      this.stopPromise ??= this.stopWithinDeadline();
      return this.stopPromise;
    }

    private async stopClient(): Promise<'stopped'> {
      try {
        await this.client.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Eufy SDK shutdown failed: ${message}`);
      }

      return 'stopped';
    }

    private async stopWithinDeadline(): Promise<void> {
      const stop = this.startPromise ? this.startPromise.then(() => this.stopClient()) : this.stopClient();

      let timer: NodeJS.Timeout;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
        timer.unref();
      });
      const result = await Promise.race([stop, timeout]);
      clearTimeout(timer!);

      if (result === 'timeout') {
        this.log.warn(`Eufy SDK shutdown exceeded ${shutdownTimeoutMs}ms; Homebridge shutdown will continue`);
      }
    }

    configureAccessory(_accessory: PlatformAccessory): void {}
  };
}

export const EufyPlatform = createEufyPlatform(createSyntheticSdkClient);
