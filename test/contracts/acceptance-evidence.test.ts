import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error the acceptance generator is untyped maintainer tooling consumed only by these contracts
import * as acceptance from '../../scripts/acceptance-evidence.mjs';

const { ACCEPTANCE_SCHEMA, TIERS, evidenceRecord, invalidities, measure, refusals, renderSummary, writeEvidence } =
  acceptance as {
    ACCEPTANCE_SCHEMA: string;
    TIERS: Record<string, { base: string | null; approver: boolean; checks: string[] }>;
    evidenceRecord: (input: Record<string, unknown>) => Record<string, never>;
    invalidities: (record: unknown) => string[];
    measure: (repository: string) => Record<string, never>;
    refusals: (input: Record<string, unknown>) => string[];
    renderSummary: (record: unknown) => string;
    writeEvidence: (directory: string, record: unknown) => string[];
  };

const repository = fileURLToPath(new URL('../..', import.meta.url));
const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const OTHER_COMMIT = '0d9c8b7a6f5e4d3c2b1a0d9c8b7a6f5e4d3c2b1a';

/** Facts a run measures for itself, shaped as `measure()` reports them for a clean checkout. */
const measured = (overrides: Record<string, unknown> = {}) => ({
  clean: true,
  plugin: { name: '@homebridge-plugins/homebridge-eufy-security', version: '5.0.0-beta.0', commit: COMMIT },
  package: {
    filename: 'homebridge-plugins-homebridge-eufy-security-5.0.0-beta.0.tgz',
    integrity: `sha512-${'A'.repeat(86)}==`,
    entryCount: 265,
    unpackedSize: 13_620_076,
    lockfileSha256: '0'.repeat(64),
  },
  sdk: {
    name: '@mega-yfue/eufy-sdk',
    declared: '0.1.0-beta.53',
    version: '0.1.0-beta.53',
    integrity: `sha512-${'B'.repeat(86)}==`,
    resolved: 'https://npm.pkg.github.com/download/@mega-yfue/eufy-sdk/0.1.0-beta.53/eabc26d',
  },
  runtime: { node: 'v24.5.0', npm: '11.6.2', homebridge: '2.4.0' },
  matrix: {
    version: 1,
    hapContract: 'Homebridge 2 HAP definitions',
    rows: 412,
    requiredAdapter: 63,
    diagnosticOnly: 333,
    blockedSdkGap: 16,
  },
  fixtures: { 'v4-migration.json': '1'.repeat(64) },
  ...overrides,
});

const workflow = (overrides: Record<string, unknown> = {}) => ({
  repository: 'homebridge-plugins/homebridge-eufy-security',
  workflow: 'CI',
  runId: '17420001',
  runAttempt: '1',
  commit: COMMIT,
  ...overrides,
});

/** Every check one tier requires, declared as passed against a synthetic reference. */
const declaredChecks = (tier: string) =>
  TIERS[tier]!.checks.map((check) => ({ check, status: 'pass', reference: `synthetic evidence for ${check}` }));

const declarations = (tier: string, overrides: Record<string, unknown> = {}) => ({
  tier,
  checks: declaredChecks(tier),
  knownGaps: [],
  approver: TIERS[tier]!.approver ? 'maintainer' : null,
  ...overrides,
});

const record = (tier: string, input: Record<string, unknown> = {}) =>
  evidenceRecord({
    declarations: declarations(tier),
    measured: measured(),
    workflow: workflow(),
    generatedAt: '2026-09-06T12:00:00.000Z',
    ...input,
  }) as unknown as Record<string, never>;

const implementation = () => record('implementation');
const pilot = () => record('private-pilot', { declarations: declarations('private-pilot'), base: implementation() });

