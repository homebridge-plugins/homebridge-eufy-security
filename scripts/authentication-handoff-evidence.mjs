/**
 * Live authentication-handoff qualification evidence (issue #1024).
 *
 * Collects the observable, redacted evidence for one dedicated-guest-account handoff from temporary
 * custom-UI authentication to the long-lived Homebridge runtime. Each check is a discrete subcommand so
 * `scripts/qualify-authentication-handoff.sh` can run it at the right point in the human procedure.
 *
 * `npm run verify` cannot contain these checks. They require a real Eufy account, an interactive captcha
 * or two-factor challenge, and a real Homebridge process holding a real ownership lease. The hermetic
 * halves are covered by `test/contracts/temporary-authentication.test.ts`,
 * `test/contracts/account-ownership.test.ts`, `test/contracts/runtime-owner.test.ts`, and
 * `test/contracts/runtime-tracker.test.ts`.
 *
 * This script never prints a credential, challenge answer, session token, account address, device
 * serial, or device name, and never prints a digest or length of one either, because its output is
 * assembled into a report intended for a public issue. Ownership tokens and lease scopes are reported
 * only as truncated digests, which identify nothing outside this storage root.
 *
 * It imports the real ownership implementation from `dist/`, so run `npm run build` first. Reusing the
 * shipped algorithm is the point: a reimplementation would not qualify the lease the plugin actually
 * takes.
 *
 * Usage:
 *   node scripts/authentication-handoff-evidence.mjs sinks       --storage <root> [--ui-log <path>]
 *   node scripts/authentication-handoff-evidence.mjs ownership   --storage <root> [--expect-kind runtime|none]
 *   node scripts/authentication-handoff-evidence.mjs acquisition --storage <root> --since <iso>
 *   node scripts/authentication-handoff-evidence.mjs conflict    --storage <root>
 *
 * Every subcommand exits non-zero when its acceptance criterion is not met, so the wizard can gate on
 * it, and every check fails closed when the evidence it needs is absent. `conflict` is the only
 * subcommand that writes: it takes and releases one bakery-guard record under
 * `ownership/<hashed>/operations/`, and it must never displace a live lease. It derives the ownership
 * scope from the published active-generation record rather than asking for an account address.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { AccountOwnership, isOwnerProcessAlive } from '../dist/account/ownership.js';

/** Persisted configuration fields that are credentials. Their values are never printed or digested. */
const SECRET_FIELDS = new Set(['password']);

/** Persisted configuration fields that identify the account holder. Also never printed. */
const IDENTITY_FIELDS = new Set(['username']);

/** Field names that must never appear in advisory runtime evidence or plugin logs. */
const FORBIDDEN_FIELD = /pass|cred|captcha|answer|cookie|secret|bearer|token/i;

/** Log field names that match FORBIDDEN_FIELD only incidentally and carry no identity. */
const ALLOWED_FIELD_EXCEPTIONS = new Set([]);

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'usage: authentication-handoff-evidence.mjs <sinks|ownership|acquisition|conflict> --storage <root>\n',
  );
  process.exit(2);
}

function parseArguments(argv) {
  const options = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) {
      usage(`unexpected argument ${flag}`);
    }
    options[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

function fail(message) {
  process.stdout.write(`FAIL ${message}\n`);
  process.exitCode = 1;
}

function pass(message) {
  process.stdout.write(`PASS ${message}\n`);
}

function info(message) {
  process.stdout.write(`     ${message}\n`);
}

/** Walks the storage root, reporting paths with account-derived names reduced to shapes. */
function walk(root, directory = root, into = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const stats = statSync(full);
    into.push({
      path: full.slice(root.length + 1),
      directory: entry.isDirectory(),
      mode: stats.mode & 0o777,
      size: stats.size,
    });
    if (entry.isDirectory()) {
      walk(root, full, into);
    }
  }
  return into;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function collectFieldNames(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFieldNames(item, into);
    }
  } else if (value && typeof value === 'object') {
    for (const [name, nested] of Object.entries(value)) {
      into.add(name);
      collectFieldNames(nested, into);
    }
  }
  return into;
}

