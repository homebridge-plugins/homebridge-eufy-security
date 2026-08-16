import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticLogger, GuidedDiagnostics, reportRuntimeNotice } from '../../src/diagnostics.js';

const HOUR_MS = 60 * 60 * 1_000;

describe('guided diagnostics session', () => {
  it('authorizes only an allowlisted profile with a random support case identifier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const first = await diagnostics.authorize('device-representation');
      now += 1;
      const second = await diagnostics.authorize('device-representation');

      expect(first).toMatchObject({
        status: 'authorized',
        profile: 'device-representation',
        expiresAt: '2026-08-19T08:00:00.000Z',
      });
      expect(first.supportCaseId).toMatch(/^support-[0-9a-f-]{36}$/);
      expect(second.supportCaseId).not.toBe(first.supportCaseId);
      await expect(diagnostics.authorize('everything' as never)).rejects.toThrow('Unknown diagnostics profile');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves the original 72-hour expiry across restart and suppresses debug evidence after expiry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const authorized = await diagnostics.authorize('startup-authentication');
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-opened' }));
      await logger.flush?.();

      now += 71 * HOUR_MS;
      const restarted = new GuidedDiagnostics(root, () => now);
      expect((await restarted.status()).expiresAt).toBe(authorized.expiresAt);

      now += 2 * HOUR_MS;
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-closed' }));
      await logger.flush?.();

      const records = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map(({ event }) => event)).toEqual(['connection-opened']);
      expect(await restarted.status()).toMatchObject({ status: 'expired', expiresAt: authorized.expiresAt });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('admits verbose evidence only when the selected profile includes its scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root);

    try {
      await diagnostics.authorize('dashboard-ui');
      const logger = createDiagnosticLogger({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-opened' }));
      reportRuntimeNotice(logger, 'status-publication-failed');
      await logger.flush?.();

      const records = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map(({ scope }) => scope)).toEqual(['runtime-notice']);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('marks a bounded reproduction and reports exact missing evidence with issue context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const authorized = await diagnostics.authorize('control-state');
      await diagnostics.startReproduction();
      rmSync(join(root, 'diagnostics', 'reproduction-markers.jsonl'));
      await diagnostics.startReproduction();
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      logger.debug?.(
        JSON.stringify({
          scope: 'homekit',
          level: 'debug',
          adapter: 'contact.sensor',
          event: 'contact-state',
          observation: 'valid',
        }),
      );
      await logger.flush?.();
      now += 5_000;
      const prepared = await diagnostics.endReproduction();

      expect(prepared).toMatchObject({
        status: 'complete',
        supportCaseId: authorized.supportCaseId,
        profile: 'control-state',
        missingEvidence: ['sdk-log'],
        partialExportAvailable: true,
      });
      expect(prepared.issueUrl).toContain(encodeURIComponent(authorized.supportCaseId));
      const markers = readFileSync(join(root, 'diagnostics', 'reproduction-markers.jsonl'), 'utf8');
      expect(markers).toContain('"event":"reproduction-started"');
      expect(markers).toContain('"event":"reproduction-ended"');
      expect(markers).not.toMatch(/serial|device|camera/i);

      now += 73 * HOUR_MS;
      expect(await diagnostics.status()).toMatchObject({
        status: 'expired',
        partialExportAvailable: true,
        issueUrl: prepared.issueUrl,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
