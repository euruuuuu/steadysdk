/**
 * Swagger 2.0 → OpenAPI 3.0, at the document level, so the rest of steadysdk (validation aside) only ever sees
 * OpenAPI 3. Covers what affects generated clients: body and form parameters become request bodies,
 * `consumes`/`produces` become media types, `collectionFormat` becomes `style`/`explode`, `host`/`basePath`
 * become servers, and security definitions, `x-nullable`, string discriminators and `type: file` are mapped.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
/** Keywords a 2.0 non-body parameter (or header, or items object) shares with JSON Schema. */
const SCHEMA_KEYWORDS = [
  'type', 'format', 'default', 'enum', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength',
  'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'multipleOf',
];
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

export function isSwagger2(document: unknown): boolean {
  return isObject(document) && typeof document['swagger'] === 'string' && document['swagger'].startsWith('2.');
}

export function convertSwagger2(source: Json): Json {
  const doc = inlineForeignRefs(structuredClone(source));
  const consumes = strings(doc['consumes']) ?? ['application/json'];
  const produces = strings(doc['produces']) ?? ['application/json'];
  const definitions = isObject(doc['parameters']) ? doc['parameters'] : {};
  const parameterIn = (param: Json): unknown => resolveParameter(param, definitions)['in'];

  const components: Json = {};
  if (isObject(doc['definitions'])) components['schemas'] = mapValues(doc['definitions'], convertSchema);

  const parameters: Json = {};
  const requestBodies: Json = {};
  for (const [name, param] of Object.entries(definitions)) {
    if (!isObject(param)) continue;
    if (param['in'] === 'body') requestBodies[name] = bodyFrom(param, consumes);
    else if (param['in'] !== 'formData') parameters[name] = convertParameter(param);
    // Form fields have no component equivalent in OpenAPI 3; references to them are inlined below.
  }
  if (Object.keys(parameters).length > 0) components['parameters'] = parameters;
  if (Object.keys(requestBodies).length > 0) components['requestBodies'] = requestBodies;
  if (isObject(doc['responses'])) components['responses'] = mapValues(doc['responses'], (response) => convertResponse(response, produces));
  if (isObject(doc['securityDefinitions'])) components['securitySchemes'] = mapValues(doc['securityDefinitions'], convertSecurityScheme);

  const paths: Json = {};
  for (const [route, rawItem] of Object.entries(isObject(doc['paths']) ? doc['paths'] : {})) {
    if (!isObject(rawItem)) continue;
    const shared = Array.isArray(rawItem['parameters']) ? rawItem['parameters'].filter(isObject) : [];
    const item: Json = copyExtensions(rawItem);
    for (const key of ['summary', 'description']) if (rawItem[key] !== undefined) item[key] = rawItem[key];
    const sharedPlain = shared.filter((param) => !['body', 'formData'].includes(String(parameterIn(param))));
    if (sharedPlain.length > 0) item['parameters'] = sharedPlain.map((param) => convertParameter(param));

    for (const method of HTTP_METHODS) {
      const op = rawItem[method];
      if (!isObject(op)) continue;
      const own = Array.isArray(op['parameters']) ? op['parameters'].filter(isObject) : [];
      const opConsumes = strings(op['consumes']) ?? consumes;
      const opProduces = strings(op['produces']) ?? produces;
      const converted: Json = copyExtensions(op);
      for (const key of ['tags', 'summary', 'description', 'externalDocs', 'operationId', 'deprecated', 'security']) {
        if (op[key] !== undefined) converted[key] = op[key];
      }
      const plain = own.filter((param) => !['body', 'formData'].includes(String(parameterIn(param))));
      if (plain.length > 0) converted['parameters'] = plain.map((param) => convertParameter(param));

      // Body and form parameters may come from the path item too; the operation's win (same name and location).
      const byKey = new Map<string, Json>();
      for (const param of [...shared, ...own]) {
        const resolved = resolveParameter(param, definitions);
        if (resolved['in'] === 'body' || resolved['in'] === 'formData') byKey.set(`${String(resolved['in'])}:${String(resolved['name'])}`, param);
      }
      const special = [...byKey.values()];
      const body = special.find((param) => resolveParameter(param, definitions)['in'] === 'body');
      const form = special.map((param) => resolveParameter(param, definitions)).filter((param) => param['in'] === 'formData');
      if (body) {
        converted['requestBody'] = typeof body['$ref'] === 'string' ? { $ref: `#/components/requestBodies/${refName(body['$ref'])}` } : bodyFrom(body, opConsumes);
      } else if (form.length > 0) {
        converted['requestBody'] = formBody(form, opConsumes);
      }

      converted['responses'] = mapValues(isObject(op['responses']) ? op['responses'] : {}, (response) => convertResponse(response, opProduces));
      item[method] = converted;
    }
    paths[route] = item;
  }

  const out: Json = { openapi: '3.0.3', info: doc['info'] ?? { title: 'API', version: '0.0.0' } };
  for (const key of ['tags', 'externalDocs', 'security']) if (doc[key] !== undefined) out[key] = doc[key];
  out['servers'] = servers(doc);
  out['paths'] = paths;
  if (Object.keys(components).length > 0) out['components'] = components;
  Object.assign(out, copyExtensions(doc));
  return rewriteRefs(out) as Json;
}

