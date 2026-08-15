import { randomUUID } from 'node:crypto';

import type { Logger } from '@mega-yfue/eufy-sdk';

export interface PlatformLogger {
  debug?(message: string): void;
  error(message: string): void;
  info(message: string): void;
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

/** Adapts SDK protocol detail to bounded debug output without preserving supplied values. */
export function createSdkLogger(target: Partial<PlatformLogger> | undefined): Logger | undefined {
  if (!target?.debug) {
    return undefined;
  }
  const format = (message: string, args: unknown[]): Record<string, unknown> => {
    const requestedSubsystem = /^\[([a-z0-9-]+)\]/i.exec(message)?.[1]?.toLowerCase();
    const subsystem = ['device', 'ffmpeg', 'mega', 'mqtt', 'p2p', 'push', 'webrtc'].includes(requestedSubsystem ?? '')
      ? requestedSubsystem
      : 'sdk';
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
      ...(details.length ? { details } : {}),
      ...(args.length > MAX_SDK_DETAILS ? { detailsTruncated: true } : {}),
    };
  };
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, args: unknown[]): void => {
    target.debug!(JSON.stringify({ ...format(message, args), level }));
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
  'status-publication-failed': { level: 'warn', action: 'Dashboard status may be stale' },
  'ownership-release-not-finalized': { level: 'error', action: 'Restart Homebridge before retrying' },
  'ownership-release-failed': { level: 'error', action: 'Restart Homebridge before retrying' },
  'shutdown-failed': { level: 'error', action: 'Restart Homebridge before retrying' },
  'shutdown-timeout': { level: 'warn', action: 'Homebridge shutdown will continue' },
  'ownership-acquisition-failed': { level: 'error', action: 'Restart Homebridge before retrying' },
  'ownership-release-incomplete': { level: 'warn', action: 'Restart Homebridge before retrying' },
  'registry-subscriber-failed': { level: 'warn', action: 'Review Homebridge Eufy health in the dashboard' },
  'event-subscriber-failed': { level: 'warn', action: 'Review Homebridge Eufy health in the dashboard' },
  'state-subscriber-failed': { level: 'warn', action: 'Review Homebridge Eufy health in the dashboard' },
} as const;

export type RuntimeNoticeCode = keyof typeof RUNTIME_NOTICES;
const RUNTIME_CONDITIONS = {
  degraded: {
    code: 'runtime-transport-degraded',
    action: 'Check network access and Eufy service availability',
    level: 'warn',
  },
  'authentication-required': {
    code: 'runtime-authentication-required',
    action: 'Authenticate again in the Homebridge Eufy dashboard, then restart Homebridge',
    level: 'warn',
  },
  'owner-conflict': {
    code: 'runtime-owner-conflict',
    action: 'Stop the other Homebridge Eufy owner before restarting Homebridge',
    level: 'error',
  },
  failed: {
    code: 'runtime-failed',
    action: 'Review Homebridge Eufy health in the dashboard and restart Homebridge',
    level: 'error',
  },
} as const;
const HOMEKIT_ACTIONS = {
  'recognized-device-not-represented': 'Review device representation in the Homebridge Eufy dashboard',
  'battery-capability-unavailable': 'Wait for complete battery capability evidence',
  'invalid-battery-observation': 'Wait for a valid battery observation',
  'battery-temperature-alert': 'Allow the device battery to return to a safe temperature',
  'contact-capability-unavailable': 'Wait for complete contact capability evidence',
  'invalid-contact-observation': 'Wait for a valid contact observation',
  'siren-capability-unavailable': 'Wait for complete siren capability evidence',
  'invalid-siren-active-observation': 'Wait for a valid siren observation',
  'smart-light-capability-unavailable': 'Wait for complete smart-light capability evidence',
  'invalid-smart-light-observation': 'Wait for a valid smart-light observation',
  'smart-light-operation-failed': 'Retry the smart-light control manually',
  'smart-light-reconciliation-expired': 'Check the physical smart-light state before retrying',
} as const;

type HomeKitConditionCode = keyof typeof HOMEKIT_ACTIONS;

/** Emits one fixed-shape operational notice selected by its allowlisted runtime code. */
export function reportRuntimeNotice(
  target: Pick<PlatformLogger, 'error' | 'warn'>,
  code: RuntimeNoticeCode,
  fields: { durationMs?: number } = {},
): void {
  const notice = RUNTIME_NOTICES[code];
  target[notice.level](
    JSON.stringify({
      scope: 'runtime-notice',
      code,
      action: notice.action,
      ...(fields.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.trunc(fields.durationMs)) }),
    }),
  );
}

/** Emits the one startup notice for effectful discarded V4 settings awaiting acknowledgement. */
export function reportDiscardedV4Settings(target: Pick<PlatformLogger, 'warn'>): void {
  target.warn(
    JSON.stringify({
      scope: 'configuration-notice',
      code: 'discarded-v4-settings-unacknowledged',
      action: 'Review and acknowledge discarded V4 settings in the Homebridge Eufy dashboard',
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
        this.write(condition.code, false, state === 'ready' ? 'recovered' : state, condition.action, 'info');
      }
    }
    if (current) {
      this.write(current.code, true, state, current.action, current.level);
    } else if (state === 'ready' || state === 'stopped') {
      this.log.info(JSON.stringify({ scope: 'runtime', event: state }));
    }
  }

  reportHomeKit(condition: HomeKitCondition, affectedDeviceIds: readonly string[]): void {
    const action = Object.hasOwn(HOMEKIT_ACTIONS, condition.code)
      ? HOMEKIT_ACTIONS[condition.code as HomeKitConditionCode]
      : undefined;
    if (
      action === undefined ||
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
      action,
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
    action: string,
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
    this.log[level](
      JSON.stringify({
        scope: 'diagnostic-condition',
        code,
        active,
        reason,
        action,
        ...fields,
      }),
    );
  }
}
