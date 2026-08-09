import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PackResult {
  filename: string;
}

describe('packed plugin', () => {
  it('imports its declared runtime entry point', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'homebridge-eufy-security-'));
    const repository = fileURLToPath(new URL('../..', import.meta.url));

    try {
      const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
        cwd: repository,
        encoding: 'utf8',
      });
      const [result] = JSON.parse(output) as PackResult[];
      execFileSync('tar', ['-xzf', join(directory, result.filename), '-C', directory]);

      const entryPoint = pathToFileURL(join(directory, 'package', 'dist', 'index.js'));
      const plugin = (await import(entryPoint.href)) as { default: unknown };

      expect(plugin.default).toBeTypeOf('function');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
