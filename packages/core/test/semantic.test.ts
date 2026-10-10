import { describe, expect, it } from 'vitest';
import { semanticErrors } from '../src/spec/semantic.js';

const doc = (paths: Record<string, unknown>) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths });
const ok = { responses: { '200': { description: 'ok' } } };
const pathParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });

describe('semanticErrors', () => {
  it('accepts path parameters declared at path or operation level', () => {
    expect(semanticErrors(doc({ '/a/{x}/{y}': { parameters: [pathParam('x')], get: { ...ok, parameters: [pathParam('y')] } } }))).toEqual([]);
  });

  it('reports undeclared and unused path parameters', () => {
    expect(semanticErrors(doc({ '/a/{x}': { get: { ...ok, parameters: [pathParam('y')] } } }))).toEqual([
      'GET /a/{x}: path parameter(s) {x} are not declared',
      'GET /a/{x}: path parameter(s) y do not appear in the path',
    ]);
  });

  it('reports duplicate operationIds', () => {
    expect(semanticErrors(doc({ '/a': { get: { ...ok, operationId: 'same' } }, '/b': { post: { ...ok, operationId: 'same' } } }))).toEqual([
      'POST /b: operationId "same" is already used by GET /a',
    ]);
  });
});
