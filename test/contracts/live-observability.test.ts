import { describe, expect, it, vi } from 'vitest';

import { createSdkLogger, reportAdaptationNotice, reportHomeKitEvent } from '../../src/diagnostics.js';

/**
 * The two facts a stream nobody can see is diagnosed from.
 *
 * Everything before them was already traced: HomeKit's selection, the station's key, the warm-up window, the
 * media command and its retries, the first inbound unit, the first keyframe. Everything after was too: a
 * failure with its reason and stage, the adaptation's exit, the release.
 *
 * Between the last of the first group and the first of the second there was nothing. So a stream that never
 * appeared could not be told apart: the SDK handed over a keyframe, and whether an adaptation was ever started
 * for it, and whether anything it produced reached the negotiated output, were both invisible. That gap is
 * where three wrong conclusions came from.
 */
const records = (debug: ReturnType<typeof vi.fn>) =>
  debug.mock.calls.map(([message]) => JSON.parse(message as string) as Record<string, unknown>);

describe('an adaptation that has started', () => {
  it('is recorded, so a keyframe with no adaptation behind it is visible', () => {
    const debug = vi.fn();
    reportAdaptationNotice({ debug }, { role: 'live-video', event: 'started' });
    expect(records(debug)[0]).toMatchObject({ scope: 'ffmpeg', role: 'live-video', event: 'started' });
  });

  it('is recorded per role, so video and audio are told apart', () => {
    const debug = vi.fn();
    reportAdaptationNotice({ debug }, { role: 'live-video', event: 'started' });
    reportAdaptationNotice({ debug }, { role: 'live-audio', event: 'started' });
    expect(records(debug).map((r) => r.role)).toEqual(['live-video', 'live-audio']);
  });

  it('carries no argument list, which is where the key material and the address are', () => {
    const debug = vi.fn();
    reportAdaptationNotice({ debug }, { role: 'live-video', event: 'started', stderr: ['srtp://192.0.2.10:5000'] });
    expect(JSON.stringify(records(debug))).not.toContain('192.0.2.10');
  });
});

describe('a session that reached the negotiated output', () => {
  it('is recorded, so output produced is told apart from output never produced', () => {
    const debug = vi.fn();
    reportHomeKitEvent({ debug }, { adapter: 'camera.streaming', event: 'live-session-streaming' });
    expect(records(debug)[0]).toMatchObject({ scope: 'homekit', event: 'live-session-streaming' });
  });

  it('carries nothing beyond the fact itself', () => {
    const debug = vi.fn();
    reportHomeKitEvent({ debug }, {
      adapter: 'camera.streaming',
      event: 'live-session-streaming',
    } as never);
    const record = records(debug)[0]!;
    expect(Object.keys(record).sort()).toEqual(['adapter', 'event', 'level', 'scope']);
  });
});
