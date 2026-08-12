import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ADAPTER_REGISTRY } from '../../src/homekit/adapters/registry.js';
import { SDK_HAP_COVERAGE_MATRIX } from '../../src/homekit/coverage-matrix.js';

describe('SDK/HAP coverage matrix', () => {
  it('classifies the complete current SDK member surface', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(SDK_HAP_COVERAGE_MATRIX.version).toBe(1);
    expect(SDK_HAP_COVERAGE_MATRIX.sdkContract).toBe(
      `@mega-yfue/eufy-sdk@${packageJson.dependencies['@mega-yfue/eufy-sdk']}`,
    );
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
      expect(row.controlStatus).toMatch(/^(not-controllable|not-represented)$/);
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
      if (row.disposition === 'explicitly-deferred') {
        expect(row.followUp, row.id).toMatch(/^#[0-9]+: /);
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
    for (const adapter of Object.values(ADAPTER_REGISTRY)) {
      const coverage = new Set(adapter.coverage.map(({ id }) => id));
      expect(adapter.requires.every(({ id }) => coverage.has(id))).toBe(true);
      if (adapter.role === 'primary-purpose') {
        expect(adapter.requires.length).toBeGreaterThan(0);
      }
    }

    const informationRows = SDK_HAP_COVERAGE_MATRIX.rows.filter(({ capability }) => capability === 'info');
    const representedInformation = informationRows.filter(({ adapter }) => adapter === 'accessory.information');
    expect(representedInformation).toHaveLength(6);
    expect(representedInformation.every(({ followUp }) => followUp === undefined)).toBe(true);
    expect(
      representedInformation.every(({ verification }) =>
        verification.some(({ file }) => file === 'test/contracts/homekit-reconciler.test.ts'),
      ),
    ).toBe(true);
  });
});
