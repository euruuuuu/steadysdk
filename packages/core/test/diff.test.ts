import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffModels } from '../src/diff/diff.js';
import { renderChangelog, serializeDiff } from '../src/diff/render.js';
import type { ApiDiff } from '../src/diff/types.js';
import { buildModel } from '../src/ir/build.js';
import { loadSpec } from '../src/spec/load.js';
import { apiModel as api, PETSTORE_DIR } from './helpers.js';

function diff(from: string, to: string): ApiDiff {
  return diffModels(api(from), api(to));
}

/** `! kind subject: message` per change; `!` marks breaking ones. */
function lines(from: string, to: string): string[] {
  return diff(from, to).changes.map((change) => {
    const subject = change.operation ?? change.schema ?? change.securityScheme ?? 'API';
    return `${change.breaking ? '!' : ' '} ${change.kind} ${subject}: ${change.message}`;
  });
}

/** An operation with the given YAML (indented under the method) and a component section. */
function op(operation: string, components = '', method = 'get', route = '/things'): string {
  const indented = operation
    .trim()
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return `paths:\n  ${route}:\n    ${method}:\n${indented}\n${components}`;
}

const OK = `responses:\n  '200': { description: ok }`;

describe('operations', () => {
  it('reports added (non-breaking) and removed (breaking) endpoints', () => {
    expect(lines(op(OK, '', 'get', '/a'), op(OK, '', 'get', '/b'))).toEqual([
      '  operation-added GET /b: Endpoint added.',
      '! operation-removed GET /a: Endpoint removed.',
    ]);
  });

  it('reports deprecation and operationId changes as non-breaking', () => {
    expect(lines(op(`operationId: listThings\n${OK}`), op(`operationId: findThings\ndeprecated: true\n${OK}`))).toEqual([
      '  operation-id-changed GET /things: operationId changed from `listThings` to `findThings`.',
      '  deprecated GET /things: Endpoint is now deprecated.',
    ]);
  });

  it('reads a renamed path parameter as a rename, not as a removed and an added endpoint', () => {
    const param = (name: string) => `parameters:\n  - { name: ${name}, in: path, required: true, schema: { type: string } }\n${OK}`;
    expect(lines(op(param('petId'), '', 'get', '/pets/{petId}'), op(param('id'), '', 'get', '/pets/{id}'))).toEqual([
      '! parameter-renamed GET /pets/{id}: Path parameter `petId` was renamed to `id`.',
    ]);
  });

  it('ignores documentation-only edits', () => {
    expect(lines(op(`summary: List things\n${OK}`), op(`summary: List all things\ndescription: Paged.\n${OK}`))).toEqual([]);
  });
});

describe('parameters', () => {
  const query = (extra: string) => op(`parameters:\n  - { name: limit, in: query${extra} }\n${OK}`);

  it('classifies added parameters by whether they are required', () => {
    expect(lines(op(OK), query(', schema: { type: integer }'))).toEqual(['  parameter-added GET /things: Optional query parameter `limit` was added.']);
    expect(lines(op(OK), query(', required: true, schema: { type: integer }'))).toEqual([
      '! parameter-added GET /things: Required query parameter `limit` was added.',
    ]);
  });

  it('treats removing a parameter or making it required as breaking', () => {
    expect(lines(query(', schema: { type: integer }'), op(OK))).toEqual(['! parameter-removed GET /things: Query parameter `limit` was removed.']);
    expect(lines(query(', schema: { type: integer }'), query(', required: true, schema: { type: integer }'))).toEqual([
      '! parameter-required GET /things: Query parameter `limit` is now required.',
    ]);
    expect(lines(query(', required: true, schema: { type: integer }'), query(', schema: { type: integer }'))).toEqual([
      '  parameter-optional GET /things: Query parameter `limit` is now optional.',
    ]);
  });

  it('compares parameter schemas as request data', () => {
    expect(lines(query(', schema: { type: integer }'), query(', schema: { type: string }'))).toEqual([
      '! type-changed GET /things: Query parameter `limit`: type changed from `integer` to `string`.',
    ]);
    // Accepting more values is fine for requests; accepting fewer is not.
    expect(lines(query(', schema: { type: string, enum: [a] }'), query(', schema: { type: string, enum: [a, b] }'))).toEqual([
      '  enum-value-added GET /things: Query parameter `limit`: enum value `b` was added.',
    ]);
    expect(lines(query(', schema: { type: string, enum: [a, b] }'), query(', schema: { type: string, enum: [a] }'))).toEqual([
      '! enum-value-removed GET /things: Query parameter `limit`: enum value `b` was removed.',
    ]);
  });

  it('treats a serialization change as breaking', () => {
    const array = (explode: boolean) => query(`, explode: ${explode}, schema: { type: array, items: { type: string } }`);
    expect(lines(array(true), array(false))).toEqual([
      '! parameter-style-changed GET /things: Query parameter `limit` is now serialized as `form` (was `form, explode`).',
    ]);
  });
});

