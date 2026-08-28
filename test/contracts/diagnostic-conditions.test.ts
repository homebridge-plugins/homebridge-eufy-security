import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import type { SnapshotFailure } from '../../src/media/contracts.js';
import {
  createDiagnosticLogger,
  createSdkLogger,
  DiagnosticConditions,
  GuidedDiagnostics,
  reportAdaptationNotice,
  reportHomeKitEvent,
  unconfirmedWriteCondition,
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

  it('names an unconfirmed write only for a member this plugin actually writes', () => {
    expect(unconfirmedWriteCondition('enabled')).toEqual({
      code: 'camera-control-operation-failed',
      capability: 'camera',
      member: 'enabled',
      active: true,
      reason: 'not-confirmed',
    });
    expect(unconfirmedWriteCondition('statusLed')?.member).toBe('statusLed');
    expect(unconfirmedWriteCondition('nightVision')?.member).toBe('nightVision');
    expect(
      unconfirmedWriteCondition('watermark'),
      'a property this plugin never writes belongs to another consumer of the same account',
    ).toBeUndefined();
    expect(unconfirmedWriteCondition('constructor')).toBeUndefined();
  });

  it('reports an unconfirmed write against the accessory it names, under its own reason', () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info: vi.fn(), warn });

    conditions.reportHomeKit(unconfirmedWriteCondition('enabled')!, ['T8170T10230000000']);

    expect(warn, 'a write the camera ignored has to reach the console, not only the record').toHaveBeenCalledOnce();
    const record = JSON.parse(debug.mock.calls[0]![0]);
    expect(record).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-control-operation-failed',
      capability: 'camera',
      member: 'enabled',
      active: true,
      reason: 'not-confirmed',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify(record), 'the serial is never emitted').not.toContain('T8170T10230000000');
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

  it('retains only bounded identity-free live startup details from SDK debug records', () => {
    const debug = vi.fn();
    const sdk = createSdkLogger({ debug })!;

    sdk.debug('[live] start trace', {
      phase: 'media-command',
      topology: 'own',
      action: 'start',
      level2: true,
      signCode: 8,
      keyframe: false,
      serial: 'T8000P0000000000',
    });

    expect(JSON.parse(debug.mock.calls[0]![0])).toEqual({
      scope: 'sdk',
      subsystem: 'p2p',
      event: 'live-start-trace',
      phase: 'media-command',
      topology: 'own',
      action: 'start',
      level2: true,
      level: 'debug',
    });

    sdk.debug('[live] start trace', { phase: 'media-command-ack', action: 'start', serial: 'T8000P0000000000' });
    expect(JSON.parse(debug.mock.calls[1]![0])).toEqual({
      scope: 'sdk',
      subsystem: 'p2p',
      event: 'live-start-trace',
      phase: 'media-command-ack',
      action: 'start',
      level: 'debug',
    });

    sdk.debug('[live] start trace', { phase: 'datagram-gap', dataType: 1, payload: 'must-not-survive' });
    expect(JSON.parse(debug.mock.calls[2]![0])).toEqual({
      scope: 'sdk',
      subsystem: 'p2p',
      event: 'live-start-trace',
      phase: 'datagram-gap',
      dataType: 1,
      level: 'debug',
    });

    sdk.debug('[live] start trace', { phase: 'media-command-retry', action: 'start' });
    sdk.debug('[live] start trace', { phase: 'media-command-unacknowledged', action: 'start' });
    expect(debug.mock.calls.slice(3).map(([message]) => JSON.parse(message).phase)).toEqual([
      'media-command-retry',
      'media-command-unacknowledged',
    ]);
  });

  it('persists an SDK live startup trace only during authorized live diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-live-start-'));
    await new GuidedDiagnostics(root).authorize('live-media', 'now');
    const logger = createDiagnosticLogger({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);

    try {
      createSdkLogger(logger)!.debug('[live] start trace', {
        phase: 'first-video-command',
        signCode: 8,
        accepted: true,
        serial: 'T8000P0000000000',
      });
      await logger.flush?.();

      const record = JSON.parse(readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8').trim());
      expect(record).toMatchObject({
        scope: 'sdk',
        level: 'debug',
        subsystem: 'p2p',
        event: 'live-start-trace',
        phase: 'first-video-command',
        signCode: 8,
        accepted: true,
      });
      expect(JSON.stringify(record)).not.toContain('T8000P0000000000');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('allowlists every bounded live camera session reason without media or device material', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const reasons = [
      'source-acquisition-timeout',
      'no-video-within-backstop',
      'source-error',
      'rtcp-timeout',
      'adaptation-spawn-failed',
      'adaptation-exited-before-output',
      'adaptation-exited-while-streaming',
      'adaptation-failed',
    ];
    const serial = 'T8000P0000000000';

    for (const reason of reasons) {
      conditions.reportHomeKit(
        { code: 'camera-live-session-failed', capability: 'camera', member: 'live', active: true, reason },
        [serial],
      );
    }
    conditions.reportHomeKit(
      {
        code: 'camera-live-session-failed',
        capability: 'camera',
        member: 'live',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledTimes(reasons.length);
    expect(warn.mock.calls[0]![0]).toContain('[camera-live-session-failed] A live camera session ended without video');
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message).reason)).toEqual([...reasons, 'recovered']);
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))[0]).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-live-session-failed',
      capability: 'camera',
      member: 'live',
      active: true,
      summaryKey: 'log.homekit.cameraLiveSessionFailed',
      actionKey: 'log.action.retryLiveView',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists every bounded talkback reason without media or device material', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const reasons = ['source-unavailable', 'unsupported-selection', 'adaptation-failed', 'device-audio-failed'];
    const serial = 'T8000P0000000000';

    for (const reason of reasons) {
      conditions.reportHomeKit(
        { code: 'camera-talkback-failed', capability: 'camera', member: 'talkback', active: true, reason },
        [serial],
      );
    }
    conditions.reportHomeKit(
      {
        code: 'camera-talkback-failed',
        capability: 'camera',
        member: 'talkback',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledTimes(reasons.length);
    expect(warn.mock.calls[0]![0]).toContain('[camera-talkback-failed] Camera talkback stopped unexpectedly');
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message).reason)).toEqual([...reasons, 'recovered']);
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))[0]).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-talkback-failed',
      capability: 'camera',
      member: 'talkback',
      active: true,
      summaryKey: 'log.homekit.cameraTalkbackFailed',
      actionKey: 'log.action.retryTalkback',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists evidenced talkback whose bound SDK action is unavailable', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });

    conditions.reportHomeKit(
      {
        code: 'camera-talkback-capability-unavailable',
        capability: 'camera',
        member: 'talkback',
        active: true,
        reason: 'missing',
      },
      ['T8000P0000000000'],
    );
    conditions.reportHomeKit(
      {
        code: 'camera-talkback-capability-unavailable',
        capability: 'camera',
        member: 'talkback',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('[camera-talkback-capability-unavailable] Camera talkback is unavailable');
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message).reason)).toEqual(['missing', 'recovered']);
  });

  it('allowlists a refused live session for a disabled camera without device material', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const serial = 'T8000P0000000000';

    for (const reason of ['disabled', 'disabled-mid-session']) {
      conditions.reportHomeKit(
        { code: 'camera-live-session-refused', capability: 'camera', member: 'live', active: true, reason },
        [serial],
      );
    }
    conditions.reportHomeKit(
      {
        code: 'camera-live-session-refused',
        capability: 'camera',
        member: 'live',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain(
      '[camera-live-session-refused] Live view is unavailable because the camera is turned off',
    );
    expect(warn.mock.calls[0]![0]).toContain('Turn the camera on in the Eufy app');
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message).reason)).toEqual([
      'disabled',
      'disabled-mid-session',
      'recovered',
    ]);
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))[0]).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-live-session-refused',
      capability: 'camera',
      member: 'live',
      active: true,
      summaryKey: 'log.homekit.cameraLiveSessionRefused',
      actionKey: 'log.action.enableCamera',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists a live session a disabled camera answered without video, apart from a transport failure', () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info: vi.fn(), warn });
    const serial = 'T8000P0000000000';

    conditions.reportHomeKit(
      {
        code: 'camera-live-session-refused',
        capability: 'camera',
        member: 'live',
        active: true,
        reason: 'disabled-no-video',
      },
      [serial],
    );
    conditions.reportHomeKit(
      {
        code: 'camera-live-session-failed',
        capability: 'camera',
        member: 'live',
        active: true,
        reason: 'source-audio-only',
      },
      [serial],
    );

    expect(warn.mock.calls.map(([message]) => String(message).split('.')[0])).toEqual([
      '[camera-live-session-refused] Live view is unavailable because the camera is turned off',
      '[camera-live-session-failed] A live camera session ended without video',
    ]);
    expect(debug.mock.calls.map(([message]) => JSON.parse(message)).map(({ code, reason }) => [code, reason])).toEqual([
      ['camera-live-session-refused', 'disabled-no-video'],
      ['camera-live-session-failed', 'source-audio-only'],
    ]);
    expect(JSON.stringify([warn.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists a recording refused for a disabled camera without device material', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const serial = 'T8000P0000000000';

    conditions.reportHomeKit(
      {
        code: 'camera-recording-refused',
        capability: 'camera',
        member: 'recordFragments',
        active: true,
        reason: 'disabled',
      },
      [serial],
    );
    conditions.reportHomeKit(
      {
        code: 'camera-recording-refused',
        capability: 'camera',
        member: 'recordFragments',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(
      '[camera-recording-refused] Recording is unavailable because the camera is turned off',
    );
    expect(warn.mock.calls[0]![0]).toContain('Turn the camera on in the Eufy app');
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))[0]).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-recording-refused',
      capability: 'camera',
      member: 'recordFragments',
      active: true,
      reason: 'disabled',
      summaryKey: 'log.homekit.cameraRecordingRefused',
      actionKey: 'log.action.enableCamera',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists a substituted camera image without device material', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const serial = 'T8000P0000000000';

    conditions.reportHomeKit(
      {
        code: 'camera-snapshot-unavailable',
        capability: 'camera',
        member: 'snapshot',
        active: true,
        reason: 'no-acquisition',
      },
      [serial],
    );
    conditions.reportHomeKit(
      {
        code: 'camera-snapshot-unavailable',
        capability: 'camera',
        member: 'snapshot',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('[camera-snapshot-unavailable] A camera image is unavailable');
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))[0]).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-snapshot-unavailable',
      capability: 'camera',
      member: 'snapshot',
      active: true,
      reason: 'no-acquisition',
      summaryKey: 'log.homekit.cameraSnapshotUnavailable',
      actionKey: 'log.action.checkCameraSnapshot',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('attributes every bounded unanswered snapshot reason to one acquisition', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    /** Exhaustive by type, so a widened media vocabulary cannot reach the log unallowlisted and untested. */
    const attributions = {
      'no-acquisition': true,
      'no-retained-image': true,
      'stored-unavailable': true,
      'stored-failed': true,
      'stored-not-observed': true,
      'stored-pending': true,
      'stored-download-failed': true,
      'stored-invalid-image': true,
      'live-unavailable': true,
      'live-failed': true,
      'live-no-keyframe': true,
      'live-source-failed': true,
      'live-undecodable-burst': true,
      'live-decoder-unavailable': true,
    } satisfies Record<SnapshotFailure, true>;
    const reasons = [...Object.keys(attributions), 'adapter-missing'];
    const serial = 'T8000P0000000000';

    for (const reason of reasons) {
      conditions.reportHomeKit(
        { code: 'camera-snapshot-unavailable', capability: 'camera', member: 'snapshot', active: true, reason },
        [serial],
      );
    }
    conditions.reportHomeKit(
      {
        code: 'camera-snapshot-unavailable',
        capability: 'camera',
        member: 'snapshot',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledTimes(reasons.length);
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message).reason)).toEqual([...reasons, 'recovered']);
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists a withdrawn camera snapshot acquisition per acquisition member', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const serial = 'T8000P0000000000';

    for (const [member, reason] of [
      ['snapshotStored', 'missing-evidence'],
      ['snapshotLive', 'adapter-missing'],
    ] as const) {
      conditions.reportHomeKit(
        { code: 'camera-snapshot-capability-unavailable', capability: 'camera', member, active: true, reason },
        [serial],
      );
    }
    conditions.reportHomeKit(
      {
        code: 'camera-snapshot-capability-unavailable',
        capability: 'camera',
        member: 'snapshotStored',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain(
      '[camera-snapshot-capability-unavailable] Camera snapshot acquisition is unavailable',
    );
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        scope: 'diagnostic-condition',
        level: 'warn',
        code: 'camera-snapshot-capability-unavailable',
        capability: 'camera',
        member: 'snapshotStored',
        active: true,
        reason: 'missing-evidence',
        summaryKey: 'log.homekit.cameraSnapshotCapabilityUnavailable',
        actionKey: 'log.action.waitCameraSnapshot',
        affectedAccessoryCount: 1,
      }),
      expect.objectContaining({ member: 'snapshotLive', active: true, reason: 'adapter-missing' }),
      expect.objectContaining({ member: 'snapshotStored', active: false, reason: 'recovered' }),
    ]);
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
  });

  it('allowlists withdrawn camera live media without device material', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const conditions = new DiagnosticConditions({ debug, error: vi.fn(), info, warn });
    const serial = 'T8000P0000000000';

    conditions.reportHomeKit(
      {
        code: 'camera-streaming-capability-unavailable',
        capability: 'camera',
        member: 'live',
        active: true,
        reason: 'sdk-fault',
      },
      [serial],
    );
    conditions.reportHomeKit(
      {
        code: 'camera-streaming-capability-unavailable',
        capability: 'camera',
        member: 'live',
        active: false,
        reason: 'recovered',
      },
      [],
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(
      '[camera-streaming-capability-unavailable] Camera live media is unavailable',
    );
    expect(info).toHaveBeenCalledOnce();
    expect(debug.mock.calls.map(([message]) => JSON.parse(message))[0]).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'camera-streaming-capability-unavailable',
      capability: 'camera',
      member: 'live',
      active: true,
      reason: 'sdk-fault',
      summaryKey: 'log.homekit.cameraStreamingCapabilityUnavailable',
      actionKey: 'log.action.waitCameraLive',
      affectedAccessoryCount: 1,
    });
    expect(JSON.stringify([warn.mock.calls, info.mock.calls, debug.mock.calls])).not.toContain(serial);
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
    reportHomeKitEvent(
      { debug },
      { adapter: 'camera.streaming', event: 'camera-enabled-changed', observation: 'valid' },
    );
    reportHomeKitEvent(
      { debug },
      { adapter: 'camera.streaming', event: 'camera-enabled-invented', observation: 'valid' },
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
    expect(debug).toHaveBeenNthCalledWith(
      3,
      JSON.stringify({
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'camera-enabled-changed',
        observation: 'valid',
      }),
    );
    expect(debug).toHaveBeenCalledTimes(3);
  });

  it('emits only allowlisted live video selections in debug output', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, {
      adapter: 'camera.streaming',
      event: 'live-video-selected',
      operation: 'start',
      profile: 'high',
      level: '4.0',
      width: 1280,
      height: 720,
      fps: 30,
      serial: 'T8000P0000000000',
    } as never);
    reportHomeKitEvent(
      { debug },
      {
        adapter: 'camera.streaming',
        event: 'live-video-selected',
        operation: 'reconfigure',
        profile: 'main',
        level: '3.1',
        width: 1920,
        height: 1080,
        fps: 30,
      },
    );
    reportHomeKitEvent(
      { debug },
      {
        adapter: 'camera.streaming',
        event: 'live-video-selected',
        operation: 'start',
        profile: 'extended' as never,
        level: '5.2' as never,
        width: 8192,
        height: 8192,
        fps: 240,
      },
    );
    reportHomeKitEvent({ debug }, {
      adapter: 'camera.streaming',
      event: 'live-video-selected',
      operation: 'start',
      profile: 'high',
      level: '4.0',
      width: '1280',
      height: 720,
      fps: '30',
    } as never);

    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'live-video-selected',
        operation: 'start',
        profile: 'high',
        levelName: '4.0',
        width: 1280,
        height: 720,
        fps: 30,
      }),
    );
    expect(debug).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'live-video-selected',
        operation: 'reconfigure',
        profile: 'main',
        levelName: '3.1',
        width: 1920,
        height: 1080,
        fps: 30,
      }),
    );
  });

  it('reconstructs only allowlisted live-session lifecycle traces', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, {
      adapter: 'camera.streaming',
      event: 'live-session-released',
      serial: 'T8000P0000000000',
    } as never);
    reportHomeKitEvent(
      { debug },
      {
        adapter: 'camera.streaming',
        event: 'live-session-failed',
        outcome: 'failed',
        reason: 'source-error',
        stage: 'raw-transport' as never,
      },
    );

    expect(debug).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'live-session-released',
      }),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('T8000P0000000000');
  });

  it('persists an allowlisted live video selection through the production diagnostic logger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-live-selection-'));
    await new GuidedDiagnostics(root).authorize('live-media', 'now');
    const logger = createDiagnosticLogger({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);

    reportHomeKitEvent(logger, {
      adapter: 'camera.streaming',
      event: 'live-video-selected',
      operation: 'start',
      profile: 'high',
      level: '4.0',
      width: 1280,
      height: 720,
      fps: 30,
    });
    reportHomeKitEvent(logger, {
      adapter: 'camera.streaming',
      event: 'live-session-released',
    });
    reportHomeKitEvent(logger, {
      adapter: 'camera.streaming',
      event: 'live-session-failed',
      outcome: 'failed',
      reason: 'source-error',
      stage: 'first-source-keyframe',
    });
    await logger.flush?.();

    const records = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'homekit',
          level: 'debug',
          adapter: 'camera.streaming',
          event: 'live-video-selected',
          operation: 'start',
          profile: 'high',
          levelName: '4.0',
          width: 1280,
          height: 720,
          fps: 30,
        }),
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'homekit',
          level: 'debug',
          adapter: 'camera.streaming',
          event: 'live-session-failed',
          outcome: 'failed',
          reason: 'source-error',
          stage: 'first-source-keyframe',
        }),
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'homekit',
          level: 'debug',
          adapter: 'camera.streaming',
          event: 'live-session-released',
        }),
      ]),
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

  it('records which announcement moved the camera power, and refuses one it does not know', () => {
    const debug = vi.fn();

    reportHomeKitEvent(
      { debug },
      {
        adapter: 'camera.streaming',
        event: 'camera-enabled-changed',
        observation: 'valid',
        announcedBy: 'poll',
      },
    );
    reportHomeKitEvent(
      { debug },
      {
        adapter: 'camera.streaming',
        event: 'camera-enabled-changed',
        observation: 'valid',
        announcedBy: 'write',
      },
    );
    reportHomeKitEvent(
      { debug },
      {
        adapter: 'camera.streaming',
        event: 'camera-enabled-changed',
        observation: 'valid',
        announcedBy: 'telepathy',
      },
    );
    reportHomeKitEvent(
      { debug },
      {
        adapter: 'contact.sensor',
        event: 'contact-state',
        observation: 'valid',
      },
    );

    const records = debug.mock.calls.map(([message]) => JSON.parse(message as string));
    expect(
      records.map((record) => record.announcedBy),
      'a support case has to tell "we did this" from "the user did this in the vendor app"',
    ).toEqual(['poll', 'write', undefined, undefined]);
    expect(records[2], 'an unknown announcement is dropped, never passed through as fact').not.toHaveProperty(
      'announcedBy',
    );
  });

  /**
   * The stderr tail is the only place an adaptation states its own cause, and it is also the only place this
   * plugin's own argument list can be echoed back — the output URL carries the base64 SRTP key and salt, and
   * the controller address is beside it. Both are therefore replaced by name before the line is kept, and the
   * record's own vocabulary is checked rather than trusted, because it is written from process exit status and
   * operating-system strings.
   */
  it('records a bounded FFmpeg failure without its arguments, keys, or addresses', () => {
    const debug = vi.fn();
    const srtpParameters = 'zBQPjxIWMOHTsPu1FTuxIVBWjLXPMR14pJEyRJEP';

    reportAdaptationNotice(
      { debug },
      {
        role: 'live-video',
        event: 'exited-before-output',
        code: 234,
        signal: 'SIGSEGV',
        stderr: [
          "Unknown encoder 'libfdk_aac'",
          `[out#0/rtp @ 0x55f1b2] Could not write header for output file srtp://192.0.2.10:50100?srtp_out_params=${srtpParameters}`,
          'Error opening input file /home/synthetic/.homebridge/node_modules/ffmpeg-for-homebridge/ffmpeg',
          'Connection to udp://[2001:db8::1]:41000 failed',
          `srtp_out_params ${srtpParameters}`,
          'progress=continue',
          '   ',
        ],
      },
    );

    const record = JSON.parse(debug.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({
      scope: 'ffmpeg',
      level: 'warn',
      role: 'live-video',
      event: 'exited-before-output',
      code: 234,
      signal: 'SIGSEGV',
    });
    expect(record.stderr, 'the one line naming the cause survives, and only the material beside it goes').toEqual([
      "Unknown encoder 'libfdk_aac'",
      '[out#0/rtp @ 0x55f1b2] Could not write header for output file <url>',
      'Error opening input file <path>',
      'Connection to <url> failed',
      'srtp_out_params <redacted>',
    ]);
    expect(JSON.stringify(record)).not.toContain(srtpParameters);
    expect(JSON.stringify(record)).not.toContain('192.0.2.10');
    expect(JSON.stringify(record)).not.toContain('2001:db8');
  });

  /**
   * Base64 includes `/`, so replacing filesystem paths before key material splits a key into sub-runs that
   * no length threshold catches and keeps the remainder verbatim. Measured over random 30-byte keys, roughly
   * one line in twenty then retained an eight-character fragment. A serial is shorter than any key threshold
   * and an SDK snapshot filename is a single path segment, so neither is caught by length or by separator.
   */
  it('leaves no fragment of a key or a serial in a line, whatever its shape', () => {
    const retained = (line: string): readonly string[] => {
      const debug = vi.fn();
      reportAdaptationNotice({ debug }, { role: 'sdk', event: 'output', stderr: [line] });
      const record =
        debug.mock.calls[0] === undefined
          ? {}
          : (JSON.parse(debug.mock.calls[0][0] as string) as { stderr?: string[] });
      return record.stderr ?? [];
    };

    expect(retained('Cannot open T8210N2012345678.jpg')).toEqual(['Cannot open <serial>.jpg']);
    expect(retained('Could not open C:\\Users\\eufy\\T8000P0000000000\\snap.jpg')).toEqual(['Could not open <path>']);
    expect(retained('Station T8010P1234567890 refused the request')).toEqual(['Station <serial> refused the request']);

    const leaked = Array.from({ length: 200 }, () => randomBytes(30).toString('base64')).filter((key) =>
      retained(`srtp_out_params ${key}`).some((kept) =>
        kept.split(/<[a-z]+>|\s/).some((fragment) => fragment.length >= 4 && key.includes(fragment)),
      ),
    );

    expect(leaked, 'not one fragment of any key survives, however the base64 happened to fall').toEqual([]);
  });

  it('drops an FFmpeg record whose role, event, exit status, or signal it cannot name', () => {
    const debug = vi.fn();

    reportAdaptationNotice({ debug }, { role: 'invented-role', event: 'exited-before-output' });
    reportAdaptationNotice({ debug }, { role: 'live-video', event: 'invented-event' });
    reportAdaptationNotice({ debug }, { role: 'sdk', event: 'output', code: -7, signal: 'SIGINVENTED' });
    reportAdaptationNotice({ debug }, { role: 'recording', event: 'spawn-failed' });

    expect(debug).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(debug.mock.calls[0]![0] as string),
      'an exit status and a signal outside the bounded sets are dropped, never passed through',
    ).toEqual({ scope: 'ffmpeg', level: 'warn', role: 'sdk', event: 'output' });
    expect(JSON.parse(debug.mock.calls[1]![0] as string)).toEqual({
      scope: 'ffmpeg',
      level: 'warn',
      role: 'recording',
      event: 'spawn-failed',
    });
  });

  /**
   * The SDK runs FFmpeg of its own for snapshot decoding, and its stderr was dropped on the way in. That is
   * the same class of evidence as the plugin's own adaptation output, and it is kept only while a profile
   * declaring FFmpeg output is authorized — a profile that does not declare it still keeps nothing.
   */
  it('keeps the SDK\u2019s own FFmpeg output as ffmpeg-log evidence only where a profile declares it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-diagnostics-'));
    await new GuidedDiagnostics(root).authorize('live-media', 'now');
    const logger = createDiagnosticLogger({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);

    try {
      createSdkLogger(logger)!.debug("[ffmpeg] Unknown decoder 'h264_synthetic'");
      createSdkLogger(logger)!.debug('[ffmpeg] failed on srtp://192.0.2.10:50100?srtp_out_params=must-not-appear');
      await logger.flush?.();

      const records = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        scope: 'ffmpeg',
        level: 'debug',
        role: 'sdk',
        event: 'output',
        stderr: ["Unknown decoder 'h264_synthetic'"],
      });
      expect(records[1]).toMatchObject({ stderr: ['failed on <url>'] });
      expect(readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')).not.toContain('must-not-appear');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
