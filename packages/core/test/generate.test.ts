import { execFile } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { generate } from '../src/generate.js';
import { NAME_LOCK_FILE } from '../src/output/manifest.js';
import { FIXTURES, PETSTORE_DIR, REPO_ROOT, tempDir } from './helpers.js';

const run = promisify(execFile);

/** Copies a spec into a fresh project dir with a config, ready to generate. */
async function project(spec = path.join(PETSTORE_DIR, 'openapi.yaml'), config = ''): Promise<string> {
  const dir = await tempDir();
  await copyFile(spec, path.join(dir, 'openapi.yaml'));
  await writeFile(path.join(dir, '.sdkgenrc.yml'), `input: ./openapi.yaml\noutput: ./sdk\n${config}`);
  return dir;
}

async function gen(dir: string, options: { dryRun?: boolean; force?: boolean; relock?: boolean } = {}) {
  return generate({ config: await loadConfig({ cwd: dir }), ...options });
}

async function editSpec(dir: string, from: string | RegExp, to: string): Promise<void> {
  const file = path.join(dir, 'openapi.yaml');
  const text = await readFile(file, 'utf8');
  const next = text.replace(from, to);
  expect(next).not.toBe(text);
  await writeFile(file, next);
}

const read = (dir: string, file: string) => readFile(path.join(dir, 'sdk', file), 'utf8');

async function typecheck(sdkDir: string, extraOptions: Record<string, unknown> = {}): Promise<void> {
  await writeFile(path.join(sdkDir, 'package.json'), '{ "type": "module" }\n');
  await writeFile(
    path.join(sdkDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        lib: ['es2022', 'dom'],
        module: 'nodenext',
        types: [],
        strict: true,
        noEmit: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noImplicitReturns: true,
        noImplicitOverride: true,
        noPropertyAccessFromIndexSignature: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        isolatedDeclarations: true,
        declaration: true,
        ...extraOptions,
      },
      include: ['**/*.ts'],
    }),
  );
  await run(path.join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', sdkDir]).catch((error: { stdout?: string }) => {
    throw new Error(`Generated SDK does not type-check:\n${error.stdout ?? String(error)}`);
  });
}

describe('examples/petstore', () => {
  it('is up to date with the generator (run `npm run examples` after intended changes)', async () => {
    const result = await generate({ config: await loadConfig({ cwd: PETSTORE_DIR }), dryRun: true });
    for (const change of result.plan.changes) {
      if (change.action !== 'update' && change.action !== 'create' && change.action !== 'delete') continue;
      const committed = await readFile(path.join(PETSTORE_DIR, 'sdk', change.path), 'utf8').catch(() => '(missing)');
      expect(committed, change.path).toBe(change.action === 'delete' ? '(deleted)' : change.content);
    }
  });
});

describe('generated code', () => {
  it('type-checks under the strictest compiler settings (petstore, 3.0)', async () => {
    const dir = await project();
    await gen(dir);
    await typecheck(path.join(dir, 'sdk'));
  });

  it('type-checks for a 3.1 spec with groupBy none and other naming styles', async () => {
    const dir = await project(
      path.join(FIXTURES, 'openapi-31.yaml'),
      'client:\n  groupBy: none\ntypescript:\n  importExtension: .ts\nnaming:\n  parameters:\n    case: preserve\n',
    );
    await gen(dir);
    await typecheck(path.join(dir, 'sdk'), { allowImportingTsExtensions: true });
  });
});

