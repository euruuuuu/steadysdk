import { Diagnostics } from '../diagnostics.js';
import type { OpenApiDocument } from '../spec/load.js';
import {
  HTTP_METHODS,
  type ApiModel,
  type EnumValue,
  type MediaType,
  type NamedSchema,
  type Operation,
  type Parameter,
  type ParameterLocation,
  type RequestBody,
  type Response,
  type ScalarType,
  type SchemaMeta,
  type SchemaNode,
  type SecurityRequirement,
  type SecurityScheme,
  type Server,
} from './model.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const SCALAR_TYPES = new Set<string>(['string', 'number', 'integer', 'boolean', 'null']);
const COMPONENT_SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;

/** Converts a bundled OpenAPI 3.0 / 3.1 document into the normalized `ApiModel`. */
export function buildModel(document: OpenApiDocument, diagnostics: Diagnostics = new Diagnostics()): ApiModel {
  return new ModelBuilder(document as unknown as Json, diagnostics).build();
}

class ModelBuilder {
  private readonly doc: Json;
  private readonly diagnostics: Diagnostics;
  private readonly componentSchemas: Json;

  constructor(doc: Json, diagnostics: Diagnostics) {
    this.doc = doc;
    this.diagnostics = diagnostics;
    const components = isObject(doc['components']) ? doc['components'] : {};
    this.componentSchemas = isObject(components['schemas']) ? components['schemas'] : {};
  }

