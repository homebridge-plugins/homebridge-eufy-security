import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../..');
const sourceRoot = resolve(repository, 'src');
const internalDirectories = new Set(['account', 'device', 'homekit', 'media', 'runtime', 'ui']);
const forbiddenDirectories = new Set(['common', 'contracts', 'shared', 'utils']);
const allowedDependencies: Readonly<Record<string, ReadonlySet<string>>> = {
  account: new Set(['account', 'configuration', 'device']),
  configuration: new Set(['settings']),
  device: new Set(['device']),
  diagnostics: new Set(),
  homekit: new Set(['device', 'homekit']),
  index: new Set(['platform', 'settings']),
  media: new Set(['configuration', 'device', 'media']),
  platform: new Set(['configuration', 'device', 'diagnostics', 'homekit', 'media', 'runtime', 'settings', 'storage']),
  runtime: new Set(['account', 'configuration', 'device', 'diagnostics', 'runtime']),
  settings: new Set(),
  storage: new Set(['account']),
  ui: new Set(['account', 'configuration', 'device', 'diagnostics', 'homekit', 'media', 'runtime', 'storage', 'ui']),
  version: new Set(),
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function sourceName(path: string): string {
  return relative(sourceRoot, path).split(sep).join('/');
}

function moduleName(path: string): string {
  const [first] = sourceName(path).split('/');
  return internalDirectories.has(first) ? first : first.replace(/\.ts$/, '');
}

function relativeTarget(source: string, specifier: string): string {
  return resolve(dirname(source), specifier.replace(/\.js$/, '.ts'));
}

interface ImportReference {
  specifier: string;
  dynamic: boolean;
  statement: string;
}

function imports(path: string): ImportReference[] {
  const document = readFileSync(path, 'utf8');
  const references: ImportReference[] = [];
  const staticImports = /\b(?:import|export)\s+(?!\()([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;/g;
  const sideEffectImports = /\bimport\s+(['"])([^'"]+)\1\s*;/g;
  const dynamicImports = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const match of document.matchAll(staticImports)) {
    references.push({ specifier: match[3], dynamic: false, statement: match[0] });
  }
  for (const match of document.matchAll(sideEffectImports)) {
    references.push({ specifier: match[2], dynamic: false, statement: match[0] });
  }
  for (const match of document.matchAll(dynamicImports)) {
    references.push({ specifier: match[2], dynamic: true, statement: match[0] });
  }
  return references;
}

function importedValue(reference: ImportReference, name: string): boolean {
  if (reference.dynamic || /^import\s+type\b/.test(reference.statement)) {
    return false;
  }
  const valueClause = reference.statement.replace(new RegExp(`\\btype\\s+${name}\\b`), '');
  return new RegExp(`\\b${name}\\b`).test(valueClause);
}

function isHomeKitMediaContractReference(source: string, target: string, reference: ImportReference): boolean {
  return (
    moduleName(source) === 'homekit' &&
    sourceName(target) === 'media/contracts.ts' &&
    !reference.dynamic &&
    /^(?:import|export)\s+type\b/.test(reference.statement)
  );
}

describe('source architecture', () => {
  const files = sourceFiles(sourceRoot);

  /**
   * `CODING_STANDARDS.md` holds the rules and `AGENTS.md` is a symlink to it.
   *
   * One file rather than two copies, so the rules an AI coding tool loads under the name it looks for cannot
   * differ from the rules a contributor reads.
   */
  it('serves human and agent coding rules from one file', () => {
    expect(lstatSync(resolve(repository, 'CODING_STANDARDS.md')).isFile()).toBe(true);
    expect(lstatSync(resolve(repository, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(resolve(repository, 'AGENTS.md'))).toBe('CODING_STANDARDS.md');
    expect(readFileSync(resolve(repository, 'AGENTS.md'), 'utf8')).toBe(
      readFileSync(resolve(repository, 'CODING_STANDARDS.md'), 'utf8'),
    );
  });

  it('keeps a closed set of domain modules without generic sharing buckets', () => {
    const directories = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories.filter((directory) => forbiddenDirectories.has(directory))).toEqual([]);
    expect(directories.filter((directory) => !internalDirectories.has(directory))).toEqual([]);
    expect(files.filter((file) => sourceName(file).includes('/') && sourceName(file).endsWith('/index.ts'))).toEqual(
      [],
    );
  });

  it('enforces the dependency direction and explicit ESM specifiers', () => {
    const violations: string[] = [];
    for (const file of files) {
      const sourceModule = moduleName(file);
      for (const reference of imports(file)) {
        if (!reference.specifier.startsWith('.')) {
          continue;
        }
        if (!reference.specifier.endsWith('.js')) {
          violations.push(`${sourceName(file)} uses relative import ${reference.specifier} without .js`);
          continue;
        }
        const target = relativeTarget(file, reference.specifier);
        const targetModule = moduleName(target);
        if (
          !allowedDependencies[sourceModule]?.has(targetModule) &&
          !isHomeKitMediaContractReference(file, target, reference)
        ) {
          violations.push(`${sourceName(file)} (${sourceModule}) imports ${sourceName(target)} (${targetModule})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('limits HomeKit media references to the type-only contract seam', () => {
    const violations: string[] = [];
    for (const file of files.filter((candidate) => moduleName(candidate) === 'homekit')) {
      for (const reference of imports(file)) {
        if (!reference.specifier.startsWith('.')) {
          continue;
        }
        const target = relativeTarget(file, reference.specifier);
        if (moduleName(target) === 'media' && !isHomeKitMediaContractReference(file, target, reference)) {
          violations.push(`${sourceName(file)} references ${sourceName(target)} through ${reference.statement}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('defines every canonical media contract only at its owning seam', () => {
    const contracts = resolve(sourceRoot, 'media/contracts.ts');
    const declarations = [...readFileSync(contracts, 'utf8').matchAll(/^export (?:interface|type) (\w+)/gm)].map(
      (match) => match[1],
    );
    const duplicates = files
      .filter((file) => file !== contracts)
      .flatMap((file) =>
        declarations
          .filter((name) =>
            new RegExp(`^(?:export\\s+)?(?:interface|type)\\s+${name}\\b`, 'm').test(readFileSync(file, 'utf8')),
          )
          .map((name) => `${name} in ${sourceName(file)}`),
      );

    expect(duplicates).toEqual([]);
  });

  it('performs no synchronous filesystem work on a media path', () => {
    const synchronous =
      /\b(?:access|appendFile|chmod|chown|copyFile|cp|lstat|mkdir|mkdtemp|open|opendir|read|readdir|readFile|readlink|realpath|rename|rm|rmdir|stat|symlink|truncate|unlink|utimes|write|writeFile)Sync\b/g;
    const violations = files
      .filter((file) => moduleName(file) === 'media')
      .flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(synchronous)].map((match) => `${sourceName(file)} calls ${match[0]}`),
      );

    expect(violations).toEqual([]);
  });

  it('has no internal import cycles', () => {
    const graph = new Map<string, string[]>();
    for (const file of files) {
      graph.set(
        file,
        imports(file)
          .filter((reference) => reference.specifier.startsWith('.'))
          .map((reference) => relativeTarget(file, reference.specifier))
          .filter((target) => files.includes(target)),
      );
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];
    const visit = (file: string, path: string[]): void => {
      if (visiting.has(file)) {
        cycles.push([...path.slice(path.indexOf(file)), file].map(sourceName).join(' -> '));
        return;
      }
      if (visited.has(file)) {
        return;
      }
      visiting.add(file);
      for (const target of graph.get(file) ?? []) {
        visit(target, [...path, file]);
      }
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of files) {
      visit(file, []);
    }
    expect(cycles).toEqual([]);
  });

  it('uses only the public SDK surface and limits concrete client ownership', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const reference of imports(file)) {
        if (reference.specifier.startsWith('@mega-yfue/eufy-sdk/')) {
          violations.push(`${sourceName(file)} imports private SDK path ${reference.specifier}`);
        }
        if (reference.specifier !== '@mega-yfue/eufy-sdk') {
          continue;
        }
        if (reference.dynamic && sourceName(file) !== 'runtime/sdk-client.ts') {
          violations.push(`${sourceName(file)} dynamically imports the SDK`);
        }
        if (importedValue(reference, 'EufyMega') && sourceName(file) !== 'ui/server.ts') {
          violations.push(`${sourceName(file)} imports the concrete EufyMega value`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
