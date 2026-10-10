import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { run } from '../src/cli.js';

const PETSTORE_SPEC = path.resolve(import.meta.dirname, '../../../examples/petstore/openapi.yaml');
const PETSTORE_NEXT = path.resolve(import.meta.dirname, '../../../examples/petstore/next');

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

  async function project(): Promise<string> {
    const dir = await tempDir();
    await copyFile(PETSTORE_SPEC, path.join(dir, 'openapi.yaml'));
    await sdkgen(dir, 'init');
    return dir;
  }

  async function editSpec(dir: string, from: string, to: string): Promise<void> {
    const spec = path.join(dir, 'openapi.yaml');
    await writeFile(spec, (await readFile(spec, 'utf8')).replace(from, to));
  }

  describe('generate', () => {
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

    it('lists the API changes it picked up since the last run', async () => {
      const dir = await project();
      expect((await sdkgen(dir, 'generate')).stdout).not.toContain('API changes');
      await editSpec(dir, 'version: 1.0.0', 'version: 1.1.0');
      await editSpec(dir, 'operationId: healthCheck', 'operationId: health');
      const result = await sdkgen(dir, 'generate');
      expect(result.stdout).toContain('API changes since the last generation (1.0.0 → 1.1.0): 1 non-breaking');
      expect(result.stdout).toContain('~ GET /health: operationId changed from `healthCheck` to `health`.');
    });

    it('runs relative to --cwd', async () => {
      const dir = await project();
      const parent = path.dirname(dir);
      const result = await sdkgen(parent, '--cwd', path.basename(dir), 'generate');
      expect(result.code).toBe(0);
    });
  });

  describe('diff', () => {
    async function generated(): Promise<string> {
      const dir = await project();
      await sdkgen(dir, 'generate');
      return dir;
    }

    it('needs a previous generation to compare against', async () => {
      const result = await sdkgen(await project(), 'diff');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No generated SDK found in sdk to compare against');
      expect(result.stderr).toContain('`sdkgen diff old.yaml new.yaml`');
    });

    it('lists changes since the last generation, and --fail-on-breaking gates on them', async () => {
      const dir = await generated();
      expect((await sdkgen(dir, 'diff')).stdout).toContain('No API changes (Swagger Petstore 1.0.0)');

      await editSpec(dir, 'enum: [available, pending, sold]', 'enum: [available, pending]');
      await editSpec(dir, 'operationId: healthCheck', 'operationId: health');
      const result = await sdkgen(dir, 'diff', '--fail-on-breaking');
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('Comparing sdk/.sdkgen/spec.json → openapi.yaml');
      expect(result.stdout).toContain('API changes in Swagger Petstore 1.0.0: 1 breaking, 1 non-breaking');
      expect(result.stdout).toContain('! schema PetStatus: Enum value `sold` was removed.');
      expect(result.stdout).toContain('~ GET /health: operationId changed from `healthCheck` to `health`.');
      expect(result.stderr).toContain('1 breaking change (--fail-on-breaking)');
      expect((await sdkgen(dir, 'diff')).code).toBe(0);
    });

    it('previews another spec against the SDK with --input, as JSON', async () => {
      const dir = await generated();
      const result = await sdkgen(dir, 'diff', '-i', path.join(PETSTORE_NEXT, 'openapi.yaml'), '--json');
      expect(result.code).toBe(0);
      const diff = JSON.parse(result.stdout) as { from: { version: string }; to: { version: string }; summary: object; changes: unknown[] };
      expect(diff).toMatchObject({ from: { version: '1.0.0' }, to: { version: '1.1.0' }, summary: { breaking: 5, nonBreaking: 7 } });
      expect(diff.changes[0]).toMatchObject({ kind: 'parameter-required', operation: 'GET /pets', breaking: true });
    });

    it('compares two files without a config', async () => {
      const dir = await tempDir();
      const result = await sdkgen(dir, 'diff', PETSTORE_SPEC, path.join(PETSTORE_NEXT, 'openapi.yaml'));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('API changes in Swagger Petstore 1.0.0 → 1.1.0: 5 breaking, 7 non-breaking');
    });
  });

  describe('changelog', () => {
    it('prints a Markdown changelog', async () => {
      const result = await sdkgen(await tempDir(), 'changelog', PETSTORE_SPEC, path.join(PETSTORE_NEXT, 'openapi.yaml'));
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toBe(await readFile(path.join(PETSTORE_NEXT, 'CHANGELOG.md'), 'utf8'));
    });

    it('writes JSON or Markdown to a file with --out', async () => {
      const dir = await tempDir();
      const next = path.join(PETSTORE_NEXT, 'openapi.yaml');
      const result = await sdkgen(dir, 'changelog', PETSTORE_SPEC, next, '--out', 'notes/api.md');
      expect(result.stdout).toContain('Wrote notes/api.md (5 breaking, 7 non-breaking)');
      expect(await readFile(path.join(dir, 'notes/api.md'), 'utf8')).toContain('## Swagger Petstore 1.0.0 → 1.1.0');

      await sdkgen(dir, 'changelog', PETSTORE_SPEC, next, '--json', '--out', 'api.json');
      expect(JSON.parse(await readFile(path.join(dir, 'api.json'), 'utf8'))).toMatchObject({ version: 1, summary: { breaking: 5 } });
    });
  });

  describe('eject', () => {
    it('copies the runtime into the project and shows how to use it', async () => {
      const dir = await project();
      const result = await sdkgen(dir, 'eject', 'runtime');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Copied the built-in runtime template to sdkgen/runtime.ts');
      expect(result.stdout).toContain('add this to .sdkgenrc.yml:\n  templates:\n    runtime: ./sdkgen/runtime.ts');
      expect(await readFile(path.join(dir, 'sdkgen/runtime.ts'), 'utf8')).toMatch(/^\/\/ Your copy of the sdkgen HTTP runtime.*fingerprint [0-9a-f]{12}/);

      const again = await sdkgen(dir, 'eject', 'runtime');
      expect(again.code).toBe(1);
      expect(again.stderr).toContain('sdkgen/runtime.ts already exists');
      expect((await sdkgen(dir, 'eject', 'runtime', '--force')).code).toBe(0);
    });

    it('writes to templates.runtime when the config sets it, and generate picks it up', async () => {
      const dir = await project();
      const config = path.join(dir, '.sdkgenrc.yml');
      await writeFile(config, `${await readFile(config, 'utf8')}\ntemplates:\n  runtime: ./custom/runtime.ts\n`);
      const result = await sdkgen(dir, 'eject', 'runtime');
      expect(result.stdout).toContain('Copied the built-in runtime template to custom/runtime.ts');
      expect(result.stdout).toContain('sdkgen uses it for generated/runtime.ts from the next run on.');
      const runtime = path.join(dir, 'custom/runtime.ts');
      await writeFile(runtime, `${await readFile(runtime, 'utf8')}\nexport const CUSTOMIZED = true;\n`);
      expect((await sdkgen(dir, 'generate')).code).toBe(0);
      expect(await readFile(path.join(dir, 'sdk/generated/runtime.ts'), 'utf8')).toContain('export const CUSTOMIZED = true;');
    });

    it('prints the template with --stdout and rejects unknown templates', async () => {
      const dir = await tempDir();
      expect((await sdkgen(dir, 'eject', 'runtime', '--stdout')).stdout).toContain('export class HttpClient');
      const unknown = await sdkgen(dir, 'eject', 'models');
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("value 'models' is invalid for argument 'template'. Allowed choices are runtime.");
    });
  });
});