describe('regeneration', () => {
  it('writes generated files, scaffolds and bookkeeping on the first run', async () => {
    const dir = await project();
    const result = await gen(dir);
    const created = result.plan.changes.filter((change) => change.action === 'create').map((change) => change.path);
    expect(created).toEqual(
      expect.arrayContaining(['generated/models.ts', 'generated/api/pets.ts', 'index.ts', 'client.ts', '.sdkgen/manifest.json', NAME_LOCK_FILE]),
    );
  });

  it('is a no-op when nothing changed', async () => {
    const dir = await project();
    await gen(dir);
    const second = await gen(dir);
    expect(second.plan.changes.filter((change) => change.action !== 'unchanged' && change.action !== 'keep')).toEqual([]);
  });

  it('never touches scaffolded files after creating them', async () => {
    const dir = await project();
    await gen(dir);
    const custom = `${await read(dir, 'client.ts')}\n// my helper\nexport const answer = 42;\n`;
    await writeFile(path.join(dir, 'sdk/client.ts'), custom);
    await editSpec(dir, 'summary: List all pets', 'summary: List every pet');
    const result = await gen(dir);
    expect(await read(dir, 'client.ts')).toBe(custom);
    expect(result.plan.changes.find((change) => change.path === 'client.ts')?.action).toBe('keep');
    expect(await read(dir, 'generated/api/pets.ts')).toContain('List every pet');
  });

  it('adds new operations without disturbing existing ones', async () => {
    const dir = await project();
    await gen(dir);
    const before = await read(dir, 'generated/api/store.ts');
    await editSpec(dir, '  /health:', '  /pets/{petId}/feed:\n    post:\n      tags: [pets]\n      operationId: feedPet\n      parameters:\n        - { name: petId, in: path, required: true, schema: { type: integer } }\n      responses:\n        \'204\': { description: fed }\n  /health:');
    const result = await gen(dir);
    expect(await read(dir, 'generated/api/pets.ts')).toContain('feedPet(params: FeedPetParams');
    expect(await read(dir, 'generated/api/store.ts')).toBe(before);
    expect(result.plan.changes.filter((change) => change.action === 'update').map((change) => change.path)).toEqual(
      expect.arrayContaining(['generated/api/pets.ts']),
    );
  });

  it('deletes generated files that are no longer produced', async () => {
    const dir = await project();
    await gen(dir);
    await editSpec(dir, /tags: \[users\]/g, 'tags: [store]');
    const result = await gen(dir);
    expect(result.plan.changes).toContainEqual(expect.objectContaining({ path: 'generated/api/users.ts', action: 'delete' }));
    await expect(read(dir, 'generated/api/users.ts')).rejects.toThrow();
  });

  it('refuses to overwrite hand-edited generated files unless forced', async () => {
    const dir = await project();
    await gen(dir);
    await writeFile(path.join(dir, 'sdk/generated/models.ts'), `${await read(dir, 'generated/models.ts')}// hack\n`);
    await expect(gen(dir)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT', details: ['generated/models.ts (edited since the last generation)'] });
    const dry = await gen(dir, { dryRun: true });
    expect(dry.plan.conflicts).toEqual([{ path: 'generated/models.ts', reason: 'edited' }]);
    await gen(dir, { force: true });
    expect(await read(dir, 'generated/models.ts')).not.toContain('// hack');
  });

  it('keeps an edited file that is no longer generated, and reports it', async () => {
    const dir = await project();
    await gen(dir);
    await writeFile(path.join(dir, 'sdk/generated/api/users.ts'), '// mine now\n');
    await editSpec(dir, /tags: \[users\]/g, 'tags: [store]');
    await expect(gen(dir)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    await gen(dir, { force: true });
    expect(await read(dir, 'generated/api/users.ts')).toBe('// mine now\n');
  });

  it('refuses to overwrite files it did not create', async () => {
    const dir = await project();
    await gen(dir);
    await rm(path.join(dir, 'sdk/.sdkgen/manifest.json'));
    await writeFile(path.join(dir, 'sdk/generated/models.ts'), '// someone else\n');
    await expect(gen(dir)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT', details: ['generated/models.ts (not created by sdkgen)'] });
  });

  it('dry runs write nothing', async () => {
    const dir = await project();
    const result = await gen(dir, { dryRun: true });
    expect(result.written).toBe(false);
    await expect(read(dir, 'generated/models.ts')).rejects.toThrow();
  });

  it('keeps method names stable when an operationId changes, until --relock', async () => {
    const dir = await project();
    await gen(dir);
    await editSpec(dir, 'operationId: listPets', 'operationId: findPets');
    const pinned = await gen(dir);
    expect(await read(dir, 'generated/api/pets.ts')).toContain('listPets(');
    expect(pinned.diagnostics).toContainEqual(expect.objectContaining({ code: 'NAME_PINNED' }));

    await gen(dir, { relock: true });
    expect(await read(dir, 'generated/api/pets.ts')).toContain('findPets(');
  });

  it('reports API changes since the last generation', async () => {
    const dir = await project();
    expect((await gen(dir)).changes).toBeUndefined();
    expect((await gen(dir)).changes?.changes).toEqual([]);

    await editSpec(dir, 'enum: [available, pending, sold]', 'enum: [available, pending]');
    const dry = await gen(dir, { dryRun: true });
    expect(dry.changes?.changes).toEqual([expect.objectContaining({ kind: 'enum-value-removed', schema: 'PetStatus', breaking: true })]);
    // A dry run leaves the baseline alone, so the next real run still sees the change.
    expect((await gen(dir)).changes?.summary).toEqual({ breaking: 1, nonBreaking: 0 });
    expect((await gen(dir)).changes?.changes).toEqual([]);
  });

  it('carries on without a changelog when the spec snapshot is unreadable', async () => {
    const dir = await project();
    await gen(dir);
    await writeFile(path.join(dir, 'sdk/.sdkgen/spec.json'), '{ "not": "a spec" }\n');
    const result = await gen(dir);
    expect(result.changes).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'SPEC_SNAPSHOT_INVALID', level: 'warning' }));
    expect((await gen(dir)).changes?.changes).toEqual([]);
  });

  it('does not write a lock when locking is disabled', async () => {
    const dir = await project(undefined, 'naming:\n  lock: false\n');
    const result = await gen(dir);
    expect(result.plan.changes.map((change) => change.path)).not.toContain(NAME_LOCK_FILE);
  });
});
