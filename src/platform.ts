import type { DynamicPlatformPlugin, PlatformAccessory, PlatformConfig } from 'homebridge';

import { parseConfig } from './configuration.js';
import { RuntimeOwner } from './runtime/owner.js';
import { createPersistedSdkClient, type SdkClientFactory } from './runtime/sdk-client.js';
import { resolveStorageRoot } from './storage.js';

export type PlatformLifecycleEvent = 'didFinishLaunching' | 'shutdown';
export type PlatformSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

export interface PlatformSignalTarget {
  on(event: PlatformSignal, listener: () => void): unknown;
  off(event: PlatformSignal, listener: () => void): unknown;
}

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
  signalTarget?: PlatformSignalTarget,
): EufyPlatformConstructor {
  return class EufyPlatform implements DynamicPlatformPlugin {
    private readonly runtime: RuntimeOwner;

    constructor(log: PlatformLogger, config: PlatformConfig, api: PlatformApi) {
      const configuredConfig = parseConfig(config);
      const storageRoot = api.user ? resolveStorageRoot(api.user.storagePath()) : undefined;
      this.runtime = new RuntimeOwner(log, configuredConfig, clientFactory, { storageRoot, shutdownTimeoutMs });
      const signals: PlatformSignal[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];
      let listeningForSignals = Boolean(signalTarget);
      const stop = (): void => {
        if (listeningForSignals) {
          listeningForSignals = false;
          for (const signal of signals) {
            signalTarget?.off(signal, stop);
          }
        }
        void this.runtime.stop();
      };
      for (const signal of signals) {
        signalTarget?.on(signal, stop);
      }
      api.on('didFinishLaunching', () => {
        void this.runtime.start();
      });
      api.on('shutdown', stop);
    }

    configureAccessory(_accessory: PlatformAccessory): void {}
  };
}

export const EufyPlatform = createEufyPlatform(createPersistedSdkClient, 10_000, process);
