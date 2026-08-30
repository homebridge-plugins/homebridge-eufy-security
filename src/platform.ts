import type { API, DynamicPlatformPlugin, HAP, PlatformAccessory, PlatformConfig } from 'homebridge';

import { ffmpegPathSource, parseConfig } from './configuration.js';
import {
  createDiagnosticLogger,
  DiagnosticConditions,
  recordFfmpegEnvironment,
  reportAdaptationNotice,
  reportDiscardedV4Settings,
  reportHomeKitEvent,
  unconfirmedWriteCondition,
  reportInvalidSnapshotCache,
  type PlatformLogger,
} from './diagnostics.js';
import { HomeKitReconciler, type HomeKitAccessoryStore } from './homekit/reconciler.js';
import type { AdaptationDiagnostics } from './media/contracts.js';
import { FfmpegLiveMedia, resolveFfmpegIdentity } from './media/live-stream.js';
import { FfmpegRecordingMedia } from './media/recording.js';
import { PersistedLastSuccessfulImages } from './media/last-successful-image.js';
import { SnapshotAcquisition } from './media/snapshot.js';
import { DeclaredMediaSessionBudget } from './media/session-budget.js';
import { StationLiveSessions } from './media/station-live-sessions.js';
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
    private unconfirmedWrites?: () => void;

    constructor(log: PlatformLogger, config: PlatformConfig, api: PlatformApi) {
      const configuredConfig = parseConfig(config);
      const storageRoot = api.user ? resolveStorageRoot(api.user.storagePath()) : undefined;
      const diagnosticLog = createDiagnosticLogger(log, storageRoot);
      const diagnostics = new DiagnosticConditions(diagnosticLog);
      const adaptationDiagnostics: AdaptationDiagnostics = {
        report: (notice) => reportAdaptationNotice(diagnosticLog, notice),
      };
      const liveMedia = configuredConfig.ffmpegPath
        ? new FfmpegLiveMedia(configuredConfig.ffmpegPath, adaptationDiagnostics)
        : undefined;
      const recordingMedia = configuredConfig.ffmpegPath
        ? new FfmpegRecordingMedia(configuredConfig.ffmpegPath, adaptationDiagnostics)
        : undefined;
      const mediaBudget = new DeclaredMediaSessionBudget(configuredConfig.maxConcurrentMediaSessions);
      // One registry for both sides of the question: HomeKit records a live session on its camera's station,
      // and snapshot acquisition asks whether a station is serving one before opening a burst on it.
      const stationLiveSessions = new StationLiveSessions();
      const snapshotMedia = new SnapshotAcquisition(
        storageRoot
          ? new PersistedLastSuccessfulImages(storageRoot, () => reportInvalidSnapshotCache(diagnosticLog))
          : undefined,
        mediaBudget,
        undefined,
        undefined,
        stationLiveSessions,
      );
      if (configuredConfig.discardedV4Settings.length > 0 && !configuredConfig.discardedV4Acknowledged) {
        reportDiscardedV4Settings(diagnosticLog);
      }
      this.runtime = new RuntimeOwner(diagnosticLog, configuredConfig, clientFactory, {
        storageRoot,
        shutdownTimeoutMs,
      });
      this.runtime.subscribeState((state) => diagnostics.reportRuntimeState(state));
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
        void this.runtime.stop().finally(() => diagnosticLog.flush?.());
      };
      for (const signal of signals) {
        signalTarget?.on(signal, stop);
      }
      this.unconfirmedWrites ??= this.runtime.subscribeUnconfirmedWrites((write) => {
        const condition = unconfirmedWriteCondition(write.property);
        if (condition) {
          diagnostics.reportHomeKit(condition, [write.serial]);
        }
      });
      api.on('didFinishLaunching', () => {
        const ffmpegPath = configuredConfig.ffmpegPath;
        if (ffmpegPath && storageRoot) {
          void resolveFfmpegIdentity(ffmpegPath, ffmpegPathSource(ffmpegPath)).then((identity) =>
            recordFfmpegEnvironment(storageRoot, identity),
          );
        }
        const accessoryStore = createAccessoryStore(api);
        if (accessoryStore) {
          this.reconciler ??= new HomeKitReconciler(
            this.runtime,
            accessoryStore,
            (diagnostic, affectedDeviceIds = []) => diagnostics.reportHomeKit(diagnostic, affectedDeviceIds),
            this.cachedAccessories,
            (trace) => reportHomeKitEvent(diagnosticLog, trace),
            configuredConfig.entityPreferences,
            liveMedia,
            snapshotMedia,
            recordingMedia,
            mediaBudget,
            stationLiveSessions,
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

export const EufyPlatform = createEufyPlatform(createPersistedSdkClient, 10_000, process);
