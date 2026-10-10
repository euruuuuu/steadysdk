import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { Diagnostics } from '../src/diagnostics.js';
import type { ApiModel, Operation } from '../src/ir/model.js';
import { assignNames } from '../src/naming/assign.js';
import type { NameLock } from '../src/naming/lock.js';
import { op } from './helpers.js';

function model(operations: Operation[], schemas: string[] = []): ApiModel {
  return {
    title: 'Pet Store',
    version: '1.0.0',
    servers: [],
    tags: [],
    securitySchemes: [],
    operations,
    schemas: schemas.map((key) => ({ key, schema: { kind: 'unknown' } })),
  };
}

function assign(api: ApiModel, options: { lock?: NameLock; config?: Record<string, unknown> } = {}) {
  const diagnostics = new Diagnostics();
  const result = assignNames({
    model: api,
    config: configSchema.parse({ input: 'x', ...options.config }),
    lock: options.lock,
    reservedTypeNames: ['Error', 'Record'],
    reservedMemberNames: ['http'],
    derivedTypes: (operation) => (operation.parameters.length > 0 ? ['params'] : []),
    diagnostics,
  });
  return { ...result, diagnostics: diagnostics.items };
}

const methodOf = (result: ReturnType<typeof assign>, key: string): string | undefined => result.names.operations.get(key)?.method;

describe('assignNames', () => {
  it('suffixes colliding method names and warns', () => {
    const result = assign(model([op('get /pets', { operationId: 'list' }), op('get /dogs', { operationId: 'list' })]));
    expect(methodOf(result, 'GET /pets')).toBe('list');
    expect(methodOf(result, 'GET /dogs')).toBe('list2');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'NAME_COLLISION', location: 'GET /dogs' }));
  });

  it('only checks uniqueness within a group', () => {
    const result = assign(
      model([op('get /pets', { operationId: 'list', tags: ['pets'] }), op('get /dogs', { operationId: 'list', tags: ['dogs'] })]),
    );
    expect(methodOf(result, 'GET /pets')).toBe('list');
    expect(methodOf(result, 'GET /dogs')).toBe('list');
  });

  it('keeps group properties and root methods apart, and avoids reserved members', () => {
    const result = assign(model([op('get /pets', { operationId: 'pets' }), op('get /x', { operationId: 'http' }), op('get /y', { tags: ['pets'] })]));
    expect(result.names.groups.get('pets')?.property).toBe('pets');
    expect(methodOf(result, 'GET /pets')).toBe('pets2');
    expect(methodOf(result, 'GET /x')).toBe('http_');
  });

  it('renames schemas that clash with reserved names', () => {
    const result = assign(model([], ['Error', 'Pet']));
    expect(result.names.schemas.get('Error')).toBe('ErrorModel');
    expect(result.names.schemas.get('Pet')).toBe('Pet');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'NAME_RESERVED' }));
  });

  it('gives schemas priority over derived helper types', () => {
    const withParams = op('get /pets', { operationId: 'listPets', parameters: [{ name: 'limit', in: 'query', required: false, deprecated: false, schema: { kind: 'unknown' }, style: 'form', explode: true }] });
    const result = assign(model([withParams], ['ListPetsParams']));
    expect(result.names.schemas.get('ListPetsParams')).toBe('ListPetsParams');
    expect(result.names.operations.get('GET /pets')?.derived.params).toBe('ListPetsParams2');
  });

  it('records every name in the lock', () => {
    const result = assign(model([op('get /pets', { operationId: 'listPets', tags: ['pets'] })], ['Pet']));
    expect(result.lock.names).toEqual({
      client: 'PetStoreClient',
      'group:pets': 'PetsApi',
      'group:pets#property': 'pets',
      'operation:GET /pets': 'listPets',
      'schema:Pet': 'Pet',
    });
  });

  describe('with a name lock', () => {
    it('keeps existing names when a new operation would take them', () => {
      const first = assign(model([op('get /pets', { operationId: 'list' })]));
      // A new operation earlier in the document wants the same name.
      const second = assign(model([op('get /animals', { operationId: 'list' }), op('get /pets', { operationId: 'list' })]), { lock: first.lock });
      expect(methodOf(second, 'GET /pets')).toBe('list');
      expect(methodOf(second, 'GET /animals')).toBe('list2');
    });

    it('pins names when an operationId changes, and says so', () => {
      const first = assign(model([op('get /pets', { operationId: 'listPets' })]));
      const second = assign(model([op('get /pets', { operationId: 'findAllPets' })]), { lock: first.lock });
      expect(methodOf(second, 'GET /pets')).toBe('listPets');
      expect(second.diagnostics).toContainEqual(expect.objectContaining({ code: 'NAME_PINNED', location: 'GET /pets' }));
    });

    it('re-derives names when the naming config changes, and reports renames', () => {
      const first = assign(model([op('get /pets', { operationId: 'listPets' })]));
      const second = assign(model([op('get /pets', { operationId: 'listPets' })]), {
        lock: first.lock,
        config: { naming: { operations: { case: 'snake' } } },
      });
      expect(methodOf(second, 'GET /pets')).toBe('list_pets');
      expect(second.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['NAMING_CONFIG_CHANGED', 'NAME_CHANGED']));
    });

    it('drops entries for operations that no longer exist', () => {
      const first = assign(model([op('get /pets', { operationId: 'listPets' }), op('get /dogs', { operationId: 'listDogs' })]));
      const second = assign(model([op('get /pets', { operationId: 'listPets' })]), { lock: first.lock });
      expect(Object.keys(second.lock.names)).not.toContain('operation:GET /dogs');
    });

    it('ignores locked names that are not identifiers', () => {
      const first = assign(model([op('get /pets', { operationId: 'listPets' })]));
      const tampered = { ...first.lock, names: { ...first.lock.names, 'operation:GET /pets': 'not valid' } };
      expect(methodOf(assign(model([op('get /pets', { operationId: 'listPets' })]), { lock: tampered }), 'GET /pets')).toBe('listPets');
    });
  });

  it('renames a parameter that collides within an operation by its location', () => {
    const param = (location: 'path' | 'query') =>
      ({ name: 'id', in: location, required: true, deprecated: false, schema: { kind: 'unknown' }, style: location === 'query' ? 'form' : 'simple', explode: location === 'query' }) as const;
    const result = assign(model([op('get /pets/{id}', { parameters: [param('path'), param('query')] })]));
    const params = result.names.operations.get('GET /pets/{id}')?.parameters;
    expect(params?.get('path:id')).toBe('id');
    expect(params?.get('query:id')).toBe('queryId');
  });
});
