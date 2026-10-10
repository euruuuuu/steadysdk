import { describe, expect, it } from 'vitest';
import { NamingEngine } from '../src/naming/engine.js';
import { naming, op } from './helpers.js';

const engine = (config: Record<string, unknown> = {}): NamingEngine => new NamingEngine(naming(config));

describe('operation names', () => {
  it('uses the operationId when present', () => {
    expect(engine().operationName(op('get /pets', { operationId: 'list_all_pets' }))).toBe('listAllPets');
  });

  it.each([
    ['get /users', 'listUsers'],
    ['get /users/{id}', 'getUserById'],
    ['post /users', 'createUser'],
    ['put /users/{id}', 'updateUser'],
    ['patch /users/{id}', 'patchUser'],
    ['delete /users/{id}', 'deleteUser'],
    ['delete /users', 'deleteUsers'],
    ['get /users/{userId}/posts', 'listUserPosts'],
    ['get /users/{userId}/posts/{postId}', 'getUserPostByPostId'],
    ['get /files/{bucket}/{key}', 'getFileByBucketAndKey'],
    ['post /orders/{id}/cancel', 'cancelOrder'],
    ['get /users/search', 'searchUsers'],
    ['post /v1/{name}:archive', 'archiveRoot'],
    ['get /api/v2/people', 'listPeople'],
    ['get /user-groups/{groupId}', 'getUserGroupByGroupId'],
    ['head /status', 'headStatuses'],
  ])('derives %s → %s from the path', (key, expected) => {
    expect(engine().operationName(op(key))).toBe(expected);
  });

  it('derives from the path when source is `path`, even with an operationId', () => {
    const config = { operations: { source: 'path' } };
    expect(engine(config).operationName(op('get /users/{id}', { operationId: 'UsersController_findOne' }))).toBe('getUserById');
  });

  it('applies custom templates and verbs', () => {
    const config = { operations: { templates: { get: 'fetch{Resource}' } } };
    expect(engine(config).operationName(op('get /users/{id}'))).toBe('fetchUser');
  });

  it('strips operationId prefixes', () => {
    const config = { operations: { stripPrefixes: ['^\\w+Controller_'] } };
    expect(engine(config).operationName(op('get /users/{id}', { operationId: 'UsersController_findOne' }))).toBe('findOne');
  });

  it('adds prefixes and suffixes, then applies the case style', () => {
    const config = { operations: { prefix: 'api', suffix: 'async', case: 'snake' } };
    expect(engine(config).operationName(op('get /pets', { operationId: 'listPets' }))).toBe('api_list_pets_async');
  });

  it('applies acronyms to method names', () => {
    expect(engine({ acronyms: ['ID'] }).operationName(op('get /users/{id}'))).toBe('getUserByID');
  });

  it('honours overrides by METHOD /path and by operationId', () => {
    const config = { overrides: { operations: { 'get /users/{id}': 'fetchUser', listPets: 'allPets' } } };
    expect(engine(config).operationName(op('get /users/{id}'))).toBe('fetchUser');
    expect(engine(config).operationName(op('get /pets', { operationId: 'listPets' }))).toBe('allPets');
  });

  it('rejects overrides that are not identifiers', () => {
    const config = { overrides: { operations: { listPets: 'list pets' } } };
    expect(() => engine(config).operationName(op('get /pets', { operationId: 'listPets' }))).toThrow(/not a valid identifier/);
  });

  it('uses custom pluralization rules', () => {
    const config = { pluralization: { irregular: { cactus: 'cacti' }, uncountable: ['metadata'] } };
    expect(engine(config).operationName(op('get /cactus'))).toBe('listCacti');
    expect(engine(config).operationName(op('get /metadata/{id}'))).toBe('getMetadataById');
  });

  it('can turn pluralization off', () => {
    expect(engine({ pluralization: { enabled: false } }).operationName(op('get /users/{id}'))).toBe('getUsersById');
  });
});

describe('type, group and parameter names', () => {
  it('converts schema keys to PascalCase with prefix/suffix', () => {
    expect(engine().typeName('pet-store.pet_record')).toBe('PetStorePetRecord');
    expect(engine({ types: { suffix: 'Dto' } }).typeName('Pet')).toBe('PetDto');
    expect(engine({ overrides: { schemas: { UserDTO: 'User' } } }).typeName('UserDTO')).toBe('User');
  });

  it('prefixes names that would start with a digit', () => {
    expect(engine().typeName('200Response')).toBe('_200Response');
  });

  it('names groups from tags', () => {
    const e = engine({ overrides: { groups: { 'Admin Tools': 'admin' } } });
    expect(e.groupProperty('pet-store')).toBe('petStore');
    expect(e.groupClassName('pet-store')).toBe('PetStoreApi');
    expect(e.groupProperty('Admin Tools')).toBe('admin');
    expect(e.groupClassName('Admin Tools')).toBe('AdminApi');
  });

  it('groups by tag, first path segment, or not at all', () => {
    const e = engine();
    const operation = op('get /api/v1/pets/{id}', { tags: ['animals'] });
    expect(e.groupOf(operation, 'tag')).toBe('animals');
    expect(e.groupOf(operation, 'path')).toBe('pets');
    expect(e.groupOf(operation, 'none')).toBe('');
  });

  it('converts parameter names, or preserves them', () => {
    const param = { name: 'X-Request-ID', in: 'header', required: false, deprecated: false, schema: { kind: 'unknown' }, style: 'simple', explode: false } as const;
    expect(engine().parameterName(param)).toBe('xRequestId');
    expect(engine({ parameters: { case: 'snake' } }).parameterName(param)).toBe('x_request_id');
    expect(engine({ parameters: { case: 'preserve' } }).parameterName(param)).toBe('X-Request-ID');
    expect(engine({ overrides: { parameters: { 'X-Request-ID': 'requestId' } } }).parameterName(param)).toBe('requestId');
  });

  it('derives helper type names from the method name', () => {
    expect(engine().derivedTypeName('params', 'listPets')).toBe('ListPetsParams');
    expect(engine({ derived: { response: '{Operation}Result' } }).derivedTypeName('response', 'getPet')).toBe('GetPetResult');
  });

  it('derives the client name from the title', () => {
    expect(engine().clientName(undefined, 'Swagger Petstore API')).toBe('SwaggerPetstoreClient');
    expect(engine().clientName(undefined, 'API')).toBe('ApiClient');
    expect(engine().clientName('Pets', 'whatever')).toBe('Pets');
  });
});
