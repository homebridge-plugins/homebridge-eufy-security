import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-for-homebridge';
import { describe, expect, it } from 'vitest';

import { parseConfig, resolveEntityPreference, serializeConfig, type EufyConfig } from '../../src/configuration.js';

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
      ffmpegPath: '/synthetic/ffmpeg',
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
});
