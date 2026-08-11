import type { EufyMega, FcmStore, SessionStore } from '@mega-yfue/eufy-sdk';

import type { EufyConfig } from '../configuration.js';
import {
  discoverCompleteDeviceRegistry,
  type CompleteDeviceSnapshot,
  type DiscoveryDevice,
} from '../device/snapshot.js';

export type SdkStartResult =
  | {
      state: 'ready';
      registry: ReadonlyMap<string, DiscoveryDevice>;
      snapshot: CompleteDeviceSnapshot;
    }
  | { state: 'degraded' }
  | { state: 'authentication-required' };

export interface SdkClient {
  start(): Promise<void | SdkStartResult>;
  stop(): Promise<void>;
  onInventory?(listener: (result: SdkStartResult) => void): void;
}

export interface RuntimeClientStores {
  account: string;
  session: SessionStore;
  push: FcmStore;
}

export type SdkClientFactory = (config: EufyConfig, stores?: RuntimeClientStores) => SdkClient;

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
  private registry: ReadonlyMap<string, DiscoveryDevice> = new Map();
  private inventoryListener?: (result: SdkStartResult) => void;
  private refresh = Promise.resolve();
  private epoch = 0;
  private isSessionExpired: (error: unknown) => boolean = () => false;

  constructor(
    private readonly config: EufyConfig,
    private readonly stores: RuntimeClientStores,
    private readonly restoredClient?: EufyMega,
  ) {}

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
      });
    const epoch = ++this.epoch;
    this.client = client;
    client.on('error', (error) => {
      if (this.isSessionExpired(error)) {
        this.inventoryListener?.({ state: 'authentication-required' });
      }
    });
    client.on('event', () => undefined);
    const refreshInventory = () => this.scheduleRefresh();
    client.on('deviceAdded', refreshInventory);
    client.on('deviceRemoved', refreshInventory);
    client.on('deviceCapabilities', refreshInventory);
    if (!client.loggedIn) {
      return { state: 'authentication-required' };
    }

    try {
      const login = await client.login();
      if (login.status !== 'ok') {
        return { state: 'authentication-required' };
      }
      const discovery = await discoverCompleteDeviceRegistry(client);
      if (epoch !== this.epoch) {
        return { state: 'degraded' };
      }
      this.registry = discovery.registry;
      return { state: 'ready', registry: this.registry, snapshot: discovery.snapshot };
    } catch (error) {
      if (this.isSessionExpired(error)) {
        return { state: 'authentication-required' };
      }
      return { state: 'degraded' };
    }
  }

  async stop(): Promise<void> {
    this.epoch += 1;
    const client = this.client;
    this.client = undefined;
    this.inventoryListener = undefined;
    await client?.disconnect();
    this.registry = new Map();
  }

  onInventory(listener: (result: SdkStartResult) => void): void {
    this.inventoryListener = listener;
  }

  private scheduleRefresh(): void {
    const epoch = this.epoch;
    this.refresh = this.refresh.then(async () => {
      if (!this.client) {
        return;
      }
      try {
        const discovery = await discoverCompleteDeviceRegistry(this.client);
        if (epoch !== this.epoch) {
          return;
        }
        this.registry = discovery.registry;
        this.inventoryListener?.({ state: 'ready', registry: this.registry, snapshot: discovery.snapshot });
      } catch (error) {
        if (epoch !== this.epoch) {
          return;
        }
        this.inventoryListener?.(
          this.isSessionExpired(error) ? { state: 'authentication-required' } : { state: 'degraded' },
        );
      }
    });
  }
}

export function createPersistedSdkClient(config: EufyConfig, stores?: RuntimeClientStores): SdkClient {
  if (!stores) {
    return createSyntheticSdkClient(config);
  }
  return new PersistedSdkClient(config, stores);
}
