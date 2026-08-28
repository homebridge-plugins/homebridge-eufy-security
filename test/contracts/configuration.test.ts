import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-for-homebridge';
import { describe, expect, it } from 'vitest';

import {
  ffmpegPathSource,
  parseConfig,
  resolveEntityPreference,
  serializeConfig,
  type EufyConfig,
} from '../../src/configuration.js';

describe('V5 configuration', () => {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const migrationFixture = JSON.parse(readFileSync(`${repository}/test/fixtures/v4-migration.json`, 'utf8')) as {
    configuration: Record<string, unknown>;
  };

  it('publishes the same defaults and closed entity-preference vocabulary in its schema', () => {
    const schema = JSON.parse(readFileSync(`${repository}/config.schema.json`, 'utf8')) as {
      pluginAlias: string;
      schema: {
        properties: Record<
          string,
          {
            additionalProperties?: boolean;
            default?: unknown;
            format?: string;
            patternProperties?: Record<string, unknown>;
          }
        >;
      };
    };

    expect(schema.pluginAlias).toBe('HomebridgeEufy');
    expect(schema.schema.properties.password.format).toBe('password');
    expect(schema.schema.properties.country.default).toBe('US');
    expect(schema.schema.properties.trustedDeviceName.default).toBe('Homebridge Eufy');
    expect(schema.schema.properties.pollingIntervalMinutes.default).toBe(10);
    expect(schema.schema.properties.maxConcurrentMediaSessions.default).toBe(0);
    expect(
      schema.schema.properties.maxConcurrentMediaSessions.description,
      'zero is not an obvious way to spell unlimited, so the schema has to say so',
    ).toMatch(/unlimited/i);
    expect(schema.schema.properties.warmUpEvents.default).toEqual(['doorbellPress']);
    expect(
      schema.schema.properties.warmUpEvents.items,
      'the valid set is whatever the devices report, so pinning an enum here would go stale',
    ).toEqual({ type: 'string' });
    expect(
      schema.schema.properties.warmUpEvents.description,
      'the user has to be told what the setting costs, not only what it does',
    ).toMatch(/battery/i);
    expect(schema.schema.properties.entityPreferences.additionalProperties).toBe(false);
    expect(schema.schema.properties.entityPreferences.patternProperties).toEqual({
      '^.+$': {
        additionalProperties: false,
        properties: {
          represented: { default: true, type: 'boolean' },
          audio: { default: true, type: 'boolean' },
          snapshotMode: { default: 'Refresh', enum: ['Cloud', 'Live', 'Refresh'], type: 'string' },
        },
        type: 'object',
      },
    });
    expect(schema.schema.properties).not.toHaveProperty('capabilities');
  });

  it('applies the fresh V5 defaults', () => {
    const config = parseConfig({ platform: 'HomebridgeEufy' });

    expect(config).toMatchObject({
      country: 'US',
      trustedDeviceName: 'Homebridge Eufy',
      pollingIntervalMinutes: 10,
      maxConcurrentMediaSessions: 0,
      warmUpEvents: ['doorbellPress'],
      ffmpegPath,
      entityPreferences: {},
    });
    expect(resolveEntityPreference(config, 'synthetic-serial')).toEqual({
      represented: true,
      audio: true,
      snapshotMode: 'Refresh',
    });
  });

  it('rejects the V4 platform alias instead of registering a compatibility identity', () => {
    expect(() => parseConfig({ platform: 'EufySecurity' })).toThrowError('platform must be HomebridgeEufy');
  });

  it('leaves concurrent media unlimited until an operator declares a limit', () => {
    expect(
      parseConfig({ platform: 'HomebridgeEufy' }).maxConcurrentMediaSessions,
      'the plugin cannot know what a host carries, so it changes nothing until told',
    ).toBe(0);
    expect(parseConfig({ platform: 'HomebridgeEufy', maxConcurrentMediaSessions: 0 }).maxConcurrentMediaSessions).toBe(
      0,
    );
    expect(parseConfig({ platform: 'HomebridgeEufy', maxConcurrentMediaSessions: 1 }).maxConcurrentMediaSessions).toBe(
      1,
    );
  });

  it('refuses a concurrent media limit that is not a whole count, rather than clamping one', () => {
    for (const maxConcurrentMediaSessions of [-1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => parseConfig({ platform: 'HomebridgeEufy', maxConcurrentMediaSessions }),
        `${JSON.stringify(maxConcurrentMediaSessions)} has to be refused rather than quietly repaired`,
      ).toThrowError('maxConcurrentMediaSessions must be a non-negative integer');
    }
    expect(
      parseConfig({ platform: 'HomebridgeEufy', maxConcurrentMediaSessions: null }).maxConcurrentMediaSessions,
      'an explicit null reads as unset here, as it already does for the polling interval beside it',
    ).toBe(0);
  });

  it('round trips overrides and preferences for entities absent from discovery', () => {
    const absentSerial = 'synthetic-absent-entity';
    const input = {
      platform: 'HomebridgeEufy',
      username: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'gb',
      trustedDeviceName: 'Synthetic Bridge',
      pollingIntervalMinutes: 3,
      ffmpegPath: '/synthetic/ffmpeg',
      maxConcurrentMediaSessions: 4,
      entityPreferences: {
        [absentSerial]: {
          represented: false,
          audio: false,
          snapshotMode: 'Cloud',
        },
        'synthetic-sparse-entity': { audio: false },
      },
    };

    const roundTrip = parseConfig(serializeConfig(parseConfig(input)));

    expect(roundTrip).toEqual<EufyConfig>({
      platform: 'HomebridgeEufy',
      username: 'guest@example.invalid',
      password: 'synthetic-password',
      country: 'GB',
      trustedDeviceName: 'Synthetic Bridge',
      pollingIntervalMinutes: 3,
      warmUpEvents: ['doorbellPress'],
      ffmpegPath: '/synthetic/ffmpeg',
      maxConcurrentMediaSessions: 4,
      entityPreferences: {
        [absentSerial]: {
          represented: false,
          audio: false,
          snapshotMode: 'Cloud',
        },
        'synthetic-sparse-entity': { audio: false },
      },
      discardedV4Settings: [],
      discardedV4Acknowledged: false,
    });
    expect(resolveEntityPreference(roundTrip, 'synthetic-sparse-entity')).toEqual({
      represented: true,
      audio: false,
      snapshotMode: 'Refresh',
    });
  });

  it('imports no discarded V4 arrays, toggles, maps, media options, flags, or workarounds', () => {
    const config = parseConfig({
      ...migrationFixture.configuration,
      platform: 'HomebridgeEufy',
      trustedDeviceName: 'V5 bridge',
      entityPreferences: {
        'synthetic-absent-entity': { represented: false },
      },
    });

    expect(serializeConfig(config)).toEqual({
      platform: 'HomebridgeEufy',
      username: 'legacy@example.invalid',
      password: 'synthetic-password',
      country: 'CA',
      trustedDeviceName: 'V5 bridge',
      pollingIntervalMinutes: 2,
      maxConcurrentMediaSessions: 0,
      warmUpEvents: ['doorbellPress'],
      ffmpegPath: '/legacy/ffmpeg',
      entityPreferences: {
        'synthetic-absent-entity': { represented: false },
      },
    });
  });

  it('round trips bounded discarded-setting names and acknowledgement metadata', () => {
    const config = parseConfig({
      platform: 'HomebridgeEufy',
      discardedV4Settings: ['cameras', 'ignoreDevices'],
      discardedV4Acknowledged: true,
    });
    expect(serializeConfig(config)).toMatchObject({
      discardedV4Settings: ['cameras', 'ignoreDevices'],
      discardedV4Acknowledged: true,
    });
  });

  it('rejects attempts to manufacture SDK capabilities through configuration', () => {
    expect(() =>
      parseConfig({
        platform: 'HomebridgeEufy',
        entityPreferences: {
          'synthetic-entity': {
            capabilities: ['lock'],
          },
        },
      }),
    ).toThrowError('entityPreferences.synthetic-entity.capabilities is not a V5 entity preference');

    expect(() => parseConfig({ platform: 'HomebridgeEufy', capabilities: ['lock'] })).toThrowError(
      'capabilities cannot be supplied by configuration',
    );
  });

  it('refuses a warm-up list that is not a list of names', () => {
    expect(() => parseConfig({ platform: 'HomebridgeEufy', warmUpEvents: 'doorbellPress' })).toThrow(
      /warmUpEvents must be an array/,
    );
    expect(() => parseConfig({ platform: 'HomebridgeEufy', warmUpEvents: [''] })).toThrow(
      /warmUpEvents entries must be non-empty strings/,
    );
  });

  it('keeps a warm-up name it does not recognise, because the SDK owns that vocabulary', () => {
    expect(
      parseConfig({ platform: 'HomebridgeEufy', warmUpEvents: ['motion', 'someLaterSdkEvent'] }),
      'refusing it would break a config the moment the SDK renames an event',
    ).toMatchObject({ warmUpEvents: ['motion', 'someLaterSdkEvent'] });
  });

  it('stores the warm-up list deduplicated and ordered, so it compares', () => {
    expect(
      parseConfig({ platform: 'HomebridgeEufy', warmUpEvents: ['motion', 'doorbellPress', 'motion'] }),
    ).toMatchObject({ warmUpEvents: ['doorbellPress', 'motion'] });
    expect(parseConfig({ platform: 'HomebridgeEufy', warmUpEvents: [] })).toMatchObject({ warmUpEvents: [] });
  });

  /**
   * The two builds have different encoder sets, so an adaptation failure cannot be attributed without knowing
   * which one ran. It is decided by comparison rather than by remembering the branch, because `serializeConfig`
   * writes the resolved path back as an explicit setting: a round trip would otherwise report the bundled
   * binary as one an administrator chose.
   */
  it('tells the bundled adaptation binary from one an administrator configured, across a round trip', () => {
    const bundled = parseConfig({ platform: 'HomebridgeEufy' });
    const configured = parseConfig({ platform: 'HomebridgeEufy', ffmpegPath: '/synthetic/ffmpeg' });

    expect(ffmpegPathSource(bundled.ffmpegPath!)).toBe('bundled');
    expect(ffmpegPathSource(configured.ffmpegPath!)).toBe('configured');
    expect(
      ffmpegPathSource(parseConfig(serializeConfig(bundled)).ffmpegPath!),
      'the serialized path is the bundled binary, whatever the setting it came back as',
    ).toBe('bundled');
  });
});
