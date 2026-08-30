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

/**
 * An adaptation trace is levelled by what it reports, not by the fact that it is one.
 *
 * Every one of these was a failure once, so stamping the class `warn` was the same thing as levelling each
 * record. `started` and `output` are not failures — one is a process beginning, the other a process reported
 * for what it wrote on the way to an intended stop — and levelling them as warnings puts four warnings in a
 * support log for every stream that worked, which is what a real fleet showed after `started` was added.
 */
describe('the level an adaptation record carries', () => {
  const levelOf = (event: string, extra: Record<string, unknown> = {}) => {
    const debug = vi.fn();
    reportAdaptationNotice({ debug }, { role: 'live-video', event, ...extra } as never);
    return records(debug)[0]?.level;
  };

  it('is debug for a process that started, which is a stream working', () => {
    expect(levelOf('started')).toBe('debug');
  });

  it('is debug for the output of a process asked to stop, teardown being how a session ends', () => {
    expect(levelOf('output', { code: 255, stderr: ['bitrate= 281.9kbits/s'] })).toBe('debug');
  });

  it.each(['spawn-failed', 'exited-before-output', 'exited-while-streaming'])('is warn for %s', (event) => {
    expect(levelOf(event, { stderr: ['Invalid data found'] })).toBe('warn');
  });
});

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

/**
 * How much source media a recording was given, which is what separates its two failure modes.
 *
 * A recording whose source delivered nothing closes an empty pipe, and FFmpeg reports that as
 * `moov atom not found` — the same words an adaptation fed malformed fragments would produce. Observed on a
 * real fleet as one such failure with nothing to say which it was, seventeen seconds after the motion that
 * triggered it.
 *
 * The count answers it outright: zero is a source that never delivered, and any other number moves the
 * question to the adaptation. It is a tally, so it is retained as a bounded integer.
 */
describe('what a recording reports about the media it was handed', () => {
  it('carries the number of source fragments it wrote', () => {
    const debug = vi.fn();
    reportAdaptationNotice({ debug }, { role: 'recording', event: 'output', code: 183, sourceFragments: 0 });
    expect(records(debug)[0]).toMatchObject({ role: 'recording', sourceFragments: 0 });
  });

  it('keeps a count that is not a tally out of the record', () => {
    const debug = vi.fn();
    reportAdaptationNotice({ debug }, {
      role: 'recording',
      event: 'output',
      code: 1,
      sourceFragments: -3,
    } as never);
    expect(records(debug)[0]).not.toHaveProperty('sourceFragments');
  });
});
