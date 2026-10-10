import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { run } from '../src/cli.js';

const PETSTORE_SPEC = path.resolve(import.meta.dirname, '../../../examples/petstore/openapi.yaml');

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sdkgen-cli-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function sdkgen(cwd: string, ...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd,
    color: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('sdkgen CLI', () => {
  it('prints its version and help', async () => {
    const dir = await tempDir();
    expect(await sdkgen(dir, '--version')).toMatchObject({ code: 0, stdout: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(await sdkgen(dir, '--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('generate|gen') });
  });

  it('fails on unknown commands', async () => {
    const result = await sdkgen(await tempDir(), 'frobnicate');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });

  describe('init', () => {
    it('creates a config pointing at a detected spec', async () => {
      const dir = await tempDir();
      await writeFile(path.join(dir, 'openapi.json'), '{}');
      const result = await sdkgen(dir, 'init');
      expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('Detected spec ./openapi.json') });
      expect(await readFile(path.join(dir, '.sdkgenrc.yml'), 'utf8')).toContain('input: ./openapi.json');
    });

    it('warns when no spec is found, and honours --input/--output', async () => {
      const dir = await tempDir();
      expect((await sdkgen(dir, 'init')).stdout).toContain('No OpenAPI file found');
      await sdkgen(dir, 'init', '--force', '-i', 'specs/my api.yaml', '-o', 'client');
      const config = await readFile(path.join(dir, '.sdkgenrc.yml'), 'utf8');
      expect(config).toContain('input: "specs/my api.yaml"');
      expect(config).toContain('output: client');
    });

    it('refuses to overwrite an existing config without --force', async () => {
      const dir = await tempDir();
      await sdkgen(dir, 'init');
      const result = await sdkgen(dir, 'init');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('.sdkgenrc.yml already exists');
      expect(result.stderr).toContain('--force');
    });
  });

  describe('generate', () => {
    async function project(): Promise<string> {
      const dir = await tempDir();
      await copyFile(PETSTORE_SPEC, path.join(dir, 'openapi.yaml'));
      await sdkgen(dir, 'init');
      return dir;
    }

    it('generates the SDK and reports what changed', async () => {
      const dir = await project();
      const result = await sdkgen(dir, 'generate');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Loaded Swagger Petstore 1.0.0 (OpenAPI 3.0.3): 11 operations, 8 schemas');
      expect(result.stdout).toContain('+ generated/api/pets.ts');
      expect(result.stdout).toContain('SDK written to sdk');
      expect(await readFile(path.join(dir, 'sdk/client.ts'), 'utf8')).toContain('export class SwaggerPetstoreClient extends GeneratedClient');
    });

    it('--check passes when up to date and fails after the spec changes', async () => {
      const dir = await project();
      await sdkgen(dir, 'generate');
      expect(await sdkgen(dir, 'generate', '--check')).toMatchObject({ code: 0, stdout: expect.stringContaining('SDK is up to date') });

      const spec = path.join(dir, 'openapi.yaml');
      await writeFile(spec, (await readFile(spec, 'utf8')).replace('summary: List all pets', 'summary: List pets'));
      const result = await sdkgen(dir, 'generate', '--check');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('~ generated/api/pets.ts');
      expect(result.stderr).toContain('~ .sdkgen/spec.json');
    });

    it('--dry-run shows changes without writing', async () => {
      const dir = await project();
      const result = await sdkgen(dir, 'gen', '--dry-run');
      expect(result.stdout).toContain('+ generated/models.ts');
      expect(result.stdout).toContain('Dry run: nothing was written');
      await expect(readFile(path.join(dir, 'sdk/generated/models.ts'))).rejects.toThrow();
    });

    it('works without a config file when given --input', async () => {
      const dir = await tempDir();
      await copyFile(PETSTORE_SPEC, path.join(dir, 'api.yaml'));
      expect((await sdkgen(dir, 'generate', '-i', 'api.yaml', '-o', 'out')).code).toBe(0);
      await expect(readFile(path.join(dir, 'out/generated/index.ts'), 'utf8')).resolves.toContain("export * from './client.js';");
    });

    it('explains a missing config', async () => {
      const result = await sdkgen(await tempDir(), 'generate');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No sdkgen config file found');
      expect(result.stderr).toContain('Hint: Run `sdkgen init`');
    });

    it('explains a missing spec', async () => {
      const result = await sdkgen(await tempDir(), 'generate', '-i', 'nope.yaml');
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/OpenAPI spec not found: .*nope\.yaml/);
    });

    it('lists the offending files on a conflict, and --force overwrites them', async () => {
      const dir = await project();
      await sdkgen(dir, 'generate');
      const models = path.join(dir, 'sdk/generated/models.ts');
      await writeFile(models, '// edited\n');
      const result = await sdkgen(dir, 'generate');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('generated/models.ts (edited since the last generation)');
      expect((await sdkgen(dir, 'generate', '--force')).code).toBe(0);
      expect(await readFile(models, 'utf8')).not.toBe('// edited\n');
    });

    it('runs relative to --cwd', async () => {
      const dir = await project();
      const parent = path.dirname(dir);
      const result = await sdkgen(parent, '--cwd', path.basename(dir), 'generate');
      expect(result.code).toBe(0);
    });
  });
});
