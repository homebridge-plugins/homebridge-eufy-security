import type { EufyConfig } from './configuration.js';

export interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type SdkClientFactory = (config: EufyConfig) => SdkClient;

export class SyntheticSdkClient implements SdkClient {
  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

export function createSyntheticSdkClient(_config: EufyConfig): SdkClient {
  return new SyntheticSdkClient();
}
