/**
 * Cumulative acceptance evidence for one immutable artifact (issue #1014).
 *
 * Produces the machine-readable acceptance record and the human-readable summary that qualify one packed
 * plugin artifact at the implementation, private-pilot, or public-beta tier. The vocabulary is the acceptance
 * matrix defined in `CONTEXT.md`: a tier is claimed for one artifact only when every check that tier and every
 * tier below it require is recorded as passed.
 *
 * Facts about the artifact are measured here rather than declared: the packed identity and integrity npm
 * reports, the lockfile digest, the SDK specifier the manifest declares beside the version, integrity, and
 * source the lockfile resolves it to, the runtime versions, the compiled coverage matrix, and the digests of
 * the fixtures the migration contracts read. A declaration file supplies only what a
 * measurement cannot answer — the result of each required check, the known gaps, and the approver — and every
 * required check missing from it refuses the claim.
 *
 * A record is an immutable workflow artifact. It carries the workflow run that produced it, is refused
 * outside one, is refused for a checkout with uncommitted changes, and is written once: a second attempt for
 * the same tier in the same directory fails rather than replacing it. A higher tier accumulates the record of
 * the tier below it and refuses one that describes a different commit or a differently packed artifact.
 *
 * Usage:
 *   node scripts/acceptance-evidence.mjs --declare <declarations.json> --out <directory> [--base <prior.json>]
 *
 * It imports the compiled coverage matrix from `dist/`, so run `npm run build` first.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_HAP_COVERAGE_MATRIX } from '../dist/homekit/coverage-matrix.js';

export const ACCEPTANCE_SCHEMA = 'homebridge-eufy/acceptance-evidence/1';

const SDK = '@mega-yfue/eufy-sdk';

/**
 * The acceptance tiers, each with the tier it accumulates and the closed set of checks it requires.
 *
 * A check belongs to exactly one tier, so a declaration states a result without restating which tier needs it.
 * `approver` marks a tier that rests on human checks and therefore records who accepted them.
 */
export const TIERS = {
  implementation: {
    base: null,
    approver: false,
    checks: [
      'hermetic-verification',
      'package-inspection',
      'migration-identity-fixtures',
      'sdk-resolution',
      'coverage-matrix-completeness',
      'security-scan',
    ],
  },
  'private-pilot': {
    base: 'implementation',
    approver: true,
    checks: [
      'clean-install',
      'v4-upgrade',
      'restart',
      'rollback-rehearsal',
      'child-bridge-ownership',
      'fleet-projection-checks',
      'home-app-checks',
    ],
  },
  'public-beta': {
    base: 'private-pilot',
    approver: true,
    checks: ['public-sdk-distribution', 'anonymous-installation', 'publication-canaries', 'final-report'],
  },
};

const isText = (value) => typeof value === 'string' && value.length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isDigest = (value) => isText(value) && /^[0-9a-f]{64}$/.test(value);
const isCommit = (value) => isText(value) && /^[0-9a-f]{40}$/.test(value);
const isIntegrity = (value) => isText(value) && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value);
const isExactVersion = (value) => isText(value) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const isInstant = (value) => isText(value) && !Number.isNaN(Date.parse(value));

/** The tier chain up to and including `tier`, oldest first. */
function chain(tier) {
  const { base } = TIERS[tier];
  return base === null ? [tier] : [...chain(base), tier];
}

/** The tier a check belongs to, or undefined for a name no tier requires. */
function owningTier(check) {
  return Object.keys(TIERS).find((tier) => TIERS[tier].checks.includes(check));
}

