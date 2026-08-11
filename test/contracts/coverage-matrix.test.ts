import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAPABILITY_MODULES } from '@mega-yfue/eufy-sdk';
import { describe, expect, it } from 'vitest';

import { ADAPTER_REGISTRY } from '../../src/homekit/adapters/registry.js';
import { SDK_HAP_COVERAGE_MATRIX } from '../../src/homekit/coverage-matrix.js';

const INFO_FIELDS = [
  'manufacturer',
  'model',
  'serialNumber',
  'name',
  'deviceType',
  'firmwareVersion',
  'hardwareVersion',
  'firmwareSubVersion',
  'macAddress',
  'updateAvailable',
] as const;

function currentSdkSurface(): string[] {
  const rows: string[] = [];
  for (const [capability, module] of Object.entries(CAPABILITY_MODULES)) {
    for (const [name, member] of Object.entries(module.members ?? {})) {
      if ('type' in member) {
        if (!member.writeOnly) {
          rows.push(`${capability}.${name}.read`);
        }
        if (member.write || member.unverified || member.writtenElsewhere) {
          rows.push(`${capability}.${name}.persistent-operation`);
        }
      } else if ('action' in member) {
        rows.push(`${capability}.${name}.momentary-action`);
      } else if ('method' in member || 'provided' in member) {
        rows.push(`${capability}.${name}.${member.answers ? 'read' : 'momentary-action'}`);
      }
    }

    const events = new Set([...(module.events ?? []).map((event) => event.emit), ...(module.emits ?? [])]);
    for (const event of events) {
      rows.push(`${capability}.${event}.event`);
    }
  }

  rows.push(...INFO_FIELDS.map((field) => `info.${field}.read`));
  return rows.sort();
}

describe('SDK/HAP coverage matrix', () => {
  it('classifies the complete current SDK member surface', () => {
    expect(SDK_HAP_COVERAGE_MATRIX.version).toBe(1);
    expect(SDK_HAP_COVERAGE_MATRIX.rows.map((row) => row.id).sort()).toEqual(currentSdkSurface());
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
        .flatMap((adapter) => adapter.rows)
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
});
