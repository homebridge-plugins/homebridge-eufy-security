export interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type SdkClientFactory = () => SdkClient;

export class SyntheticSdkClient implements SdkClient {
  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

export function createSyntheticSdkClient(): SdkClient {
  return new SyntheticSdkClient();
}