/** Every field an acceptance record carries, with the predicate that decides whether it is recorded. */
const SHAPE = [
  ['schema', (value) => value === ACCEPTANCE_SCHEMA],
  ['tier', (value) => Object.hasOwn(TIERS, value)],
  ['generatedAt', isInstant],
  ['plugin.name', isText],
  ['plugin.version', isText],
  ['plugin.commit', isCommit],
  ['package.filename', isText],
  ['package.integrity', isIntegrity],
  ['package.entryCount', isCount],
  ['package.unpackedSize', isCount],
  ['package.lockfileSha256', isDigest],
  ['sdk.name', isText],
  ['sdk.declared', isExactVersion],
  ['sdk.version', isExactVersion],
  ['sdk.integrity', isIntegrity],
  ['sdk.resolved', isText],
  ['runtime.node', isText],
  ['runtime.npm', isText],
  ['runtime.homebridge', isText],
  ['matrix.version', isCount],
  ['matrix.hapContract', isText],
  ['matrix.rows', isCount],
  ['matrix.requiredAdapter', isCount],
  ['matrix.diagnosticOnly', isCount],
  ['matrix.blockedSdkGap', isCount],
  ['fixtures', (value) => isObject(value) && Object.values(value).every(isDigest)],
  ['workflow.repository', isText],
  ['workflow.workflow', isText],
  ['workflow.runId', isText],
  ['workflow.runAttempt', isText],
  ['workflow.commit', isCommit],
  ['accumulates', (value) => value === null || (isObject(value) && isText(value.tier) && isText(value.runId))],
  ['checks', (value) => Array.isArray(value) && value.every(isRecordedCheck)],
  ['knownGaps', (value) => Array.isArray(value) && value.every(isText)],
  ['approver', (value) => value === null || isText(value)],
];

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordedCheck(value) {
  return (
    isObject(value) && owningTier(value.check) === value.tier && value.status === 'pass' && isText(value.reference)
  );
}

function at(record, path) {
  return path
    .split('.')
    .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), record);
}

/**
 * The fields that make `record` something other than an acceptance record, as their paths.
 *
 * A prior-tier record arrives from a previous workflow run and is untrusted input, so a higher tier validates
 * it before accumulating it.
 */
export function invalidities(record) {
  return SHAPE.filter(([path, valid]) => !valid(at(record, path))).map(([path]) => path);
}

/** The workflow run identity of the current process, or null when it is not running in one. */
export function workflowIdentity(environment) {
  const identity = {
    repository: environment.GITHUB_REPOSITORY,
    workflow: environment.GITHUB_WORKFLOW,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    commit: environment.GITHUB_SHA,
  };
  return Object.values(identity).every(isText) ? identity : null;
}

/**
 * The reasons the declared tier cannot be claimed for the measured artifact. An empty result is the claim.
 */
export function refusals({ declarations, base = null, measured, workflow }) {
  const tier = isObject(declarations) ? declarations.tier : undefined;
  if (!Object.hasOwn(TIERS, tier)) {
    return [`"${tier}" is not an acceptance tier`];
  }

  const problems = [];
  if (workflow === null || workflow === undefined) {
    problems.push('the evidence was not produced by a workflow run, so it is not an immutable acceptance artifact');
  } else if (workflow.commit !== measured.plugin.commit) {
    problems.push(`the workflow ran at ${workflow.commit} while the checkout measured is ${measured.plugin.commit}`);
  }
  if (!measured.clean) {
    problems.push(
      'the working tree carries uncommitted changes, so the recorded commit does not describe the artifact',
    );
  }
  if (
    !isExactVersion(measured.sdk.version) ||
    measured.sdk.declared !== measured.sdk.version ||
    !isIntegrity(measured.sdk.integrity)
  ) {
    problems.push(
      `the SDK is declared as "${measured.sdk.declared}" and resolved as "${measured.sdk.version}", so one exact ` +
        'published identity with a sha512 integrity cannot be recorded',
    );
  }

  const expected = TIERS[tier].base;
  if (expected === null && base !== null) {
    problems.push(`${tier} is the first tier and accumulates nothing`);
  }
  if (expected !== null) {
    if (base === null) {
      problems.push(`${tier} accumulates ${expected} evidence for the same artifact, which was not supplied`);
    } else {
      problems.push(...invalidities(base).map((path) => `the ${expected} evidence supplied does not record ${path}`));
      if (base.tier !== expected) {
        problems.push(`${tier} accumulates ${expected} evidence, and the record supplied is ${base.tier}`);
      }
      if (at(base, 'plugin.commit') !== measured.plugin.commit) {
        problems.push(
          `the ${expected} evidence supplied describes commit ${at(base, 'plugin.commit')} rather than the ` +
            'artifact measured',
        );
      } else if (at(base, 'package.integrity') !== measured.package.integrity) {
        problems.push(`the ${expected} evidence supplied describes a differently packed artifact`);
      }
    }
  }

  const declared = new Set();
  for (const entry of Array.isArray(declarations.checks) ? declarations.checks : []) {
    if (!isObject(entry) || owningTier(entry.check) !== tier) {
      problems.push(`${isObject(entry) ? entry.check : entry} is not a check the ${tier} tier requires`);
      continue;
    }
    if (!isText(entry.reference)) {
      problems.push(`${entry.check} is declared without a reference to the evidence behind it`);
    }
    if (declared.has(entry.check)) {
      problems.push(`${entry.check} is declared more than once, so one result would silently replace another`);
    }
    declared.add(entry.check);
  }

  const passed = new Set(
    [...(base === null ? [] : (base.checks ?? [])), ...(declarations.checks ?? [])]
      .filter((entry) => isObject(entry) && entry.status === 'pass')
      .map((entry) => entry.check),
  );
  for (const claimed of chain(tier)) {
    for (const check of TIERS[claimed].checks) {
      if (!passed.has(check)) {
        problems.push(`${claimed} requires ${check}, which no supplied evidence records as passed`);
      }
    }
  }

  if (TIERS[tier].approver && !isText(declarations.approver)) {
    problems.push(`${tier} rests on human checks, so it records the maintainer who approved it`);
  }
  if (!Array.isArray(declarations.knownGaps)) {
    problems.push('the record states its known gaps explicitly, and none were declared');
  }

  return problems;
}