describe('request bodies', () => {
  const body = (schema: string, extra = '') =>
    op(`requestBody:\n  ${extra}content:\n    application/json:\n      schema: ${schema}\n${OK}`, '', 'post');

  it('classifies new request properties by whether they are required', () => {
    const before = body('{ type: object, properties: { name: { type: string } } }');
    expect(lines(before, body('{ type: object, required: [age], properties: { name: { type: string }, age: { type: integer } } }'))).toEqual([
      '! property-added POST /things: Request body: required property `age` was added.',
    ]);
    expect(lines(before, body('{ type: object, properties: { name: { type: string }, age: { type: integer } } }'))).toEqual([
      '  property-added POST /things: Request body: optional property `age` was added.',
    ]);
  });

  it('reports required flags and media types', () => {
    const schema = '{ type: string }';
    expect(lines(body(schema), body(schema, 'required: true\n  '))).toEqual(['! request-body-required POST /things: Request body is now required.']);
    expect(lines(op(OK, '', 'post'), body(schema))).toEqual(['  request-body-added POST /things: Optional request body was added.']);
    expect(lines(body(schema), op(OK, '', 'post'))).toEqual(['! request-body-removed POST /things: Request body was removed.']);

    const both = op(
      `requestBody:\n  content:\n    application/json: { schema: { type: string } }\n    application/xml: { schema: { type: string } }\n${OK}`,
      '',
      'post',
    );
    expect(lines(both, body(schema))).toEqual(['! media-type-removed POST /things: Request body: `application/xml` is no longer accepted.']);
    expect(lines(body(schema), both)).toEqual(['  media-type-added POST /things: Request body: `application/xml` is now accepted.']);
  });
});

