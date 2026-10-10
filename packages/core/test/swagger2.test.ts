import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/ir/build.js';
import type { Operation } from '../src/ir/model.js';
import { loadSpec } from '../src/spec/load.js';
import { FIXTURES } from './helpers.js';

const FIXTURE = path.join(FIXTURES, 'swagger-2.0.yaml');

describe('Swagger 2.0', () => {
  it('is validated as 2.0, then read as OpenAPI 3.0', async () => {
    const spec = await loadSpec(FIXTURE);
    expect(spec).toMatchObject({ openapiVersion: '3.0.3', dialect: '3.0', convertedFrom: '2.0' });
    const doc = spec.document as unknown as Record<string, Record<string, unknown>>;
    expect(doc['servers']).toEqual([{ url: 'https://api.example.com/v1' }, { url: 'http://api.example.com/v1' }]);
    expect(doc['components']?.['securitySchemes']).toEqual({
      basic: { type: 'http', scheme: 'basic' },
      key: { type: 'apiKey', in: 'header', name: 'X-Key' },
      oauth: {
        type: 'oauth2',
        flows: { authorizationCode: { authorizationUrl: 'https://example.com/authorize', tokenUrl: 'https://example.com/token', scopes: { 'pets:read': 'Read pets' } } },
      },
    });
  });

  it('maps parameters, bodies, forms and responses onto the model', async () => {
    const model = buildModel((await loadSpec(FIXTURE)).document);
    const op = (key: string): Operation => model.operations.find((candidate) => candidate.key === key)!;

    // csv (the 2.0 default) and multi collection formats
    expect(op('GET /pets').parameters.map(({ name, style, explode }) => ({ name, style, explode }))).toEqual([
      { name: 'limit', style: 'form', explode: true },
      { name: 'tags', style: 'form', explode: false },
      { name: 'status', style: 'form', explode: true },
    ]);
    expect(op('GET /pets').responses.map((response) => response.status)).toEqual(['200', 'default']);
    expect(op('GET /pets').responses[1]?.content[0]?.schema).toEqual({ kind: 'ref', target: 'Error' });

    expect(op('POST /pets').requestBody).toMatchObject({ required: true, content: [{ contentType: 'application/json', schema: { kind: 'ref', target: 'Pet' } }] });
    expect(op('PUT /pets/{id}').requestBody?.content.map((media) => media.contentType)).toEqual(['application/json', 'application/xml']);
    expect(op('PUT /pets/{id}').parameters).toMatchObject([{ name: 'id', in: 'path', schema: { type: 'integer', format: 'int64' } }]);

    expect(op('POST /pets/{id}/photo').requestBody).toMatchObject({
      required: true,
      content: [
        {
          contentType: 'multipart/form-data',
          schema: {
            kind: 'object',
            properties: [
              { name: 'file', required: true, schema: { kind: 'scalar', type: 'string', format: 'binary' } },
              { name: 'caption', required: false, schema: { description: 'Shown under the photo.' } },
            ],
          },
        },
      ],
    });
    // A form field referenced from #/parameters is inlined.
    expect(op('POST /login').requestBody?.content[0]).toMatchObject({
      contentType: 'application/x-www-form-urlencoded',
      schema: { properties: [{ name: 'username', required: true }, { name: 'password', required: true }] },
    });
    expect(op('POST /login').security).toEqual([]);

    const pet = model.schemas.find((named) => named.key === 'Pet')!.schema;
    expect(pet).toMatchObject({ kind: 'object', properties: expect.arrayContaining([expect.objectContaining({ name: 'tag', schema: { kind: 'scalar', type: 'string', nullable: true } })]) });
  });

  it('reports 2.0 validation errors', async () => {
    const broken = path.join(FIXTURES, 'swagger-2.0-invalid.yaml');
    await expect(loadSpec(broken)).rejects.toMatchObject({ code: 'SPEC_INVALID' });
    await expect(loadSpec(broken, { validate: false })).resolves.toMatchObject({ convertedFrom: '2.0' });
  });
});