/**
 * The acceptance record for the declared tier, validated against the schema it declares. Throws with every
 * refusal when the tier cannot be claimed, and with every unrecorded field when a measurement is missing.
 */
export function evidenceRecord({ declarations, base = null, measured, workflow, generatedAt }) {
  const problems = refusals({ declarations, base, measured, workflow });
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }

  const record = {
    schema: ACCEPTANCE_SCHEMA,
    tier: declarations.tier,
    generatedAt,
    plugin: measured.plugin,
    package: measured.package,
    sdk: measured.sdk,
    runtime: measured.runtime,
    matrix: measured.matrix,
    fixtures: measured.fixtures,
    workflow,
    accumulates: base === null ? null : { tier: base.tier, runId: base.workflow.runId },
    checks: [
      ...(base === null ? [] : base.checks),
      ...declarations.checks.map(({ check, reference }) => ({
        check,
        tier: declarations.tier,
        status: 'pass',
        reference,
      })),
    ],
    knownGaps: declarations.knownGaps,
    approver: isText(declarations.approver) ? declarations.approver : null,
  };

  const unrecorded = invalidities(record);
  if (unrecorded.length > 0) {
    throw new Error(unrecorded.map((path) => `the record would not carry ${path}`).join('\n'));
  }

  return record;
}

const row = (label, value) => `| ${label} | ${value} |`;

/** The human-readable summary of one record, stating the same facts the record carries. */
export function renderSummary(record) {
  const { plugin, package: packed, sdk, runtime, matrix, workflow } = record;
  const accumulated = record.accumulates
    ? `, accumulating the ${record.accumulates.tier} record from run ${record.accumulates.runId}`
    : '';

  return [
    `# Acceptance evidence — ${record.tier}`,
    '',
    `Generated ${record.generatedAt} by ${workflow.repository} workflow ${workflow.workflow}, run ` +
      `${workflow.runId} attempt ${workflow.runAttempt} at commit ${workflow.commit}${accumulated}.`,
    '',
    '## Artifact',
    '',
    '| Fact | Value |',
    '| --- | --- |',
    row('Plugin', `${plugin.name} ${plugin.version}`),
    row('Commit', plugin.commit),
    row('Package', `${packed.filename} (${packed.entryCount} files, ${packed.unpackedSize} bytes unpacked)`),
    row('Package integrity', packed.integrity),
    row('Lockfile SHA-256', packed.lockfileSha256),
    row('SDK', `${sdk.name} ${sdk.version}, declared as ${sdk.declared}`),
    row('SDK resolution', sdk.resolved),
    row('SDK integrity', sdk.integrity),
    row('Node.js', runtime.node),
    row('npm', runtime.npm),
    row('Homebridge', runtime.homebridge),
    row('Coverage matrix', `version ${matrix.version} against ${matrix.hapContract}`),
    row(
      'Coverage rows',
      `${matrix.rows} rows: ${matrix.requiredAdapter} required adapter, ${matrix.diagnosticOnly} ` +
        `diagnostic-only, ${matrix.blockedSdkGap} blocked by an SDK gap`,
    ),
    ...Object.entries(record.fixtures).map(([name, digest]) => row(`Fixture ${name}`, digest)),
    '',
    '## Checks',
    '',
    '| Check | Tier | Result | Evidence |',
    '| --- | --- | --- | --- |',
    ...record.checks.map((entry) => `| ${entry.check} | ${entry.tier} | ${entry.status} | ${entry.reference} |`),
    '',
    '## Known gaps',
    '',
    ...(record.knownGaps.length === 0 ? ['None declared.'] : record.knownGaps.map((gap) => `- ${gap}`)),
    '',
    '## Approver',
    '',
    record.approver ?? 'Not required: every check this tier requires is automated.',
    '',
  ].join('\n');
}