/** Requests without a declared host go to wherever the spec is served from: a relative server URL. */
function servers(doc: Json): Json[] {
  const basePath = typeof doc['basePath'] === 'string' ? doc['basePath'] : '/';
  if (typeof doc['host'] !== 'string') return [{ url: basePath }];
  const schemes = (strings(doc['schemes']) ?? ['https']).sort((a, b) => Number(b === 'https') - Number(a === 'https'));
  return schemes.map((scheme) => ({ url: `${scheme}://${doc['host']}${basePath === '/' ? '' : basePath}` }));
}

function convertParameter(param: Json): Json {
  if (typeof param['$ref'] === 'string') return { $ref: param['$ref'] };
  const out: Json = copyExtensions(param);
  for (const key of ['name', 'in', 'description', 'required', 'allowEmptyValue']) if (param[key] !== undefined) out[key] = param[key];
  out['schema'] = schemaFromSimple(param);
  if (param['type'] === 'array') {
    const format = typeof param['collectionFormat'] === 'string' ? param['collectionFormat'] : 'csv';
    const location = param['in'];
    if (format === 'multi') {
      out['style'] = 'form';
      out['explode'] = true;
    } else if (format === 'ssv' && location === 'query') {
      out['style'] = 'spaceDelimited';
      out['explode'] = false;
    } else if (format === 'pipes' && location === 'query') {
      out['style'] = 'pipeDelimited';
      out['explode'] = false;
    } else {
      // csv (the 2.0 default): comma-separated, which OpenAPI 3 spells `explode: false`.
      out['style'] = location === 'query' || location === 'cookie' ? 'form' : 'simple';
      out['explode'] = false;
    }
  }
  return out;
}

/** The JSON Schema of a non-body parameter, header or items object. */
function schemaFromSimple(simple: Json): Json {
  if (simple['type'] === 'file') return { type: 'string', format: 'binary' };
  const schema: Json = {};
  for (const key of SCHEMA_KEYWORDS) if (simple[key] !== undefined) schema[key] = simple[key];
  if (isObject(simple['items'])) schema['items'] = schemaFromSimple(simple['items']);
  if (simple['x-nullable'] === true) schema['nullable'] = true;
  return schema;
}

function bodyFrom(param: Json, consumes: readonly string[]): Json {
  const schema = convertSchema(param['schema'] ?? {});
  const types = consumes.filter((type) => !FORM_TYPES.includes(type));
  const out: Json = { content: Object.fromEntries((types.length > 0 ? types : ['application/json']).map((type) => [type, { schema }])) };
  if (param['description'] !== undefined) out['description'] = param['description'];
  if (param['required'] === true) out['required'] = true;
  return out;
}

/** formData parameters → one object schema, sent as multipart when files are involved. */
function formBody(fields: Json[], consumes: readonly string[]): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const field of fields) {
    const name = String(field['name']);
    const schema = schemaFromSimple(field);
    if (field['description'] !== undefined) schema['description'] = field['description'];
    properties[name] = schema;
    if (field['required'] === true) required.push(name);
  }
  const hasFile = fields.some((field) => field['type'] === 'file');
  const declared = consumes.filter((type) => FORM_TYPES.includes(type));
  const types = hasFile ? ['multipart/form-data'] : declared.length > 0 ? declared : ['application/x-www-form-urlencoded'];
  const schema: Json = { type: 'object', properties };
  if (required.length > 0) schema['required'] = required;
  return { content: Object.fromEntries(types.map((type) => [type, { schema }])), ...(required.length > 0 && { required: true }) };
}

