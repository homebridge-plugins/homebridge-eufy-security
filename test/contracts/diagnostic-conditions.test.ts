import { describe, expect, it, vi } from 'vitest';

import { createSdkLogger, DiagnosticConditions, reportHomeKitEvent } from '../../src/diagnostics.js';

describe('diagnostic conditions', () => {
  it('emits transitions once and explicitly clears a recovered condition', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const conditions = new DiagnosticConditions({ error: vi.fn(), info, warn });

    conditions.reportRuntimeState('degraded');
    conditions.reportRuntimeState('degraded');
    conditions.reportRuntimeState('ready');

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({
      scope: 'diagnostic-condition',
      code: 'runtime-transport-degraded',
      active: true,
      action: 'Check network access and Eufy service availability',
    });
    expect(info.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual(
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
    const conditions = new DiagnosticConditions({ error: vi.fn(), info, warn });
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
    const active = JSON.parse(warn.mock.calls[0]![0]);
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
    expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain(firstSerial);
    expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain(secondSerial);
    expect(JSON.parse(info.mock.calls[0]![0])).toMatchObject({
      code: 'invalid-contact-observation',
      active: false,
      reason: 'recovered',
      affectedAccessoryCount: 0,
    });
  });

  it('tracks members with the same code as independent conditions', () => {
    const warn = vi.fn();
    const info = vi.fn();
    const conditions = new DiagnosticConditions({ error: vi.fn(), info, warn });
    const base = {
      code: 'invalid-smart-light-observation',
      capability: 'smart_light',
      active: true,
      reason: 'malformed',
    } as const;

    conditions.reportHomeKit({ ...base, member: 'power' }, ['synthetic-light']);
    conditions.reportHomeKit({ ...base, member: 'brightness' }, ['synthetic-light']);
    conditions.reportHomeKit({ ...base, member: 'power', active: false, reason: 'recovered' }, []);

    expect(warn.mock.calls.map(([message]) => JSON.parse(message).member)).toEqual(['power', 'brightness']);
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.parse(info.mock.calls[0]![0])).toMatchObject({ member: 'power', active: false });
  });

  it('bounds aliases while retaining the complete affected-accessory count', () => {
    const warn = vi.fn();
    const conditions = new DiagnosticConditions({ error: vi.fn(), info: vi.fn(), warn });
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

    const output = JSON.parse(warn.mock.calls[0]![0]);
    expect(output).toMatchObject({ affectedAccessoryCount: 40, aliasesTruncated: true });
    expect(output.accessoryAliases).toHaveLength(32);
    expect(JSON.stringify(output)).not.toContain('synthetic-device-');
  });

  it('drops non-allowlisted fields and rejects unknown generated output', () => {
    const outputs: string[] = [];
    const conditions = new DiagnosticConditions({
      error: (message) => outputs.push(message),
      info: (message) => outputs.push(message),
      warn: (message) => outputs.push(message),
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
      debug: (message) => outputs.push(message),
      error: (message) => outputs.push(message),
      info: (message) => outputs.push(message),
      warn: (message) => outputs.push(message),
    })!;
    sdk.error(
      `[p2p] ${prohibited.join(' ')}`,
      { account: prohibited[0], token: prohibited[2], capture: prohibited[7] },
      ...Array.from({ length: 20 }, () => prohibited[6]),
    );

    expect(outputs).toHaveLength(2);
    expect(JSON.parse(outputs[1]!)).toMatchObject({ detailsTruncated: true, details: expect.any(Array) });
    expect(JSON.parse(outputs[1]!).details).toHaveLength(16);
    for (const value of prohibited) {
      expect(outputs.join('\n')).not.toContain(value);
    }
    expect(outputs[0]).not.toContain('T8000P2222222222');
    expect(outputs[0]).not.toContain('unknown-condition');
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

    expect(debug).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        scope: 'homekit',
        adapter: 'contact.sensor',
        event: 'contact-state',
        observation: 'malformed',
      }),
    );
  });
});
