import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';

const exec = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/github-action.sh');
const CLI = path.join(REPO_ROOT, 'packages/cli/dist/index.js');
const PETSTORE_SPEC = path.join(REPO_ROOT, 'examples/petstore/openapi.yaml');

// The action runs the built CLI, so make sure dist/ matches the sources.
beforeAll(() => exec(path.join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-b'], { cwd: REPO_ROOT }), 120_000);

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'apisteady-action-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });
const apisteady = (cwd: string, ...args: string[]) => exec('node', [CLI, ...args], { cwd });

/** A repository with a generated Petstore SDK committed on main, pushed to a bare `origin`. */
async function repository(): Promise<string> {
  const root = await tempDir();
  const dir = path.join(root, 'work');
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await copyFile(PETSTORE_SPEC, path.join(dir, 'openapi.yaml'));
  await apisteady(dir, 'init');
  await apisteady(dir, 'generate');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'Add the SDK');
  await exec('git', ['clone', '-q', '--bare', dir, path.join(root, 'origin.git')]);
  await git(dir, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
  return dir;
}

async function editSpec(dir: string, from: string, to: string): Promise<void> {
  const file = path.join(dir, 'openapi.yaml');
  await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
}

/** Runs the action script the way action.yml does, for a pull request into main unless `env` says otherwise. */
async function action(dir: string, env: Record<string, string> = {}) {
  const files = await tempDir();
  const summaryFile = path.join(files, 'summary.md');
  const outputFile = path.join(files, 'output');
  await writeFile(summaryFile, '');
  await writeFile(outputFile, '');
  const result = await exec('bash', [SCRIPT], {
    cwd: dir,
    env: {
      ...process.env,
      APISTEADY_CLI: CLI,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_BASE_REF: 'main',
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  }).then(
    (done) => ({ code: 0, ...done }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  return { ...result, summary: await readFile(summaryFile, 'utf8'), outputs: await readFile(outputFile, 'utf8') };
}

const BREAKING = ['enum: [available, pending, sold]', 'enum: [available, pending]'] as const;

describe('GitHub Action script', () => {
  it('fetches the pull request base and passes when nothing changed', async () => {
    const dir = await repository();
    const result = await action(dir);
    expect(result.code).toBe(0);
    expect(result.summary).toContain('- ✅ The generated SDK is up to date with the spec.');
    expect(result.summary).toContain('No API changes.');
    expect(result.outputs).toBe('breaking=0\nnon-breaking=0\n');
  });

  it('fails on breaking changes without a major version bump, and passes with one', async () => {
    const dir = await repository();
    await editSpec(dir, ...BREAKING);
    await apisteady(dir, 'generate');
    const result = await action(dir);
    expect(result.code).toBe(1);
    expect(result.summary).toContain(
      '- ❌ 1 breaking change, but info.version is still 1.0.0. They need a new major version: 2.0.0 or later. (--require-bump)',
    );
    expect(result.summary).toContain('### Breaking changes');
    expect(result.summary).toContain('**Schema `PetStatus`**');
    expect(result.outputs).toBe('breaking=1\nnon-breaking=0\n');

    await editSpec(dir, 'version: 1.0.0', 'version: 2.0.0');
    await apisteady(dir, 'generate');
    const bumped = await action(dir);
    expect(bumped.code).toBe(0);
    expect(bumped.summary).toContain('## Swagger Petstore 1.0.0 → 2.0.0');
  });

  it('fails when the committed SDK is out of date', async () => {
    const dir = await repository();
    await editSpec(dir, 'summary: List all pets', 'summary: List pets');
    const result = await action(dir, { INPUT_REQUIRE_BUMP: 'false' });
    expect(result.code).toBe(1);
    expect(result.summary).toContain('- ❌ The generated SDK is out of date: run `apisteady generate` and commit the result.');
  });

  it('can gate on any breaking change, and skips the comparison without a base', async () => {
    const dir = await repository();
    await editSpec(dir, ...BREAKING);
    await editSpec(dir, 'version: 1.0.0', 'version: 2.0.0');
    await apisteady(dir, 'generate');
    expect((await action(dir, { INPUT_FAIL_ON_BREAKING: 'true' })).code).toBe(1);

    const manual = await action(dir, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
    expect(manual.code).toBe(0);
    expect(manual.summary).toContain('No base revision to compare the API against');
  });

  it('uses the commit before a push as the base', async () => {
    const dir = await repository();
    const before = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
    await editSpec(dir, 'operationId: healthCheck', 'operationId: health');
    await apisteady(dir, 'generate');
    await git(dir, 'commit', '-q', '-am', 'Rename an operationId');
    const result = await action(dir, { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_BEFORE: before });
    expect(result.code).toBe(0);
    expect(result.outputs).toBe('breaking=0\nnon-breaking=1\n');
  });

  it('treats a spec that is new in the pull request as all additions', async () => {
    const dir = await repository();
    await git(dir, 'rm', '-q', '-r', 'openapi.yaml', 'sdk');
    await git(dir, 'commit', '-q', '-m', 'Start over');
    await git(dir, 'push', '-q', 'origin', 'main');
    await git(dir, 'checkout', '-q', 'HEAD~1', '--', 'openapi.yaml', 'sdk');
    const result = await action(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('openapi.yaml does not exist at origin/main; every endpoint counts as new.');
    expect(result.outputs).toMatch(/^breaking=0\nnon-breaking=\d+\n$/);
  });
});