function readText(path) {
  try {
    return path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Acceptance criterion 1: no credential or challenge answer reaches persisted state or the logs.
 *
 * Probes only the fields that are actually sensitive: the account password, which the runtime process
 * deliberately persists so it can rebuild its SDK client, and the account address, which the published
 * active-generation record deliberately names. Neither value, its digest, nor its length is ever
 * printed, because this output is written into a report intended for a public issue.
 *
 * A captcha or two-factor answer is persisted nowhere by design, so there is nothing to probe for it.
 * That half of the criterion is a human read of the logs, which `--ui-log` includes here.
 */
function auditSinks(root, uiLog) {
  const tree = walk(root);
  if (tree.length === 0) {
    fail('the storage root is empty; nothing has been persisted yet');
    return;
  }

  const wrongMode = tree.filter((node) => (node.directory ? node.mode !== 0o700 : node.mode !== 0o600));
  if (wrongMode.length === 0) {
    pass(`storage root is owner-only across ${tree.length} entries`);
  } else {
    fail(`${wrongMode.length} storage entries are not owner-only`);
    for (const node of wrongMode) {
      info(`${node.mode.toString(8)} ${node.path.replace(/[0-9a-f]{16,}/g, '<hashed>')}`);
    }
  }

  const secrets = new Map();
  for (const node of tree) {
    if (node.directory || !node.path.endsWith('configuration.json')) {
      continue;
    }
    for (const [field, value] of Object.entries(readJson(join(root, node.path)) ?? {})) {
      if (typeof value === 'string' && (SECRET_FIELDS.has(field) || IDENTITY_FIELDS.has(field))) {
        secrets.set(value, field);
      }
    }
  }
  if (secrets.size === 0) {
    fail('no persisted account credential was found to probe; complete the login first');
    return;
  }
  info(`probing ${secrets.size} sensitive persisted value(s); values, digests, and lengths withheld`);
  for (const field of new Set(secrets.values())) {
    info(`  field=${field}`);
  }

  const probed = [...tree.filter((node) => !node.directory).map((node) => ({ label: node.path, path: join(root, node.path) }))];
  if (uiLog) {
    probed.push({ label: 'ui.log', path: uiLog });
  }

  let leaked = 0;
  let scanned = 0;
  for (const candidate of probed) {
    if (candidate.label.endsWith('configuration.json') || !/\.(json|jsonl|gz|log)$/.test(candidate.label)) {
      continue;
    }
    const text = readText(candidate.path);
    if (text === null) {
      continue;
    }
    scanned += 1;
    const label = candidate.label.replace(/[0-9a-f-]{36}/g, '<uuid>').replace(/[0-9a-f]{16,}/g, '<hashed>');
    for (const [value, field] of secrets) {
      if (!text.includes(value)) {
        continue;
      }
      if (IDENTITY_FIELDS.has(field) && candidate.label === join('accounts', 'active.json')) {
        info(`${label} names the active account by design`);
        continue;
      }
      leaked += 1;
      fail(`${label} contains the persisted ${field} verbatim`);
    }
  }
  if (scanned === 0) {
    fail('no candidate sink was scanned; the storage root looks incomplete');
  } else if (leaked === 0) {
    pass(`no credential or account address appears outside its declared sink across ${scanned} file(s)`);
  }

  const tracker = readJson(join(root, 'tracker.json'));
  if (!tracker) {
    fail('tracker.json is missing or unreadable; start the runtime first');
  } else {
    const offending = [...collectFieldNames(tracker)].filter(
      (name) => FORBIDDEN_FIELD.test(name) && !ALLOWED_FIELD_EXCEPTIONS.has(name),
    );
    if (offending.length === 0) {
      pass('advisory runtime evidence declares no credential-bearing field');
    } else {
      fail(`tracker.json declares credential-bearing field(s): ${offending.join(',')}`);
    }
  }

  const logs = tree.filter((node) => !node.directory && node.path.startsWith('logs/'));
  if (logs.length === 0) {
    fail('no plugin log was found; the runtime has not written its JSONL log yet');
  }
  for (const node of logs) {
    const fields = new Set();
    let records = 0;
    let malformed = 0;
    for (const line of readText(join(root, node.path)).split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      records += 1;
      try {
        collectFieldNames(JSON.parse(line), fields);
      } catch {
        malformed += 1;
      }
    }
    const offending = [...fields].filter(
      (name) => FORBIDDEN_FIELD.test(name) && !ALLOWED_FIELD_EXCEPTIONS.has(name),
    );
    if (malformed > 0) {
      info(`${node.path} has ${malformed} unparsable record(s), which were not field-checked`);
    }
    if (offending.length === 0) {
      pass(`${node.path} declares no credential-bearing field across ${records} records`);
    } else {
      fail(`${node.path} declares credential-bearing field(s): ${offending.join(',')}`);
    }
  }
}

/**
 * Reports ownership leases without acquiring one, so both the temporary flow and the restart can be
 * observed. `--expect-kind none` requires that a lease was once taken in this root and then released,
 * because an ownership directory that never existed proves nothing about release.
 */
function reportOwnership(root, expectedKind) {
  const ownership = join(root, 'ownership');
  let scopes;
  try {
    scopes = readdirSync(ownership, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    scopes = undefined;
  }
  if (scopes === undefined || scopes.length === 0) {
    if (expectedKind === undefined) {
      info('no ownership scope exists yet');
      return [];
    }
    fail('no ownership scope exists; no lease has ever been taken in this storage root');
    return [];
  }

  const live = [];
  let retained = 0;
  for (const scope of scopes) {
    const record = readJson(join(ownership, scope.name, 'owner.json'));
    if (record) {
      retained += 1;
      if (isOwnerProcessAlive(record)) {
        live.push({ scope: scope.name.slice(0, 12), kind: record.kind, pid: record.pid, token: digest(record.token) });
      } else {
        info(`scope ${scope.name.slice(0, 12)} retains a lease whose owner process is gone`);
      }
    }
    const orphaned = (readdirSync(join(ownership, scope.name, 'operations')) ?? []).filter((name) =>
      name.endsWith('.tmp'),
    );
    if (orphaned.length > 0) {
      info(`scope ${scope.name.slice(0, 12)} retains ${orphaned.length} guard temp file(s) leaked by an earlier hard kill`);
    }
  }

  for (const owner of live) {
    info(`live lease scope=${owner.scope} kind=${owner.kind} pid=${owner.pid} token=sha256:${owner.token}`);
  }

  if (expectedKind === 'none') {
    if (retained === 0) {
      pass(`ownership was released across ${scopes.length} scope(s); no lease record remains`);
    } else {
      fail(`${retained} lease record(s) remain after release, ${live.length} of them still live`);
    }
    return live;
  }
  if (expectedKind === undefined) {
    return live;
  }
  const matching = live.filter((owner) => owner.kind === expectedKind);
  if (matching.length === 1) {
    pass(`exactly one live ${expectedKind} lease is held`);
  } else {
    fail(`found ${matching.length} live ${expectedKind} lease(s); expected exactly one`);
  }
  return live;
}

/**
 * Acceptance criterion 2: a restart acquires the persisted session exactly once and publishes a
 * complete observation-only snapshot without another interactive login.
 *
 * "Exactly once" is counted from the SDK's own `session-restored` event, which the plugin emits when it
 * rebuilds its client from persisted state rather than authenticating again.
 */
function auditAcquisition(root, since) {
  const boundary = Date.parse(since ?? '');
  if (!Number.isFinite(boundary)) {
    usage('acquisition requires --since <iso timestamp of the restart>');
  }

  const text = readText(join(root, 'logs', 'homebridge-eufy.jsonl'));
  if (text === null) {
    fail('the plugin JSONL log is missing; the runtime never started');
    return;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (Date.parse(record.timestamp ?? '') >= boundary) {
        records.push(record);
      }
    } catch {
      continue;
    }
  }
  info(`inspecting ${records.length} plugin log record(s) since ${since}`);
  if (records.length === 0) {
    fail('the plugin logged nothing after the restart');
    return;
  }

  const states = records
    .filter((record) => record.scope === 'runtime' && record.messageKey === 'log.runtime.state')
    .map((record) => record.event);
  info(`runtime states: ${states.join(' -> ') || 'none logged'}`);

  const restored = records.filter((record) => record.scope === 'sdk' && record.event === 'session-restored').length;
  if (restored === 1) {
    pass('the persisted session was restored exactly once');
  } else {
    fail(`the persisted session was restored ${restored} time(s); expected exactly once`);
  }

  const ready = states.filter((state) => state === 'ready').length;
  if (ready === 1) {
    pass('the runtime reached ready exactly once');
  } else {
    fail(`the runtime reached ready ${ready} time(s); expected exactly once`);
  }

  const active = (code) =>
    records.filter((record) => record.scope === 'diagnostic-condition' && record.code === code && record.active === true);

  const conflicts = active('runtime-owner-conflict');
  if (conflicts.length === 0) {
    pass('the restarted runtime reported no ownership conflict');
  } else {
    fail(`${conflicts.length} ownership conflict(s) were reported after restart`);
  }

  const reauthentication = active('runtime-authentication-required');
  if (reauthentication.length === 0) {
    pass('the restarted runtime never requested another interactive login');
  } else {
    fail(`${reauthentication.length} authentication-required condition(s) were reported after restart`);
  }

  const tracker = readJson(join(root, 'tracker.json'));
  const devices = tracker?.snapshot?.devices;
  if (tracker?.state === 'ready' && tracker.complete === true && Array.isArray(devices) && devices.length > 0) {
    pass(`runtime published a complete snapshot of ${devices.length} device(s)`);
    info(`status=${tracker.status} generation is present: ${typeof tracker.generation === 'string'}`);
  } else {
    fail(
      `runtime did not publish a complete snapshot (state=${tracker?.state} complete=${tracker?.complete} devices=${Array.isArray(devices) ? devices.length : 'none'})`,
    );
  }
}

/**
 * Acceptance criterion 3: a concurrent second owner is refused without stealing the live lease.
 *
 * Attempts a real acquisition against the live storage root from this separate process, then verifies
 * the incumbent lease token and owner process are unchanged and the runtime is still publishing fresh
 * ready evidence. It must target the live root rather than a copy, because a copy holds no live lease
 * and so cannot demonstrate refusal at all. It constructs no SDK client and performs no device or
 * session write; the only state it touches is one bakery-guard record it releases before returning.
 */
async function probeConflict(root) {
  const before = reportOwnership(root, undefined);
  const incumbent = before.find((owner) => owner.kind === 'runtime');
  if (!incumbent) {
    fail('no live runtime lease is held; start the runtime before probing for a conflict');
    return;
  }
  const trackerBefore = readJson(join(root, 'tracker.json'));

  const active = readJson(join(root, 'accounts', 'active.json'));
  const scope = typeof active?.account === 'string' ? active.account.trim().toLowerCase() : undefined;
  if (!scope) {
    fail('no active account is published; complete the login and restart before probing for a conflict');
    return;
  }
  if (createHash('sha256').update(scope).digest('hex').slice(0, 12) !== incumbent.scope) {
    fail('the published active account does not hash to the scope holding the live lease');
    return;
  }

  const ownership = new AccountOwnership(join(root, 'ownership'));
  const result = await ownership.acquire(scope, 'runtime');
  if (result.state !== 'owner-conflict') {
    fail('a concurrent second owner acquired the lease; the live owner was stolen');
    await result.lease.release();
    return;
  }
  pass('a concurrent second owner was refused');
  info(`refusal evidence kind=${result.owner.kind} pid=${result.owner.pid} acquiredAt=${result.owner.acquiredAt}`);
  const exposed = Object.keys(result.owner).sort().join(',');
  if (exposed === 'acquiredAt,kind,pid') {
    pass('refusal evidence exposes only bounded owner facts');
  } else {
    fail(`refusal evidence exposed unexpected fields: ${exposed}`);
  }

  const after = reportOwnership(root, undefined).find((owner) => owner.kind === 'runtime');
  if (after?.token === incumbent.token && after.pid === incumbent.pid) {
    pass('the incumbent lease token and owner process are unchanged');
  } else {
    fail('the incumbent lease was displaced by the refused acquisition');
  }

  const trackerAfter = readJson(join(root, 'tracker.json'));
  const age = Date.now() - Date.parse(trackerAfter?.updatedAt ?? '');
  if (trackerAfter?.state === 'ready' && trackerBefore?.state === 'ready' && Number.isFinite(age) && age < 120_000) {
    pass(`advisory runtime evidence still reports a ready runtime, refreshed ${Math.round(age / 1000)}s ago`);
  } else {
    fail(
      `advisory runtime evidence is not fresh and ready (before=${trackerBefore?.state} after=${trackerAfter?.state} age=${Number.isFinite(age) ? `${Math.round(age / 1000)}s` : 'unknown'})`,
    );
  }
}

const options = parseArguments(process.argv.slice(2));
if (!options.storage) {
  usage('--storage <root> is required');
}

switch (options.command) {
  case 'sinks':
    auditSinks(options.storage, options['ui-log']);
    break;
  case 'ownership':
    reportOwnership(options.storage, options['expect-kind']);
    break;
  case 'acquisition':
    auditAcquisition(options.storage, options.since);
    break;
  case 'conflict':
    await probeConflict(options.storage);
    break;
  default:
    usage(`unknown command ${options.command}`);
}
