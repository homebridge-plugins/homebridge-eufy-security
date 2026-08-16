import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';

import type { Logger } from '@mega-yfue/eufy-sdk';

export interface PlatformLogger {
  debug?(message: string): void;
  error(message: string): void;
  info(message: string): void;
  localize?(key: string, parameters?: Readonly<Record<string, string | number>>): string;
  flush?(): Promise<void>;
  warn(message: string): void;
}

export interface HomeKitCondition {
  code: string;
  capability?: string;
  member?: string;
  active: boolean;
  reason: string;
}

export interface HomeKitEventTrace {
  adapter: string;
  event: string;
  observation: string;
}

const MAX_SDK_DETAILS = 16;
const MAX_LOG_RECORD_BYTES = 64 * 1024;
const MAX_CURRENT_LOG_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 200 * 1024 * 1024;
const MAX_QUEUED_LOG_BYTES = 1024 * 1024;
const LOG_ROTATIONS = 3;
const LOG_DIRECTORY = 'logs';
const LOG_FILE = 'homebridge-eufy.jsonl';
const gzip = promisify(gzipCallback);
const SDK_SUBSYSTEMS = new Set(['device', 'mega', 'mqtt', 'p2p', 'push', 'webrtc', 'sdk']);
const SDK_EVENT_KEYS = new Set([
  'client-warning',
  'connection-closed',
  'connection-opened',
  'connection-retrying',
  'media-error',
  'media-warning',
  'operation-failed',
  'observation-invalid',
  'protocol-command',
  'protocol-unhandled',
  'sdk-diagnostic',
  'session-connecting',
  'session-idle',
  'session-resumed',
  'session-restored',
  'session-retrying',
  'snapshot-cache-warning',
  'transport-error',
]);
const EN_MESSAGES = JSON.parse(readFileSync(new URL('../i18n/runtime/en.json', import.meta.url), 'utf8')) as Record<
  string,
  string
>;

