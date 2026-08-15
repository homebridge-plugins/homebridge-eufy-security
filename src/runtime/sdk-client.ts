import type { AnyDeviceEvent, Device, EufyMega, FcmStore, Logger, SessionStore } from '@mega-yfue/eufy-sdk';

import type { EufyConfig } from '../configuration.js';
import { discoverCompleteDeviceRegistry, type CompleteDeviceSnapshot } from '../device/snapshot.js';
import { createSdkLogger, type PlatformLogger } from '../diagnostics.js';

interface RealtimeReadyClient {
  waitForRealtime?(): Promise<{ state: string }>;
}

export type SdkStartResult =
  | {
      state: 'ready';
      registry: ReadonlyMap<string, Device>;
      snapshot: CompleteDeviceSnapshot;
    }
  | { state: 'degraded'; complete?: false; registry?: never; snapshot?: never }
  | {
      state: 'degraded';
      complete: true;
      registry: ReadonlyMap<string, Device>;
      snapshot: CompleteDeviceSnapshot;
    }
  | { state: 'authentication-required' };

export interface SdkClient {
  start(): Promise<void | SdkStartResult>;
  stop(): Promise<void>;
  onInventory?(listener: (result: SdkStartResult) => void): void;
  onEvent?(listener: (event: AnyDeviceEvent) => void): void;
}

export interface RuntimeClientStores {
  account: string;
  session: SessionStore;
  push: FcmStore;
}

export type SdkLogger = Partial<PlatformLogger>;

export type SdkClientFactory = (config: EufyConfig, stores?: RuntimeClientStores, logger?: SdkLogger) => SdkClient;

export class SyntheticSdkClient implements SdkClient {
  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

export function createSyntheticSdkClient(_config: EufyConfig): SdkClient {
  return new SyntheticSdkClient();
}

/** Long-lived SDK adapter that can only start from a locally accepted persisted session. */
export class PersistedSdkClient implements SdkClient {
  private client?: EufyMega;
  private registry: ReadonlyMap<string, Device> = new Map();
  private inventoryListener?: (result: SdkStartResult) => void;
  private eventListener?: (event: AnyDeviceEvent) => void;
  private refresh = Promise.resolve();
  private epoch = 0;
  private connected = false;
  private inventoryReady = false;
  private readonly diagnostics?: Logger;
  private isSessionExpired: (error: unknown) => boolean = () => false;
  private readonly handleError = (error: Error): void => {
    this.diagnostics?.error('[client] error event', error);
    if (this.isSessionExpired(error)) {
      this.inventoryListener?.({ state: 'authentication-required' });
    }
  };
  private readonly handleEvent = (event: AnyDeviceEvent): void => this.eventListener?.(event);
  private readonly handleConnect = (): void => {
    this.connected = true;
    if (!this.inventoryReady) {
      return;
    }
    this.epoch += 1;
    this.scheduleRefresh();
  };
  private readonly handleDisconnect = (): void => {
    this.connected = false;
    if (!this.inventoryReady) {
      return;
    }
    this.epoch += 1;
    this.inventoryListener?.({ state: 'degraded' });
  };
  private readonly refreshInventory = (): void => {
    if (this.inventoryReady) {
      this.scheduleRefresh();
    }
  };

  constructor(
    private readonly config: EufyConfig,
    private readonly stores: RuntimeClientStores,
    private readonly restoredClient?: EufyMega,
    private readonly logger?: SdkLogger,
  ) {
    this.diagnostics = createSdkLogger(logger);
  }

