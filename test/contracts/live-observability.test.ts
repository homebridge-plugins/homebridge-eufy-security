import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDiagnosticLogger,
  createSdkLogger,
  GuidedDiagnostics,
  reportAdaptationNotice,
  reportHomeKitEvent,
} from '../../src/diagnostics.js';

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

/**
 * Which pull a live trace belongs to, so several cameras' records can be told apart.
 *
 * A phase says what happened and nothing about where. Four cameras warming off one HomeBase produced four
 * identical `warming` records on a real fleet, and the only way to attribute them was to correlate the
 * surrounding media commands by time — which is guesswork, and it read one camera's failure onto another.
 *
 * The SDK now states an opaque per-process handle. It is retained verbatim BECAUSE it is opaque: it resolves
 * to no device, means nothing in the next run, and is bounded in shape — a value shaped like a serial is
 * dropped rather than passed through, since this record is the one a support archive keeps.
 */
describe('the pull a live trace belongs to', () => {
  const traceOf = (source: unknown) => {
    const debug = vi.fn();
    const sdk = createSdkLogger({ debug })!;
    sdk.debug('[live] start trace', { phase: 'warming', retryMs: 2000, deadlineMs: 20000, source });
    return records(debug)[0];
  };

  it('is retained, so two cameras warming together are two records and not one repeated', () => {
    expect(traceOf('pull-3')).toMatchObject({ phase: 'warming', source: 'pull-3' });
    expect(traceOf('station-1:2')).toMatchObject({ source: 'station-1:2' });
  });

  it('is dropped where it is not an opaque handle, a serial being what this record may never carry', () => {
    expect(traceOf('T8010P2320172199:2')).not.toHaveProperty('source');
    expect(traceOf('T8010P2320172199')).not.toHaveProperty('source');
  });

  it('is absent where the SDK sent none, rather than invented', () => {
    expect(traceOf(undefined)).not.toHaveProperty('source');
  });
});

/**
 * A started request that reached neither a streaming outcome nor a failure.
 *
 * Every request is meant to end in one or the other, and a controller badges the camera either way. One ending
 * in neither leaves an operator looking at a failure this log has no record of, and nobody can diagnose what
 * was never written down. Observed once on a real controller: a selection, then no adaptation, no source
 * command, and no outcome at all.
 */
describe('a request that reached no outcome', () => {
  it('is recorded, with how long was waited', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, { adapter: 'camera.streaming', event: 'live-request-unaccounted', afterMs: 30_000 });

    expect(records(debug)[0]).toMatchObject({
      scope: 'homekit',
      event: 'live-request-unaccounted',
      afterMs: 30_000,
    });
  });

  it('carries nothing beyond the wait, the path that dropped it having left nothing else', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, { adapter: 'camera.streaming', event: 'live-request-unaccounted', afterMs: 12_345 });

    const record = records(debug)[0]!;
    expect(Object.keys(record).sort()).toEqual(['adapter', 'afterMs', 'event', 'level', 'scope']);
  });

  it('is withheld where the wait is not a finite number, rather than logged as nonsense', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, {
      adapter: 'camera.streaming',
      event: 'live-request-unaccounted',
      afterMs: Number.NaN,
    } as never);

    expect(debug).not.toHaveBeenCalled();
  });
});

/**
 * A request refused before it reached the source.
 *
 * Each of these answers a controller instantly and is badged instantly, and none was recorded. That is why a
 * badge appearing at the moment of a switch had no counterpart in any log, and why five explanations for it
 * were proposed and ruled out by measurement rather than read off a record.
 */
