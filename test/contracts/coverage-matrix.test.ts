import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ADAPTER_REGISTRY } from '../../src/homekit/adapters/registry.js';
import { SDK_HAP_COVERAGE_MATRIX } from '../../src/homekit/coverage-matrix.js';

describe('SDK/HAP coverage matrix', () => {
  it('classifies the complete current SDK member surface', () => {
    expect(SDK_HAP_COVERAGE_MATRIX.version).toBe(1);
    expect(SDK_HAP_COVERAGE_MATRIX.rows.length).toBeGreaterThan(0);
    expect(new Set(SDK_HAP_COVERAGE_MATRIX.rows.map((row) => row.id)).size).toBe(SDK_HAP_COVERAGE_MATRIX.rows.length);
  });

  it('records executable evidence and policy for every row', () => {
    for (const row of SDK_HAP_COVERAGE_MATRIX.rows) {
      expect(row.memberKind).toMatch(/^(read|event|persistent-operation|momentary-action)$/);
      expect(row.evidence.length, row.id).toBeGreaterThan(0);
      expect(row.hapFit.length, row.id).toBeGreaterThan(0);
      expect(row).toHaveProperty('adapter');
      expect(row.representationStatus).toMatch(/^(represented|not-represented)$/);
      expect(row.controlStatus).toMatch(/^(controllable|not-controllable|not-represented)$/);
      expect(row.identityEffect.length, row.id).toBeGreaterThan(0);
      expect(row.diagnostics.length, row.id).toBeGreaterThan(0);
      expect(row.verification.length, row.id).toBeGreaterThan(0);
      for (const verification of row.verification) {
        const file = resolve(verification.file);
        expect(existsSync(file), `${row.id}: ${verification.file}`).toBe(true);
        expect(readFileSync(file, 'utf8'), `${row.id}: ${verification.behavior}`).toContain(verification.behavior);
      }

      if (row.disposition === 'required-adapter') {
        expect(row.adapter, row.id).toBeTruthy();
        expect(row.verification.length, row.id).toBeGreaterThan(1);
        expect(row.representationStatus).toBe('represented');
      }
    }
  });

  it('admits only represented rows into the closed-world adapter registry', () => {
    const represented = [
      ...new Set(
        SDK_HAP_COVERAGE_MATRIX.rows.filter((row) => row.disposition === 'required-adapter').map((row) => row.adapter!),
      ),
    ];

    expect(Object.keys(ADAPTER_REGISTRY).sort()).toEqual(represented.sort());
    expect(
      Object.values(ADAPTER_REGISTRY)
        .flatMap((adapter) => adapter.coverage.map(({ id }) => id))
        .sort(),
    ).toEqual(
      SDK_HAP_COVERAGE_MATRIX.rows
        .filter((row) => row.disposition === 'required-adapter')
        .map((row) => row.id)
        .sort(),
    );
    expect(
      SDK_HAP_COVERAGE_MATRIX.rows
        .filter((row) => row.disposition !== 'required-adapter')
        .every((row) => row.adapter === null),
    ).toBe(true);
  });

  it('distinguishes representation-establishing adapters from supplemental enrichment', () => {
    expect(ADAPTER_REGISTRY['contact.sensor']).toMatchObject({ role: 'primary-purpose' });
    expect(ADAPTER_REGISTRY['accessory.information']).toMatchObject({ role: 'supplemental' });
    expect(ADAPTER_REGISTRY['battery.status']).toMatchObject({ role: 'supplemental' });
    for (const adapter of Object.values(ADAPTER_REGISTRY)) {
      const coverage = new Set(adapter.coverage.map(({ id }) => id));
      expect(adapter.requires.every(({ id }) => coverage.has(id))).toBe(true);
      expect(adapter.requiresAny?.every(({ id }) => coverage.has(id)) ?? true).toBe(true);
      if (adapter.role === 'primary-purpose') {
        expect(adapter.requires.length + (adapter.requiresAny?.length ?? 0)).toBeGreaterThan(0);
      }
    }

    const informationRows = SDK_HAP_COVERAGE_MATRIX.rows.filter(({ capability }) => capability === 'info');
    const representedInformation = informationRows.filter(({ adapter }) => adapter === 'accessory.information');
    expect(representedInformation).toHaveLength(6);
    expect(
      representedInformation.every(({ verification }) =>
        verification.some(({ file }) => file === 'test/contracts/homekit-reconciler.test.ts'),
      ),
    ).toBe(true);

    const representedBattery = SDK_HAP_COVERAGE_MATRIX.rows.filter(({ adapter }) => adapter === 'battery.status');
    expect(representedBattery.map(({ id }) => id).sort()).toEqual(
      ['battery.level.read', 'battery.charging.read', 'battery.batteryAlert.event'].sort(),
    );

    const representedSiren = SDK_HAP_COVERAGE_MATRIX.rows.filter(({ adapter }) => adapter === 'siren.test');
    expect(representedSiren.map(({ id }) => id).sort()).toEqual(
      ['siren.active.read', 'siren.test.momentary-action', 'siren.stop.momentary-action'].sort(),
    );
    expect(representedSiren.find(({ id }) => id === 'siren.active.read')?.controlStatus).toBe('not-controllable');
    expect(
      representedSiren
        .filter(({ memberKind }) => memberKind === 'momentary-action')
        .every(({ controlStatus }) => controlStatus === 'controllable'),
    ).toBe(true);

    const representedSmartLight = SDK_HAP_COVERAGE_MATRIX.rows.filter(
      ({ adapter }) => adapter === 'smart-light.lightbulb',
    );
    expect(representedSmartLight.map(({ id }) => id).sort()).toEqual(
      [
        'smart_light.power.read',
        'smart_light.power.persistent-operation',
        'smart_light.brightness.read',
        'smart_light.brightness.persistent-operation',
        'smart_light.smartLightState.event',
        'smart_light.setColor.momentary-action',
      ].sort(),
    );

    const representedCameraControls = SDK_HAP_COVERAGE_MATRIX.rows.filter(
      ({ adapter }) => adapter === 'camera.controls',
    );
    expect(representedCameraControls.map(({ id }) => id).sort()).toEqual(
      [
        'camera.enabled.read',
        'light.isOn.read',
        'light.isOn.persistent-operation',
        'light.brightness.read',
        'light.brightness.persistent-operation',
        'audio.microphone.read',
        'audio.microphone.persistent-operation',
        'audio.speaker.read',
        'audio.speaker.persistent-operation',
        'audio.volume.read',
        'audio.volume.persistent-operation',
      ].sort(),
    );

    const representedStreaming = SDK_HAP_COVERAGE_MATRIX.rows.filter(({ adapter }) => adapter === 'camera.streaming');
    expect(representedStreaming.map(({ id }) => id).sort()).toEqual(
      [
        'camera.live.momentary-action',
        'camera.snapshotStored.momentary-action',
        'camera.snapshotLive.momentary-action',
        'camera.talkback.momentary-action',
        'camera.recordFragments.momentary-action',
        'camera.statusLed.read',
        'camera.statusLed.persistent-operation',
        'camera.nightVision.read',
        'camera.nightVision.persistent-operation',
        'camera.enabled.persistent-operation',
      ].sort(),
    );

    const representedLock = SDK_HAP_COVERAGE_MATRIX.rows.filter(({ adapter }) => adapter === 'lock.mechanism');
    expect(representedLock.map(({ id }) => id).sort()).toEqual(
      ['lock.lock.momentary-action', 'lock.unlock.momentary-action'].sort(),
    );
    expect(representedLock.every(({ controlStatus }) => controlStatus === 'controllable')).toBe(true);
    expect(representedLock.every(({ evidence }) => evidence.some((item) => item.includes('T8531')))).toBe(true);
    expect(
      SDK_HAP_COVERAGE_MATRIX.rows
        .filter(({ id }) => id === 'lock.locked.read' || id === 'lock.lockState.event')
        .every(
          ({ disposition, representationStatus }) =>
            disposition === 'blocked-sdk-gap' && representationStatus === 'not-represented',
        ),
    ).toBe(true);

    const diagnosticOnlySiren = SDK_HAP_COVERAGE_MATRIX.rows.filter(
      ({ capability, disposition }) => capability === 'siren' && disposition === 'diagnostic-only',
    );
    expect(diagnosticOnlySiren.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'siren.alarmVolume.persistent-operation',
        'siren.alarmTone.read',
        'siren.alarmTone.persistent-operation',
        'siren.trigger.momentary-action',
      ]),
    );
    expect(diagnosticOnlySiren.every(({ representationStatus }) => representationStatus === 'not-represented')).toBe(
      true,
    );
  });
});
