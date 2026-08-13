import type { API, DynamicPlatformPlugin, HAP, PlatformAccessory, PlatformConfig } from 'homebridge';

import { parseConfig } from './configuration.js';
import {
  HomeKitReconciler,
  type HomeKitAccessoryStore,
  type HomeKitDiagnostic,
  type HomeKitEventTrace,
} from './homekit/reconciler.js';
import { RuntimeOwner } from './runtime/owner.js';
import { createPersistedSdkClient, type SdkClientFactory } from './runtime/sdk-client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { resolveStorageRoot } from './storage.js';

export type PlatformLifecycleEvent = 'didFinishLaunching' | 'shutdown';
export type PlatformSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

export interface PlatformSignalTarget {
  on(event: PlatformSignal, listener: () => void): unknown;
  off(event: PlatformSignal, listener: () => void): unknown;
}

export interface PlatformLogger {
  debug?(message: string): void;
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface PlatformApi {
  on(event: PlatformLifecycleEvent, listener: () => void): void;
  user?: { storagePath(): string };
  hap?: HAP;
  platformAccessory?: API['platformAccessory'];
  registerPlatformAccessories?: API['registerPlatformAccessories'];
  updatePlatformAccessories?: API['updatePlatformAccessories'];
  unregisterPlatformAccessories?: API['unregisterPlatformAccessories'];
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
    private readonly cachedAccessories: PlatformAccessory[] = [];
    private reconciler?: HomeKitReconciler;

    constructor(log: PlatformLogger, config: PlatformConfig, api: PlatformApi) {
      const configuredConfig = parseConfig(config);
      if (configuredConfig.discardedV4Settings.length > 0 && !configuredConfig.discardedV4Acknowledged) {
        log.warn('Discarded V4 settings need acknowledgement in the Homebridge Eufy dashboard');
      }
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
        this.reconciler?.stop();
        void this.runtime.stop();
      };
      for (const signal of signals) {
        signalTarget?.on(signal, stop);
      }
      api.on('didFinishLaunching', () => {
        const accessoryStore = createAccessoryStore(api);
        if (accessoryStore) {
          this.reconciler ??= new HomeKitReconciler(
            this.runtime,
            accessoryStore,
            (diagnostic) => reportHomeKitDiagnostic(log, diagnostic),
            this.cachedAccessories,
            (trace) => reportHomeKitEvent(log, trace),
            configuredConfig.entityPreferences,
          );
          this.reconciler.start();
        }
        void this.runtime.start();
      });
      api.on('shutdown', stop);
    }

    configureAccessory(accessory: PlatformAccessory): void {
      this.cachedAccessories.push(accessory);
    }
  };
}

function createAccessoryStore(api: PlatformApi): HomeKitAccessoryStore | undefined {
  if (
    !api.hap ||
    !api.platformAccessory ||
    !api.registerPlatformAccessories ||
    !api.updatePlatformAccessories ||
    !api.unregisterPlatformAccessories
  ) {
    return undefined;
  }
  return {
    hap: api.hap,
    generateUuid: (input) => api.hap!.uuid.generate(input),
    createAccessory: (name, uuid) => new api.platformAccessory!(name, uuid),
    register: (accessories) => api.registerPlatformAccessories!(PLUGIN_NAME, PLATFORM_NAME, accessories),
    update: (accessories) => api.updatePlatformAccessories!(accessories),
    unregister: (accessories) => api.unregisterPlatformAccessories!(PLUGIN_NAME, PLATFORM_NAME, accessories),
  };
}

function reportHomeKitDiagnostic(log: PlatformLogger, diagnostic: HomeKitDiagnostic): void {
  const message = JSON.stringify({ scope: 'homekit', ...diagnostic });
  if (diagnostic.active) {
    log.warn(message);
  } else {
    log.info(message);
  }
}

function reportHomeKitEvent(log: PlatformLogger, trace: HomeKitEventTrace): void {
  log.debug?.(JSON.stringify({ scope: 'homekit', ...trace }));
}

export const EufyPlatform = createEufyPlatform(createPersistedSdkClient, 10_000, process);