describe('a request refused before the source', () => {
  it('records each bounded reason', () => {
    for (const reason of ['disabled', 'at-capacity', 'cancelled', 'prepare-failed'] as const) {
      const debug = vi.fn();

      reportHomeKitEvent({ debug }, { adapter: 'camera.streaming', event: 'live-request-refused', reason });

      expect(records(debug)[0]).toMatchObject({ scope: 'homekit', event: 'live-request-refused', reason });
    }
  });

  it('carries the reason alone, no port, key or session identity travelling with it', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, { adapter: 'camera.streaming', event: 'live-request-refused', reason: 'cancelled' });

    expect(Object.keys(records(debug)[0]!).sort()).toEqual(['adapter', 'event', 'level', 'reason', 'scope']);
  });

  it('withholds a reason outside the bounded set rather than logging it', () => {
    const debug = vi.fn();

    reportHomeKitEvent({ debug }, {
      adapter: 'camera.streaming',
      event: 'live-request-refused',
      reason: 'something-invented',
    } as never);

    expect(debug).not.toHaveBeenCalled();
  });
});

/**
 * What a live record says once the file sink has retained it, rather than what its reporter emitted.
 *
 * The reporter and the sink each rebuild the record from an allowlist, so a spy on the reporter cannot show
 * what the log a support archive is assembled from actually holds.
 */
describe('a live record that reached the support archive', () => {
  /**
   * Drives the production logger over an authorized live-media window and returns what the log file holds.
   *
   * The retained `timestamp` is dropped so the remaining keys can be compared exactly rather than as a subset.
   */
  const retained = async (record: Readonly<Record<string, unknown>>) => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-live-retained-'));
    await new GuidedDiagnostics(root).authorize('live-media', 'now');
    const logger = createDiagnosticLogger({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);
    if ('scope' in record) {
      logger.debug?.(JSON.stringify(record));
    } else {
      reportHomeKitEvent(logger, record as Parameters<typeof reportHomeKitEvent>[1]);
    }
    await logger.flush?.();
    const path = join(root, 'logs', 'homebridge-eufy.jsonl');
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const { timestamp, ...rest } = JSON.parse(line) as Record<string, unknown>;
        expect(timestamp).toEqual(expect.any(String));
        return rest;
      });
  };

  it('keeps a request refused before the source, the badge an operator saw having no other counterpart', async () => {
    await expect(
      retained({ adapter: 'camera.streaming', event: 'live-request-refused', reason: 'at-capacity' }),
    ).resolves.toEqual([
      {
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'live-request-refused',
        reason: 'at-capacity',
      },
    ]);
  });

  it('keeps a request that reached no outcome, with the wait that is all it carries', async () => {
    await expect(
      retained({ adapter: 'camera.streaming', event: 'live-request-unaccounted', afterMs: 30_000 }),
    ).resolves.toEqual([
      {
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'live-request-unaccounted',
        afterMs: 30_000,
      },
    ]);
  });

  it('keeps a session that reached the negotiated output', async () => {
    await expect(retained({ adapter: 'camera.streaming', event: 'live-session-streaming' })).resolves.toEqual([
      { scope: 'homekit', level: 'debug', adapter: 'camera.streaming', event: 'live-session-streaming' },
    ]);
  });

  it('keeps the geometry a camera-native camera negotiated, which is the shape the fault is about', async () => {
    await expect(
      retained({
        adapter: 'camera.streaming',
        event: 'live-video-selected',
        operation: 'start',
        profile: 'high',
        level: '4.0',
        width: 1600,
        height: 1200,
        fps: 30,
      }),
    ).resolves.toEqual([
      {
        scope: 'homekit',
        level: 'debug',
        adapter: 'camera.streaming',
        event: 'live-video-selected',
        operation: 'start',
        profile: 'high',
        levelName: '4.0',
        width: 1600,
        height: 1200,
        fps: 30,
      },
    ]);
  });

  it('refuses a HomeKit event name arriving under the SDK scope, the two vocabularies being separate', async () => {
    await expect(
      retained({ scope: 'sdk', level: 'debug', subsystem: 'p2p', event: 'live-request-refused' }),
    ).resolves.toEqual([]);
  });
});
