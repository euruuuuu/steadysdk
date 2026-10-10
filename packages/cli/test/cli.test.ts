import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';
import { run } from '../src/cli.js';

const exec = promisify(execFile);
const PETSTORE_SPEC = path.resolve(import.meta.dirname, '../../../examples/petstore/openapi.yaml');
const PETSTORE_NEXT = path.resolve(import.meta.dirname, '../../../examples/petstore/next');

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'steadysdk-cli-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function steadysdk(cwd: string, ...argv: string[]) {
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

describe('steadysdk CLI', () => {
  it('prints its version and help', async () => {
    const dir = await tempDir();
    expect(await steadysdk(dir, '--version')).toMatchObject({ code: 0, stdout: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(await steadysdk(dir, '--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('generate|gen') });
  });

  it('fails on unknown commands', async () => {
    const result = await steadysdk(await tempDir(), 'frobnicate');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });

  describe('init', () => {
    it('creates a config pointing at a detected spec', async () => {
      const dir = await tempDir();
      await writeFile(path.join(dir, 'openapi.json'), '{}');
      const result = await steadysdk(dir, 'init');
      expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('Detected spec ./openapi.json') });
      expect(await readFile(path.join(dir, '.steadysdkrc.yml'), 'utf8')).toContain('input: ./openapi.json');
    });

    it('looks in the usual spec folders and says what it found', async () => {
      const dir = await tempDir();
      await mkdir(path.join(dir, 'api'));
      await copyFile(PETSTORE_SPEC, path.join(dir, 'api/openapi.yaml'));
      await writeFile(path.join(dir, 'api/swagger.json'), '{}');
      const result = await steadysdk(dir, 'init');
      expect(result.stdout).toContain('Detected spec ./api/openapi.yaml (Swagger Petstore 1.0.0, OpenAPI 3.0.3, 11 operations)');
      expect(result.stdout).toContain('Also found: ./api/swagger.json.');
      // `npx steadysdk ...` when the tests themselves run through npx.
      expect(result.stdout).toMatch(/Keep it in sync in CI: +(npx )?steadysdk generate --check/);
      // Run through npx without the package installed, it says to install it first.
      const viaNpx = await withEnv({ npm_command: 'exec' }, () => steadysdk(dir, 'init', '--force'));
      expect(viaNpx.stdout).toContain('1. Add it to the project:      npm install --save-dev @steadysdk/cli');
      expect(viaNpx.stdout).toContain('Generate the SDK:           npx steadysdk generate');
      expect(await readFile(path.join(dir, '.steadysdkrc.yml'), 'utf8')).toContain('input: ./api/openapi.yaml');
    });

    it('warns when no spec is found, and honours --input/--output', async () => {
      const dir = await tempDir();
      expect((await steadysdk(dir, 'init')).stdout).toContain('No OpenAPI file found');
      await steadysdk(dir, 'init', '--force', '-i', 'specs/my api.yaml', '-o', 'client');
      const config = await readFile(path.join(dir, '.steadysdkrc.yml'), 'utf8');
      expect(config).toContain('input: "specs/my api.yaml"');
      expect(config).toContain('output: client');
    });

    it('refuses to overwrite an existing config without --force', async () => {
      const dir = await tempDir();
      await steadysdk(dir, 'init');
      const result = await steadysdk(dir, 'init');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('.steadysdkrc.yml already exists');
      expect(result.stderr).toContain('--force');
    });
  });

  async function project(): Promise<string> {
    const dir = await tempDir();
    await copyFile(PETSTORE_SPEC, path.join(dir, 'openapi.yaml'));
    await steadysdk(dir, 'init');
    return dir;
  }

  async function editSpec(dir: string, from: string, to: string): Promise<void> {
    const spec = path.join(dir, 'openapi.yaml');
    await writeFile(spec, (await readFile(spec, 'utf8')).replace(from, to));
  }

  describe('generate', () => {
    it('generates the SDK and reports what changed', async () => {
      const dir = await project();
      const result = await steadysdk(dir, 'generate');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Loaded Swagger Petstore 1.0.0 (OpenAPI 3.0.3): 11 operations, 8 schemas');
      expect(result.stdout).toContain('+ generated/api/pets.ts');
      expect(result.stdout).toContain('SDK written to sdk');
      expect(await readFile(path.join(dir, 'sdk/client.ts'), 'utf8')).toContain('export class SwaggerPetstoreClient extends GeneratedClient');
    });

    it('--check passes when up to date and fails after the spec changes', async () => {
      const dir = await project();
      await steadysdk(dir, 'generate');
      expect(await steadysdk(dir, 'generate', '--check')).toMatchObject({ code: 0, stdout: expect.stringContaining('SDK is up to date') });

      const spec = path.join(dir, 'openapi.yaml');
      await writeFile(spec, (await readFile(spec, 'utf8')).replace('summary: List all pets', 'summary: List pets'));
      const result = await steadysdk(dir, 'generate', '--check');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('~ generated/api/pets.ts');
      expect(result.stderr).toContain('~ .steadysdk/spec.json');
    });

    it('--dry-run shows changes without writing', async () => {
      const dir = await project();
      const result = await steadysdk(dir, 'gen', '--dry-run');
      expect(result.stdout).toContain('+ generated/models.ts');
      expect(result.stdout).toContain('Dry run: nothing was written');
      await expect(readFile(path.join(dir, 'sdk/generated/models.ts'))).rejects.toThrow();
    });

    it('works without a config file when given --input', async () => {
      const dir = await tempDir();
      await copyFile(PETSTORE_SPEC, path.join(dir, 'api.yaml'));
      expect((await steadysdk(dir, 'generate', '-i', 'api.yaml', '-o', 'out')).code).toBe(0);
      await expect(readFile(path.join(dir, 'out/generated/index.ts'), 'utf8')).resolves.toContain("export * from './client.js';");
    });

    it('explains a missing config', async () => {
      const result = await steadysdk(await tempDir(), 'generate');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No steadysdk config file found');
      expect(result.stderr).toContain('Hint: Run `steadysdk init`');
    });

    it('explains a missing spec', async () => {
      const result = await steadysdk(await tempDir(), 'generate', '-i', 'nope.yaml');
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/OpenAPI spec not found: .*nope\.yaml/);
    });

    it('lists the offending files on a conflict, and --force overwrites them', async () => {
      const dir = await project();
      await steadysdk(dir, 'generate');
      const models = path.join(dir, 'sdk/generated/models.ts');
      await writeFile(models, '// edited\n');
      const result = await steadysdk(dir, 'generate');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('generated/models.ts (edited since the last generation)');
      expect((await steadysdk(dir, 'generate', '--force')).code).toBe(0);
      expect(await readFile(models, 'utf8')).not.toBe('// edited\n');
    });

    it('lists the API changes it picked up since the last run', async () => {
      const dir = await project();
      expect((await steadysdk(dir, 'generate')).stdout).not.toContain('API changes');
      await editSpec(dir, 'version: 1.0.0', 'version: 1.1.0');
      await editSpec(dir, 'operationId: healthCheck', 'operationId: health');
      const result = await steadysdk(dir, 'generate');
      expect(result.stdout).toContain('API changes since the last generation (1.0.0 → 1.1.0): 1 non-breaking');
      expect(result.stdout).toContain('~ GET /health: operationId changed from `healthCheck` to `health`.');
    });

    it('runs relative to --cwd', async () => {
      const dir = await project();
      const parent = path.dirname(dir);
      const result = await steadysdk(parent, '--cwd', path.basename(dir), 'generate');
      expect(result.code).toBe(0);
    });
  });

  describe('diff', () => {
    async function generated(): Promise<string> {
      const dir = await project();
      await steadysdk(dir, 'generate');
      return dir;
    }

    it('needs a previous generation to compare against', async () => {
      const result = await steadysdk(await project(), 'diff');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No generated SDK found in sdk to compare against');
      expect(result.stderr).toContain('`steadysdk diff old.yaml new.yaml`');
    });

    it('lists changes since the last generation, and --fail-on-breaking gates on them', async () => {
      const dir = await generated();
      expect((await steadysdk(dir, 'diff')).stdout).toContain('No API changes (Swagger Petstore 1.0.0)');

      await editSpec(dir, 'enum: [available, pending, sold]', 'enum: [available, pending]');
      await editSpec(dir, 'operationId: healthCheck', 'operationId: health');
      const result = await steadysdk(dir, 'diff', '--fail-on-breaking');
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('Comparing sdk/.steadysdk/spec.json → openapi.yaml');
      expect(result.stdout).toContain('API changes in Swagger Petstore 1.0.0: 1 breaking, 1 non-breaking');
      expect(result.stdout).toContain('! schema PetStatus: Enum value `sold` was removed.');
      expect(result.stdout).toContain('~ GET /health: operationId changed from `healthCheck` to `health`.');
      expect(result.stderr).toContain('1 breaking change (--fail-on-breaking)');
      expect((await steadysdk(dir, 'diff')).code).toBe(0);
    });

    it('previews another spec against the SDK with --input, as JSON', async () => {
      const dir = await generated();
      const result = await steadysdk(dir, 'diff', '-i', path.join(PETSTORE_NEXT, 'openapi.yaml'), '--json');
      expect(result.code).toBe(0);
      const diff = JSON.parse(result.stdout) as { from: { version: string }; to: { version: string }; summary: object; changes: unknown[] };
      expect(diff).toMatchObject({ from: { version: '1.0.0' }, to: { version: '1.1.0' }, summary: { breaking: 5, nonBreaking: 7 } });
      expect(diff.changes[0]).toMatchObject({ kind: 'parameter-required', operation: 'GET /pets', breaking: true });
    });

    it('compares two files without a config', async () => {
      const dir = await tempDir();
      const result = await steadysdk(dir, 'diff', PETSTORE_SPEC, path.join(PETSTORE_NEXT, 'openapi.yaml'));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('API changes in Swagger Petstore 1.0.0 → 1.1.0: 5 breaking, 7 non-breaking');
    });
  });

  describe('changelog', () => {
    it('prints a Markdown changelog', async () => {
      const result = await steadysdk(await tempDir(), 'changelog', PETSTORE_SPEC, path.join(PETSTORE_NEXT, 'openapi.yaml'));
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toBe(await readFile(path.join(PETSTORE_NEXT, 'CHANGELOG.md'), 'utf8'));
    });

    it('writes JSON or Markdown to a file with --out', async () => {
      const dir = await tempDir();
      const next = path.join(PETSTORE_NEXT, 'openapi.yaml');
      const result = await steadysdk(dir, 'changelog', PETSTORE_SPEC, next, '--out', 'notes/api.md');
      expect(result.stdout).toContain('Wrote notes/api.md (5 breaking, 7 non-breaking)');
      expect(await readFile(path.join(dir, 'notes/api.md'), 'utf8')).toContain('## Swagger Petstore 1.0.0 → 1.1.0');

      await steadysdk(dir, 'changelog', PETSTORE_SPEC, next, '--json', '--out', 'api.json');
      expect(JSON.parse(await readFile(path.join(dir, 'api.json'), 'utf8'))).toMatchObject({ version: 1, summary: { breaking: 5 } });
    });
  });

  describe('eject', () => {
    it('copies the runtime into the project and shows how to use it', async () => {
      const dir = await project();
      const result = await steadysdk(dir, 'eject', 'runtime');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Copied the built-in runtime template to steadysdk/runtime.ts');
      expect(result.stdout).toContain('add this to .steadysdkrc.yml:\n  templates:\n    runtime: ./steadysdk/runtime.ts');
      expect(await readFile(path.join(dir, 'steadysdk/runtime.ts'), 'utf8')).toMatch(/^\/\/ Your copy of the steadysdk HTTP runtime.*fingerprint [0-9a-f]{12}/);

      const again = await steadysdk(dir, 'eject', 'runtime');
      expect(again.code).toBe(1);
      expect(again.stderr).toContain('steadysdk/runtime.ts already exists');
      expect((await steadysdk(dir, 'eject', 'runtime', '--force')).code).toBe(0);
    });

    it('writes to templates.runtime when the config sets it, and generate picks it up', async () => {
      const dir = await project();
      const config = path.join(dir, '.steadysdkrc.yml');
      await writeFile(config, `${await readFile(config, 'utf8')}\ntemplates:\n  runtime: ./custom/runtime.ts\n`);
      const result = await steadysdk(dir, 'eject', 'runtime');
      expect(result.stdout).toContain('Copied the built-in runtime template to custom/runtime.ts');
      expect(result.stdout).toContain('steadysdk uses it for generated/runtime.ts from the next run on.');
      const runtime = path.join(dir, 'custom/runtime.ts');
      await writeFile(runtime, `${await readFile(runtime, 'utf8')}\nexport const CUSTOMIZED = true;\n`);
      expect((await steadysdk(dir, 'generate')).code).toBe(0);
      expect(await readFile(path.join(dir, 'sdk/generated/runtime.ts'), 'utf8')).toContain('export const CUSTOMIZED = true;');
    });

    it('prints the template with --stdout and rejects unknown templates', async () => {
      const dir = await tempDir();
      expect((await steadysdk(dir, 'eject', 'runtime', '--stdout')).stdout).toContain('export class HttpClient');
      const unknown = await steadysdk(dir, 'eject', 'models');
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("value 'models' is invalid for argument 'template'. Allowed choices are runtime.");
    });
  });

  describe('diff against git revisions', () => {
    const git = (cwd: string, ...args: string[]) =>
      exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });

    async function repository(): Promise<string> {
      const dir = await project();
      await git(dir, 'init', '-q', '-b', 'main');
      await git(dir, 'add', '-A');
      await git(dir, 'commit', '-q', '-m', 'spec');
      await editSpec(dir, 'enum: [available, pending, sold]', 'enum: [available, pending]');
      return dir;
    }

    it('compares the configured spec with its version at --base, and gates with --require-bump', async () => {
      const dir = await repository();
      const result = await steadysdk(dir, 'diff', '--base', 'main', '--require-bump');
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('Comparing main:openapi.yaml → openapi.yaml');
      expect(result.stdout).toContain('! schema PetStatus: Enum value `sold` was removed.');
      expect(result.stderr).toContain('1 breaking change, but info.version is still 1.0.0. They need a new major version: 2.0.0 or later.');

      await editSpec(dir, 'version: 1.0.0', 'version: 2.0.0');
      const bumped = await steadysdk(dir, 'diff', '--base', 'main', '--require-bump');
      expect(bumped.code).toBe(0);
      expect(bumped.stdout).toContain('1 breaking change; 1.0.0 → 2.0.0 is a new major version.');
    });

    it('reads <revision>:<path> arguments from git', async () => {
      const dir = await repository();
      const result = await steadysdk(dir, 'changelog', 'main:openapi.yaml', 'openapi.yaml');
      expect(result.stdout).toContain('- **Schema `PetStatus`** (used by');
      const both = await steadysdk(dir, 'diff', 'main:openapi.yaml', '--base', 'main');
      expect(both.code).toBe(1);
      expect(both.stderr).toContain('Pass either an [old] spec or --base, not both');
    });
  });

  describe('watch', () => {
    async function waitFor(condition: () => boolean, what: string): Promise<void> {
      for (const started = Date.now(); !condition(); await new Promise((resolve) => setTimeout(resolve, 25))) {
        if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${what}`);
      }
    }

    it('regenerates on every save, keeps going after a broken one, and stops when aborted', async () => {
      const dir = await project();
      const controller = new AbortController();
      let stdout = '';
      let stderr = '';
      const exited = run(['watch'], {
        cwd: dir,
        color: false,
        signal: controller.signal,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      });
      await waitFor(() => stdout.includes('Watching 2 files for changes'), 'the first generation');
      expect(stdout).toContain('SDK written to sdk');

      await editSpec(dir, 'operationId: healthCheck', 'operationId: health');
      await waitFor(() => stdout.includes('operationId changed from `healthCheck` to `health`'), 'the regeneration');
      expect(stdout).toMatch(/\[\d\d:\d\d:\d\d\] openapi\.yaml changed/);

      const spec = path.join(dir, 'openapi.yaml');
      const valid = await readFile(spec, 'utf8');
      await writeFile(spec, 'openapi: 3.0.3\ninfo: [broken\n');
      await waitFor(() => stderr.includes('Could not read OpenAPI spec'), 'the parse error');
      await writeFile(spec, valid.replace('summary: List all pets', 'summary: List pets'));
      await waitFor(() => stdout.split('SDK written to sdk').length === 4, 'the recovery');

      controller.abort();
      expect(await exited).toBe(0);
      expect(stdout).toContain('Stopped watching.');
      expect(await readFile(path.join(dir, 'sdk/generated/api/pets.ts'), 'utf8')).toContain('List pets');
    });

    it('refuses specs it cannot watch', async () => {
      const result = await steadysdk(await tempDir(), 'watch', '-i', 'https://example.com/openapi.yaml');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Cannot watch https://example.com/openapi.yaml: it is a URL');
    });
  });
});