function convertResponse(raw: unknown, produces: readonly string[]): unknown {
  if (!isObject(raw)) return raw;
  if (typeof raw['$ref'] === 'string') return { $ref: raw['$ref'] };
  const out: Json = { ...copyExtensions(raw), description: typeof raw['description'] === 'string' ? raw['description'] : '' };
  if (isObject(raw['headers'])) {
    out['headers'] = mapValues(raw['headers'], (header) =>
      isObject(header) ? { ...(header['description'] !== undefined && { description: header['description'] }), schema: schemaFromSimple(header) } : header,
    );
  }
  if (raw['schema'] !== undefined) {
    const schema = convertSchema(raw['schema']);
    out['content'] = Object.fromEntries((produces.length > 0 ? produces : ['application/json']).map((type) => [type, { schema }]));
  }
  return out;
}

/** 2.0 schema quirks: `x-nullable`, string discriminators, `type: file`. `$ref`s are rewritten afterwards. */
function convertSchema(raw: unknown): Json {
  if (!isObject(raw)) return {};
  if (raw['type'] === 'file') return { type: 'string', format: 'binary' };
  const out: Json = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'x-nullable') {
      if (value === true) out['nullable'] = true;
    } else if (key === 'discriminator' && typeof value === 'string') {
      out['discriminator'] = { propertyName: value };
    } else if (key === 'properties' && isObject(value)) {
      out[key] = mapValues(value, convertSchema);
    } else if ((key === 'items' || key === 'additionalProperties' || key === 'not') && isObject(value)) {
      out[key] = convertSchema(value);
    } else if (key === 'allOf' && Array.isArray(value)) {
      out[key] = value.map(convertSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function convertSecurityScheme(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const description = raw['description'] === undefined ? {} : { description: raw['description'] };
  switch (raw['type']) {
    case 'basic':
      return { type: 'http', scheme: 'basic', ...description };
    case 'apiKey':
      return { type: 'apiKey', in: raw['in'], name: raw['name'], ...description };
    case 'oauth2': {
      const flow = { implicit: 'implicit', password: 'password', application: 'clientCredentials', accessCode: 'authorizationCode' }[String(raw['flow'])] ?? 'implicit';
      const settings: Json = { scopes: isObject(raw['scopes']) ? raw['scopes'] : {} };
      if (raw['authorizationUrl'] !== undefined) settings['authorizationUrl'] = raw['authorizationUrl'];
      if (raw['tokenUrl'] !== undefined) settings['tokenUrl'] = raw['tokenUrl'];
      return { type: 'oauth2', flows: { [flow]: settings }, ...description };
    }
    default:
      return raw;
  }
}

function resolveParameter(param: Json, definitions: Json): Json {
  if (typeof param['$ref'] !== 'string') return param;
  const target = definitions[refName(param['$ref'])];
  return isObject(target) ? target : param;
}

/** Points 2.0 component references at their OpenAPI 3 locations. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string') {
      out[key] = item
        .replace(/^#\/definitions\//, '#/components/schemas/')
        .replace(/^#\/responses\//, '#/components/responses/')
        .replace(/^#\/parameters\//, '#/components/parameters/');
    } else {
      out[key] = rewriteRefs(item);
    }
  }
  return out;
}

/**
 * Bundling can leave `$ref`s pointing into other parts of the document (`#/paths/...`), whose shape changes
 * in the conversion. Those are inlined first; references to definitions, parameters and responses are kept.
 */
function inlineForeignRefs(doc: Json): Json {
  const KEPT = /^#\/(definitions|parameters|responses|securityDefinitions)\//;
  const resolve = (pointer: string): unknown => {
    let current: unknown = doc;
    for (const token of pointer.slice(2).split('/')) {
      const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
      current = isObject(current) ? current[key] : Array.isArray(current) ? current[Number(key)] : undefined;
    }
    return current;
  };
  const visit = (value: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, seen));
    if (!isObject(value)) return value;
    const ref = value['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/') && !KEPT.test(ref) && !seen.has(ref)) {
      const target = resolve(ref);
      if (target !== undefined) return visit(structuredClone(target), new Set([...seen, ref]));
    }
    return mapValues(value, (item) => visit(item, seen));
  };
  return visit(doc, new Set()) as Json;
}

function refName(ref: string): string {
  return decodeURIComponent(ref.slice(ref.lastIndexOf('/') + 1)).replace(/~1/g, '/').replace(/~0/g, '~');
}

function copyExtensions(value: Json): Json {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith('x-')));
}

function mapValues(value: Json, map: (item: unknown) => unknown): Json {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item)]));
}
