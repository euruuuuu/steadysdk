import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { findConfigFile, loadConfig, parseConfig } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';
import { REPO_ROOT, tempDir } from './helpers.js';

describe('config', () => {
  it('fills in defaults', () => {
    const config = parseConfig({ input: 'spec.yaml' });
    expect(config).toMatchObject({
      output: './sdk',
      target: 'typescript',
      validate: true,
      client: { groupBy: 'auto' },
      naming: { operations: { case: 'camel', source: 'operationId' }, types: { case: 'pascal' }, lock: true },
    });
  });

  it('documents every option in .steadysdkrc.example.yml, with the real defaults', async () => {
    const example = parseYaml(await readFile(path.join(REPO_ROOT, '.steadysdkrc.example.yml'), 'utf8'));
    const parsed = parseConfig(example);
    const { naming: { operations: { actions: _actions, ...operations }, ...naming }, ...rest } = configSchema.parse({ input: './openapi.yaml' });
    const { naming: { operations: { actions: _exampleActions, ...exampleOperations }, ...exampleNaming }, ...exampleRest } = parsed;
    expect(exampleRest).toEqual(rest);
    expect(exampleNaming).toEqual(naming);
    expect(exampleOperations).toEqual(operations);
  });

  it('treats sections whose options are all commented out as unset', () => {
    expect(parseConfig(parseYaml('input: x\ntemplates:\n  # runtime: ./runtime.ts\nclient:\n')).templates).toEqual({});
  });

  it.each([
    [{ input: 'x', naming: { operations: { case: 'kebab' } } }, 'naming.operations.case'],
    [{ input: 'x', templates: { header: 'Copyright Acme' } }, 'templates.header: Every line must be a comment'],
    [{ input: 'x', ignore: { paths: [''] } }, 'ignore.paths.0'],
    [{ input: 'x', client: { groupby: 'tag' } }, 'client'],
    [{ input: 'x', naming: { operations: { stripPrefixes: ['(unclosed'] } } }, 'naming.operations.stripPrefixes.0: Invalid regular expression'],
    [{ output: './sdk' }, 'input'],
  ])('rejects invalid config %#', (value, where) => {
    try {
      parseConfig(value);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
      expect((error as { details: string[] }).details.join('\n')).toContain(where);
    }
  });

  it('finds the config in a parent directory and resolves paths against it', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, '.steadysdkrc.yml'), 'input: specs/api.yaml\noutput: out/sdk\n');
    const nested = path.join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });

    expect(await findConfigFile(nested)).toBe(path.join(root, '.steadysdkrc.yml'));
    const config = await loadConfig({ cwd: nested });
    expect(config.inputPath).toBe(path.join(root, 'specs/api.yaml'));
    expect(config.outputDir).toBe(path.join(root, 'out/sdk'));
  });

  it('resolves flag overrides against the working directory', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, '.steadysdkrc.yml'), 'input: api.yaml\n');
    const nested = path.join(root, 'sub');
    await mkdir(nested);
    const config = await loadConfig({ cwd: nested, overrides: { input: 'other.yaml', output: 'gen' } });
    expect(config.inputPath).toBe(path.join(nested, 'other.yaml'));
    expect(config.outputDir).toBe(path.join(nested, 'gen'));
  });

  it('works from flags alone, and explains a missing config otherwise', async () => {
    const dir = await tempDir();
    await expect(loadConfig({ cwd: dir, overrides: { input: 'api.yaml' } })).resolves.toMatchObject({ configPath: undefined });
    await expect(loadConfig({ cwd: dir })).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });

  it('keeps URLs as inputs', async () => {
    const dir = await tempDir();
    const config = await loadConfig({ cwd: dir, overrides: { input: 'https://example.com/openapi.json' } });
    expect(config.inputPath).toBe('https://example.com/openapi.json');
  });

  it('reports YAML syntax errors', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, '.steadysdkrc.yml'), 'input: [unclosed\n');
    await expect(loadConfig({ cwd: dir })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