  async start(): Promise<SdkStartResult> {
    if (!this.stores.session.load()) {
      return { state: 'authentication-required' };
    }
    const sdk = await import('@mega-yfue/eufy-sdk');
    this.isSessionExpired = (error) => error instanceof sdk.SessionExpiredError;
    const client =
      this.restoredClient ??
      new sdk.EufyMega({
        email: this.stores.account,
        password: this.config.password ?? '',
        countryCode: this.config.country,
        phoneModel: this.config.trustedDeviceName,
        pollMs: this.config.pollingIntervalMinutes * 60_000,
        store: this.stores.session,
        pushStore: this.stores.push,
        logger: this.diagnostics,
      });
    const epoch = ++this.epoch;
    this.connected = true;
    this.client = client;
    client.on('error', this.handleError);
    client.on('event', this.handleEvent);
    client.on('connect', this.handleConnect);
    client.on('disconnect', this.handleDisconnect);
    client.on('deviceAdded', this.refreshInventory);
    client.on('deviceRemoved', this.refreshInventory);
    client.on('deviceCapabilities', this.refreshInventory);
    if (!client.loggedIn) {
      return { state: 'authentication-required' };
    }

    try {
      const login = await client.login();
      if (login.status !== 'ok') {
        return { state: 'authentication-required' };
      }
      const realtimeReady = await this.realtimeReady(client);
      const discovery = await discoverCompleteDeviceRegistry(client);
      if (epoch !== this.epoch) {
        return { state: 'degraded' };
      }
      this.registry = discovery.registry;
      this.inventoryReady = true;
      if (realtimeReady && this.connected) {
        return { state: 'ready', registry: this.registry, snapshot: discovery.snapshot };
      }
      return { state: 'degraded', complete: true, registry: this.registry, snapshot: discovery.snapshot };
    } catch (error) {
      if (this.isSessionExpired(error)) {
        return { state: 'authentication-required' };
      }
      return { state: 'degraded' };
    }
  }

  async stop(): Promise<void> {
    this.epoch += 1;
    this.connected = false;
    this.inventoryReady = false;
    const client = this.client;
    this.client = undefined;
    this.inventoryListener = undefined;
    this.eventListener = undefined;
    client?.off('error', this.handleError);
    client?.off('event', this.handleEvent);
    client?.off('connect', this.handleConnect);
    client?.off('disconnect', this.handleDisconnect);
    client?.off('deviceAdded', this.refreshInventory);
    client?.off('deviceRemoved', this.refreshInventory);
    client?.off('deviceCapabilities', this.refreshInventory);
    await client?.disconnect();
    this.registry = new Map();
  }

  onInventory(listener: (result: SdkStartResult) => void): void {
    this.inventoryListener = listener;
  }

  onEvent(listener: (event: AnyDeviceEvent) => void): void {
    this.eventListener = listener;
  }

  private scheduleRefresh(): void {
    const epoch = this.epoch;
    this.refresh = this.refresh.then(async () => {
      if (!this.client || !this.connected) {
        return;
      }
      try {
        const realtimeReady = await this.realtimeReady(this.client);
        const discovery = await discoverCompleteDeviceRegistry(this.client);
        if (epoch !== this.epoch || !this.connected) {
          return;
        }
        this.registry = discovery.registry;
        this.inventoryListener?.(
          realtimeReady
            ? { state: 'ready', registry: this.registry, snapshot: discovery.snapshot }
            : { state: 'degraded', complete: true, registry: this.registry, snapshot: discovery.snapshot },
        );
      } catch (error) {
        if (epoch !== this.epoch || !this.connected) {
          return;
        }
        this.inventoryListener?.(
          this.isSessionExpired(error) ? { state: 'authentication-required' } : { state: 'degraded' },
        );
      }
    });
  }

  private async realtimeReady(client: EufyMega): Promise<boolean> {
    const waitForRealtime = (client as EufyMega & RealtimeReadyClient).waitForRealtime;
    if (!waitForRealtime) {
      return true;
    }
    return (await waitForRealtime.call(client)).state === 'ready';
  }
}

export function createPersistedSdkClient(
  config: EufyConfig,
  stores?: RuntimeClientStores,
  logger?: SdkLogger,
): SdkClient {
  if (!stores) {
    return createSyntheticSdkClient(config);
  }
  return new PersistedSdkClient(config, stores, undefined, logger);
}
