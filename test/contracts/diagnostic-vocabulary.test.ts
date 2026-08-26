import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DiagnosticConditions } from '../../src/diagnostics.js';

/**
 * Every diagnostic this plugin can emit has to survive its own allowlist, and every one it declares has to be
 * demonstrated by a test.
 *
 * A condition whose code, capability, member or reason is undeclared is discarded without a word, so a user
 * reports "it does not work" and the log holds nothing. Neither half is hypothetical. Every diagnostic the
 * lock adapter emitted was dropped for the life of the feature, because `lock` was missing from the capability
 * allowlist and `target` from the member one. Both HomeKit Secure Video recording conditions were dropped the
 * same way, so a failed recording left no record at all. Nothing threw in either case, which is exactly why
 * they survived — and neither code had a test, which is why nobody noticed.
 *
 * The source is read rather than the runtime, because the drop happens on values no type can check: the
 * allowlists are `Set<string>`, so a capability the adapters use and diagnostics does not know is a legal
 * program.
 */
describe('diagnostic vocabulary', () => {
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
    });

  const diagnostics = readFileSync('src/diagnostics.ts', 'utf8');
  const sources = new Map(
    sourceFiles('src')
      .filter((path) => !path.endsWith('diagnostics.ts'))
      .map((path) => [path, readFileSync(path, 'utf8')]),
  );

  const constants = new Map<string, string>();
  for (const text of sources.values()) {
    for (const [, name, value] of text.matchAll(/const ([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9-]+)'/g)) {
      constants.set(name!, value!);
    }
  }

  /**
   * The blocks that genuinely describe a diagnostic: a `diagnose({ … })` call, or a declared shape carrying
   * both a code and a reason. Restricting to those keeps unrelated structures out — the motion adapter pairs a
   * capability with an event name for evidence matching, which is not a diagnostic at all.
   */
  const contexts = [...sources].flatMap(([path, text]) => [
    ...[...text.matchAll(/diagnose\(\{(.*?)\}\)/gs)].map(([, body]) => ({ path, body: body! })),
    ...[...text.matchAll(/(?:interface|type)\s+\w+\s*=?\s*\{(.*?)\n\}/gs)]
      .map(([, body]) => ({ path, body: body! }))
      .filter(({ body }) => /\bcode\??:/.test(body) && /\breason\??:/.test(body)),
  ]);

  /** Every value a diagnostic field can carry: a literal, a constant, or a string-literal union. */
  const values = (field: string): Map<string, string> => {
    const found = new Map<string, string>();
    for (const { path, body } of contexts) {
      for (const [, literal] of body.matchAll(new RegExp(String.raw`\b${field}:\s*'([a-z0-9-]+)'`, 'g'))) {
        found.set(literal!, path);
      }
      for (const [, reference] of body.matchAll(new RegExp(String.raw`\b${field}:\s*([A-Z][A-Z0-9_]*)`, 'g'))) {
        const resolved = constants.get(reference!);
        if (resolved !== undefined) found.set(resolved, path);
      }
      /**
       * A union of alternatives, or a ternary choosing between them — the camera bundle picks most of its
       * reasons with a nested conditional, so taking only the first literal would see one branch in four.
       */
      const expression = new RegExp(String.raw`\b${field}\??:((?:[^,}\n]|\n\s{6,})*)`, 'g');
      for (const [, chosen] of body.matchAll(expression)) {
        if (!/[|?]/.test(chosen!)) continue;
        /**
         * Only what a ternary CHOOSES, never what it tests: `typeof set !== 'function' ? 'power' : …` would
         * otherwise report `function` as a member the plugin emits.
         */
        const selected = chosen!.includes('?') ? chosen!.slice(chosen!.indexOf('?') + 1) : chosen!;
        for (const [, member] of selected.matchAll(/'([a-z0-9-]+)'/g)) found.set(member!, path);
      }
    }
    return found;
  };

  const codes = values('code');
  /**
   * One form the other fields do not have: a condition constant handed to a reporter helper, which is how the
   * camera bundle emits most of its own. Those call sites are neither a `diagnose` block nor a declared shape,
   * so a constant referenced beyond its own declaration counts as a code this plugin can emit.
   */
  for (const [name, value] of constants) {
    if (!/(?:CONDITION|CODE)$/.test(name)) continue;
    for (const [path, text] of sources) {
      const references = [...text.matchAll(new RegExp(String.raw`\b${name}\b`, 'g'))].length;
      if (references > (text.includes(`const ${name} =`) ? 1 : 0)) codes.set(value, path);
    }
  }

  /** Whether the real reporter keeps a condition, which is the only definition of "not dropped". */
  const kept = (condition: { code: string; capability?: string; member?: string; reason: string }): boolean => {
    const records: string[] = [];
    const probe = new DiagnosticConditions({
      debug: (message) => records.push(message),
      error: () => {},
      info: () => {},
      warn: () => {},
    });
    probe.reportHomeKit({ ...condition, active: true }, ['T8000P0000000000']);
    return records.length > 0;
  };

  it('reads all three forms, so the checks below are not vacuous', () => {
    expect(codes.has('camera-controls-capability-unavailable'), 'a literal in a diagnose call').toBe(true);
    expect(codes.has('camera-recording-unavailable'), 'a constant, whose absence dropped every recording').toBe(true);
    expect(codes.has('lock-reconciliation-expired'), 'a union on a reporter parameter').toBe(true);
    expect(values('member').has('target'), 'the member whose absence dropped every lock diagnostic').toBe(true);
    expect(values('reason').has('missing-trigger'), 'a reason chosen by a nested ternary').toBe(true);
  });

  it('declares every code the adapters can emit', () => {
    const dropped = [...codes]
      .filter(([code]) => !kept({ code, reason: 'recovered' }))
      .map(([code, path]) => `${code} (${path})`);

    expect(dropped, 'an undeclared code is discarded, so a user report has nothing behind it').toEqual([]);
  });

  it('declares every capability, member and reason the adapters can emit', () => {
    const sample = 'camera-control-operation-failed';
    const dropped = [
      ...[...values('capability')].map(
        ([capability, path]) =>
          [`capability=${capability} (${path})`, kept({ code: sample, capability, reason: 'recovered' })] as const,
      ),
      ...[...values('member')].map(
        ([member, path]) =>
          [`member=${member} (${path})`, kept({ code: sample, member, reason: 'recovered' })] as const,
      ),
      ...[...values('reason')].map(
        ([reason, path]) => [`reason=${reason} (${path})`, kept({ code: sample, reason })] as const,
      ),
    ]
      .filter(([, survived]) => !survived)
      .map(([label]) => label);

    expect(dropped).toEqual([]);
  });

  /**
   * The reverse direction, decided by demonstration rather than by static analysis: a code no test names has
   * never been shown to reach a log, and the two recording codes prove what that costs. The exceptions are
   * named so the list shrinks rather than hides — each is a diagnostic that exists in declaration only.
   */
  it('demonstrates every code it declares with a test', () => {
    const undemonstrated = new Set([
      'arming-capability-unavailable',
      'arming-operation-failed',
      'invalid-battery-observation',
      'invalid-siren-active-observation',
      'lock-capability-unavailable',
    ]);
    const tests = sourceFiles('test')
      .filter((path) => !path.endsWith('diagnostic-vocabulary.test.ts'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('');
    const declared = [
      ...diagnostics.slice(diagnostics.indexOf('const HOMEKIT_CONDITIONS')).matchAll(/^ {2}'([a-z0-9-]+)':/gm),
    ].map(([, code]) => code!);

    const missing = declared.filter((code) => !tests.includes(`'${code}'`) && !undemonstrated.has(code));
    const demonstrated = declared.filter((code) => tests.includes(`'${code}'`));

    expect(declared.length).toBeGreaterThan(30);
    expect(missing, 'a new diagnostic has to be demonstrated by a test before it is declared').toEqual([]);
    expect(
      [...undemonstrated].filter((code) => tests.includes(`'${code}'`)),
      'a code that gained a test must leave the exception list',
    ).toEqual([]);
    expect(demonstrated.length).toBe(declared.length - undemonstrated.size);
  });
});