describe('responses', () => {
  const returns = (schema: string, status = '200') =>
    op(`responses:\n  '${status}':\n    description: ok\n    content:\n      application/json:\n        schema: ${schema}`);

  it('treats new success statuses as breaking and new error statuses as not', () => {
    const base = returns('{ type: string }');
    expect(lines(base, op(`responses:\n  '200': { description: ok, content: { application/json: { schema: { type: string } } } }\n  '202': { description: queued }`))).toEqual([
      '! response-added GET /things: Can now respond with `202`.',
    ]);
    expect(lines(base, op(`responses:\n  '200': { description: ok, content: { application/json: { schema: { type: string } } } }\n  '404': { description: missing }`))).toEqual([
      '  response-added GET /things: Documents a `404` response.',
    ]);
  });

  it('compares response schemas as response data', () => {
    const object = (props: string, required = '[]') => returns(`{ type: object, required: ${required}, properties: { ${props} } }`);
    expect(lines(object('id: { type: string }, name: { type: string }'), object('id: { type: string }'))).toEqual([
      '! property-removed GET /things: Response `200`: property `name` was removed.',
    ]);
    expect(lines(object('id: { type: string }', '[id]'), object('id: { type: string }'))).toEqual([
      '! property-optional GET /things: Response `200`: property `id` is now optional.',
    ]);
    expect(lines(object('id: { type: string }'), object('id: { type: string }', '[id]'))).toEqual([
      '  property-required GET /things: Response `200`: property `id` is now required.',
    ]);
    expect(lines(object('id: { type: string }'), object('id: { type: string, nullable: true }'))).toEqual([
      '! nullable-added GET /things: Response `200`: `id` can now be null.',
    ]);
    // Clients may not handle a value they have never seen.
    expect(lines(returns('{ type: string, enum: [a] }'), returns('{ type: string, enum: [a, b] }'))).toEqual([
      '! enum-value-added GET /things: Response `200`: enum value `b` was added.',
    ]);
  });

  it('applies the direction to number widening and to new union variants', () => {
    expect(lines(returns('{ type: integer }'), returns('{ type: number }'))).toEqual([
      '! type-changed GET /things: Response `200`: type changed from `integer` to `number`.',
    ]);
    expect(lines(returns('{ type: string }'), returns('{ oneOf: [{ type: string }, { type: integer }] }'))).toEqual([
      '! variant-added GET /things: Response `200`: variant `integer` was added.',
    ]);
    const param = (schema: string) => op(`parameters:\n  - { name: q, in: query, schema: ${schema} }\n${OK}`);
    expect(lines(param('{ type: integer }'), param('{ type: number }'))).toEqual([
      '  type-changed GET /things: Query parameter `q`: type changed from `integer` to `number`.',
    ]);
    expect(lines(param('{ type: string }'), param('{ oneOf: [{ type: string }, { type: integer }] }'))).toEqual([
      '  variant-added GET /things: Query parameter `q`: variant `integer` was added.',
    ]);
  });

  it('follows array items and map values', () => {
    expect(lines(returns('{ type: array, items: { type: object, properties: { id: { type: string } } } }'), returns('{ type: array, items: { type: object, properties: {} } }'))).toEqual([
      '! property-removed GET /things: Response `200`: property `[].id` was removed.',
    ]);
    expect(lines(returns('{ type: object, additionalProperties: { type: integer } }'), returns('{ type: object, additionalProperties: { type: string } }'))).toEqual([
      '! type-changed GET /things: Response `200`: type of `{}` changed from `integer` to `string`.',
    ]);
  });

  it('separates format changes that change the SDK type from those that do not', () => {
    expect(lines(returns('{ type: integer, format: int32 }'), returns('{ type: integer, format: int64 }'))).toEqual([
      '  format-changed GET /things: Response `200`: format changed from `int32` to `int64`.',
    ]);
    expect(lines(returns('{ type: string }'), returns('{ type: string, format: binary }'))).toEqual([
      '! format-changed GET /things: Response `200`: format changed from none to `binary`.',
    ]);
  });
});

