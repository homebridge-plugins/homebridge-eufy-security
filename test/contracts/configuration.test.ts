import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-for-homebridge';
import { describe, expect, it } from 'vitest';

import { parseConfig, resolveEntityPreference, serializeConfig, type EufyConfig } from '../../src/configuration.js';

describe('V5 configuration', () => {
  it('publishes the same defaults and closed entity-preference vocabulary in its schema', () => {
    const repository = fileURLToPath(new URL('../..', import.meta.url));
    const schema = JSON.parse(readFileSync(`${repository}/config.schema.json`, 'utf8')) as {
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
    const config = parseConfig({ platform: 'EufySecurity' });

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

  it('round trips overrides and preferences for entities absent from discovery', () => {
    const absentSerial = 'synthetic-absent-entity';
    const input = {
      platform: 'EufySecurity',
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
      platform: 'EufySecurity',
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
    });
    expect(resolveEntityPreference(roundTrip, 'synthetic-sparse-entity')).toEqual({
      represented: true,
      audio: false,
      snapshotMode: 'Refresh',
    });
  });

  it('does not import discarded V4 device arrays or feature settings', () => {
    const config = parseConfig({
      platform: 'EufySecurity',
      username: 'guest@example.invalid',
      cameras: [{ serialNumber: 'synthetic-camera', enableCamera: false }],
      stations: [{ serialNumber: 'synthetic-station' }],
      ignoreDevices: ['synthetic-camera'],
      enableDetailedLogging: true,
      CameraMaxLivestreamDuration: 30,
      entityPreferences: {
        'synthetic-absent-entity': { represented: false },
      },
    });

    const serialized = serializeConfig(config);
    expect(serialized).toEqual(
      expect.objectContaining({
        entityPreferences: {
          'synthetic-absent-entity': { represented: false },
        },
      }),
    );
    expect(serialized).not.toHaveProperty('cameras');
    expect(serialized).not.toHaveProperty('stations');
    expect(serialized).not.toHaveProperty('ignoreDevices');
    expect(serialized).not.toHaveProperty('enableDetailedLogging');
    expect(serialized).not.toHaveProperty('CameraMaxLivestreamDuration');
  });

  it('rejects attempts to manufacture SDK capabilities through configuration', () => {
    expect(() =>
      parseConfig({
        platform: 'EufySecurity',
        entityPreferences: {
          'synthetic-entity': {
            capabilities: ['lock'],
          },
        },
      }),
    ).toThrowError('entityPreferences.synthetic-entity.capabilities is not a V5 entity preference');

    expect(() => parseConfig({ platform: 'EufySecurity', capabilities: ['lock'] })).toThrowError(
      'capabilities cannot be supplied by configuration',
    );
  });
});
