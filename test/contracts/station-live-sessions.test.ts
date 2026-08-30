import { describe, expect, it } from 'vitest';

import { StationLiveSessions } from '../../src/media/station-live-sessions.js';

/**
 * Which stations currently have a live session.
 *
 * A HomeBase fans several cameras over one session and serves them one at a time, so a live burst opened on
 * one of its cameras contends with a live view already running on another. A standalone camera is its own
 * station and contends with nobody.
 *
 * Measured on a base carrying four cameras: each HomeKit tile asking for a still can open a burst, and the
 * station is serving a live view at the same time.
 */
const BASE = 'T8010P0000000000';
const STANDALONE = 'T8410P0000000002';

describe('StationLiveSessions', () => {
  it('reports no station busy to begin with', () => {
    expect(new StationLiveSessions().busy(BASE)).toBe(false);
  });

  it('reports the station of a held session busy', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE);
    expect(sessions.busy(BASE)).toBe(true);
  });

  it('leaves another station alone', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE);
    expect(sessions.busy(STANDALONE)).toBe(false);
  });

  it('frees the station when the session releases', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE)();
    expect(sessions.busy(BASE)).toBe(false);
  });

  /**
   * Two cameras of one base can hold live sessions at once — the base serves them in turn rather than
   * refusing the second — so the station is busy until the last of them has gone.
   */
  it('stays busy while any session on that station is held', () => {
    const sessions = new StationLiveSessions();
    const first = sessions.hold(BASE);
    const second = sessions.hold(BASE);
    first();
    expect(sessions.busy(BASE)).toBe(true);
    second();
    expect(sessions.busy(BASE)).toBe(false);
  });

  /** A release runs once: a session that reports its end twice must not free a peer's hold. */
  it('ignores a repeated release', () => {
    const sessions = new StationLiveSessions();
    const release = sessions.hold(BASE);
    sessions.hold(BASE);
    release();
    release();
    expect(sessions.busy(BASE)).toBe(true);
  });

  it('forgets a station once its last session has gone, so nothing accumulates', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE)();
    expect(sessions.held).toBe(0);
  });
});
