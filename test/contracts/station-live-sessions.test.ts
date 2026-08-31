import { describe, expect, it, vi } from 'vitest';

import { StationLiveSessions } from '../../src/media/station-live-sessions.js';

/**
 * Which claim holds each station's one live channel, and who yields to whom.
 *
 * A HomeBase serves one of its cameras at a time, and the SDK refuses a second rather than degrading both. It
 * reports the constraint and does not rank the callers, because the ranking depends on what HomeKit shows at
 * once. So the order lives here: a live view is on a screen now, a recording writes to a file and cannot be
 * re-taken, a still fills a tile that is off screen while a live view is on it.
 *
 * A standalone camera is its own station and contends with nobody.
 */
const BASE = 'T8010P0000000000';
const STANDALONE = 'T8410P0000000002';
/** Two cameras of one base: the pair that contends. */
const CAM_A = 'T8114P0000000000';
const CAM_B = 'T8210P0000000001';

describe('StationLiveSessions', () => {
  it('reports nothing holding a station to begin with', () => {
    expect(new StationLiveSessions().heldFor(BASE)).toBeUndefined();
  });

  it('reports what a held session holds the station for', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE, CAM_A, 'recording');
    expect(sessions.heldFor(BASE)).toBe('recording');
  });

  it('reports the strongest claim while several hold one station', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE, CAM_A, 'snapshot');
    sessions.hold(BASE, CAM_B, 'live');
    sessions.hold(BASE, CAM_A, 'recording');
    expect(sessions.heldFor(BASE)).toBe('live');
  });

  it('leaves another station alone', () => {
    const sessions = new StationLiveSessions();
    sessions.hold(BASE, CAM_A, 'live');
    expect(sessions.heldFor(STANDALONE)).toBeUndefined();
  });

  describe('admits', () => {
    it('admits anything to a station nothing holds', () => {
      const sessions = new StationLiveSessions();
      expect(sessions.admits(BASE, CAM_B, 'snapshot')).toBe(true);
    });

    it('admits a live view over a recording and a still', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'recording');
      expect(sessions.admits(BASE, CAM_B, 'live')).toBe(true);
    });

    it('refuses a still while a recording holds the station', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'recording');
      expect(sessions.admits(BASE, CAM_B, 'snapshot')).toBe(false);
    });

    /** Equal claims do not displace each other, and the SDK refuses the second, which is the honest answer. */
    it('refuses a second live view rather than evicting the first', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'live');
      expect(sessions.admits(BASE, CAM_B, 'live')).toBe(false);
    });
  });

  describe('yielding', () => {
    it('asks a weaker holder to abandon, which is what frees the channel', () => {
      const sessions = new StationLiveSessions();
      const abandon = vi.fn();
      sessions.hold(BASE, CAM_A, 'snapshot', abandon);

      sessions.hold(BASE, CAM_B, 'live');

      expect(abandon).toHaveBeenCalledOnce();
    });

    it('asks every weaker holder, not merely the strongest of them', () => {
      const sessions = new StationLiveSessions();
      const still = vi.fn();
      const recording = vi.fn();
      sessions.hold(BASE, CAM_A, 'snapshot', still);
      sessions.hold(BASE, CAM_A, 'recording', recording);

      sessions.hold(BASE, CAM_B, 'live');

      expect(still).toHaveBeenCalledOnce();
      expect(recording).toHaveBeenCalledOnce();
    });

    it('never asks an equal or stronger holder to abandon', () => {
      const sessions = new StationLiveSessions();
      const live = vi.fn();
      sessions.hold(BASE, CAM_A, 'live', live);

      sessions.hold(BASE, CAM_A, 'recording');
      sessions.hold(BASE, CAM_A, 'live');

      expect(live).not.toHaveBeenCalled();
    });

    it('leaves a holder alone when it stated no way to be stopped cleanly', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'snapshot');

      expect(() => sessions.hold(BASE, CAM_B, 'live')).not.toThrow();
      expect(sessions.heldFor(BASE)).toBe('live');
    });

    it('leaves a weaker holder on ANOTHER station untouched', () => {
      const sessions = new StationLiveSessions();
      const elsewhere = vi.fn();
      sessions.hold(STANDALONE, CAM_B, 'snapshot', elsewhere);

      sessions.hold(BASE, CAM_A, 'live');

      expect(elsewhere).not.toHaveBeenCalled();
    });
  });

  describe('releasing', () => {
    it('frees the station when the only session releases', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'live')();
      expect(sessions.heldFor(BASE)).toBeUndefined();
    });

    it('keeps the station held while any session on it remains', () => {
      const sessions = new StationLiveSessions();
      const first = sessions.hold(BASE, CAM_A, 'live');
      sessions.hold(BASE, CAM_B, 'live');
      first();
      expect(sessions.heldFor(BASE)).toBe('live');
    });

    /** A release runs once: a session reporting its end twice must not free a peer's hold. */
    it('ignores a repeated release', () => {
      const sessions = new StationLiveSessions();
      const release = sessions.hold(BASE, CAM_A, 'live');
      sessions.hold(BASE, CAM_B, 'live');
      release();
      release();
      expect(sessions.heldFor(BASE)).toBe('live');
    });

    it('reports the weaker claim once the stronger one has gone', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'recording');
      const live = sessions.hold(BASE, CAM_B, 'live');
      live();
      expect(sessions.heldFor(BASE)).toBe('recording');
    });

    it('forgets a station once its last session has gone, so nothing accumulates', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'live')();
      expect(sessions.held).toBe(0);
    });
  });

  /**
   * Every egress on one camera shares a single pull, so nothing there contends. This is what a motion
   * notification produces once the operator taps that camera's tile, and it is the common shape.
   */
  describe('within one camera', () => {
    it('admits any claim on a camera the station is already serving', () => {
      const sessions = new StationLiveSessions();
      sessions.hold(BASE, CAM_A, 'live');

      expect(sessions.admits(BASE, CAM_A, 'recording')).toBe(true);
      expect(sessions.admits(BASE, CAM_A, 'snapshot')).toBe(true);
      expect(sessions.admits(BASE, CAM_A, 'live')).toBe(true);
    });

    it('never asks a camera to yield to other work on itself', () => {
      const sessions = new StationLiveSessions();
      const recording = vi.fn();
      sessions.hold(BASE, CAM_A, 'recording', recording);

      sessions.hold(BASE, CAM_A, 'live');

      expect(recording).not.toHaveBeenCalled();
    });
  });
});