function formatMessage(
  catalog: Readonly<Record<string, string>>,
  key: string,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const template = catalog[key] ?? EN_MESSAGES[key] ?? key;
  return template
    .replace(/\{([a-zA-Z0-9]+)\}/g, (placeholder, name: string) =>
      parameters[name] === undefined ? placeholder : String(parameters[name]),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function localize(target: unknown, key: string, parameters: Readonly<Record<string, string | number>> = {}): string {
  const translator = (target as Partial<Pick<PlatformLogger, 'localize'>>).localize;
  return translator?.(key, parameters) ?? formatMessage(EN_MESSAGES, key, parameters);
}

class JsonLineLog {
  private readonly directory: string;
  private readonly path: string;
  private pending = Promise.resolve();
  private queuedBytes = 0;
  private droppedRecords = 0;
  private droppedAt?: string;
  private totalBytes?: number;

  constructor(
    storageRoot: string,
    private readonly onError: () => void,
  ) {
    this.directory = join(storageRoot, LOG_DIRECTORY);
    this.path = join(this.directory, LOG_FILE);
  }

  write(message: string): void {
    const payload = sanitizeStructuredEvent(message);
    if (!payload) {
      return;
    }
    const record = this.serialize(payload);
    const bytes = Buffer.byteLength(record);
    if (bytes > MAX_LOG_RECORD_BYTES || this.queuedBytes + bytes > MAX_QUEUED_LOG_BYTES) {
      this.droppedAt ??= new Date().toISOString();
      this.droppedRecords += 1;
      return;
    }
    const droppedRecords = this.droppedRecords;
    const droppedAt = this.droppedAt;
    this.droppedRecords = 0;
    this.droppedAt = undefined;
    this.queuedBytes += bytes;
    this.pending = this.pending
      .then(async () => {
        if (droppedRecords > 0) {
          await this.append(
            this.serialize(
              {
                scope: 'diagnostics',
                level: 'warn',
                event: 'records-dropped',
                droppedRecords,
              },
              droppedAt,
            ),
          );
        }
        await this.append(record);
      })
      .catch(() => this.onError())
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }

  flush(): Promise<void> {
    const droppedRecords = this.droppedRecords;
    const droppedAt = this.droppedAt;
    this.droppedRecords = 0;
    this.droppedAt = undefined;
    if (droppedRecords > 0) {
      this.pending = this.pending
        .then(() =>
          this.append(
            this.serialize(
              {
                scope: 'diagnostics',
                level: 'warn',
                event: 'records-dropped',
                droppedRecords,
              },
              droppedAt,
            ),
          ),
        )
        .catch(() => this.onError());
    }
    return this.pending;
  }

  private serialize(payload: Readonly<Record<string, unknown>>, timestamp = new Date().toISOString()): string {
    return `${JSON.stringify({ ...payload, timestamp })}\n`;
  }

  private async append(record: string): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await chmod(this.directory, 0o700);
    const bytes = Buffer.byteLength(record);
    const rotated = await this.prepare(bytes);
    if (this.totalBytes === undefined || rotated) {
      this.totalBytes = await this.measureTotal();
    }
    try {
      await chmod(this.path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await appendFile(this.path, record, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    await chmod(this.path, 0o600);
    this.totalBytes += bytes;
    await this.enforceTotalLimit();
  }

  private async prepare(recordBytes: number): Promise<boolean> {
    try {
      const current = await stat(this.path);
      const today = new Date().toISOString().slice(0, 10);
      const currentDay = current.mtime.toISOString().slice(0, 10);
      if (currentDay !== today || current.size + recordBytes > MAX_CURRENT_LOG_BYTES) {
        await this.rotate();
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return false;
  }

  private async rotate(): Promise<void> {
    await rm(`${this.path}.${LOG_ROTATIONS}.gz`, { force: true });
    for (let index = LOG_ROTATIONS - 1; index >= 1; index -= 1) {
      try {
        const target = `${this.path}.${index + 1}.gz`;
        await rename(`${this.path}.${index}.gz`, target);
        await chmod(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    const compressed = await gzip(await readFile(this.path));
    await writeFile(`${this.path}.1.gz`, compressed, { flag: 'w', mode: 0o600 });
    await chmod(`${this.path}.1.gz`, 0o600);
    await rm(this.path, { force: true });
  }

  private async measureTotal(): Promise<number> {
    const files = [this.path, ...Array.from({ length: LOG_ROTATIONS }, (_, index) => `${this.path}.${index + 1}.gz`)];
    const sizes = await Promise.all(
      files.map(async (path) => {
        try {
          return (await stat(path)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
          }
          throw error;
        }
      }),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  private async enforceTotalLimit(): Promise<void> {
    for (let index = LOG_ROTATIONS; index >= 1 && this.totalBytes! > MAX_TOTAL_LOG_BYTES; index -= 1) {
      const path = `${this.path}.${index}.gz`;
      try {
        const size = (await stat(path)).size;
        await rm(path, { force: true });
        this.totalBytes! -= size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
}

/**
 * Routes human messages to Homebridge and structured events to the plugin JSONL log.
 * File writes preserve accepted order; records beyond the bounded pending queue are counted and reported.
 */
export function createDiagnosticLogger(
  target: PlatformLogger,
  storageRoot?: string,
  catalog: Readonly<Record<string, string>> = EN_MESSAGES,
): PlatformLogger {
  let fileFailureReported = false;
  const reportFileFailure = (): void => {
    if (!fileFailureReported) {
      fileFailureReported = true;
      target.warn(`[diagnostic-log-write-failed] ${formatMessage(catalog, 'log.diagnosticFileFailed')}`);
    }
  };
  const file = storageRoot ? new JsonLineLog(storageRoot, reportFileFailure) : undefined;
  const debug = file ? (message: string): void => file.write(message) : undefined;
  return {
    ...(debug ? { debug } : {}),
    error: (message) => target.error(message),
    flush: () => file?.flush() ?? Promise.resolve(),
    info: (message) => target.info(message),
    localize: (key, parameters) => formatMessage(catalog, key, parameters),
    warn: (message) => target.warn(message),
  };
}

function classifySdkEvent(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('restored persisted session')) return 'session-restored';
  if (normalized.includes('retrying') || normalized.includes('reconnecting')) return 'connection-retrying';
  if (normalized.includes('close') || normalized.includes('disconnect')) return 'connection-closed';
  if (normalized.includes('in use again') || normalized.includes('idle-detach cancelled')) return 'session-resumed';
  if (normalized.includes('connecting')) return 'session-connecting';
  if (normalized.includes('connected') || normalized.includes('logged in')) return 'connection-opened';
  if (normalized.includes('idle')) return 'session-idle';
  if (normalized.includes('candidate failed')) return 'snapshot-cache-warning';
  if (
    normalized.includes('wire value is not numeric') ||
    normalized.includes('unknown codec') ||
    normalized.includes('malformed')
  ) {
    return 'observation-invalid';
  }
  if (normalized.includes('unhandled payload')) return 'protocol-unhandled';
  if (
    normalized.includes('sendsetpayload') ||
    normalized.includes('requestimage') ||
    normalized.includes('querydatabase')
  ) {
    return 'protocol-command';
  }
  if (
    (normalized.includes('talkback') || normalized.includes('live media') || normalized.includes('live stream')) &&
    (normalized.includes('failed') || normalized.includes('error'))
  ) {
    return 'media-error';
  }
  if (
    normalized.includes('upstream error') ||
    normalized.includes('send err') ||
    normalized.includes('connection error')
  ) {
    return 'transport-error';
  }
  if (normalized.includes('failed') || normalized.includes('error')) return 'operation-failed';
  if (
    normalized.includes('talkback') ||
    normalized.includes('live media') ||
    normalized.includes('startlivemedia') ||
    normalized.includes('stoplivemedia')
  ) {
    return 'media-warning';
  }
  if (normalized.includes('[eufy]')) return 'client-warning';
  if (normalized.includes('retry')) return 'session-retrying';
  return 'sdk-diagnostic';
}

/** Adapts SDK protocol detail to bounded debug output without preserving supplied values. */
export function createSdkLogger(target: Partial<PlatformLogger> | undefined): Logger | undefined {
  if (!target?.debug) {
    return undefined;
  }
  const format = (message: string, args: unknown[]): Record<string, unknown> | undefined => {
    const requestedSubsystem = /^\[([a-z0-9-]+)(?:\s+[^\]]+)?\]/i.exec(message)?.[1]?.toLowerCase();
    if (requestedSubsystem === 'ffmpeg') {
      return undefined;
    }
    const subsystemAliases: Readonly<Record<string, string>> = {
      eufy: 'mega',
      fcm: 'push',
      live: 'p2p',
      session: 'p2p',
      smqtt: 'mqtt',
      'stored-snapshot-cache': 'device',
    };
    const aliasedSubsystem = requestedSubsystem ? subsystemAliases[requestedSubsystem] : undefined;
    const subsystem = SDK_SUBSYSTEMS.has(requestedSubsystem ?? '') ? requestedSubsystem : (aliasedSubsystem ?? 'sdk');
    const details = args.slice(0, MAX_SDK_DETAILS).map((value) => {
      if (value instanceof Error) {
        const errorType = ['Error', 'RangeError', 'SessionExpiredError', 'TypeError'].includes(value.name)
          ? value.name
          : 'Error';
        return { errorType };
      }
      if (typeof value === 'string') {
        return { type: 'string', length: value.length };
      }
      if (value && typeof value === 'object') {
        return { type: 'object' };
      }
      return { type: typeof value };
    });
    return {
      scope: 'sdk',
      subsystem,
      event: classifySdkEvent(message),
      ...(details.length ? { details } : {}),
      ...(args.length > MAX_SDK_DETAILS ? { detailsTruncated: true } : {}),
    };
  };
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, args: unknown[]): void => {
    const event = format(message, args);
    if (event) {
      target.debug!(JSON.stringify({ ...event, level }));
    }
  };
  return {
    debug: (message, ...args) => write('debug', message, args),
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args),
  };
}

export type RuntimeState =
  | 'stopped'
  | 'acquiring-ownership'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'authentication-required'
  | 'owner-conflict'
  | 'failed'
  | 'stopping';

const CAPABILITIES = new Set(['battery', 'contact', 'siren', 'smart_light']);
const MEMBERS = new Set([
  'active',
  'batteryAlert',
  'brightness',
  'charging',
  'color',
  'level',
  'open',
  'power',
  'stop',
  'test',
]);
const REASONS = new Set([
  'capability-not-supported',
  'expired',
  'hot',
  'malformed',
  'missing',
  'no-primary-purpose-member',
  'operation-failure',
  'primary-adapter-unavailable',
  'recovered',
  'sdk-fault',
  'timeout',
]);
const RUNTIME_CONDITION_REASONS = new Set([
  'stopped',
  'acquiring-ownership',
  'starting',
  'ready',
  'degraded',
  'authentication-required',
  'owner-conflict',
  'failed',
  'stopping',
  'recovered',
]);
const MAX_ACCESSORY_ALIASES = 32;
const HOMEKIT_EVENT_ROUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  'battery.status': new Set(['battery-alert', 'battery-level']),
  'contact.sensor': new Set(['contact-state']),
  'doorbell.press': new Set(['doorbell-press']),
  'motion.sensor': new Set(['motion-detection']),
  'smart-light.lightbulb': new Set(['smart-light-state']),
};
const HOMEKIT_OBSERVATIONS = new Set(['malformed', 'missing', 'valid']);
const RUNTIME_NOTICES = {
  'status-publication-failed': {
    level: 'warn',
    messageKey: 'log.notice.statusPublicationFailed',
  },
  'ownership-release-not-finalized': {
    level: 'error',
    messageKey: 'log.notice.ownershipReleaseNotFinalized',
  },
  'ownership-release-failed': {
    level: 'error',
    messageKey: 'log.notice.ownershipReleaseFailed',
  },
  'shutdown-failed': {
    level: 'error',
    messageKey: 'log.notice.shutdownFailed',
  },
  'shutdown-timeout': {
    level: 'warn',
    messageKey: 'log.notice.shutdownTimeout',
    durationMessageKey: 'log.notice.shutdownTimeoutWithDuration',
  },
  'ownership-acquisition-failed': {
    level: 'error',
    messageKey: 'log.notice.ownershipAcquisitionFailed',
  },
  'ownership-release-incomplete': {
    level: 'warn',
    messageKey: 'log.notice.ownershipReleaseIncomplete',
  },
  'registry-subscriber-failed': {
    level: 'warn',
    messageKey: 'log.notice.registrySubscriberFailed',
  },
  'event-subscriber-failed': {
    level: 'warn',
    messageKey: 'log.notice.eventSubscriberFailed',
  },
  'state-subscriber-failed': {
    level: 'warn',
    messageKey: 'log.notice.stateSubscriberFailed',
  },
} as const;

export type RuntimeNoticeCode = keyof typeof RUNTIME_NOTICES;
const RUNTIME_CONDITIONS = {
  degraded: {
    code: 'runtime-transport-degraded',
    summaryKey: 'log.runtime.transportDegraded',
    actionKey: 'log.action.checkNetwork',
    level: 'warn',
  },
  'authentication-required': {
    code: 'runtime-authentication-required',
    summaryKey: 'log.runtime.authenticationRequired',
    actionKey: 'log.action.reauthenticate',
    level: 'warn',
  },
  'owner-conflict': {
    code: 'runtime-owner-conflict',
    summaryKey: 'log.runtime.ownerConflict',
    actionKey: 'log.action.stopOtherOwner',
    level: 'error',
  },
  failed: {
    code: 'runtime-failed',
    summaryKey: 'log.runtime.failed',
    actionKey: 'log.action.reviewRuntime',
    level: 'error',
  },
} as const;
const HOMEKIT_CONDITIONS = {
  'recognized-device-not-represented': {
    summaryKey: 'log.homekit.recognizedNotRepresented',
    actionKey: 'log.action.openDashboard',
  },
  'battery-capability-unavailable': {
    summaryKey: 'log.homekit.batteryCapabilityUnavailable',
    actionKey: 'log.action.waitBattery',
  },
  'invalid-battery-observation': {
    summaryKey: 'log.homekit.invalidBatteryObservation',
    actionKey: 'log.action.waitBatteryObservation',
  },
  'battery-temperature-alert': {
    summaryKey: 'log.homekit.batteryTemperatureAlert',
    actionKey: 'log.action.allowBatteryCooling',
  },
  'contact-capability-unavailable': {
    summaryKey: 'log.homekit.contactCapabilityUnavailable',
    actionKey: 'log.action.waitContact',
  },
  'invalid-contact-observation': {
    summaryKey: 'log.homekit.invalidContactObservation',
    actionKey: 'log.action.waitContactObservation',
  },
  'siren-capability-unavailable': {
    summaryKey: 'log.homekit.sirenCapabilityUnavailable',
    actionKey: 'log.action.waitSiren',
  },
  'invalid-siren-active-observation': {
    summaryKey: 'log.homekit.invalidSirenObservation',
    actionKey: 'log.action.waitSirenObservation',
  },
  'smart-light-capability-unavailable': {
    summaryKey: 'log.homekit.lightCapabilityUnavailable',
    actionKey: 'log.action.waitLight',
  },
  'invalid-smart-light-observation': {
    summaryKey: 'log.homekit.invalidLightObservation',
    actionKey: 'log.action.waitLightObservation',
  },
  'smart-light-operation-failed': {
    summaryKey: 'log.homekit.lightOperationFailed',
    actionKey: 'log.action.retryLight',
  },
  'smart-light-reconciliation-expired': {
    summaryKey: 'log.homekit.lightReconciliationExpired',
    actionKey: 'log.action.checkPhysicalLight',
  },
} as const;

type HomeKitConditionCode = keyof typeof HOMEKIT_CONDITIONS;

function sanitizeStructuredEvent(message: string): Record<string, unknown> | undefined {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    value = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const level = ['debug', 'info', 'warn', 'error'].includes(String(value.level)) ? String(value.level) : undefined;
  if (!level || typeof value.scope !== 'string') return undefined;

  if (value.scope === 'sdk') {
    if (
      typeof value.subsystem !== 'string' ||
      !SDK_SUBSYSTEMS.has(value.subsystem) ||
      typeof value.event !== 'string' ||
      !SDK_EVENT_KEYS.has(value.event)
    ) {
      return undefined;
    }
    const details: Array<Record<string, unknown>> = [];
    for (const detail of Array.isArray(value.details) ? value.details.slice(0, MAX_SDK_DETAILS) : []) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
      const candidate = detail as Record<string, unknown>;
      if (['Error', 'RangeError', 'SessionExpiredError', 'TypeError'].includes(String(candidate.errorType))) {
        details.push({ errorType: String(candidate.errorType) });
        continue;
      }
      if (!['boolean', 'number', 'object', 'string', 'undefined'].includes(String(candidate.type))) continue;
      const length =
        Number.isSafeInteger(candidate.length) && Number(candidate.length) >= 0 ? Number(candidate.length) : undefined;
      details.push({ type: String(candidate.type), ...(length === undefined ? {} : { length }) });
    }
    return {
      scope: 'sdk',
      level,
      subsystem: value.subsystem,
      event: value.event,
      ...(details.length ? { details } : {}),
      ...(value.detailsTruncated === true ? { detailsTruncated: true } : {}),
    };
  }

  if (value.scope === 'runtime-notice') {
    if (typeof value.code !== 'string' || !Object.hasOwn(RUNTIME_NOTICES, value.code)) return undefined;
    const notice = RUNTIME_NOTICES[value.code as RuntimeNoticeCode];
    const durationMs =
      Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0 ? Number(value.durationMs) : undefined;
    const messageKey =
      durationMs !== undefined && 'durationMessageKey' in notice ? notice.durationMessageKey : notice.messageKey;
    return {
      scope: 'runtime-notice',
      level: notice.level,
      code: value.code,
      messageKey,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }

  if (value.scope === 'configuration-notice') {
    if (value.code !== 'discarded-v4-settings-unacknowledged') return undefined;
    return {
      scope: 'configuration-notice',
      level: 'warn',
      code: value.code,
      messageKey: 'log.discardedSettings',
    };
  }

  if (value.scope === 'homekit') {
    if (
      typeof value.adapter !== 'string' ||
      typeof value.event !== 'string' ||
      !HOMEKIT_EVENT_ROUTES[value.adapter]?.has(value.event) ||
      typeof value.observation !== 'string' ||
      !HOMEKIT_OBSERVATIONS.has(value.observation)
    ) {
      return undefined;
    }
    return {
      scope: 'homekit',
      level: 'debug',
      adapter: value.adapter,
      event: value.event,
      observation: value.observation,
    };
  }

  if (value.scope === 'runtime') {
    if (!['ready', 'stopped'].includes(String(value.event))) return undefined;
    return { scope: 'runtime', level: 'info', event: value.event, messageKey: 'log.runtime.state' };
  }

  if (value.scope === 'diagnostic-condition') {
    const homeKitDefinition =
      typeof value.code === 'string' && Object.hasOwn(HOMEKIT_CONDITIONS, value.code)
        ? HOMEKIT_CONDITIONS[value.code as HomeKitConditionCode]
        : undefined;
    const runtimeDefinition = Object.values(RUNTIME_CONDITIONS).find(({ code }) => code === value.code);
    if (typeof value.code !== 'string' || (!homeKitDefinition && !runtimeDefinition)) return undefined;
    if (typeof value.active !== 'boolean' || typeof value.reason !== 'string') return undefined;
    if (runtimeDefinition) {
      if (!RUNTIME_CONDITION_REASONS.has(value.reason)) return undefined;
      if (
        value.capability !== undefined ||
        value.member !== undefined ||
        value.affectedAccessoryCount !== undefined ||
        value.accessoryAliases !== undefined ||
        value.aliasesTruncated !== undefined
      ) {
        return undefined;
      }
      return {
        scope: 'diagnostic-condition',
        level: value.active ? runtimeDefinition.level : 'info',
        code: value.code,
        active: value.active,
        reason: value.reason,
        summaryKey: runtimeDefinition.summaryKey,
        actionKey: runtimeDefinition.actionKey,
      };
    }
    if (!REASONS.has(value.reason)) return undefined;
    const affectedAccessoryCount =
      Number.isSafeInteger(value.affectedAccessoryCount) && Number(value.affectedAccessoryCount) >= 0
        ? Number(value.affectedAccessoryCount)
        : undefined;
    const accessoryAliases = Array.isArray(value.accessoryAliases)
      ? value.accessoryAliases
          .filter((alias): alias is string => typeof alias === 'string' && /^accessory-[0-9a-f-]{36}$/.test(alias))
          .slice(0, MAX_ACCESSORY_ALIASES)
      : [];
    return {
      scope: 'diagnostic-condition',
      level: value.active ? 'warn' : 'info',
      code: value.code,
      active: value.active,
      reason: value.reason,
      summaryKey: homeKitDefinition!.summaryKey,
      actionKey: homeKitDefinition!.actionKey,
      ...(typeof value.capability === 'string' && CAPABILITIES.has(value.capability)
        ? { capability: value.capability }
        : {}),
      ...(typeof value.member === 'string' && MEMBERS.has(value.member) ? { member: value.member } : {}),
      ...(affectedAccessoryCount === undefined ? {} : { affectedAccessoryCount }),
      ...(accessoryAliases.length ? { accessoryAliases } : {}),
      ...(value.aliasesTruncated === true ? { aliasesTruncated: true } : {}),
    };
  }

  return undefined;
}

/** Emits one fixed-shape operational notice selected by its allowlisted runtime code. */
export function reportRuntimeNotice(
  target: Pick<PlatformLogger, 'error' | 'warn'> & Partial<Pick<PlatformLogger, 'debug'>>,
  code: RuntimeNoticeCode,
  fields: { durationMs?: number } = {},
): void {
  const notice = RUNTIME_NOTICES[code];
  const durationMs = fields.durationMs === undefined ? undefined : Math.max(0, Math.trunc(fields.durationMs));
  const messageKey =
    durationMs !== undefined && 'durationMessageKey' in notice ? notice.durationMessageKey : notice.messageKey;
  target[notice.level](`[${code}] ${localize(target, messageKey, { durationMs: durationMs ?? 0 })}`);
  target.debug?.(
    JSON.stringify({
      scope: 'runtime-notice',
      level: notice.level,
      code,
      messageKey,
      ...(durationMs === undefined ? {} : { durationMs }),
    }),
  );
}

/** Emits the startup notice for discarded settings awaiting acknowledgement. */
export function reportDiscardedV4Settings(
  target: Pick<PlatformLogger, 'warn'> & Partial<Pick<PlatformLogger, 'debug'>>,
): void {
  const code = 'discarded-v4-settings-unacknowledged';
  const messageKey = 'log.discardedSettings';
  target.warn(`[${code}] ${localize(target, messageKey)}`);
  target.debug?.(
    JSON.stringify({
      scope: 'configuration-notice',
      level: 'warn',
      code,
      messageKey,
    }),
  );
}

/** Emits one allowlisted HomeKit event trace only when host debug output is available. */
export function reportHomeKitEvent(target: Pick<PlatformLogger, 'debug'>, trace: HomeKitEventTrace): void {
  if (
    !target.debug ||
    !HOMEKIT_EVENT_ROUTES[trace.adapter]?.has(trace.event) ||
    !HOMEKIT_OBSERVATIONS.has(trace.observation)
  ) {
    return;
  }
  target.debug(
    JSON.stringify({
      scope: 'homekit',
      level: 'debug',
      adapter: trace.adapter,
      event: trace.event,
      observation: trace.observation,
    }),
  );
}

/** Emits bounded normal-output condition transitions without stable device or account identity. */
export class DiagnosticConditions {
  private readonly active = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private runtimeState?: RuntimeState;

  constructor(private readonly log: PlatformLogger) {}

  reportRuntimeState(state: RuntimeState): void {
    if (state === this.runtimeState) {
      return;
    }
    this.runtimeState = state;
    const current = RUNTIME_CONDITIONS[state as keyof typeof RUNTIME_CONDITIONS];
    for (const condition of Object.values(RUNTIME_CONDITIONS)) {
      if (condition !== current) {
        this.write(
          condition.code,
          false,
          state === 'ready' ? 'recovered' : state,
          condition.summaryKey,
          condition.actionKey,
          'info',
        );
      }
    }
    if (current) {
      this.write(current.code, true, state, current.summaryKey, current.actionKey, current.level);
    } else if (state === 'ready' || state === 'stopped') {
      const messageKey = 'log.runtime.state';
      this.log.info(`[runtime-${state}] ${localize(this.log, messageKey, { state })}`);
      this.log.debug?.(JSON.stringify({ scope: 'runtime', level: 'info', event: state, messageKey }));
    }
  }

  reportHomeKit(condition: HomeKitCondition, affectedDeviceIds: readonly string[]): void {
    const definition = Object.hasOwn(HOMEKIT_CONDITIONS, condition.code)
      ? HOMEKIT_CONDITIONS[condition.code as HomeKitConditionCode]
      : undefined;
    if (
      definition === undefined ||
      !REASONS.has(condition.reason) ||
      (condition.capability !== undefined && !CAPABILITIES.has(condition.capability)) ||
      (condition.member !== undefined && !MEMBERS.has(condition.member))
    ) {
      return;
    }
    const uniqueDeviceIds = condition.active ? [...new Set(affectedDeviceIds)].sort() : [];
    const accessoryAliases = uniqueDeviceIds
      .map((identity) => this.accessoryAlias(identity))
      .filter((alias): alias is string => alias !== undefined)
      .sort();
    this.write(
      condition.code,
      condition.active,
      condition.reason,
      definition.summaryKey,
      definition.actionKey,
      condition.active ? 'warn' : 'info',
      {
        ...(condition.capability === undefined ? {} : { capability: condition.capability }),
        ...(condition.member === undefined ? {} : { member: condition.member }),
        affectedAccessoryCount: uniqueDeviceIds.length,
        ...(accessoryAliases.length === 0 ? {} : { accessoryAliases }),
        ...(accessoryAliases.length === uniqueDeviceIds.length ? {} : { aliasesTruncated: true }),
      },
      `${condition.code}:${condition.capability ?? ''}:${condition.member ?? ''}`,
    );
  }

  private accessoryAlias(identity: string): string | undefined {
    let alias = this.aliases.get(identity);
    if (!alias && this.aliases.size < MAX_ACCESSORY_ALIASES) {
      alias = `accessory-${randomUUID()}`;
      this.aliases.set(identity, alias);
    }
    return alias;
  }

  private write(
    code: string,
    active: boolean,
    reason: string,
    summaryKey: string,
    actionKey: string,
    level: 'info' | 'warn' | 'error',
    fields: Readonly<Record<string, unknown>> = {},
    conditionKey = code,
  ): void {
    const fingerprint = JSON.stringify({ active, reason, ...fields });
    if (active) {
      if (this.active.get(conditionKey) === fingerprint) {
        return;
      }
      this.active.set(conditionKey, fingerprint);
    } else if (!this.active.delete(conditionKey)) {
      return;
    }
    const affectedAccessoryCount =
      typeof fields.affectedAccessoryCount === 'number' ? fields.affectedAccessoryCount : undefined;
    const summary = localize(this.log, summaryKey);
    const action = localize(this.log, actionKey);
    const affected = affectedAccessoryCount
      ? localize(this.log, affectedAccessoryCount === 1 ? 'log.condition.affectedOne' : 'log.condition.affectedMany', {
          count: affectedAccessoryCount,
        })
      : '';
    const message = localize(this.log, active ? 'log.condition.active' : 'log.condition.recovered', {
      action,
      affected,
      summary,
    });
    this.log[level](`[${code}] ${message}`);
    this.log.debug?.(
      JSON.stringify({
        scope: 'diagnostic-condition',
        level,
        code,
        active,
        reason,
        summaryKey,
        actionKey,
        ...fields,
      }),
    );
  }
}