describe('component schemas', () => {
  const usedIn = (where: 'request' | 'response' | 'both' | 'none', schema: string) => {
    const ref = `{ $ref: '#/components/schemas/Status' }`;
    const request = `parameters:\n  - { name: status, in: query, schema: ${ref} }`;
    const response = `responses:\n  '200': { description: ok, content: { application/json: { schema: ${ref} } } }`;
    const operation =
      where === 'request' ? `${request}\n${OK}` : where === 'response' ? response : where === 'both' ? `${request}\n${response}` : OK;
    return op(operation, `components:\n  schemas:\n    Status: ${schema}`);
  };

  it('judges a change by where the component is used', () => {
    const before = '{ type: string, enum: [on, off] }';
    const after = '{ type: string, enum: [on, off, paused] }';
    expect(lines(usedIn('request', before), usedIn('request', after))).toEqual(['  enum-value-added Status: Enum value `paused` was added.']);
    expect(lines(usedIn('response', before), usedIn('response', after))).toEqual(['! enum-value-added Status: Enum value `paused` was added.']);
    expect(lines(usedIn('both', before), usedIn('both', after))).toEqual(['! enum-value-added Status: Enum value `paused` was added.']);
    // An unused component is still an exported SDK type: assume both directions.
    expect(lines(usedIn('none', before), usedIn('none', after))).toEqual(['! enum-value-added Status: Enum value `paused` was added.']);
  });

  it('lists the operations that use a changed component', () => {
    const [change] = diff(usedIn('both', '{ type: string }'), usedIn('both', '{ type: integer }')).changes;
    expect(change).toMatchObject({ scope: 'schema', schema: 'Status', kind: 'type-changed', affects: ['GET /things'] });
  });

  it('reports changes inside a component once, on the component', () => {
    const spec = (props: string) =>
      op(
        `requestBody:\n  content:\n    application/json: { schema: { $ref: '#/components/schemas/Pet' } }\n${OK}`,
        `components:\n  schemas:\n    Pet: { type: object, properties: { ${props} } }\n    Owner: { type: object, properties: { pet: { $ref: '#/components/schemas/Pet' } } }`,
        'post',
      );
    expect(lines(spec('name: { type: string }'), spec('name: { type: string }, age: { type: integer }'))).toEqual([
      '  property-added Pet: Optional property `age` was added.',
    ]);
  });

  it('reports a renamed component with the same shape as a reference change at its use sites', () => {
    const spec = (name: string) =>
      returnsRef(name, `components:\n  schemas:\n    ${name}: { type: object, properties: { id: { type: string } } }`);
    expect(lines(spec('Pet'), spec('Animal'))).toEqual([
      '  reference-changed GET /things: Response `200`: now uses `Animal` instead of `Pet`.',
      '  schema-added Animal: Added.',
      '! schema-removed Pet: Removed.',
    ]);
  });

  it('treats extracting an inline schema into a component as non-breaking', () => {
    const inline = op(`responses:\n  '200': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: string } } } } } }`);
    const extracted = returnsRef('Thing', `components:\n  schemas:\n    Thing: { type: object, properties: { id: { type: string } } }`);
    expect(lines(inline, extracted)).toEqual([
      '  reference-changed GET /things: Response `200`: now uses `Thing` instead of an inline schema.',
      '  schema-added Thing: Added.',
    ]);
  });

  it('compares a flattened allOf property by property', () => {
    const composed = `components:\n  schemas:\n    Base: { type: object, required: [id], properties: { id: { type: string } } }\n    Pet:\n      allOf:\n        - $ref: '#/components/schemas/Base'\n        - { type: object, properties: { name: { type: string } } }`;
    const flat = `components:\n  schemas:\n    Base: { type: object, required: [id], properties: { id: { type: string } } }\n    Pet: { type: object, required: [id], properties: { id: { type: string }, name: { type: string }, age: { type: integer } } }`;
    expect(lines(returnsRef('Pet', composed), returnsRef('Pet', flat))).toEqual(['  property-added Pet: Optional property `age` was added.']);
  });

  it('terminates on recursive schemas', () => {
    const tree = (name: string) =>
      returnsRef(name, `components:\n  schemas:\n    ${name}: { type: object, properties: { children: { type: array, items: { $ref: '#/components/schemas/${name}' } } } }`);
    expect(lines(tree('Node'), tree('TreeNode'))).toEqual([
      '  reference-changed GET /things: Response `200`: now uses `TreeNode` instead of `Node`.',
      '  schema-added TreeNode: Added.',
      '! schema-removed Node: Removed.',
    ]);
  });

  it('reports additional properties, defaults and deprecations', () => {
    const schema = (extra: string) => usedIn('response', `{ type: object, properties: { n: { type: integer${extra} } }, additionalProperties: false }`);
    const open = usedIn('response', '{ type: object, properties: { n: { type: integer } } }');
    expect(lines(schema(''), open)).toEqual(['! additional-properties-changed Status: The object now allows additional properties.']);
    expect(lines(schema(', default: 1'), schema(', default: 2, deprecated: true'))).toEqual([
      '  deprecated Status: `n` is now deprecated.',
      '  default-changed Status: Default of `n` changed from `1` to `2`.',
    ]);
  });
});

