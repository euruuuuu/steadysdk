import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Diagnostics } from '../src/diagnostics.js';
import { SteadySdkError } from '../src/errors.js';
import { buildModel } from '../src/ir/build.js';
import type { ObjectSchema } from '../src/ir/model.js';
import { loadSpec } from '../src/spec/load.js';
import { FIXTURES, PETSTORE_DIR } from './helpers.js';

async function load(file: string) {
  const spec = await loadSpec(file);
  const diagnostics = new Diagnostics();
  return { spec, model: buildModel(spec.document, diagnostics), diagnostics: diagnostics.items };
}

describe('loadSpec', () => {
  it('loads and validates OpenAPI 3.0 and 3.1', async () => {
    expect((await loadSpec(path.join(PETSTORE_DIR, 'openapi.yaml'))).dialect).toBe('3.0');
    expect((await loadSpec(path.join(FIXTURES, 'openapi-31.yaml'))).dialect).toBe('3.1');
  });

  it('bundles external $refs into components', async () => {
    const { model } = await load(path.join(FIXTURES, 'multi/openapi.yaml'));
    expect(model.schemas[0]).toMatchObject({ key: 'Pet', schema: { kind: 'object' } });
  });

  it.each([
    ['missing.yaml', 'SPEC_NOT_FOUND'],
    ['broken.yaml', 'SPEC_PARSE_FAILED'],
    ['openapi-4.yaml', 'SPEC_UNSUPPORTED'],
    ['invalid.yaml', 'SPEC_INVALID'],
  ])('reports %s as %s', async (file, code) => {
    const error = await loadSpec(path.join(FIXTURES, file)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SteadySdkError);
    expect(error).toMatchObject({ code });
  });

  it('explains validation failures', async () => {
    const error = (await loadSpec(path.join(FIXTURES, 'invalid.yaml')).catch((caught: unknown) => caught)) as SteadySdkError;
    expect(error.details.join('\n')).toMatch(/petId/);
    expect(error.hint).toMatch(/validate: false/);
  });

  it('can skip validation', async () => {
    await expect(loadSpec(path.join(FIXTURES, 'invalid.yaml'), { validate: false })).resolves.toMatchObject({ dialect: '3.0' });
  });

  it('hashes the document independently of key order', async () => {
    const a = await loadSpec(path.join(PETSTORE_DIR, 'openapi.yaml'));
    const b = await loadSpec(path.join(PETSTORE_DIR, 'openapi.yaml'));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildModel (3.0 petstore)', async () => {
  const { model } = await load(path.join(PETSTORE_DIR, 'openapi.yaml'));
  const operation = (key: string) => model.operations.find((candidate) => candidate.key === key)!;

  it('reads info, servers (with variables) and tags', () => {
    expect(model).toMatchObject({ title: 'Swagger Petstore', version: '1.0.0' });
    expect(model.servers[0]?.url).toBe('https://petstore.example.com/v1');
    expect(model.tags.map((tag) => tag.name)).toEqual(['pets', 'store', 'users']);
  });

  it('keeps component $refs as named references', () => {
    expect(operation('POST /pets').requestBody?.content[0]?.schema).toEqual({ kind: 'ref', target: 'NewPet' });
  });

  it('resolves referenced parameters and merges path-level ones', () => {
    expect(operation('GET /pets').parameters.map((param) => `${param.in}:${param.name}`)).toEqual(['query:limit', 'query:status', 'header:X-Request-ID']);
    expect(operation('GET /pets/{petId}').parameters[0]).toMatchObject({ name: 'petId', in: 'path', required: true, style: 'simple' });
  });

  it('applies serialization defaults and explicit styles', () => {
    const [limit, status] = operation('GET /pets').parameters;
    expect(limit).toMatchObject({ style: 'form', explode: true });
    expect(status).toMatchObject({ style: 'form', explode: false });
  });

  it('inherits global security unless the operation overrides it', () => {
    expect(operation('GET /pets').security).toEqual([[{ scheme: 'bearerAuth', scopes: [] }]]);
    expect(operation('GET /store/inventory').security).toEqual([[{ scheme: 'apiKey', scopes: [] }]]);
    expect(operation('GET /health').security).toEqual([]);
  });

  it('maps nullable and enums', () => {
    const order = model.schemas.find((schema) => schema.key === 'Order')!.schema as ObjectSchema;
    const property = (name: string) => order.properties.find((candidate) => candidate.name === name)!;
    expect(property('shipDate').schema).toMatchObject({ kind: 'scalar', type: 'string', nullable: true, format: 'date-time' });
    expect(property('status').schema).toMatchObject({ kind: 'scalar', enum: ['placed', 'approved', 'delivered'] });
    expect(property('payment').schema).toMatchObject({ kind: 'union', exclusive: true, discriminator: { propertyName: 'method' } });
  });

  it('turns allOf into an intersection', () => {
    expect(model.schemas.find((schema) => schema.key === 'Pet')?.schema).toMatchObject({
      kind: 'intersection',
      description: 'A pet in the store.',
      parts: [{ kind: 'ref', target: 'NewPet' }, { kind: 'object' }],
    });
  });

  it('normalizes response status keys and resolves response $refs', () => {
    expect(operation('GET /pets').responses.map((response) => response.status)).toEqual(['200', 'default']);
    expect(operation('GET /pets').responses[1]?.content[0]?.schema).toEqual({ kind: 'ref', target: 'Error' });
  });
});

describe('buildModel (3.1 features)', async () => {
  const { model, diagnostics } = await load(path.join(FIXTURES, 'openapi-31.yaml'));
  const thing = model.schemas.find((schema) => schema.key === 'Thing')!.schema as ObjectSchema;
  const property = (name: string) => thing.properties.find((candidate) => candidate.name === name)!.schema;

  it('maps type arrays with null to nullable', () => {
    expect(property('label')).toEqual({ kind: 'scalar', type: 'string', nullable: true });
  });

  it('maps const to a single-value enum', () => {
    expect(property('kind')).toEqual({ kind: 'scalar', type: 'string', enum: ['thing'] });
  });

  it('maps multi-type arrays to unions', () => {
    expect(property('score')).toMatchObject({ kind: 'union', variants: [{ type: 'integer' }, { type: 'string' }] });
  });

  it('keeps descriptions next to $ref and collapses single-entry allOf', () => {
    expect(property('parent')).toEqual({ kind: 'ref', target: 'Thing', description: 'The parent thing.' });
    expect(property('extra')).toEqual({ kind: 'ref', target: 'Extra', description: 'Wrapped in allOf to carry a description.' });
  });

  it('lets operation-level parameters override path-level ones', () => {
    const params = model.operations[0]!.parameters;
    expect(params).toHaveLength(2);
    expect(params[1]).toMatchObject({ name: 'verbose', description: 'Operation-level parameter wins.', schema: { type: 'integer' } });
  });

  it('reads webhooks and their payloads', () => {
    expect(model.webhooks).toEqual([
      {
        key: 'newThing',
        name: 'newThing',
        method: 'post',
        summary: undefined,
        description: undefined,
        deprecated: false,
        payload: { required: false, description: undefined, content: [{ contentType: 'application/json', schema: { kind: 'ref', target: 'Thing' } }] },
      },
    ]);
    expect(diagnostics.map((item) => item.code)).not.toContain('WEBHOOKS_IGNORED');
  });
});

describe('buildModel edge cases', () => {
  const doc = (schemas: Record<string, unknown>, paths: Record<string, unknown> = {}) =>
    ({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths, components: { schemas } }) as never;

  it('expands $refs that point outside components/schemas', () => {
    const model = buildModel(
      doc({}, {
        '/a': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { n: { type: 'number' } } } } } } } } },
        '/b': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/paths/~1a/get/responses/200/content/application~1json/schema' } } } } } } },
      }),
    );
    expect(model.operations[1]?.responses[0]?.content[0]?.schema).toMatchObject({ kind: 'object', properties: [{ name: 'n' }] });
  });

  it('warns about unresolvable $refs and treats them as unknown', () => {
    const diagnostics = new Diagnostics();
    const model = buildModel(doc({ A: { $ref: '#/components/schemas/Missing' } }), diagnostics);
    expect(model.schemas[0]?.schema.kind).toBe('unknown');
    expect(diagnostics.items[0]?.code).toBe('UNRESOLVED_REF');
  });

  it('drops an empty `type: object` next to oneOf', () => {
    const model = buildModel(doc({ A: { type: 'object', oneOf: [{ type: 'string' }, { type: 'number' }] } }));
    expect(model.schemas[0]?.schema.kind).toBe('union');
  });

  it('reads 3.1-style null variants and type arrays as nullable, like 3.0', () => {
    const schema = (raw: unknown) => buildModel(doc({ B: { type: 'object' }, A: raw })).schemas[1]?.schema;
    const ref = { $ref: '#/components/schemas/B' };
    expect(schema({ anyOf: [ref, { type: 'null' }] })).toEqual({ kind: 'ref', target: 'B', nullable: true });
    expect(schema({ allOf: [ref], type: ['null'] })).toEqual({ kind: 'ref', target: 'B', nullable: true });
    expect(schema({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] })).toEqual({
      kind: 'union',
      exclusive: true,
      variants: [{ kind: 'scalar', type: 'string' }, { kind: 'scalar', type: 'number' }],
      discriminator: undefined,
      nullable: true,
    });
    // A `type` list that only repeats the variants' types adds nothing.
    expect(schema({ anyOf: [{ type: 'string' }, { type: 'integer' }], type: ['null', 'string', 'number'] })).toMatchObject({
      kind: 'union',
      nullable: true,
      variants: [{ type: 'string' }, { type: 'integer' }],
    });
    expect(schema({ type: 'null' })).toEqual({ kind: 'scalar', type: 'null', nullable: true });
  });

  it('builds the same model for a schema written the 3.0 way and the 3.1 way', () => {
    const v30 = { type: 'object', properties: { owner: { allOf: [{ $ref: '#/components/schemas/B' }], nullable: true }, tags: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], nullable: true } } };
    const v31 = { type: 'object', properties: { owner: { anyOf: [{ $ref: '#/components/schemas/B' }, { type: 'null' }] }, tags: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], type: ['null', 'string', 'array'] } } };
    const build = (raw: unknown) => buildModel(doc({ B: { type: 'object' }, A: raw }));
    expect(build(v31)).toEqual(build(v30));
  });

  it('infers enum types when `type` is missing', () => {
    const model = buildModel(doc({ A: { enum: [1, 2, null] } }));
    expect(model.schemas[0]?.schema).toEqual({ kind: 'scalar', type: 'integer', enum: [1, 2], nullable: true });
  });
});

describe('semantic validation', () => {
  it('declares undeclared path parameters as strings when validation is off', async () => {
    const spec = await loadSpec(path.join(FIXTURES, 'invalid.yaml'), { validate: false });
    const diagnostics = new Diagnostics();
    const model = buildModel(spec.document, diagnostics);
    expect(model.operations[0]?.parameters).toEqual([
      expect.objectContaining({ name: 'petId', in: 'path', required: true, schema: { kind: 'scalar', type: 'string' } }),
    ]);
    expect(diagnostics.items[0]?.code).toBe('MISSING_PATH_PARAM');
  });
});
