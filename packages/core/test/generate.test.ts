import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { generate } from '../src/generate.js';
import { ejectTemplate } from '../src/generators/typescript/templates.js';
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

describe('examples/petstore/sdk as committed', () => {
  it('type-checks, including the hand-written code in its custom regions', async () => {
    const dir = await tempDir();
    await cp(path.join(PETSTORE_DIR, 'sdk'), path.join(dir, 'sdk'), { recursive: true });
    await typecheck(path.join(dir, 'sdk'));
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

describe('custom regions', () => {
  const STORE = 'generated/api/store.ts';

  /** Adds an import and a helper method to the StoreApi class, inside its custom regions. */
  async function customizeStore(dir: string): Promise<string> {
    const file = path.join(dir, 'sdk', STORE);
    const text = (await readFile(file, 'utf8'))
      .replace('// <sdkgen:custom imports>\n', "// <sdkgen:custom imports>\nimport type { Pet } from '../models.js';\n")
      .replace(
        '  // <sdkgen:custom members>\n',
        "  // <sdkgen:custom members>\n  /** The pet an order is for. */\n  orderedPet(order: Order): Pick<Pet, 'id'> {\n    return { id: order.petId };\n  }\n",
      );
    await writeFile(file, text);
    return text;
  }

  it('keeps code inside custom regions when regenerating, and the result type-checks', async () => {
    const dir = await project();
    await gen(dir);
    await customizeStore(dir);
    await editSpec(dir, 'summary: Find purchase order by ID', 'summary: Find an order');
    const result = await gen(dir);
    expect(result.plan.conflicts).toEqual([]);
    const store = await read(dir, STORE);
    expect(store).toContain('Find an order');
    expect(store).toContain("import type { Pet } from '../models.js';\n// </sdkgen:custom>");
    expect(store).toContain('orderedPet(order: Order)');
    expect((await gen(dir, { dryRun: true })).plan.changes.find((change) => change.path === STORE)?.action).toBe('unchanged');
    await typecheck(path.join(dir, 'sdk'));
  });

  it('still reports edits outside custom regions', async () => {
    const dir = await project();
    await gen(dir);
    await customizeStore(dir);
    const file = path.join(dir, 'sdk', STORE);
    await writeFile(file, (await readFile(file, 'utf8')).replace('export class StoreApi', '// tweak\nexport class StoreApi'));
    await expect(gen(dir)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT', details: [`${STORE} (edited since the last generation)`] });
  });

  it('keeps a file whose region code has nowhere to go, and says why', async () => {
    const dir = await project();
    await gen(dir);
    await customizeStore(dir);
    await editSpec(dir, /tags: \[store\]/g, 'tags: [pets]');
    await expect(gen(dir)).rejects.toMatchObject({
      code: 'OUTPUT_CONFLICT',
      details: [`${STORE} (code in custom region imports, members would be lost: the region is no longer generated)`],
    });
    // Even --force leaves it in place rather than deleting the user's code.
    await gen(dir, { force: true });
    expect(await read(dir, STORE)).toContain('orderedPet(order: Order)');
  });

  it('reports broken region markers', async () => {
    const dir = await project();
    await gen(dir);
    const file = path.join(dir, 'sdk', STORE);
    await writeFile(file, (await customizeStore(dir)).replace('  // </sdkgen:custom>\n}', '}'));
    await editSpec(dir, 'summary: Find purchase order by ID', 'summary: Find an order');
    await expect(gen(dir)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT', details: [expect.stringMatching(/broken custom region markers: region "members" \(line \d+\) is never closed/)] });
  });

  it('can be turned off, without silently dropping code already in regions', async () => {
    const dir = await project(undefined, 'typescript:\n  customRegions: false\n');
    await gen(dir);
    expect(await read(dir, STORE)).not.toContain('sdkgen:custom');
    expect(await read(dir, STORE)).toContain('// Generated by sdkgen. Do not edit');

    const withRegions = await project();
    await gen(withRegions);
    await customizeStore(withRegions);
    await writeFile(path.join(withRegions, '.sdkgenrc.yml'), 'input: ./openapi.yaml\noutput: ./sdk\ntypescript:\n  customRegions: false\n');
    await expect(gen(withRegions)).rejects.toMatchObject({ details: [expect.stringContaining('code in custom region imports, members would be lost')] });
  });
});

describe('ignore', () => {
  it('leaves ignored operations, their files and unused schemas out of the SDK and its changelog', async () => {
    const dir = await project(undefined, 'ignore:\n  tags: [users]\n  operations: ["GET /health"]\n  unusedSchemas: true\n');
    const first = await gen(dir);
    expect(first.model.operations.map((op) => op.key)).not.toContain('POST /users/login');
    expect(first.plan.changes.map((change) => change.path)).not.toContain('generated/api/users.ts');
    expect(first.diagnostics).toContainEqual(expect.objectContaining({ code: 'IGNORED', message: 'Left out 2 operations (ignore config)' }));
    expect(await read(dir, 'generated/client.ts')).not.toContain('healthCheck');

    // Changes to ignored operations do not show up as API changes.
    await editSpec(dir, 'summary: Log a user into the system\n      security: []', 'summary: Log a user into the system');
    expect((await gen(dir)).changes?.changes).toEqual([]);
    await typecheck(path.join(dir, 'sdk'));
  });
});

describe('templates', () => {
  it('puts the configured header at the top of generated files and scaffolds', async () => {
    const dir = await project(undefined, 'templates:\n  header: |\n    // Copyright (c) Acme. {title} API {version}.\n');
    await gen(dir);
    for (const file of ['generated/models.ts', 'generated/runtime.ts', 'generated/api/pets.ts', 'generated/index.ts', 'client.ts', 'index.ts']) {
      expect((await read(dir, file)).split('\n')[0], file).toBe('// Copyright (c) Acme. Swagger Petstore API 1.0.0.');
    }
    expect((await read(dir, 'generated/models.ts')).split('\n')[1]).toMatch(/^\/\/ Generated by sdkgen\./);
    expect((await read(dir, 'client.ts')).split('\n')[1]).toBe('');
    await typecheck(path.join(dir, 'sdk'));
  });

  async function withRuntime(edit: (source: string) => string): Promise<string> {
    const dir = await project(undefined, 'templates:\n  runtime: ./sdkgen/runtime.ts\n');
    await mkdir(path.join(dir, 'sdkgen'));
    await writeFile(path.join(dir, 'sdkgen/runtime.ts'), edit(await ejectTemplate('runtime')));
    return dir;
  }

  it('uses an ejected runtime instead of the built-in one', async () => {
    const dir = await withRuntime((source) => `${source}\nexport const RETRIES = 3;\n`);
    const result = await gen(dir);
    expect(await read(dir, 'generated/runtime.ts')).toContain('export const RETRIES = 3;');
    expect(result.diagnostics.map((item) => item.code)).not.toContain('TEMPLATE_OUTDATED');
    await typecheck(path.join(dir, 'sdk'));
  });

  it('rejects a runtime that lacks what the generated code imports', async () => {
    const dir = await withRuntime((source) => source.replace('export interface RequestOptions', 'interface RequestOptions'));
    await expect(gen(dir)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID', details: ['export RequestOptions'] });
  });

  it('warns when the runtime was ejected from another version of the built-in one', async () => {
    const dir = await withRuntime((source) => source.replace(/fingerprint [0-9a-f]{12}/, 'fingerprint 000000000000'));
    expect((await gen(dir)).diagnostics).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_OUTDATED' }));
  });

  it('explains a missing runtime template', async () => {
    const dir = await project(undefined, 'templates:\n  runtime: ./nope.ts\n');
    await expect(gen(dir)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', hint: expect.stringContaining('sdkgen eject runtime') });
  });
});
