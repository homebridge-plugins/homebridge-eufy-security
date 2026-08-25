import type { FcmStore, LoginResult, SessionStore } from '@mega-yfue/eufy-sdk';

import type { EufyConfig } from '../configuration.js';
import {
  discoverCompleteDeviceSnapshot,
  type CompleteDeviceSnapshot,
  type DiscoveryClient,
} from '../device/snapshot.js';
import type { AccountOwnerEvidence, AccountReleaseResult } from './ownership.js';

const FLOW_TIMEOUT = Symbol('flow-timeout');

export interface TemporaryAuthenticationClientOptions {
  account: string;
  password: string;
  country: string;
  trustedDeviceName: string;
  sessionStore: SessionStore;
  pushStore: FcmStore;
}

export interface TemporaryAuthenticationInput {
  configuration: EufyConfig;
}

export interface TemporaryAuthenticationClient {
  login(): Promise<LoginResult>;
  solveCaptcha(answer: string): Promise<LoginResult>;
  submitVerifyCode(code: string): Promise<LoginResult>;
  discover(): Promise<CompleteDeviceSnapshot>;
  disconnect(): Promise<void>;
}

export type TemporaryAuthenticationClientFactory = (
  options: TemporaryAuthenticationClientOptions,
) => TemporaryAuthenticationClient;

/** The complete SDK surface an interactive authentication flow is permitted to reach. */
export interface AuthenticatingSdkClient extends DiscoveryClient {
  login(): Promise<LoginResult>;
  solveCaptcha(answer: string): Promise<LoginResult>;
  submitVerifyCode(code: string): Promise<LoginResult>;
  disconnect(): Promise<void>;
}

/**
 * Narrows a full SDK client to the observation-only surface of an interactive authentication flow.
 *
 * The returned client exposes no persistent write, momentary action, rename, reboot, or raw transport
 * operation, so authenticating and discovering an account cannot change device state.
 */
export function observationOnlyAuthenticationClient(client: AuthenticatingSdkClient): TemporaryAuthenticationClient {
  return {
    login: () => client.login(),
    solveCaptcha: (answer) => client.solveCaptcha(answer),
    submitVerifyCode: (code) => client.submitVerifyCode(code),
    discover: () => discoverCompleteDeviceSnapshot(client),
    disconnect: () => client.disconnect(),
  };
}

interface TemporaryLease {
  release(): Promise<AccountReleaseResult>;
}

interface TemporaryOwnership {
  acquire(
    accountScope: string,
    kind: 'temporary-authentication',
  ): Promise<
    | { state: 'owner'; lease: TemporaryLease; recovered: boolean }
    | { state: 'owner-conflict'; owner: AccountOwnerEvidence }
  >;
}

interface TemporaryStores {
  account: string;
  configuration: { save(value: EufyConfig): void };
  session: SessionStore;
  push: FcmStore;
  snapshot: { save(value: CompleteDeviceSnapshot): void };
  commit(signal?: AbortSignal): Promise<void>;
  discard(): Promise<void>;
}

interface TemporaryPersistence {
  active?(): Promise<{ account: string; configuration?: { load(): EufyConfig | null } } | null>;
  stage(account: string): Promise<TemporaryStores>;
}

interface TemporaryRuntimeActivity {
  fresh(): Promise<TemporaryRuntimeEvidence | null>;
}

interface TemporaryRuntimeEvidence {
  state: string;
  updatedAt: string;
}

export interface TemporaryAuthenticationOptions {
  flowTimeoutMs: number;
  cleanupTimeoutMs: number;
}

export type TemporaryAuthenticationResult =
  | { status: 'captcha'; image: string; retry: boolean }
  | { status: 'two-factor'; method: string }
  | { status: 'restart-required' }
  | { status: 'blocked'; owner: AccountOwnerEvidence }
  | ({ status: 'plugin-running' } & TemporaryRuntimeEvidence)
  | { status: 'failed' }
  | { status: 'timed-out' }
  | { status: 'closed' };

