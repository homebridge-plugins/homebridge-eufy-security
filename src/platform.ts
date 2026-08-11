import type { DynamicPlatformPlugin, PlatformAccessory, PlatformConfig } from 'homebridge';
import { join } from 'node:path';

import { parseConfig } from './configuration.js';
import { RuntimeOwner } from './runtime/owner.js';
import { createPersistedSdkClient, type SdkClientFactory } from './runtime/sdk-client.js';

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
    private readonly runtime: RuntimeOwner;

    constructor(log: PlatformLogger, config: PlatformConfig, api: PlatformApi) {
      const configuredConfig = parseConfig(config);
      const storageRoot = api.user ? join(api.user.storagePath(), 'eufy-security') : undefined;
      this.runtime = new RuntimeOwner(log, configuredConfig, clientFactory, { storageRoot, shutdownTimeoutMs });
      api.on('didFinishLaunching', () => {
        void this.runtime.start();
      });
      api.on('shutdown', () => {
        void this.runtime.stop();
      });
    }

    configureAccessory(_accessory: PlatformAccessory): void {}
  };
}

export const EufyPlatform = createEufyPlatform(createPersistedSdkClient);
