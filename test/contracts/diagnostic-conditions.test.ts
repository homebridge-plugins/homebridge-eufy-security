import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  createDiagnosticLogger,
  createSdkLogger,
  DiagnosticConditions,
  GuidedDiagnostics,
  reportHomeKitEvent,
  reportRuntimeNotice,
} from '../../src/diagnostics.js';

describe('diagnostic conditions', () => {
  it('emits transitions once and explicitly clears a recovered condition', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });

    conditions.reportRuntimeState('degraded');
    conditions.reportRuntimeState('degraded');
    conditions.reportRuntimeState('ready');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('[runtime-transport-degraded] The Eufy connection is degraded.');
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      scope: 'diagnostic-condition',
      level: 'warn',
      code: 'runtime-transport-degraded',
      active: true,
      reason: 'degraded',
      summaryKey: 'log.runtime.transportDegraded',
      actionKey: 'log.action.checkNetwork',
    });
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual(
      expect.objectContaining({
        scope: 'diagnostic-condition',
        code: 'runtime-transport-degraded',
        active: false,
        reason: 'recovered',
      }),
    );
  });

  it('uses stable support-case accessory aliases and never emits supplied identity', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const firstSerial = 'T8000P0000000000';
    const secondSerial = 'T8000P1111111111';
    const diagnostic = {
      code: 'invalid-contact-observation',
      capability: 'contact',
      member: 'open',
      active: true,
      reason: 'malformed',
    } as const;

    conditions.reportHomeKit(diagnostic, [firstSerial, secondSerial]);
    conditions.reportHomeKit(diagnostic, [secondSerial, firstSerial]);
    conditions.reportHomeKit({ ...diagnostic, active: false, reason: 'recovered' }, []);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('2 accessories are affected.');
    const active = JSON.parse(debug.mock.calls[0]![0]);
    expect(active).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'invalid-contact-observation',
      active: true,
      affectedAccessoryCount: 2,
    });
    expect(active.accessoryAliases).toHaveLength(2);
    expect(active.accessoryAliases[0]).toMatch(/^accessory-[0-9a-f-]{36}$/);
    expect(active.accessoryAliases[1]).toMatch(/^accessory-[0-9a-f-]{36}$/);
    expect(active.accessoryAliases[0]).not.toBe(active.accessoryAliases[1]);
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(firstSerial);
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(secondSerial);
    expect(JSON.parse(debug.mock.calls[1]![0])).toMatchObject({
      code: 'invalid-contact-observation',
      active: false,
      reason: 'recovered',
      affectedAccessoryCount: 0,
    });
  });

  it('tracks members with the same code as independent conditions', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const base = {
      code: 'invalid-smart-light-observation',
      capability: 'smart_light',
      active: true,
      reason: 'malformed',
    } as const;

    conditions.reportHomeKit({ ...base, member: 'power' }, ['synthetic-light']);
    conditions.reportHomeKit({ ...base, member: 'brightness' }, ['synthetic-light']);
    conditions.reportHomeKit({ ...base, member: 'power', active: false, reason: 'recovered' }, []);

    expect(debug.mock.calls.slice(0, 2).map(([message]) => JSON.parse(message).member)).toEqual([
      'power',
      'brightness',
    ]);
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.parse(debug.mock.calls[2]![0])).toMatchObject({ member: 'power', active: false });
  });

  it('allowlists security-system faults without retaining device identity', () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info: vi.fn(), warn });
    const identity = 'synthetic-security-system';

    conditions.reportHomeKit(
      {
        code: 'unsupported-arming-mode',
        capability: 'arming',
        member: 'mode',
        active: true,
        reason: 'unsupported',
      },
      [identity],
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(debug.mock.calls[0]![0])).toMatchObject({
      code: 'unsupported-arming-mode',
      capability: 'arming',
      member: 'mode',
      active: true,
      reason: 'unsupported',
    });
    expect(JSON.stringify([warn.mock.calls, debug.mock.calls])).not.toContain(identity);
  });

  it('bounds aliases while retaining the complete affected-accessory count', () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info: vi.fn(), warn });
    const identities = Array.from({ length: 40 }, (_, index) => `synthetic-device-${index}`);

    conditions.reportHomeKit(
      {
        code: 'battery-temperature-alert',
        capability: 'battery',
        member: 'batteryAlert',
        active: true,
        reason: 'hot',
      },
      identities,
    );

    const output = JSON.parse(debug.mock.calls[0]![0]);
    expect(output).toMatchObject({ affectedAccessoryCount: 40, aliasesTruncated: true });
    expect(output.accessoryAliases).toHaveLength(32);
    expect(JSON.stringify(output)).not.toContain('synthetic-device-');
  });

  it('drops non-allowlisted fields and rejects unknown generated output', () => {
    const normal: string[] = [];
    const structured: string[] = [];
    const conditions = new DiagnosticConditions({
      debug: (message) => structured.push(message),
      error: (message) => normal.push(message),
      info: (message) => normal.push(message),
      warn: (message) => normal.push(message),
    });
    const prohibited = [
      'account@example.invalid',
      'credential-value',
      'token-value',
      'cookie-value',
      'private-key-value',
      '192.0.2.1',
      'protocol-frame-value',
      'raw-capture-value',
    ];

    conditions.reportHomeKit(
      {
        code: 'battery-temperature-alert',
        capability: 'battery',
        member: 'batteryAlert',
        active: true,
        reason: 'hot',
        account: prohibited[0],
        credential: prohibited[1],
        token: prohibited[2],
        cookie: prohibited[3],
        key: prohibited[4],
        address: prohibited[5],
        sdk: { frame: prohibited[6] },
        capture: prohibited[7],
      } as never,
      ['T8000P2222222222'],
    );
    conditions.reportHomeKit(
      {
        code: 'unknown-condition',
        capability: 'unknown',
        member: 'unknown',
        active: true,
        reason: 'unknown',
      } as never,
      ['T8000P3333333333'],
    );
    const sdk = createSdkLogger({
      debug: (message) => structured.push(message),
    })!;
    sdk.error(
      `[p2p] ${prohibited.join(' ')}`,
      { account: prohibited[0], token: prohibited[2], capture: prohibited[7] },
      ...Array.from({ length: 20 }, () => prohibited[6]),
    );

    expect(normal).toHaveLength(1);
    expect(structured).toHaveLength(2);
    expect(JSON.parse(structured[1]!)).toMatchObject({ detailsTruncated: true, details: expect.any(Array) });
    expect(JSON.parse(structured[1]!).details).toHaveLength(16);
    for (const value of prohibited) {
      expect([...normal, ...structured].join('\n')).not.toContain(value);
    }
    expect(normal[0]).not.toContain('T8000P2222222222');
    expect(normal[0]).not.toContain('unknown-condition');
  });

  it('classifies current SDK session messages without retaining session identity', () => {
    const debug = vi.fn();
    const sdk = createSdkLogger({ debug })!;

    sdk.debug('[session synthetic-parent] connecting now (wired, on demand)');
    sdk.debug('[session synthetic-parent] connected');
    sdk.debug('[session synthetic-parent] in use again — idle-detach cancelled');
    sdk.debug('[session synthetic-parent] idle window elapsed — disconnecting now (device can sleep)');
    sdk.warn('[live synthetic-parent] live stream failed to start');
    sdk.warn('[p2p] send err synthetic-address');
    sdk.warn('[device] property synthetic-property wire value is not numeric');

    const records = debug.mock.calls.map(([message]) => JSON.parse(message));
    expect(records.map(({ subsystem, event }) => ({ subsystem, event }))).toEqual([
      { subsystem: 'p2p', event: 'session-connecting' },
      { subsystem: 'p2p', event: 'connection-opened' },
      { subsystem: 'p2p', event: 'session-resumed' },
      { subsystem: 'p2p', event: 'connection-closed' },
      { subsystem: 'p2p', event: 'media-error' },
      { subsystem: 'p2p', event: 'transport-error' },
      { subsystem: 'device', event: 'observation-invalid' },
    ]);
    expect(JSON.stringify(records)).not.toContain('synthetic-parent');
    expect(JSON.stringify(records)).not.toContain('synthetic-address');
    expect(JSON.stringify(records)).not.toContain('synthetic-property');
  });

  it('emits only allowlisted bounded HomeKit event traces in debug output', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, {
      adapter: 'contact.sensor',
      event: 'contact-state',
      observation: 'malformed',
      scope: 'account@example.invalid',
      serial: 'T8000P0000000000',
    } as never);
    reportHomeKitEvent(
      { debug },
      { adapter: 'T8000P0000000000', event: 'protocol-frame-value', observation: 'raw-capture-value' },
    );
    reportHomeKitEvent(
      { debug },
      { adapter: 'arming.security-system', event: 'security-system-alarm', observation: 'valid' },
    );

    expect(debug).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        scope: 'homekit',
        level: 'debug',
        adapter: 'contact.sensor',
        event: 'contact-state',
        observation: 'malformed',
      }),
    );
    expect(debug).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        scope: 'homekit',
        level: 'debug',
        adapter: 'arming.security-system',
        event: 'security-system-alarm',
        observation: 'valid',
      }),
    );
  });

  it('keeps plugin and SDK events together in JSONL while Homebridge receives human messages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-diagnostics-'));
    const debug = vi.fn();
    const warn = vi.fn();
    await new GuidedDiagnostics(root).authorize('startup-authentication', 'now');
    const logger = createDiagnosticLogger({ debug, error: vi.fn(), info: vi.fn(), warn }, root);

    try {
      reportRuntimeNotice(logger, 'status-publication-failed');
      createSdkLogger(logger)!.info('[mqtt] connected');
      await logger.flush?.();

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[status-publication-failed] Runtime status could not be published; dashboard status may be stale.',
      );
      expect(debug).not.toHaveBeenCalled();
      const logDirectory = join(root, 'logs');
      const logPath = join(logDirectory, 'homebridge-eufy.jsonl');
      const records = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map(({ scope }) => scope)).toEqual(['runtime-notice', 'sdk']);
      expect(records.map(({ level }) => level)).toEqual(['warn', 'info']);
      expect(records[1]).toMatchObject({ subsystem: 'mqtt', event: 'connection-opened' });
      expect(records.every(({ timestamp }) => Number.isFinite(Date.parse(timestamp)))).toBe(true);
      expect(statSync(logDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1_000);
      utimesSync(logPath, yesterday, yesterday);
      createSdkLogger(logger)!.warn('[push] reconnecting');
      await logger.flush?.();

      const archived = gunzipSync(readFileSync(`${logPath}.1.gz`)).toString('utf8');
      expect(archived).toContain('"scope":"runtime-notice"');
      expect(statSync(`${logPath}.1.gz`).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(logPath, 'utf8').trim())).toMatchObject({ scope: 'sdk', level: 'warn' });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('renders Homebridge messages through an injected runtime catalog', () => {
    const warn = vi.fn();
    const logger = createDiagnosticLogger({ error: vi.fn(), info: vi.fn(), warn }, undefined, {
      'log.notice.statusPublicationFailed': 'Translated runtime notice.',
    });

    reportRuntimeNotice(logger, 'status-publication-failed');

    expect(warn).toHaveBeenCalledExactlyOnceWith('[status-publication-failed] Translated runtime notice.');
  });

  it('reconstructs file records from allowlisted fields and excludes FFmpeg', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-diagnostics-'));
    await new GuidedDiagnostics(root).authorize('startup-authentication', 'now');
    const logger = createDiagnosticLogger({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);

    try {
      logger.debug?.(
        JSON.stringify({
          scope: 'sdk',
          level: 'warn',
          subsystem: 'p2p',
          event: 'connection-retrying',
          token: 'must-not-appear',
          serial: 'T8000P0000000000',
        }),
      );
      logger.debug?.(JSON.stringify({ scope: 'unknown', level: 'error', token: 'must-not-appear' }));
      logger.debug?.(
        JSON.stringify({
          scope: 'diagnostic-condition',
          level: 'warn',
          code: 'runtime-transport-degraded',
          active: true,
          reason: 'degraded',
          capability: 'contact',
        }),
      );
      logger.debug?.(
        JSON.stringify({
          scope: 'diagnostic-condition',
          level: 'warn',
          code: 'invalid-contact-observation',
          active: true,
          reason: 'owner-conflict',
        }),
      );
      createSdkLogger(logger)!.debug('[ffmpeg] raw stderr must-not-appear');
      await logger.flush?.();

      const output = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8');
      const records = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        scope: 'sdk',
        level: 'warn',
        subsystem: 'p2p',
        event: 'connection-retrying',
      });
      expect(output).not.toContain('must-not-appear');
      expect(output).not.toContain('T8000P0000000000');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