/** Owns one isolated SDK client for an interactive authentication flow. */
export class TemporaryAuthentication {
  private client?: TemporaryAuthenticationClient;
  private readonly leases: TemporaryLease[] = [];
  private stores?: TemporaryStores;
  private cleanupPromise?: Promise<boolean>;
  private preparation?: Promise<TemporaryAuthenticationResult | undefined>;
  private flowTimer?: NodeJS.Timeout;
  private flowDeadline?: Promise<typeof FLOW_TIMEOUT>;
  private cleanupDeadline?: number;
  private state: 'new' | 'starting' | 'active' | 'settled' = 'new';
  private terminalResult?: TemporaryAuthenticationResult;
  private continuationPending = false;
  private inputConfiguration?: EufyConfig;

  constructor(
    private readonly ownership: TemporaryOwnership,
    private readonly persistence: TemporaryPersistence,
    private readonly clientFactory: TemporaryAuthenticationClientFactory,
    private readonly options: TemporaryAuthenticationOptions,
    private readonly runtimeActivity?: TemporaryRuntimeActivity,
  ) {}

  async start(input: TemporaryAuthenticationInput): Promise<TemporaryAuthenticationResult> {
    if (this.state !== 'new') {
      return { status: 'failed' };
    }

    this.state = 'starting';
    this.inputConfiguration = input.configuration;
    this.armFlowDeadline();
    try {
      const runtime = this.runtimeActivity ? await this.waitForFlow(this.runtimeActivity.fresh()) : null;
      if (runtime === FLOW_TIMEOUT) {
        return this.expire();
      }
      if (runtime) {
        this.state = 'settled';
        const result = { status: 'plugin-running', ...runtime } as const;
        this.terminalResult = result;
        return result;
      }
      if (this.isSettled()) {
        return this.terminalResult ?? { status: 'closed' };
      }

      this.preparation = this.prepare(input);
      const preparationResult = await this.waitForFlow(this.preparation);
      if (preparationResult === FLOW_TIMEOUT) {
        return this.expire();
      }
      if (preparationResult) {
        await this.cleanup(false);
        return preparationResult;
      }
      if (this.state !== 'starting' || !this.client) {
        return this.terminalResult ?? { status: 'closed' };
      }
      this.state = 'active';
      const result = await this.waitForFlow(this.client.login());
      if (this.state !== 'active') {
        return this.terminalResult ?? { status: 'closed' };
      }
      return result === FLOW_TIMEOUT ? this.expire() : await this.apply(result);
    } catch {
      if (this.isSettled()) {
        return this.terminalResult ?? { status: 'closed' };
      }
      return this.fail();
    }
  }

  private async prepare(input: TemporaryAuthenticationInput): Promise<TemporaryAuthenticationResult | undefined> {
    const account = input.configuration.username?.trim().toLowerCase();
    const password = input.configuration.password;
    if (!account || !password) {
      throw new TypeError('temporary authentication requires account credentials');
    }
    const activeAccount = await this.persistence.active?.();
    const activeConfiguration = activeAccount?.configuration?.load();
    if (activeConfiguration) {
      if (activeConfiguration.username?.trim().toLowerCase() !== activeAccount!.account) {
        throw new Error('active account generation has mismatched configuration');
      }
      this.inputConfiguration = {
        ...activeConfiguration,
        username: input.configuration.username,
        password: input.configuration.password,
        country: input.configuration.country,
        trustedDeviceName: input.configuration.trustedDeviceName,
        entityPreferences: {
          ...input.configuration.entityPreferences,
          ...activeConfiguration.entityPreferences,
        },
      };
    }
    if (this.state === 'settled') {
      return this.terminalResult ?? { status: 'closed' };
    }
    const accountScopes =
      activeAccount && activeAccount.account !== account ? [activeAccount.account, account] : [account];
    for (const accountScope of accountScopes) {
      const ownership = await this.ownership.acquire(accountScope, 'temporary-authentication');
      if (this.isSettled()) {
        if (ownership.state === 'owner') {
          this.leases.push(ownership.lease);
        }
        return this.terminalResult ?? { status: 'closed' };
      }
      if (ownership.state === 'owner-conflict') {
        this.state = 'settled';
        const result = { status: 'blocked', owner: ownership.owner } as const;
        this.terminalResult = result;
        return result;
      }
      this.leases.push(ownership.lease);
    }

    this.stores = await this.persistence.stage(account);
    if (this.isSettled()) {
      await this.boundedStore(this.stores.discard());
      return this.terminalResult ?? { status: 'closed' };
    }
    this.client = this.clientFactory({
      account,
      password,
      country: this.inputConfiguration!.country,
      trustedDeviceName: this.inputConfiguration!.trustedDeviceName,
      sessionStore: this.stores.session,
      pushStore: this.stores.push,
    });
    return undefined;
  }

