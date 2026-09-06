import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? join(repository, '..', 'eufy-sdk', 'docs', 'public', 'devices'));
const destination = resolve(process.argv[3] ?? join(repository, 'homebridge-ui', 'public', 'assets', 'devices'));
const families = new Set(['security', 'life', 'clean', 'mower']);
const entries = [];

for (const family of readdirSync(source, { withFileTypes: true })) {
  if (!family.isDirectory() || !families.has(family.name)) {
    throw new TypeError(`unexpected device artwork family: ${family.name}`);
  }
  const sourceDirectory = join(source, family.name);
  let familyCount = 0;
  for (const file of readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.webp')) {
      throw new TypeError(`unexpected device artwork entry: ${family.name}/${file.name}`);
    }
    familyCount++;
    entries.push({ family: family.name, file: file.name });
  }
  if (familyCount === 0) {
    throw new TypeError(`device artwork family is empty: ${family.name}`);
  }
}

if (new Set(entries.map(({ family }) => family)).size !== families.size) {
  throw new TypeError('device artwork source does not contain every required family');
}

const temporary = `${destination}.${process.pid}.tmp`;
const backup = `${destination}.${process.pid}.backup`;
rmSync(temporary, { force: true, recursive: true });
rmSync(backup, { force: true, recursive: true });
for (const entry of entries) {
  const directory = join(temporary, entry.family);
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(source, entry.family, entry.file), join(directory, entry.file));
}

if (existsSync(destination)) {
  renameSync(destination, backup);
}
try {
  renameSync(temporary, destination);
  rmSync(backup, { force: true, recursive: true });
} catch (error) {
  if (existsSync(backup)) {
    renameSync(backup, destination);
  }
  rmSync(temporary, { force: true, recursive: true });
  throw error;
}
process.stdout.write(`Synchronized ${entries.length} device images from ${source}\n`);
