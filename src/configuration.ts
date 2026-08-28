import bundledFfmpegPath from 'ffmpeg-for-homebridge';

import { PLATFORM_NAME } from './settings.js';

export const DEFAULT_COUNTRY = 'US';
export const DEFAULT_TRUSTED_DEVICE_NAME = 'Homebridge Eufy';
export const DEFAULT_POLLING_INTERVAL_MINUTES = 10;
export const DEFAULT_WARM_UP_EVENTS: readonly string[] = ['doorbellPress'];

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
  warmUpEvents: string[];
  ffmpegPath: string | undefined;
  entityPreferences: Record<string, EntityPreference>;
  discardedV4Settings: string[];
  discardedV4Acknowledged: boolean;
}

/**
 * Events whose arrival may open a camera's connection before HomeKit asks for media.
 *
 * The names are the SDK's own semantic events, not a vocabulary invented here: the interface offers whatever
 * the discovered devices report, so an event the SDK gains needs no change in this plugin, and the list is
 * handed straight back to the SDK. That is also why an unrecognised entry is kept rather than refused — this
 * plugin cannot know the whole valid set, which depends on the devices and the SDK version, and a stored name
 * the SDK no longer emits simply never fires.
 *
 * Opening a connection early is what makes the media HomeKit asks for straight afterwards start immediately
 * instead of waiting on a cold one. The list is global and the warming is not: an event opens the connection of
 * the camera that reported it and no other, so each camera is warmed only by the events it reports itself. It is
 * not free either — a camera running on its own battery is kept awake for the whole idle window that follows, so
 * a camera reporting often may never sleep. Which events earn that is the user's call.
 */

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
  const warmUpEvents = parseWarmUpEvents(value.warmUpEvents);
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
    warmUpEvents,
    ffmpegPath: configuredFfmpegPath ?? bundledFfmpegPath,
    entityPreferences: parseEntityPreferences(value.entityPreferences),
    discardedV4Settings: parseDiscardedV4Settings(value.discardedV4Settings),
    discardedV4Acknowledged: value.discardedV4Acknowledged === true,
  };
}

/**
 * Whether a resolved FFmpeg path names the binary bundled with the plugin or one an administrator chose.
 *
 * The two are different builds with different encoder sets on the same host, so an adaptation failure cannot be
 * attributed without knowing which one ran. It is decided by comparing the resolved value with the bundled
 * one rather than by remembering which branch produced it, because a configuration this plugin serialized
 * carries the resolved path back as an explicit setting and would otherwise report the bundled binary as a
 * chosen one.
 */
export function ffmpegPathSource(path: string): 'bundled' | 'configured' {
  return path === bundledFfmpegPath ? 'bundled' : 'configured';
}

/** Produces a synthetic-safe Homebridge block without discovering or filtering entities. */
/**
 * The chosen warm-up events, refusing anything unrecognised rather than dropping it.
 *
 * Silently ignoring an unknown entry would leave a user who mistyped one believing a camera is warmed when it
 * is not. Duplicates collapse and the declared order is restored, so the stored list is comparable however the
 * interface happened to build it.
 */
function parseWarmUpEvents(value: unknown): string[] {
  if (value === undefined) {
    return [...DEFAULT_WARM_UP_EVENTS];
  }
  if (!Array.isArray(value)) {
    throw new TypeError('warmUpEvents must be an array');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new TypeError('warmUpEvents entries must be non-empty strings');
    }
  }
  return [...new Set(value as string[])].sort();
}

export function serializeConfig(config: EufyConfig): Record<string, unknown> {
  return {
    platform: PLATFORM_NAME,
    username: config.username,
    password: config.password,
    country: config.country,
    trustedDeviceName: config.trustedDeviceName,
    pollingIntervalMinutes: config.pollingIntervalMinutes,
    warmUpEvents: [...config.warmUpEvents],
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
