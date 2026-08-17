import { describe, expect, it } from 'vitest';

import { parseDiagnosticsAuthorization, parseDiagnosticsUiEvent } from '../../src/ui/server.js';

describe('custom UI diagnostics input', () => {
  it('accepts only current and cached authorize payloads', () => {
    expect(parseDiagnosticsAuthorization({ profile: 'dashboard-ui' })).toEqual({
      profile: 'dashboard-ui',
      reproductionMode: 'now',
    });
    expect(parseDiagnosticsAuthorization({ profile: 'control-state', reproductionMode: 'intermittent' })).toEqual({
      profile: 'control-state',
      reproductionMode: 'intermittent',
    });

    for (const value of [
      undefined,
      [],
      { profile: 'dashboard-ui', extra: true },
      { profile: 'dashboard-ui', reproductionMode: undefined },
      { profile: 'dashboard-ui', reproductionMode: 'later' },
      { profile: 'unknown' },
      { reproductionMode: 'now' },
    ]) {
      expect(() => parseDiagnosticsAuthorization(value)).toThrow('Invalid diagnostics request');
    }
  });

  it('accepts only one allowlisted UI event field', () => {
    expect(parseDiagnosticsUiEvent({ event: 'issue-observed' })).toBe('issue-observed');

    for (const value of [
      undefined,
      [],
      {},
      { event: 'future-event' },
      { event: 'issue-observed', detail: 'must not cross the boundary' },
    ]) {
      expect(() => parseDiagnosticsUiEvent(value)).toThrow('Invalid diagnostics UI event');
    }
  });
});