  async submitCaptcha(answer: string): Promise<TemporaryAuthenticationResult> {
    if (this.challenge !== 'captcha') {
      return { status: 'failed' };
    }
    return this.continue(() => this.client!.solveCaptcha(answer));
  }

  async submitTwoFactor(code: string): Promise<TemporaryAuthenticationResult> {
    if (this.challenge !== 'two-factor') {
      return { status: 'failed' };
    }
    return this.continue(() => this.client!.submitVerifyCode(code));
  }

  private challenge?: 'captcha' | 'two-factor';

  private async continue(operation: () => Promise<LoginResult>): Promise<TemporaryAuthenticationResult> {
    if (this.state !== 'active' || !this.client || this.continuationPending) {
      return { status: 'failed' };
    }
    this.continuationPending = true;
    try {
      const result = await this.waitForFlow(operation());
      if (this.state !== 'active') {
        return this.terminalResult ?? { status: 'closed' };
      }
      return result === FLOW_TIMEOUT ? this.expire() : await this.apply(result);
    } catch {
      if (this.isSettled()) {
        return this.terminalResult ?? { status: 'closed' };
      }
      return this.fail();
    } finally {
      this.continuationPending = false;
    }
  }

  async close(): Promise<TemporaryAuthenticationResult> {
    if (this.state === 'settled') {
      await this.cleanupPromise;
      return { status: 'closed' };
    }
    this.state = 'settled';
    const result = { status: 'closed' } as const;
    this.terminalResult = result;
    await this.cleanup(false);
    return result;
  }

  private async apply(result: LoginResult): Promise<TemporaryAuthenticationResult> {
    if (result.status === 'captcha') {
      this.challenge = 'captcha';
      return { status: 'captcha', image: result.image, retry: result.retry };
    }
    if (result.status === '2fa') {
      this.challenge = 'two-factor';
      return { status: 'two-factor', method: result.method };
    }

    this.challenge = undefined;
    const snapshot = await this.waitForFlow(this.client!.discover());
    if (this.state !== 'active') {
      return this.terminalResult ?? { status: 'closed' };
    }
    if (snapshot === FLOW_TIMEOUT) {
      return this.expire();
    }
    this.stores!.configuration.save(this.inputConfiguration!);
    this.stores!.snapshot.save(snapshot);
    this.state = 'settled';
    const cleaned = await this.cleanup(true);
    const terminalResult: TemporaryAuthenticationResult = { status: cleaned ? 'restart-required' : 'failed' };
    this.terminalResult = terminalResult;
    return terminalResult;
  }

  private cleanup(commit: boolean): Promise<boolean> {
    this.cleanupPromise ??= this.performCleanup(commit);
    return this.cleanupPromise;
  }

  private async fail(): Promise<TemporaryAuthenticationResult> {
    this.state = 'settled';
    await this.cleanup(false);
    this.terminalResult = { status: 'failed' };
    return this.terminalResult;
  }

