import bundledFfmpegPath from 'ffmpeg-for-homebridge';

import { PLATFORM_NAME } from './settings.js';

export const DEFAULT_COUNTRY = 'US';
export const DEFAULT_TRUSTED_DEVICE_NAME = 'Homebridge Eufy';
export const DEFAULT_POLLING_INTERVAL_MINUTES = 10;
export const DEFAULT_SESSION_WARM_UP: SessionWarmUp = 'doorbell';

export type SnapshotMode = 'Cloud' | 'Live' | 'Refresh';

export interface EntityPreference {
  represented?: boolean;
  audio?: boolean;
  snapshotMode?: SnapshotMode;
}

export interface ResolvedEntityPreference {
  represented: boolean;
  audio: boolean;
  snapshotMode: SnapshotMode;
}

export interface EufyConfig {
  platform: typeof PLATFORM_NAME;
  username?: string;
  password?: string;
  country: string;
  trustedDeviceName: string;
  pollingIntervalMinutes: number;
  sessionWarmUp: SessionWarmUp;
  ffmpegPath: string | undefined;
  entityPreferences: Record<string, EntityPreference>;
  discardedV4Settings: string[];
  discardedV4Acknowledged: boolean;
}

/**
 * How eagerly a camera's session is opened before HomeKit asks for its media.
 *
 * Opening it early is what makes the first live view or snapshot after an event start immediately instead of
 * waiting on a cold session. It is not free: the only camera a warm-up genuinely opens is one that runs on its
 * own battery, and it is then kept awake for the whole idle window that follows. So the setting is ordered by
 * what it costs, and the default earns it — a doorbell press means somebody is at the door, while a detection
 * nobody looks at spends battery for nothing.
 */
export type SessionWarmUp = 'off' | 'doorbell' | 'detections';

const SESSION_WARM_UPS = new Set<SessionWarmUp>(['off', 'doorbell', 'detections']);

const ENTITY_PREFERENCE_KEYS = new Set<keyof EntityPreference>(['represented', 'audio', 'snapshotMode']);
const SNAPSHOT_MODES = new Set<SnapshotMode>(['Cloud', 'Live', 'Refresh']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }
  return value;
}

function parseEntityPreferences(value: unknown): Record<string, EntityPreference> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError('entityPreferences must be an object keyed by SDK entity serial');
  }

  return Object.fromEntries(
    Object.entries(value).map(([serial, candidate]) => {
      if (serial.length === 0 || !isRecord(candidate)) {
        throw new TypeError(`entityPreferences.${serial || '<empty>'} must be an object`);
      }
      for (const key of Object.keys(candidate)) {
        if (!ENTITY_PREFERENCE_KEYS.has(key as keyof EntityPreference)) {
          throw new TypeError(`entityPreferences.${serial}.${key} is not a V5 entity preference`);
        }
      }
      if (candidate.represented !== undefined && typeof candidate.represented !== 'boolean') {
        throw new TypeError(`entityPreferences.${serial}.represented must be a boolean`);
      }
      if (candidate.audio !== undefined && typeof candidate.audio !== 'boolean') {
        throw new TypeError(`entityPreferences.${serial}.audio must be a boolean`);
      }
      if (candidate.snapshotMode !== undefined && !SNAPSHOT_MODES.has(candidate.snapshotMode as SnapshotMode)) {
        throw new TypeError(`entityPreferences.${serial}.snapshotMode must be Cloud, Live, or Refresh`);
      }

      return [serial, { ...candidate } as EntityPreference];
    }),
  );
}

function parseDiscardedV4Settings(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !entry.match(/^[A-Za-z][A-Za-z0-9]{0,63}$/))
  ) {
    throw new TypeError('discardedV4Settings must contain bounded setting names');
  }
  return [...new Set(value)].sort();
}

/** Validates a Homebridge block and resolves the current defaults. */
export function parseConfig(value: unknown): EufyConfig {
  if (!isRecord(value)) {
    throw new TypeError('configuration must be an object');
  }
  if (value.platform !== PLATFORM_NAME) {
    throw new TypeError(`platform must be ${PLATFORM_NAME}`);
  }
  if (value.capabilities !== undefined) {
    throw new TypeError('capabilities cannot be supplied by configuration');
  }

  const country = optionalString(value, 'country') ?? DEFAULT_COUNTRY;
  if (!/^[a-z]{2}$/i.test(country)) {
    throw new TypeError('country must be a two-letter country code');
  }
  const trustedDeviceName = optionalString(value, 'trustedDeviceName') ?? DEFAULT_TRUSTED_DEVICE_NAME;
  if (trustedDeviceName.length === 0) {
    throw new TypeError('trustedDeviceName must not be empty');
  }
  const pollingIntervalMinutes = value.pollingIntervalMinutes ?? DEFAULT_POLLING_INTERVAL_MINUTES;
  if (!Number.isInteger(pollingIntervalMinutes) || (pollingIntervalMinutes as number) < 0) {
    throw new TypeError('pollingIntervalMinutes must be a non-negative integer');
  }
  const sessionWarmUp = (value.sessionWarmUp ?? DEFAULT_SESSION_WARM_UP) as SessionWarmUp;
  if (!SESSION_WARM_UPS.has(sessionWarmUp)) {
    throw new TypeError(`sessionWarmUp must be one of ${[...SESSION_WARM_UPS].join(', ')}`);
  }
  const configuredFfmpegPath = optionalString(value, 'ffmpegPath');
  if (configuredFfmpegPath === '') {
    throw new TypeError('ffmpegPath must not be empty');
  }

  return {
    platform: PLATFORM_NAME,
    username: optionalString(value, 'username'),
    password: optionalString(value, 'password'),
    country: country.toUpperCase(),
    trustedDeviceName,
    pollingIntervalMinutes: pollingIntervalMinutes as number,
    sessionWarmUp,
    ffmpegPath: configuredFfmpegPath ?? bundledFfmpegPath,
    entityPreferences: parseEntityPreferences(value.entityPreferences),
    discardedV4Settings: parseDiscardedV4Settings(value.discardedV4Settings),
    discardedV4Acknowledged: value.discardedV4Acknowledged === true,
  };
}

/** Produces a synthetic-safe Homebridge block without discovering or filtering entities. */
export function serializeConfig(config: EufyConfig): Record<string, unknown> {
  return {
    platform: PLATFORM_NAME,
    username: config.username,
    password: config.password,
    country: config.country,
    trustedDeviceName: config.trustedDeviceName,
    pollingIntervalMinutes: config.pollingIntervalMinutes,
    sessionWarmUp: config.sessionWarmUp,
    ffmpegPath: config.ffmpegPath,
    entityPreferences: Object.fromEntries(
      Object.entries(config.entityPreferences).map(([serial, preference]) => [serial, { ...preference }]),
    ),
    ...(config.discardedV4Settings.length > 0 ? { discardedV4Settings: [...config.discardedV4Settings] } : {}),
    ...(config.discardedV4Acknowledged ? { discardedV4Acknowledged: true } : {}),
  };
}

/** Applies preference defaults without adding a serial to persisted configuration. */
export function resolveEntityPreference(config: EufyConfig, serial: string): ResolvedEntityPreference {
  const preference = config.entityPreferences[serial];
  return {
    represented: preference?.represented ?? true,
    audio: preference?.audio ?? true,
    snapshotMode: preference?.snapshotMode ?? 'Refresh',
  };
}