describe('acceptance evidence', () => {
  /**
   * One record states every identity, hash, version, and result the acceptance report is required to carry,
   * and validates against the schema it declares.
   */
  it('records the artifact, its provenance, and its results', () => {
    const evidence = implementation() as unknown as Record<string, Record<string, unknown>>;

    expect(invalidities(evidence)).toEqual([]);
    expect(evidence.schema).toBe(ACCEPTANCE_SCHEMA);
    expect(evidence.tier).toBe('implementation');
    expect(evidence.plugin).toEqual(measured().plugin);
    expect(evidence.package).toEqual(measured().package);
    expect(evidence.sdk).toEqual(measured().sdk);
    expect(evidence.runtime).toEqual(measured().runtime);
    expect(evidence.matrix).toEqual(measured().matrix);
    expect(evidence.fixtures).toEqual(measured().fixtures);
    expect(evidence.workflow).toEqual(workflow());
    expect(evidence.knownGaps).toEqual([]);
    expect(evidence.approver).toBeNull();
    expect(evidence.accumulates).toBeNull();
    expect(evidence.checks).toEqual(
      TIERS.implementation!.checks.map((check) => ({
        check,
        tier: 'implementation',
        status: 'pass',
        reference: `synthetic evidence for ${check}`,
      })),
    );
  });

  /**
   * A record that is missing a field, carries an unexpected schema, or reports an unhashed dependency is not
   * an acceptance record. Validation runs on a supplied prior-tier artifact, which is untrusted input.
   */
  it('refuses a record whose required evidence is absent or malformed', () => {
    expect(invalidities(undefined)).not.toEqual([]);
    expect(invalidities({ ...implementation(), schema: 'something-else' })).toEqual(['schema']);
    expect(invalidities({ ...implementation(), tier: 'nearly-there' })).toEqual(['tier']);
    expect(invalidities({ ...implementation(), knownGaps: undefined })).toEqual(['knownGaps']);
    expect(invalidities({ ...implementation(), approver: 42 })).toEqual(['approver']);
    expect(invalidities({ ...implementation(), plugin: { name: 'x', version: '1', commit: 'HEAD' } })).toEqual([
      'plugin.commit',
    ]);
    expect(invalidities({ ...implementation(), sdk: { ...measured().sdk, integrity: 'md5-nope' } })).toEqual([
      'sdk.integrity',
    ]);
    expect(invalidities({ ...implementation(), sdk: { ...measured().sdk, version: '^0.1.0' } })).toEqual([
      'sdk.version',
    ]);
    expect(invalidities({ ...implementation(), runtime: { node: 'v24.5.0', npm: '11.6.2' } })).toEqual([
      'runtime.homebridge',
    ]);
    expect(
      () => record('implementation', { measured: measured({ runtime: { node: 'v24.5.0', npm: '11.6.2' } }) }),
      'a record is validated against its own schema before it can be written',
    ).toThrow('the record would not carry runtime.homebridge');
    expect(invalidities({ ...implementation(), workflow: null })).toEqual([
      'workflow.repository',
      'workflow.workflow',
      'workflow.runId',
      'workflow.runAttempt',
      'workflow.commit',
    ]);
  });

  /**
   * A tier is claimed only for evidence a workflow produced, at the commit that workflow ran, from a checkout
   * whose content the recorded commit describes.
   */
  it('claims a tier only from a workflow run against the measured artifact', () => {
    expect(refusals({ declarations: declarations('implementation'), measured: measured(), workflow: null })).toEqual([
      'the evidence was not produced by a workflow run, so it is not an immutable acceptance artifact',
    ]);
    expect(
      refusals({
        declarations: declarations('implementation'),
        measured: measured(),
        workflow: workflow({ commit: OTHER_COMMIT }),
      }),
    ).toEqual([`the workflow ran at ${OTHER_COMMIT} while the checkout measured is ${COMMIT}`]);
    expect(
      refusals({
        declarations: declarations('implementation'),
        measured: measured({ clean: false }),
        workflow: workflow(),
      }),
    ).toEqual(['the working tree carries uncommitted changes, so the recorded commit does not describe the artifact']);
    expect(
      refusals({
        declarations: declarations('implementation'),
        measured: measured({
          sdk: { ...measured().sdk, declared: 'file:../eufy-sdk', version: undefined, integrity: undefined },
        }),
        workflow: workflow(),
      }),
    ).toEqual([
      'the SDK is declared as "file:../eufy-sdk" and resolved as "undefined", so one exact published identity ' +
        'with a sha512 integrity cannot be recorded',
    ]);
    expect(
      refusals({
        declarations: declarations('implementation'),
        measured: measured({ sdk: { ...measured().sdk, declared: '^0.1.0' } }),
        workflow: workflow(),
      }),
      'a range that resolves to an exact version is still not one exact declared identity',
    ).toEqual([
      'the SDK is declared as "^0.1.0" and resolved as "0.1.0-beta.53", so one exact published identity with a ' +
        'sha512 integrity cannot be recorded',
    ]);
  });

  /**
   * A tier cannot be claimed while one of its required checks is absent, failed, or unrecognized, and no
   * record is produced for a refused claim.
   */
  it('refuses a tier whose required automated or human evidence is missing', () => {
    const short = declarations('implementation', { checks: declaredChecks('implementation').slice(1) });
    const failed = declarations('implementation', {
      checks: declaredChecks('implementation').map((entry, index) =>
        index === 0 ? { ...entry, status: 'fail' } : entry,
      ),
    });
    const [first] = TIERS.implementation!.checks;

    expect(refusals({ declarations: short, measured: measured(), workflow: workflow() })).toEqual([
      `implementation requires ${first}, which no supplied evidence records as passed`,
    ]);
    expect(refusals({ declarations: failed, measured: measured(), workflow: workflow() })).toEqual([
      `implementation requires ${first}, which no supplied evidence records as passed`,
    ]);
    expect(
      refusals({
        declarations: declarations('implementation', {
          checks: [...declaredChecks('implementation'), { check: 'vibes', status: 'pass', reference: 'none' }],
        }),
        measured: measured(),
        workflow: workflow(),
      }),
    ).toEqual(['vibes is not a check the implementation tier requires']);
    expect(
      refusals({
        declarations: declarations('implementation', {
          checks: [
            ...declaredChecks('implementation'),
            { check: first, status: 'fail', reference: 'a later contradiction' },
          ],
        }),
        measured: measured(),
        workflow: workflow(),
      }),
    ).toEqual([`${first} is declared more than once, so one result would silently replace another`]);
    expect(() => record('implementation', { declarations: short })).toThrow(/which no supplied evidence records/);
  });

  /**
   * A human tier records the maintainer who accepted it. An implementation tier is entirely automated and
   * records no approver.
   */
  it('requires an approver for every tier that rests on a human check', () => {
    expect(TIERS.implementation!.approver).toBe(false);
    for (const tier of ['private-pilot', 'public-beta']) {
      expect(TIERS[tier]!.approver, tier).toBe(true);
    }
    expect(
      refusals({
        declarations: declarations('private-pilot', { approver: null }),
        base: implementation(),
        measured: measured(),
        workflow: workflow(),
      }),
    ).toEqual(['private-pilot rests on human checks, so it records the maintainer who approved it']);
    expect(
      refusals({
        declarations: declarations('implementation', { knownGaps: undefined }),
        measured: measured(),
        workflow: workflow(),
      }),
    ).toEqual(['the record states its known gaps explicitly, and none were declared']);
  });

  /**
   * A higher tier accumulates the lower tier's evidence for the same artifact. It refuses to stand alone, to
   * accumulate a tier other than the one below it, and to accumulate a record describing a different artifact.
   */
  it('accumulates the tier below it, for one artifact', () => {
    const evidence = pilot() as unknown as Record<string, unknown>;

    expect(invalidities(evidence)).toEqual([]);
    expect(TIERS['private-pilot']!.base).toBe('implementation');
    expect(TIERS['public-beta']!.base).toBe('private-pilot');
    expect(evidence.accumulates).toEqual({ tier: 'implementation', runId: workflow().runId });
    expect((evidence.checks as Array<{ check: string; tier: string }>).map((entry) => entry.tier)).toEqual([
      ...TIERS.implementation!.checks.map(() => 'implementation'),
      ...TIERS['private-pilot']!.checks.map(() => 'private-pilot'),
    ]);

    expect(
      refusals({ declarations: declarations('private-pilot'), measured: measured(), workflow: workflow() }),
    ).toContain('private-pilot accumulates implementation evidence for the same artifact, which was not supplied');
    expect(
      refusals({
        declarations: declarations('public-beta'),
        base: implementation(),
        measured: measured(),
        workflow: workflow(),
      }),
    ).toContain('public-beta accumulates private-pilot evidence, and the record supplied is implementation');
    expect(
      refusals({
        declarations: declarations('implementation'),
        base: implementation(),
        measured: measured(),
        workflow: workflow(),
      }),
    ).toEqual(['implementation is the first tier and accumulates nothing']);
    expect(
      refusals({
        declarations: declarations('private-pilot'),
        base: { ...implementation(), plugin: { ...measured().plugin, commit: OTHER_COMMIT } },
        measured: measured(),
        workflow: workflow(),
      }),
    ).toContain(
      `the implementation evidence supplied describes commit ${OTHER_COMMIT} rather than the artifact measured`,
    );
    expect(
      refusals({
        declarations: declarations('private-pilot'),
        base: { ...implementation(), package: { ...measured().package, integrity: `sha512-${'C'.repeat(86)}==` } },
        measured: measured(),
        workflow: workflow(),
      }),
    ).toContain('the implementation evidence supplied describes a differently packed artifact');
    expect(
      refusals({
        declarations: declarations('private-pilot'),
        base: { ...implementation(), checks: [] },
        measured: measured(),
        workflow: workflow(),
      })[0],
    ).toMatch(/^implementation requires /);
  });

  /**
   * The public-beta tier accumulates the whole chain, so its record carries every implementation and pilot
   * check alongside its own.
   */
  it('carries the complete chain at the public-beta tier', () => {
    const evidence = record('public-beta', {
      declarations: declarations('public-beta'),
      base: pilot(),
    }) as unknown as { tier: string; checks: Array<{ check: string }>; approver: string };

    expect(invalidities(evidence)).toEqual([]);
    expect(evidence.checks.map((entry) => entry.check)).toEqual([
      ...TIERS.implementation!.checks,
      ...TIERS['private-pilot']!.checks,
      ...TIERS['public-beta']!.checks,
    ]);
    expect(evidence.approver).toBe('maintainer');
  });

  /**
   * The generated Markdown states the same facts as the record, so the human summary cannot claim a tier,
   * artifact, or result the machine-readable evidence does not.
   */
  it('generates a summary carrying the recorded facts', () => {
    const evidence = pilot() as unknown as Record<string, Record<string, string>>;
    const summary = renderSummary(evidence);

    expect(summary).toContain('# Acceptance evidence — private-pilot');
    for (const value of [
      evidence.plugin!.version!,
      evidence.plugin!.commit!,
      evidence.package!.integrity!,
      evidence.package!.lockfileSha256!,
      evidence.sdk!.version!,
      evidence.sdk!.integrity!,
      evidence.sdk!.resolved!,
      evidence.runtime!.node!,
      evidence.runtime!.homebridge!,
      evidence.workflow!.runId!,
      'v4-migration.json',
      'rollback-rehearsal',
      'hermetic-verification',
      'maintainer',
    ]) {
      expect(summary, value).toContain(value);
    }
    expect(renderSummary({ ...evidence, knownGaps: ['T8531 secured state remains an SDK gap'] })).toContain(
      'T8531 secured state remains an SDK gap',
    );
  });

  /**
   * A written record is immutable: the pair is created once, and a second attempt for the same tier in the
   * same place fails rather than replacing it.
   */
  it('writes each tier once and never rewrites it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'homebridge-eufy-acceptance-'));

    try {
      const evidence = implementation();
      const written = writeEvidence(directory, evidence);

      expect(written.map((path) => path.slice(directory.length + 1))).toEqual([
        'acceptance-implementation.json',
        'acceptance-implementation.md',
      ]);
      expect(JSON.parse(readFileSync(written[0]!, 'utf8'))).toEqual(evidence);
      expect(readFileSync(written[1]!, 'utf8')).toBe(renderSummary(evidence));
      expect(() => writeEvidence(directory, evidence)).toThrow(/EEXIST/);
      expect(JSON.parse(readFileSync(written[0]!, 'utf8'))).toEqual(evidence);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  /**
   * The facts a run measures come from this repository rather than from a declaration: the packed artifact,
   * the resolved SDK, the coverage matrix the plugin compiled, and the fixtures the migration contracts read.
   */
  it('measures the artifact it reports on', () => {
    const facts = measure(repository) as unknown as Record<string, Record<string, unknown>>;

    expect(typeof facts.clean).toBe('boolean');
    expect(facts.plugin!.name).toBe('@homebridge-plugins/homebridge-eufy-security');
    expect(facts.plugin!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(facts.package!.integrity).toMatch(/^sha512-/);
    expect(facts.package!.entryCount).toBeGreaterThan(0);
    expect(facts.package!.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.sdk!.name).toBe('@mega-yfue/eufy-sdk');
    expect(facts.sdk!.declared).toBe(
      (JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { dependencies: Record<string, string> })
        .dependencies['@mega-yfue/eufy-sdk'],
    );
    expect(facts.runtime!.node).toBe(process.version);
    expect(facts.matrix!.rows).toBe(
      (facts.matrix!.requiredAdapter as number) +
        (facts.matrix!.diagnosticOnly as number) +
        (facts.matrix!.blockedSdkGap as number),
    );
    expect(Object.keys(facts.fixtures!)).toContain('v4-migration.json');
    expect(Object.values(facts.fixtures!).every((digest) => /^[0-9a-f]{64}$/.test(String(digest)))).toBe(true);
  }, 30_000);

  /**
   * Continuous integration produces the implementation record itself, after the gate whose result it states,
   * and uploads it under a name no later run can replace.
   */
  it('produces the implementation tier as an uploaded workflow artifact', () => {
    const ci = readFileSync(join(repository, '.github', 'workflows', 'ci.yml'), 'utf8');
    const steps = ['run: npm run verify', 'run: npm run qualify:release', 'scripts/acceptance-evidence.mjs'].map(
      (step) => ci.indexOf(step),
    );

    expect(steps.some((position) => position < 0)).toBe(false);
    expect([...steps].sort((left, right) => left - right)).toEqual(steps);
    expect(ci).toContain('uses: actions/upload-artifact@');
    expect(ci).toMatch(/name: acceptance-implementation-\$\{\{ github\.run_id }}-\$\{\{ github\.run_attempt }}/);
    expect(ci).toContain('if-no-files-found: error');
    expect(ci, 'the declaration and the record are written outside the checkout it measures').not.toMatch(
      /acceptance-evidence\.mjs[^\n]*--out \.?\//,
    );
  });
});
