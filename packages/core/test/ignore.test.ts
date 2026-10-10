import { describe, expect, it } from 'vitest';
import { ignoreSchema } from '../src/config/schema.js';
import { Diagnostics } from '../src/diagnostics.js';
import { applyIgnore } from '../src/ir/ignore.js';
import { apiModel } from './helpers.js';

const SPEC = `
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } } }
    post:
      operationId: legacyCreatePet
      tags: [pets]
      responses: { '201': { description: ok } }
  /pets/{id}:
    delete:
      operationId: deletePet
      tags: [pets, internal]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { '204': { description: ok } }
  /admin:
    get:
      operationId: adminHome
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/AdminStats' } } } } }
  /admin/users/{id}:
    get:
      operationId: adminUser
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: ok } }
components:
  schemas:
    Pet: { type: object, properties: { owner: { $ref: '#/components/schemas/Owner' } } }
    Owner: { type: object, properties: { name: { type: string } } }
    AdminStats: { type: object, properties: { count: { type: integer } } }
    Unused: { type: string }
`;

function ignore(config: Record<string, unknown>) {
  const diagnostics = new Diagnostics();
  const model = applyIgnore(apiModel(SPEC), ignoreSchema.parse(config), diagnostics);
  return { ops: model.operations.map((op) => op.key), schemas: model.schemas.map((named) => named.key), model, diagnostics: diagnostics.items };
}

describe('ignore', () => {
  it('keeps everything by default', () => {
    const result = ignore({});
    expect(result.ops).toHaveLength(5);
    expect(result.diagnostics).toEqual([]);
  });

  it('matches operations by key, method wildcard, operationId pattern, path pattern and tag', () => {
    expect(ignore({ operations: ['DELETE /pets/{id}'] }).ops).not.toContain('DELETE /pets/{id}');
    expect(ignore({ operations: ['* /pets'] }).ops).toEqual(['DELETE /pets/{id}', 'GET /admin', 'GET /admin/users/{id}']);
    expect(ignore({ operations: ['legacy*'] }).ops).not.toContain('POST /pets');
    expect(ignore({ tags: ['internal'] }).ops).not.toContain('DELETE /pets/{id}');
    // `/**` covers the path itself and everything below it; `*` stays within one segment.
    expect(ignore({ paths: ['/admin/**'] }).ops).toEqual(['GET /pets', 'POST /pets', 'DELETE /pets/{id}']);
    expect(ignore({ paths: ['/admin/*'] }).ops).toContain('GET /admin/users/{id}');
    expect(ignore({ paths: ['/admin/*/*'] }).ops).not.toContain('GET /admin/users/{id}');
  });

  it('reports entries that match nothing, and what was left out', () => {
    const { diagnostics } = ignore({ paths: ['/admn/**', '/admin'], schemas: ['Nope*'] });
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'IGNORE_UNMATCHED', message: 'ignore.paths entry "/admn/**" matches nothing in the spec' }),
      expect.objectContaining({ code: 'IGNORE_UNMATCHED', message: 'ignore.schemas entry "Nope*" matches nothing in the spec' }),
      expect.objectContaining({ level: 'info', code: 'IGNORED', message: 'Left out 1 operation (ignore config)' }),
    ]);
  });

  it('types references to an ignored schema as unknown, with a warning', () => {
    const { schemas, model, diagnostics } = ignore({ schemas: ['Own*'] });
    expect(schemas).toEqual(['Pet', 'AdminStats', 'Unused']);
    expect(model.schemas[0]?.schema).toMatchObject({ kind: 'object', properties: [{ name: 'owner', schema: { kind: 'unknown' } }] });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'IGNORED_SCHEMA_USED', message: 'Ignored schema `Owner` is used by schema `Pet`; typed as unknown there' }),
    );
  });

  it('can also drop the schemas no kept operation uses', () => {
    expect(ignore({ unusedSchemas: true }).schemas).toEqual(['Pet', 'Owner', 'AdminStats']);
    expect(ignore({ paths: ['/admin/**'], unusedSchemas: true }).schemas).toEqual(['Pet', 'Owner']);
  });
});
