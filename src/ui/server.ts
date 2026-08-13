import { join } from 'node:path';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { EufyMega } from '@mega-yfue/eufy-sdk';

import { AccountOwnership } from '../account/ownership.js';
import { AccountSessionPersistence } from '../account/persistence.js';
import {
  TemporaryAuthentication,
  type TemporaryAuthenticationClientFactory,
  type TemporaryAuthenticationResult,
  type TemporaryAuthenticationInput,
} from '../account/temporary-authentication.js';
import { parseConfig } from '../configuration.js';
import { discoverCompleteDeviceSnapshot } from '../device/snapshot.js';
import { RuntimeTracker } from '../runtime/tracker.js';
import { resolveStorageRoot } from '../storage.js';
import { readDashboard } from './dashboard.js';

const AUTHENTICATION_FLOW_TIMEOUT_MS = 5 * 60_000;
const AUTHENTICATION_CLEANUP_TIMEOUT_MS = 10_000;

interface CleanupSignalTarget {
  exit(code?: number): never;
  once(event: 'disconnect' | 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Binds every custom-UI child-process exit path to one bounded authentication cleanup. */
export function bindTemporaryAuthenticationProcessCleanup(
  target: CleanupSignalTarget,
  close: () => Promise<unknown>,
): void {
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    stopping ??= close().finally(() => target.exit(0));
  };
  target.once('disconnect', stop);
  target.once('SIGHUP', stop);
  target.once('SIGINT', stop);
  target.once('SIGTERM', stop);
}

function requiredString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : undefined;
}

function parseStartPayload(value: unknown): TemporaryAuthenticationInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError('Invalid authentication request', { status: 400 });
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.configuration !== 'object' ||
    payload.configuration === null ||
    Array.isArray(payload.configuration)
  ) {
    throw new RequestError('Invalid authentication request', { status: 400 });
  }
  const candidate = payload.configuration as Record<string, unknown>;
  const account = requiredString(candidate.username, 320)?.trim().toLowerCase();
  const password = requiredString(candidate.password, 1_024);
  const country = requiredString(candidate.country, 2)?.toUpperCase();
  const trustedDeviceName = requiredString(candidate.trustedDeviceName, 128)?.trim();
  if (!account || !password || !country?.match(/^[A-Z]{2}$/) || !trustedDeviceName) {
    throw new RequestError('Invalid authentication request', { status: 400 });
  }
  try {
    return {
      configuration: parseConfig({
        ...candidate,
        username: account,
        password,
        country,
        trustedDeviceName,
      }),
    };
  } catch {
    throw new RequestError('Invalid authentication request', { status: 400 });
  }
}

function parseAnswer(value: unknown, key: 'answer' | 'code'): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError('Invalid authentication continuation', { status: 400 });
  }
  const answer = requiredString((value as Record<string, unknown>)[key], 128)?.trim();
  if (!answer) {
    throw new RequestError('Invalid authentication continuation', { status: 400 });
  }
  return answer;
}

function parseRepresentationPreferences(value: unknown): Record<string, boolean> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError('Invalid dashboard request', { status: 400 });
  }
  const preferences = (value as Record<string, unknown>).representationPreferences;
  if (preferences === undefined) {
    return {};
  }
  if (
    typeof preferences !== 'object' ||
    preferences === null ||
    Array.isArray(preferences) ||
    Object.entries(preferences).some(
      ([serial, represented]) => serial.length === 0 || serial.length > 128 || typeof represented !== 'boolean',
    )
  ) {
    throw new RequestError('Invalid dashboard request', { status: 400 });
  }
  return { ...(preferences as Record<string, boolean>) };
}

/** Creates the production SDK client without enabling realtime ownership. */
export const createTemporaryAuthenticationClient: TemporaryAuthenticationClientFactory = (options) =>
  temporaryClient(
    new EufyMega({
      email: options.account,
      password: options.password,
      countryCode: options.country,
      phoneModel: options.trustedDeviceName,
      store: options.sessionStore,
      pushStore: options.pushStore,
      autoRealtime: false,
      storedSnapshotCache: false,
    }),
  );

function temporaryClient(client: EufyMega): ReturnType<TemporaryAuthenticationClientFactory> {
  return {
    login: () => client.login(),
    solveCaptcha: (answer) => client.solveCaptcha(answer),
    submitVerifyCode: (code) => client.submitVerifyCode(code),
    discover: () => discoverCompleteDeviceSnapshot(client),
    disconnect: () => client.disconnect(),
  };
}

/** Homebridge custom-UI child process that exclusively owns interactive authentication. */
export class EufyAuthenticationUiServer extends HomebridgePluginUiServer {
  private authentication?: TemporaryAuthentication;
  private readonly ownership: AccountOwnership;
  private readonly persistence: AccountSessionPersistence;
  private readonly runtimeTracker: RuntimeTracker;
  private startPending = false;
  private flowGeneration = 0;

  constructor(
    private readonly clientFactory: TemporaryAuthenticationClientFactory = createTemporaryAuthenticationClient,
  ) {
    super();
    if (!this.homebridgeStoragePath) {
      throw new Error('Homebridge storage path is unavailable');
    }
    const root = resolveStorageRoot(this.homebridgeStoragePath);
    this.ownership = new AccountOwnership(join(root, 'ownership'));
    this.persistence = new AccountSessionPersistence(join(root, 'accounts'));
    this.runtimeTracker = new RuntimeTracker(join(root, 'tracker.json'));

    this.onRequest('/auth/start', (payload) => this.startAuthentication(payload));
    this.onRequest('/auth/captcha', (payload) => this.continueCaptcha(payload));
    this.onRequest('/auth/two-factor', (payload) => this.continueTwoFactor(payload));
    this.onRequest('/auth/close', () => this.closeAuthentication());
    this.onRequest('/dashboard', (payload) =>
      readDashboard(this.runtimeTracker, Date.now, parseRepresentationPreferences(payload)),
    );
    this.installCleanupHandlers();
    this.ready();
  }

  private async startAuthentication(payload: unknown): Promise<TemporaryAuthenticationResult> {
    if (this.startPending) {
      return { status: 'failed' };
    }
    this.startPending = true;
    const generation = this.flowGeneration;
    try {
      await this.authentication?.close();
      if (generation !== this.flowGeneration) {
        return { status: 'closed' };
      }
      this.authentication = new TemporaryAuthentication(
        this.ownership,
        this.persistence,
        this.clientFactory,
        {
          flowTimeoutMs: AUTHENTICATION_FLOW_TIMEOUT_MS,
          cleanupTimeoutMs: AUTHENTICATION_CLEANUP_TIMEOUT_MS,
        },
        this.runtimeTracker,
      );
      return await this.authentication.start(parseStartPayload(payload));
    } finally {
      this.startPending = false;
    }
  }

  private continueCaptcha(payload: unknown): Promise<TemporaryAuthenticationResult> {
    return this.authentication?.submitCaptcha(parseAnswer(payload, 'answer')) ?? Promise.resolve({ status: 'failed' });
  }

  private continueTwoFactor(payload: unknown): Promise<TemporaryAuthenticationResult> {
    return this.authentication?.submitTwoFactor(parseAnswer(payload, 'code')) ?? Promise.resolve({ status: 'failed' });
  }

  private async closeAuthentication(): Promise<TemporaryAuthenticationResult> {
    this.flowGeneration++;
    const authentication = this.authentication;
    this.authentication = undefined;
    return authentication?.close() ?? { status: 'closed' };
  }

  private installCleanupHandlers(): void {
    bindTemporaryAuthenticationProcessCleanup(process, () => this.closeAuthentication());
  }
}
