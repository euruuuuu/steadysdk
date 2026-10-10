import { execFile } from 'node:child_process';
import { cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkVersionBump } from '../src/diff/version.js';
import type { ApiDiff } from '../src/diff/types.js';
import { parseRevisionArgument } from '../src/spec/git.js';
import { loadSpec } from '../src/spec/load.js';
import { FIXTURES, tempDir } from './helpers.js';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });

describe('specs at a git revision', () => {
  it('reads a multi-file spec as it was at the revision, external $refs included', async () => {
    const dir = await tempDir();
    await cp(path.join(FIXTURES, 'multi'), dir, { recursive: true });
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'v1');
    await writeFile(path.join(dir, 'schemas/pet.yaml'), 'type: object\nproperties:\n  nickname: { type: string }\n');

    const now = await loadSpec(path.join(dir, 'openapi.yaml'));
    const then = await loadSpec(path.join(dir, 'openapi.yaml'), { revision: 'main' });
    const pet = (spec: typeof now) => JSON.stringify(spec.document.components?.schemas?.['Pet']);
    expect(pet(now)).toContain('nickname');
    expect(pet(then)).toContain('"required":["name"]');
    expect(then.source).toBe('main:openapi.yaml');
    expect(now.files.map((file) => path.basename(file))).toEqual(['openapi.yaml', 'pet.yaml']);
  });

  it('explains unknown revisions and files that did not exist yet', async () => {
    const dir = await tempDir();
    await cp(path.join(FIXTURES, 'multi'), dir, { recursive: true });
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
    await expect(loadSpec(path.join(dir, 'openapi.yaml'), { revision: 'nope' })).rejects.toMatchObject({ code: 'GIT_REVISION_NOT_FOUND' });
    await expect(loadSpec(path.join(dir, 'openapi.yaml'), { revision: 'main' })).rejects.toMatchObject({
      code: 'SPEC_NOT_FOUND',
      message: 'openapi.yaml does not exist at git revision "main"',
    });
  });

  it('parses <revision>:<path> arguments', () => {
    expect(parseRevisionArgument('main:openapi.yaml')).toEqual({ revision: 'main', file: 'openapi.yaml' });
    expect(parseRevisionArgument('origin/main:specs/api.yaml')).toEqual({ revision: 'origin/main', file: 'specs/api.yaml' });
    expect(parseRevisionArgument('HEAD~1:./api.json')).toEqual({ revision: 'HEAD~1', file: './api.json' });
    expect(parseRevisionArgument('C:\\specs\\api.yaml')).toBeUndefined();
    expect(parseRevisionArgument('https://example.com/api.yaml')).toBeUndefined();
    expect(parseRevisionArgument('openapi.yaml')).toBeUndefined();
  });
});

describe('version bump check', () => {
  const diff = (from: string, to: string, breaking: number): ApiDiff => ({
    version: 1,
    from: { title: 'API', version: from },
    to: { title: 'API', version: to },
    summary: { breaking, nonBreaking: 0 },
    changes: [],
  });

  it('needs no bump without breaking changes', () => {
    expect(checkVersionBump(diff('1.0.0', '1.0.0', 0))).toMatchObject({ ok: true, required: 'none' });
  });

  it('needs a new major version for breaking changes', () => {
    expect(checkVersionBump(diff('1.4.2', '2.0.0', 1))).toMatchObject({ ok: true, message: '1 breaking change; 1.4.2 → 2.0.0 is a new major version.' });
    expect(checkVersionBump(diff('v1.4.2', 'v3.0.0-beta.1', 2))).toMatchObject({ ok: true });
    expect(checkVersionBump(diff('1.4.2', '1.5.0', 2))).toEqual({
      ok: false,
      required: 'major',
      from: '1.4.2',
      to: '1.5.0',
      suggested: '2.0.0',
      message: '2 breaking changes, but info.version only went from 1.4.2 to 1.5.0. They need a new major version: 2.0.0 or later.',
    });
    expect(checkVersionBump(diff('1.0.0', '1.0.0', 1)).message).toContain('info.version is still 1.0.0');
  });

  it('accepts a new minor version below 1.0.0, as semver tooling does', () => {
    expect(checkVersionBump(diff('0.3.1', '0.4.0', 1))).toMatchObject({ ok: true });
    expect(checkVersionBump(diff('0.3.1', '1.0.0', 1))).toMatchObject({ ok: true });
    expect(checkVersionBump(diff('0.3.1', '0.3.2', 1))).toMatchObject({ ok: false, suggested: '0.4.0' });
  });

  it('only requires a change for versions that are not semver', () => {
    expect(checkVersionBump(diff('2024-01-01', '2024-06-01', 1))).toMatchObject({ ok: true });
    const unchanged = checkVersionBump(diff('2024-01-01', '2024-01-01', 1));
    expect(unchanged).toMatchObject({ ok: false, message: '1 breaking change, but info.version is still 2024-01-01.' });
    expect(unchanged.suggested).toBeUndefined();
  });
});
