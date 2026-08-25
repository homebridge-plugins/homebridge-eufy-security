import { describe, expect, it } from 'vitest';

import {
  parseAuthenticationAnswer,
  parseAuthenticationStart,
  parseDiagnosticsAuthorization,
  parseDiagnosticsUiEvent,
} from '../../src/ui/server.js';

const SUBMITTED_PASSWORD = 'synthetic-password-must-never-be-echoed';
const SUBMITTED_ANSWER = 'synthetic-challenge-answer-must-never-be-echoed';

function startPayload(overrides: Record<string, unknown> = {}) {
  return {
    configuration: {
      platform: 'HomebridgeEufy',
      username: 'Guest@Example.Invalid',
      password: SUBMITTED_PASSWORD,
      country: 'us',
      trustedDeviceName: '  Synthetic Homebridge  ',
      ...overrides,
    },
  };
}

/** Asserts a rejection carries the generic message and never echoes the submitted value back. */
function expectRejection(parse: () => unknown, message: string, submitted: string) {
  let thrown: unknown;
  expect(() => {
    try {
      parse();
    } catch (error) {
      thrown = error;
      throw error;
    }
  }).toThrow(message);
  expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(submitted);
}

describe('custom UI authentication input', () => {
  it('normalizes an accepted start payload without altering the submitted secret', () => {
    const parsed = parseAuthenticationStart(startPayload());

    expect(parsed.configuration.username).toBe('guest@example.invalid');
    expect(parsed.configuration.country).toBe('US');
    expect(parsed.configuration.trustedDeviceName).toBe('Synthetic Homebridge');
    expect(parsed.configuration.password).toBe(SUBMITTED_PASSWORD);
  });

  it('rejects a malformed start payload without echoing the submitted secret', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      [],
      'string',
      {},
      { configuration: null },
      { configuration: [] },
      { configuration: 'string' },
      startPayload({ username: undefined }),
      startPayload({ username: '' }),
      startPayload({ username: `${'a'.repeat(311)}@example.invalid` }),
      startPayload({ password: undefined }),
      startPayload({ password: '' }),
      startPayload({ password: 'a'.repeat(1_025) }),
      startPayload({ password: 42 }),
      startPayload({ country: undefined }),
      startPayload({ country: 'USA' }),
      startPayload({ country: '1' }),
      startPayload({ trustedDeviceName: undefined }),
      startPayload({ trustedDeviceName: 'a'.repeat(129) }),
      startPayload({ platform: 'EufySecurity' }),
    ];

    for (const value of rejected) {
      expectRejection(() => parseAuthenticationStart(value), 'Invalid authentication request', SUBMITTED_PASSWORD);
    }
  });

  it('accepts one trimmed challenge answer per continuation field', () => {
    expect(parseAuthenticationAnswer({ answer: '  1234  ' }, 'answer')).toBe('1234');
    expect(parseAuthenticationAnswer({ code: '  654321  ' }, 'code')).toBe('654321');
  });

  it('rejects a malformed challenge continuation without echoing the submitted answer', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      [],
      'string',
      {},
      { answer: '' },
      { answer: '   ' },
      { answer: 42 },
      { answer: SUBMITTED_ANSWER.repeat(4) },
      { code: '1234' },
    ];

    for (const value of rejected) {
      expectRejection(
        () => parseAuthenticationAnswer(value, 'answer'),
        'Invalid authentication continuation',
        SUBMITTED_ANSWER,
      );
    }
  });
});

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