  private async performCleanup(commit: boolean): Promise<boolean> {
    clearTimeout(this.flowTimer);
    this.cleanupDeadline ??= Date.now() + this.options.cleanupTimeoutMs;
    let successful = true;
    let safeToRelease = true;
    if (this.preparation) {
      safeToRelease = await this.bounded(this.preparation);
      successful = safeToRelease;
      if (!safeToRelease) {
        void this.preparation.then(
          () => this.releaseAfterPreparation(),
          () => this.releaseAfterPreparation(),
        );
      }
    }
    if (this.client) {
      successful = await this.bounded(this.client.disconnect());
      safeToRelease = successful && safeToRelease;
    }
    if (commit && successful) {
      const commitOutcome = this.stores ? await this.boundedCommit(this.stores) : 'failure';
      successful = commitOutcome === 'success';
      if (commitOutcome === 'failure' && this.stores) {
        safeToRelease = (await this.boundedStore(this.stores.discard())) !== 'timeout';
      } else if (commitOutcome === 'timeout') {
        safeToRelease = false;
      }
    } else {
      const discardOutcome = this.stores ? await this.boundedStore(this.stores.discard()) : 'success';
      successful = discardOutcome === 'success' && successful;
      safeToRelease = discardOutcome !== 'timeout' && safeToRelease;
    }
    if (safeToRelease) {
      for (const lease of [...this.leases].reverse()) {
        successful = (await this.boundedRelease(lease)) && successful;
      }
    }
    return successful;
  }

  private async bounded(operation: Promise<unknown>): Promise<boolean> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.remainingCleanupMs());
      timer.unref();
    });
    try {
      return await Promise.race([operation.then(() => true), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer!);
    }
  }

  private async boundedRelease(lease: TemporaryLease): Promise<boolean> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.remainingCleanupMs());
      timer.unref();
    });
    try {
      const result = await Promise.race([lease.release(), timeout]);
      return result !== false && result.state === 'stopped';
    } catch {
      return false;
    } finally {
      clearTimeout(timer!);
    }
  }

  private async boundedStore(operation: Promise<unknown>): Promise<'success' | 'failure' | 'timeout'> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.remainingCleanupMs());
      timer.unref();
    });
    try {
      return await Promise.race([operation.then(() => 'success' as const).catch(() => 'failure' as const), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async boundedCommit(stores: TemporaryStores): Promise<'success' | 'failure' | 'timeout'> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.remainingCleanupMs());
      timer.unref();
    });
    try {
      return await Promise.race([
        stores
          .commit(controller.signal)
          .then(() => 'success' as const)
          .catch(() => 'failure' as const),
        timeout,
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private isSettled(): boolean {
    return this.state === 'settled';
  }

  private remainingCleanupMs(): number {
    this.cleanupDeadline ??= Date.now() + this.options.cleanupTimeoutMs;
    return Math.max(0, this.cleanupDeadline - Date.now());
  }

  private async releaseAfterPreparation(): Promise<void> {
    this.cleanupDeadline = Date.now() + this.options.cleanupTimeoutMs;
    for (const lease of [...this.leases].reverse()) {
      await this.boundedRelease(lease);
    }
    this.leases.length = 0;
  }

  private armFlowDeadline(): void {
    this.flowDeadline = new Promise((resolve) => {
      this.flowTimer = setTimeout(() => resolve(FLOW_TIMEOUT), this.options.flowTimeoutMs);
      this.flowTimer.unref();
    });
  }

  private waitForFlow<T>(operation: Promise<T>): Promise<T | typeof FLOW_TIMEOUT> {
    return Promise.race([operation, this.flowDeadline!]);
  }

  private async expire(): Promise<TemporaryAuthenticationResult> {
    this.state = 'settled';
    await this.cleanup(false);
    this.terminalResult = { status: 'timed-out' };
    return this.terminalResult;
  }
}
