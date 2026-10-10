import { HTTP_METHODS } from '../ir/model.js';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Rules the OpenAPI JSON Schema cannot express but generated code depends on.
 * Expects a dereferenced document (as returned by swagger-parser's validate).
 */
export function semanticErrors(document: unknown): string[] {
  const errors: string[] = [];
  const paths = isObject(document) && isObject(document['paths']) ? document['paths'] : {};
  const operationIds = new Map<string, string>();

  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    const shared = pathParams(item['parameters']);

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const declared = new Set([...shared, ...pathParams(op['parameters'])]);

      const missing = templated.filter((name) => !declared.has(name));
      if (missing.length > 0) errors.push(`${key}: path parameter(s) ${missing.map((name) => `{${name}}`).join(', ')} are not declared`);
      const unused = [...declared].filter((name) => !templated.includes(name));
      if (unused.length > 0) errors.push(`${key}: path parameter(s) ${unused.join(', ')} do not appear in the path`);

      if (typeof op['operationId'] === 'string') {
        const previous = operationIds.get(op['operationId']);
        if (previous) errors.push(`${key}: operationId "${op['operationId']}" is already used by ${previous}`);
        else operationIds.set(op['operationId'], key);
      }
    }
  }
  return errors;
}

function pathParams(parameters: unknown): string[] {
  return (Array.isArray(parameters) ? parameters : [])
    .filter(isObject)
    .filter((param) => param['in'] === 'path' && typeof param['name'] === 'string')
    .map((param) => param['name'] as string);
}
