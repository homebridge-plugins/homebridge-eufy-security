/**
 * Release qualification: the checks that can only hold for a publishable tree.
 *
 * The contract suite runs on a working checkout, where the SDK is a link to the package being developed
 * beside this one. That link is exactly what must never be published, so the checks that refuse it live here
 * and run from `prepublishOnly` rather than from `npm run verify`.
 *
 * Real-device data is not detectable by shape. A device serial, a station identifier, and a P2P DID are
 * required to be synthetic *and correctly shaped*, so a pattern that matches a real one matches every fixture
 * too. What is scanned for instead is material that has no legitimate form in this repository at all: a
 * private key, a bearer token, a cloud credential, and a retained evidence artifact.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '@mega-yfue/eufy-sdk';
const PUBLISHABLE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TRUSTED_REGISTRIES = ['https://registry.npmjs.org/', 'https://npm.pkg.github.com/'];
const BINARY = /\.(?:webp|jpg|jpeg|png|gz|xcf|svg|ico|woff2?)$/i;
const SECRETS = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'bearer token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'cloud access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
];
/**
 * Retained evidence, matched on the path rather than the content.
 *
 * A support archive is encrypted and a rotated log is gzipped, so neither answers a pattern read out of its
 * bytes. What identifies them is where they are and what they are called.
 */
const EVIDENCE = /(?:\.eufysupport(?:\.gz)?|\.jsonl(?:\.\d+)?(?:\.gz)?)$/i;
const failures = [];

const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(join(repository, 'package-lock.json'), 'utf8'));
const declared = manifest.dependencies?.[SDK] ?? '';
const locked = lockfile.packages?.[`node_modules/${SDK}`] ?? {};

if (!PUBLISHABLE_VERSION.test(declared)) {
  failures.push(`${SDK} is declared as "${declared}", which is not one exact published version`);
}
if (locked.version !== declared) {
  failures.push(`the lockfile resolves ${SDK} to "${locked.version}" while the manifest declares "${declared}"`);
}
if (typeof locked.integrity !== 'string' || !locked.integrity.startsWith('sha512-')) {
  failures.push(`the lockfile carries no sha512 integrity for ${SDK}`);
}
if (!TRUSTED_REGISTRIES.some((registry) => (locked.resolved ?? '').startsWith(registry))) {
  failures.push(`the lockfile resolves ${SDK} from an unexpected source: ${locked.resolved}`);
}

try {
  const installed = join(repository, 'node_modules', ...SDK.split('/'));
  if (lstatSync(installed).isSymbolicLink()) {
    failures.push(`${SDK} is installed as a symbolic link, so the tree builds against an unpublished working copy`);
  } else {
    const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
    if (version !== declared) {
      failures.push(`the installed ${SDK} is ${version} while the manifest declares ${declared}`);
    }
  }
} catch {
  failures.push(`${SDK} is not installed, so its provenance cannot be qualified`);
}

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: repository, encoding: 'utf8' }),
)[0].files.map((file) => file.path);
const tracked = execFileSync('git', ['ls-files', 'src', 'test', 'scripts', 'docs', 'homebridge-ui', 'i18n'], {
  cwd: repository,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

for (const path of new Set([...packed, ...tracked])) {
  if (EVIDENCE.test(path)) {
    failures.push(`${path} is retained evidence`);
    continue;
  }
  if (BINARY.test(path)) {
    continue;
  }
  let content;
  try {
    content = readFileSync(join(repository, path), 'utf8');
  } catch {
    continue;
  }
  for (const { name, pattern } of SECRETS) {
    if (pattern.test(content)) {
      failures.push(`${path} carries a ${name}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`qualify:release — ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(`qualify:release — clean (${packed.length} packed files, ${tracked.length} tracked sources)\n`);
