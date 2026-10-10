/**
 * The intermediate representation (IR): a normalized, language-agnostic view of an OpenAPI document.
 *
 * Generators and the diff engine work on this model rather than raw OpenAPI, so 3.0 / 3.1 differences
 * (nullable vs type arrays, const, ...) and $ref plumbing are handled exactly once, in `buildModel`.
 * Names here are the *spec's* names; SDK identifiers are assigned later by the naming engine.
 */

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiModel {
  title: string;
  version: string;
  description?: string | undefined;
  servers: Server[];
  tags: Tag[];
  operations: Operation[];
  /** `components.schemas`, in document order. */
  schemas: NamedSchema[];
  securitySchemes: SecurityScheme[];
}

export interface Server {
  /** URL with server variables replaced by their defaults. */
  url: string;
  description?: string | undefined;
}

export interface Tag {
  name: string;
  description?: string | undefined;
}

export interface NamedSchema {
  /** The `components.schemas` key: the stable identity used by the name lock and the diff engine. */
  key: string;
  schema: SchemaNode;
}

export interface Operation {
  /** Stable identity, e.g. `GET /pets/{petId}`. */
  key: string;
  method: HttpMethod;
  path: string;
  operationId?: string | undefined;
  summary?: string | undefined;
  description?: string | undefined;
  tags: string[];
  deprecated: boolean;
  /** Path-level and operation-level parameters, merged (operation wins). */
  parameters: Parameter[];
  requestBody?: RequestBody | undefined;
  responses: Response[];
  /** Effective security (global default applied). Alternatives are OR-ed; `[]` means no auth. */
  security: SecurityRequirement[];
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export interface Parameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  deprecated: boolean;
  description?: string | undefined;
  schema: SchemaNode;
  /** Serialization style with OpenAPI defaults applied (`form` for query/cookie, `simple` otherwise). */
  style: string;
  explode: boolean;
}

export interface MediaType {
  contentType: string;
  schema: SchemaNode;
}

export interface RequestBody {
  required: boolean;
  description?: string | undefined;
  content: MediaType[];
}

export interface Response {
  /** `200`, `2XX`, `default`, ... */
  status: string;
  description?: string | undefined;
  content: MediaType[];
}

/** All schemes in one requirement must be satisfied together. */
export type SecurityRequirement = Array<{ scheme: string; scopes: string[] }>;

export type SecurityScheme =
  | { key: string; type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string; description?: string | undefined }
  | { key: string; type: 'http'; scheme: string; bearerFormat?: string | undefined; description?: string | undefined }
  | { key: string; type: 'oauth2'; description?: string | undefined }
  | { key: string; type: 'openIdConnect'; url: string; description?: string | undefined };

export interface SchemaMeta {
  title?: string | undefined;
  description?: string | undefined;
  deprecated?: boolean | undefined;
  nullable?: boolean | undefined;
  readOnly?: boolean | undefined;
  writeOnly?: boolean | undefined;
  default?: unknown;
}

export type ScalarType = 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type EnumValue = string | number | boolean | null;

export interface RefSchema extends SchemaMeta {
  kind: 'ref';
  /** Key into `ApiModel.schemas`. */
  target: string;
}

export interface ScalarSchema extends SchemaMeta {
  kind: 'scalar';
  type: ScalarType;
  format?: string | undefined;
  /** Allowed values; `const` is represented as a one-element enum. */
  enum?: EnumValue[] | undefined;
}

export interface ArraySchema extends SchemaMeta {
  kind: 'array';
  items: SchemaNode;
}

export interface Property {
  name: string;
  required: boolean;
  schema: SchemaNode;
}

export interface ObjectSchema extends SchemaMeta {
  kind: 'object';
  properties: Property[];
  /** `undefined` when the spec does not say; `false` = closed; a schema = typed map values. */
  additionalProperties?: SchemaNode | boolean | undefined;
}

export interface UnionSchema extends SchemaMeta {
  kind: 'union';
  /** `oneOf` is exclusive, `anyOf` is not. */
  exclusive: boolean;
  variants: SchemaNode[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> | undefined } | undefined;
}

export interface IntersectionSchema extends SchemaMeta {
  kind: 'intersection';
  parts: SchemaNode[];
}

export interface UnknownSchema extends SchemaMeta {
  kind: 'unknown';
}

export type SchemaNode =
  | RefSchema
  | ScalarSchema
  | ArraySchema
  | ObjectSchema
  | UnionSchema
  | IntersectionSchema
  | UnknownSchema;