  build(): ApiModel {
    const info = isObject(this.doc['info']) ? this.doc['info'] : {};
    if (isObject(this.doc['webhooks']) && Object.keys(this.doc['webhooks']).length > 0) {
      this.diagnostics.info('WEBHOOKS_IGNORED', 'Webhooks are not part of the generated client and were skipped.', '#/webhooks');
    }
    return {
      title: asString(info['title']) ?? 'API',
      version: asString(info['version']) ?? '0.0.0',
      description: asString(info['description']),
      servers: this.servers(),
      tags: asArray(this.doc['tags'])
        .filter(isObject)
        .map((tag) => ({ name: asString(tag['name']) ?? '', description: asString(tag['description']) }))
        .filter((tag) => tag.name !== ''),
      operations: this.operations(),
      schemas: this.schemas(),
      securitySchemes: this.securitySchemes(),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // $ref plumbing

  private resolvePointer(ref: string): unknown {
    if (!ref.startsWith('#')) return undefined;
    let current: unknown = this.doc;
    for (const rawToken of ref.slice(1).split('/').slice(1)) {
      const token = decodeURIComponent(rawToken).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(current)) current = current[Number(token)];
      else if (isObject(current)) current = current[token];
      else return undefined;
    }
    return current;
  }

  /** Follows non-schema `$ref`s (parameters, request bodies, responses, ...) to their target. */
  private deref(value: unknown, at: string): Json | undefined {
    const seen = new Set<string>();
    let current = value;
    while (isObject(current) && typeof current['$ref'] === 'string') {
      const ref = current['$ref'];
      if (seen.has(ref)) {
        this.diagnostics.warn('CIRCULAR_REF', `Circular $ref ${ref}`, at);
        return undefined;
      }
      seen.add(ref);
      current = this.resolvePointer(ref);
      if (current === undefined) {
        this.diagnostics.warn('UNRESOLVED_REF', `Could not resolve $ref ${ref}`, at);
        return undefined;
      }
    }
    return isObject(current) ? current : undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Top-level sections

  private servers(): Server[] {
    return asArray(this.doc['servers'])
      .filter(isObject)
      .map((server) => {
        const variables = isObject(server['variables']) ? server['variables'] : {};
        const url = (asString(server['url']) ?? '/').replace(/\{([^}]+)\}/g, (match, name: string) => {
          const variable = variables[name];
          return isObject(variable) && variable['default'] !== undefined ? String(variable['default']) : match;
        });
        return { url, description: asString(server['description']) };
      });
  }

  private schemas(): NamedSchema[] {
    return Object.entries(this.componentSchemas).map(([key, raw]) => ({
      key,
      schema: this.schema(raw, `#/components/schemas/${escapePointer(key)}`, new Set()),
    }));
  }

  private securitySchemes(): SecurityScheme[] {
    const components = isObject(this.doc['components']) ? this.doc['components'] : {};
    const schemes = isObject(components['securitySchemes']) ? components['securitySchemes'] : {};
    const out: SecurityScheme[] = [];
    for (const [key, rawScheme] of Object.entries(schemes)) {
      const at = `#/components/securitySchemes/${escapePointer(key)}`;
      const scheme = this.deref(rawScheme, at);
      if (!scheme) continue;
      const description = asString(scheme['description']);
      switch (scheme['type']) {
        case 'apiKey': {
          const location = scheme['in'];
          if (location === 'header' || location === 'query' || location === 'cookie') {
            out.push({ key, type: 'apiKey', in: location, name: asString(scheme['name']) ?? key, description });
          }
          break;
        }
        case 'http':
          out.push({
            key,
            type: 'http',
            scheme: (asString(scheme['scheme']) ?? 'bearer').toLowerCase(),
            bearerFormat: asString(scheme['bearerFormat']),
            description,
          });
          break;
        case 'oauth2':
          out.push({ key, type: 'oauth2', description });
          break;
        case 'openIdConnect':
          out.push({ key, type: 'openIdConnect', url: asString(scheme['openIdConnectUrl']) ?? '', description });
          break;
        default:
          this.diagnostics.warn('UNSUPPORTED_SECURITY', `Security scheme type "${String(scheme['type'])}" is not supported`, at);
      }
    }
    return out;
  }

  private security(raw: unknown): SecurityRequirement[] {
    return asArray(raw)
      .filter(isObject)
      .map((requirement) =>
        Object.entries(requirement).map(([scheme, scopes]) => ({
          scheme,
          scopes: asArray(scopes).filter((scope): scope is string => typeof scope === 'string'),
        })),
      );
  }

  // ---------------------------------------------------------------------------------------------
  // Operations

  private operations(): Operation[] {
    const paths = isObject(this.doc['paths']) ? this.doc['paths'] : {};
    const globalSecurity = this.security(this.doc['security']);
    const operations: Operation[] = [];

    for (const [path, rawItem] of Object.entries(paths)) {
      const itemAt = `#/paths/${escapePointer(path)}`;
      const item = this.deref(rawItem, itemAt);
      if (!item) continue;
      const shared = this.parameters(item['parameters'], `${itemAt}/parameters`);

      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isObject(op)) continue;
        const at = `${itemAt}/${method}`;
        const key = `${method.toUpperCase()} ${path}`;

        const parameters = new Map<string, Parameter>();
        for (const param of [...shared, ...this.parameters(op['parameters'], `${at}/parameters`)]) {
          parameters.set(`${param.in}:${param.name}`, param);
        }
        // Only reachable with validation off; keeps the generated method callable.
        for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
          if (name === undefined || parameters.has(`path:${name}`)) continue;
          this.diagnostics.warn('MISSING_PATH_PARAM', `Path parameter {${name}} is not declared; typed as string`, at);
          parameters.set(`path:${name}`, {
            name,
            in: 'path',
            required: true,
            deprecated: false,
            schema: { kind: 'scalar', type: 'string' },
            style: 'simple',
            explode: false,
          });
        }

        operations.push({
          key,
          method,
          path,
          operationId: asString(op['operationId']),
          summary: asString(op['summary']),
          description: asString(op['description']),
          tags: asArray(op['tags']).filter((tag): tag is string => typeof tag === 'string'),
          deprecated: op['deprecated'] === true,
          parameters: [...parameters.values()],
          requestBody: this.requestBody(op['requestBody'], `${at}/requestBody`),
          responses: this.responses(op['responses'], `${at}/responses`),
          security: op['security'] === undefined ? globalSecurity : this.security(op['security']),
        });
      }
    }
    return operations;
  }

  private parameters(raw: unknown, at: string): Parameter[] {
    const out: Parameter[] = [];
    asArray(raw).forEach((rawParam, index) => {
      const paramAt = `${at}/${index}`;
      const param = this.deref(rawParam, paramAt);
      const name = asString(param?.['name']);
      const location = param?.['in'];
      if (!param || !name || !isParameterLocation(location)) {
        this.diagnostics.warn('INVALID_PARAMETER', 'Skipped a parameter without a valid name/in', paramAt);
        return;
      }
      let rawSchema = param['schema'];
      if (rawSchema === undefined && isObject(param['content'])) {
        const first = Object.values(param['content'])[0];
        rawSchema = isObject(first) ? first['schema'] : undefined;
        this.diagnostics.warn(
          'PARAMETER_CONTENT',
          `Parameter "${name}" uses \`content\`; it will be sent as a plain value`,
          paramAt,
        );
      }
      const style = asString(param['style']) ?? (location === 'query' || location === 'cookie' ? 'form' : 'simple');
      out.push({
        name,
        in: location,
        required: location === 'path' ? true : param['required'] === true,
        deprecated: param['deprecated'] === true,
        description: asString(param['description']),
        schema: this.schema(rawSchema, `${paramAt}/schema`, new Set()),
        style,
        explode: typeof param['explode'] === 'boolean' ? param['explode'] : style === 'form',
      });
    });
    return out;
  }

  private requestBody(raw: unknown, at: string): RequestBody | undefined {
    if (raw === undefined) return undefined;
    const body = this.deref(raw, at);
    if (!body) return undefined;
    return {
      required: body['required'] === true,
      description: asString(body['description']),
      content: this.content(body['content'], `${at}/content`),
    };
  }

  private responses(raw: unknown, at: string): Response[] {
    if (!isObject(raw)) return [];
    return Object.entries(raw).flatMap(([status, rawResponse]) => {
      const responseAt = `${at}/${escapePointer(status)}`;
      const response = this.deref(rawResponse, responseAt);
      if (!response) return [];
      return [
        {
          status: status.toUpperCase() === 'DEFAULT' ? 'default' : status.toUpperCase(),
          description: asString(response['description']),
          content: this.content(response['content'], `${responseAt}/content`),
        },
      ];
    });
  }

  private content(raw: unknown, at: string): MediaType[] {
    if (!isObject(raw)) return [];
    return Object.entries(raw).map(([contentType, media]) => ({
      contentType,
      schema: this.schema(isObject(media) ? media['schema'] : undefined, `${at}/${escapePointer(contentType)}/schema`, new Set()),
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Schemas

  /** `stack` holds the non-component `$ref`s being expanded inline, to detect cycles. */
  private schema(raw: unknown, at: string, stack: ReadonlySet<string>): SchemaNode {
    if (!isObject(raw)) return { kind: 'unknown' };

    const ref = asString(raw['$ref']);
    if (ref !== undefined) return this.refSchema(raw, ref, at, stack);

    const meta = this.meta(raw);
    const rawType = raw['type'];
    const types = (Array.isArray(rawType) ? rawType : rawType === undefined ? [] : [rawType]).filter(
      (type): type is string => typeof type === 'string',
    );
    if (types.includes('null') && types.length > 1) meta.nullable = true;
    const nonNullTypes = types.length > 1 ? types.filter((type) => type !== 'null') : types;

    const composed = this.composition(raw, at, stack);
    let own = this.ownSchema(raw, nonNullTypes, at, stack);
    // `type: object` next to oneOf/allOf adds nothing unless it declares properties of its own.
    if (composed && own?.kind === 'object' && own.properties.length === 0 && own.additionalProperties === undefined) {
      own = undefined;
    }

    let node: SchemaNode;
    if (composed && own) {
      node =
        composed.kind === 'intersection'
          ? { ...composed, parts: [...composed.parts, own] }
          : { kind: 'intersection', parts: [own, composed] };
    } else {
      node = composed ?? own ?? { kind: 'unknown' };
    }
    return applyMeta(node, meta);
  }

  private refSchema(raw: Json, ref: string, at: string, stack: ReadonlySet<string>): SchemaNode {
    // Siblings of $ref are ignored by 3.0 but commonly used for docs; keep the harmless ones.
    const meta: SchemaMeta = {};
    if (typeof raw['description'] === 'string') meta.description = raw['description'];
    if (raw['nullable'] === true) meta.nullable = true;
    if (raw['deprecated'] === true) meta.deprecated = true;

    const match = COMPONENT_SCHEMA_REF.exec(ref);
    if (match?.[1] !== undefined) {
      const target = decodeURIComponent(match[1]).replace(/~1/g, '/').replace(/~0/g, '~');
      if (target in this.componentSchemas) return { kind: 'ref', target, ...meta };
    }
    if (stack.has(ref)) {
      this.diagnostics.warn(
        'CIRCULAR_INLINE_SCHEMA',
        `Recursive schema ${ref} is not under components/schemas; typed as unknown`,
        at,
      );
      return { kind: 'unknown', ...meta };
    }
    const target = this.resolvePointer(ref);
    if (target === undefined) {
      this.diagnostics.warn('UNRESOLVED_REF', `Could not resolve $ref ${ref}`, at);
      return { kind: 'unknown', ...meta };
    }
    return applyMeta(this.schema(target, ref, new Set([...stack, ref])), meta);
  }

  private meta(raw: Json): SchemaMeta {
    const meta: SchemaMeta = {};
    if (typeof raw['title'] === 'string') meta.title = raw['title'];
    if (typeof raw['description'] === 'string') meta.description = raw['description'];
    if (raw['deprecated'] === true) meta.deprecated = true;
    if (raw['nullable'] === true) meta.nullable = true;
    if (raw['readOnly'] === true) meta.readOnly = true;
    if (raw['writeOnly'] === true) meta.writeOnly = true;
    if (raw['default'] !== undefined) meta.default = raw['default'];
    return meta;
  }

  /** The schema described by `type` and its keywords, ignoring allOf/oneOf/anyOf. */
  private ownSchema(raw: Json, types: string[], at: string, stack: ReadonlySet<string>): SchemaNode | undefined {
    if (types.length > 1) {
      return {
        kind: 'union',
        exclusive: true,
        variants: types.map((type) => this.ownSchema(raw, [type], at, stack) ?? { kind: 'unknown' }),
      };
    }

    const enumValues = this.enumValues(raw);
    let type = types[0];
    if (type === undefined) {
      if (isObject(raw['properties']) || raw['additionalProperties'] !== undefined) type = 'object';
      else if (raw['items'] !== undefined) type = 'array';
      else if (enumValues) type = inferEnumType(enumValues);
      else return undefined;
    }

    if (type === 'object') {
      const required = new Set(asArray(raw['required']).filter((name): name is string => typeof name === 'string'));
      const properties = isObject(raw['properties']) ? raw['properties'] : {};
      const additional = raw['additionalProperties'];
      return {
        kind: 'object',
        properties: Object.entries(properties).map(([name, schema]) => ({
          name,
          required: required.has(name),
          schema: this.schema(schema, `${at}/properties/${escapePointer(name)}`, stack),
        })),
        additionalProperties:
          typeof additional === 'boolean'
            ? additional
            : isObject(additional)
              ? this.schema(additional, `${at}/additionalProperties`, stack)
              : undefined,
      };
    }

    if (type === 'array') {
      return { kind: 'array', items: this.schema(raw['items'], `${at}/items`, stack) };
    }

    if (SCALAR_TYPES.has(type)) {
      const node: SchemaNode = { kind: 'scalar', type: type as ScalarType };
      if (typeof raw['format'] === 'string') node.format = raw['format'];
      if (enumValues) {
        const nonNull = enumValues.filter((value) => value !== null);
        if (nonNull.length !== enumValues.length && type !== 'null') node.nullable = true;
        node.enum = type === 'null' ? enumValues : nonNull;
      }
      return node;
    }

    this.diagnostics.warn('UNKNOWN_TYPE', `Unknown schema type "${type}"; typed as unknown`, at);
    return { kind: 'unknown' };
  }

  private enumValues(raw: Json): EnumValue[] | undefined {
    if (raw['const'] !== undefined && isEnumValue(raw['const'])) return [raw['const']];
    if (!Array.isArray(raw['enum'])) return undefined;
    const values = raw['enum'].filter(isEnumValue);
    return values.length > 0 ? values : undefined;
  }

  private composition(raw: Json, at: string, stack: ReadonlySet<string>): SchemaNode | undefined {
    const convert = (keyword: string): SchemaNode[] =>
      asArray(raw[keyword]).map((schema, index) => this.schema(schema, `${at}/${keyword}/${index}`, stack));

    const parts: SchemaNode[] = [];
    const allOf = convert('allOf');
    if (allOf.length > 0) parts.push(...allOf);

    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const variants = convert(keyword);
      if (variants.length === 0) continue;
      const discriminator = isObject(raw['discriminator']) ? raw['discriminator'] : undefined;
      const propertyName = asString(discriminator?.['propertyName']);
      const mapping = isObject(discriminator?.['mapping'])
        ? Object.fromEntries(
            Object.entries(discriminator['mapping']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined;
      parts.push({
        kind: 'union',
        exclusive: keyword === 'oneOf',
        variants,
        discriminator: propertyName ? { propertyName, mapping } : undefined,
      });
    }

    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    return { kind: 'intersection', parts };
  }
}

/** Merges meta onto a node; a single-part wrapper (e.g. `allOf: [$ref]`) collapses into its part. */
function applyMeta(node: SchemaNode, meta: SchemaMeta): SchemaNode {
  const merged: SchemaNode = { ...node };
  for (const [key, value] of Object.entries(meta) as Array<[keyof SchemaMeta, unknown]>) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (merged.kind === 'intersection' && merged.parts.length === 1 && merged.parts[0]) {
    const { kind: _kind, parts, ...rest } = merged;
    return applyMeta(parts[0]!, rest);
  }
  return merged;
}

function isEnumValue(value: unknown): value is EnumValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function inferEnumType(values: EnumValue[]): ScalarType {
  const nonNull = values.filter((value) => value !== null);
  if (nonNull.length === 0) return 'null';
  if (nonNull.every((value) => typeof value === 'string')) return 'string';
  if (nonNull.every((value) => typeof value === 'boolean')) return 'boolean';
  if (nonNull.every((value) => Number.isInteger(value))) return 'integer';
  if (nonNull.every((value) => typeof value === 'number')) return 'number';
  return 'string';
}

function isParameterLocation(value: unknown): value is ParameterLocation {
  return value === 'path' || value === 'query' || value === 'header' || value === 'cookie';
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