/** `GET /things` returning the given component. */
function returnsRef(name: string, components: string): string {
  return op(`responses:\n  '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/${name}' } } } }`, components);
}

describe('security and servers', () => {
  const secured = (security: string, schemes = 'bearer: { type: http, scheme: bearer }') =>
    `security: ${security}\npaths:\n  /a: { get: { responses: { '200': { description: ok } } } }\n  /b: { get: { responses: { '200': { description: ok } } } }\ncomponents:\n  securitySchemes:\n    ${schemes}\n    key: { type: apiKey, in: header, name: X-Key }`;

  it('reports a global security change once', () => {
    expect(lines(secured('[]'), secured('[{ bearer: [] }]'))).toEqual(['! security-changed API: Every endpoint: authentication changed from none to `bearer`.']);
  });

  it('treats an extra way to authenticate as non-breaking', () => {
    expect(lines(secured('[{ bearer: [] }]'), secured('[{ bearer: [] }, { key: [] }]'))).toEqual([
      '  security-changed API: Every endpoint: authentication changed from `bearer` to `bearer` or `key`.',
    ]);
  });

  it('reports changed and removed security schemes', () => {
    expect(lines(secured('[]'), secured('[]', 'bearer: { type: http, scheme: basic }'))).toEqual([
      '! security-scheme-changed bearer: Changed from HTTP `bearer` authentication to HTTP `basic` authentication.',
    ]);
    expect(lines(secured('[]'), secured('[]', 'other: { type: http, scheme: bearer }'))).toEqual([
      '  security-scheme-added other: Added: HTTP `bearer` authentication.',
      '! security-scheme-removed bearer: Removed.',
    ]);
  });

  it('reports the default server URL', () => {
    expect(lines('servers: [{ url: https://a.example.com }]', 'servers: [{ url: https://b.example.com }]')).toEqual([
      '  server-changed API: Default server URL changed from `https://a.example.com` to `https://b.example.com`.',
    ]);
  });
});

describe('output', () => {
  const before = op(`operationId: listThings\nparameters:\n  - { name: limit, in: query, schema: { type: integer } }\n${OK}`);
  const after = `${op(`operationId: listThings\nparameters:\n  - { name: limit, in: query, required: true, schema: { type: integer } }\n  - { name: q, in: query, schema: { type: string } }\n${OK}`)}`;

  it('renders a Markdown changelog with breaking changes first', () => {
    const result = diffModels(api(before), api(`info: { title: Test, version: 1.1.0 }\n${after}`));
    expect(renderChangelog(result)).toBe(
      [
        '## Test 1.0.0 → 1.1.0',
        '',
        '**1 breaking change**, 1 non-breaking change.',
        '',
        '### Breaking changes',
        '',
        '- **`GET /things`** (`listThings`): query parameter `limit` is now required.',
        '',
        '### Non-breaking changes',
        '',
        '- **`GET /things`** (`listThings`): optional query parameter `q` was added.',
        '',
      ].join('\n'),
    );
    expect(renderChangelog(diff(before, before))).toBe('## Test 1.0.0\n\nNo API changes.\n');
  });

  it('serializes to versioned JSON with a fixed key order', () => {
    const json = JSON.parse(serializeDiff(diff(before, after))) as ApiDiff;
    expect(json).toMatchObject({ version: 1, summary: { breaking: 1, nonBreaking: 1 } });
    expect(Object.keys(json.changes[0]!)).toEqual(['kind', 'breaking', 'scope', 'operation', 'operationId', 'location', 'message']);
  });
});

describe('examples/petstore/next', () => {
  it('CHANGELOG.md is up to date (run `npm run examples` after intended changes)', async () => {
    const load = async (file: string) => buildModel((await loadSpec(path.join(PETSTORE_DIR, file))).document);
    const changelog = renderChangelog(diffModels(await load('openapi.yaml'), await load('next/openapi.yaml')));
    expect(await readFile(path.join(PETSTORE_DIR, 'next/CHANGELOG.md'), 'utf8')).toBe(changelog);
  });
});