/** The facts about the artifact this repository currently packs, measured rather than declared. */
export function measure(repository) {
  const git = (...argv) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8' }).trim();
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const lockfile = readFileSync(join(repository, 'package-lock.json'));
  const locked = JSON.parse(lockfile).packages?.[`node_modules/${SDK}`] ?? {};
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: repository, encoding: 'utf8' }),
  )[0];
  const fixtures = join(repository, 'test', 'fixtures');
  const disposition = (name) => SDK_HAP_COVERAGE_MATRIX.rows.filter((entry) => entry.disposition === name).length;

  return {
    clean: git('status', '--porcelain') === '',
    plugin: { name: manifest.name, version: manifest.version, commit: git('rev-parse', 'HEAD') },
    package: {
      filename: packed.filename,
      integrity: packed.integrity,
      entryCount: packed.entryCount,
      unpackedSize: packed.unpackedSize,
      lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    },
    sdk: {
      name: SDK,
      declared: manifest.dependencies?.[SDK],
      version: locked.version,
      integrity: locked.integrity,
      resolved: locked.resolved,
    },
    runtime: {
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      homebridge: JSON.parse(readFileSync(join(repository, 'node_modules', 'homebridge', 'package.json'), 'utf8'))
        .version,
    },
    matrix: {
      version: SDK_HAP_COVERAGE_MATRIX.version,
      hapContract: SDK_HAP_COVERAGE_MATRIX.hapContract,
      rows: SDK_HAP_COVERAGE_MATRIX.rows.length,
      requiredAdapter: disposition('required-adapter'),
      diagnosticOnly: disposition('diagnostic-only'),
      blockedSdkGap: disposition('blocked-sdk-gap'),
    },
    fixtures: Object.fromEntries(
      readdirSync(fixtures, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
        .map((path) => [
          path.slice(fixtures.length + 1),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ]),
    ),
  };
}

/** Writes the record and its summary, refusing to replace either. Returns the paths written. */
export function writeEvidence(directory, record) {
  const written = [];
  for (const [extension, content] of [
    ['json', `${JSON.stringify(record, null, 2)}\n`],
    ['md', renderSummary(record)],
  ]) {
    const path = join(directory, `acceptance-${record.tier}.${extension}`);
    writeFileSync(path, content, { flag: 'wx' });
    written.push(path);
  }
  return written;
}

if (import.meta.main) {
  const options = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    options[argv[index].replace(/^--/, '')] = argv[index + 1];
  }
  if (!options.declare || !options.out) {
    process.stderr.write('usage: acceptance-evidence.mjs --declare <file> --out <directory> [--base <file>]\n');
    process.exit(2);
  }

  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const declarations = JSON.parse(readFileSync(options.declare, 'utf8'));
  const base = options.base ? JSON.parse(readFileSync(options.base, 'utf8')) : null;
  const measured = measure(repository);
  const workflow = workflowIdentity(process.env);
  const problems = refusals({ declarations, base, measured, workflow });

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`acceptance-evidence — ${problem}\n`);
    }
    process.exit(1);
  }

  const written = writeEvidence(
    options.out,
    evidenceRecord({ declarations, base, measured, workflow, generatedAt: new Date().toISOString() }),
  );
  process.stdout.write(`acceptance-evidence — ${declarations.tier} recorded (${written.join(', ')})\n`);
}
