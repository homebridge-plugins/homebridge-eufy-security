import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DiagnosticConditions } from '../../src/diagnostics.js';

/**
 * Every diagnostic this plugin emits has to survive its own allowlist.
 *
 * A condition whose code, capability, member or reason is not declared is discarded without a word, so the
 * user reports "it does not work" and the log holds nothing at all. That is not hypothetical: every diagnostic
 * the lock adapter emitted was dropped for the life of the feature, because `lock` was missing from the
 * capability allowlist and `target` from the member one, and all three lock condition codes were unreachable
 * as a result. Nothing failed — that is exactly the problem.
 *
 * This reads the source rather than the runtime, because the drop happens on values a type cannot check: the
 * allowlists are `Set<string>`, so a capability the adapters use and diagnostics does not know is a legal
 * program. Reading the source is what makes the two halves agree.
 */
describe('diagnostic vocabulary', () => {
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
    });

  /** Every `diagnose({ … })` call whose fields are literals, which is every one an adapter writes by hand. */
  const emitted = sourceFiles('src')
    .filter((path) => !path.endsWith('diagnostics.ts'))
    .flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...text.matchAll(/diagnose\(\{(.*?)\}\)/gs)].map((match) => {
        const field = (name: string): string | undefined => new RegExp(`\\b${name}:\\s*'([^']+)'`).exec(match[1]!)?.[1];
        return {
          path,
          code: field('code'),
          capability: field('capability'),
          member: field('member'),
          reason: field('reason'),
        };
      });
    });

  it('finds the diagnostics the adapters emit, so the checks below are not vacuous', () => {
    expect(emitted.length).toBeGreaterThan(30);
    expect(emitted.filter(({ capability }) => capability !== undefined).length).toBeGreaterThan(20);
  });

  it('declares every capability, member and reason the adapters emit', () => {
    const conditions = new DiagnosticConditions({ debug: () => {}, error: () => {}, info: () => {}, warn: () => {} });
    const dropped: string[] = [];
    for (const { path, code, capability, member, reason } of emitted) {
      if (code === undefined || reason === undefined) {
        continue;
      }
      const records: string[] = [];
      const probe = new DiagnosticConditions({
        debug: (message) => records.push(message),
        error: () => {},
        info: () => {},
        warn: () => {},
      });
      probe.reportHomeKit({ code, capability, member, active: true, reason }, ['T8000P0000000000']);
      if (records.length === 0) {
        dropped.push(`${code} (capability=${capability ?? '-'} member=${member ?? '-'} reason=${reason}) in ${path}`);
      }
    }
    expect(conditions).toBeDefined();
    expect(dropped, 'a dropped diagnostic leaves a user report with nothing behind it').toEqual([]);
  });
});
