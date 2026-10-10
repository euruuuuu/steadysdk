/**
 * Result types of the diff engine. The JSON form of `ApiDiff` is a public, versioned format
 * (`apisteady diff --json`, `apisteady changelog --json`), so fields are only ever added.
 */

export const DIFF_FORMAT_VERSION = 1;

export type ChangeKind =
  // Operations
  | 'operation-added'
  | 'operation-removed'
  | 'operation-id-changed'
  | 'security-changed'
  // Parameters
  | 'parameter-added'
  | 'parameter-removed'
  | 'parameter-renamed'
  | 'parameter-required'
  | 'parameter-optional'
  | 'parameter-style-changed'
  // Request bodies and responses
  | 'request-body-added'
  | 'request-body-removed'
  | 'request-body-required'
  | 'request-body-optional'
  | 'response-added'
  | 'response-removed'
  | 'media-type-added'
  | 'media-type-removed'
  // Schemas, wherever they appear
  | 'schema-added'
  | 'schema-removed'
  | 'type-changed'
  | 'reference-changed'
  | 'format-changed'
  | 'enum-added'
  | 'enum-removed'
  | 'enum-value-added'
  | 'enum-value-removed'
  | 'nullable-added'
  | 'nullable-removed'
  | 'property-added'
  | 'property-removed'
  | 'property-required'
  | 'property-optional'
  | 'additional-properties-changed'
  | 'variant-added'
  | 'variant-removed'
  | 'part-added'
  | 'part-removed'
  | 'discriminator-changed'
  | 'default-changed'
  // Webhooks (OpenAPI 3.1): requests the API sends; payload changes use the schema kinds above
  | 'webhook-added'
  | 'webhook-removed'
  // Anything above that can be deprecated (operation, parameter, schema, property, webhook)
  | 'deprecated'
  | 'undeprecated'
  // API-wide
  | 'security-scheme-added'
  | 'security-scheme-removed'
  | 'security-scheme-changed'
  | 'server-changed';

/**
 * What a change is about: an operation, a component schema, a security scheme, or the API as a whole
 * (default server, a security requirement every operation shares).
 */
export type ChangeScope = 'operation' | 'webhook' | 'schema' | 'security' | 'api';

export interface Change {
  kind: ChangeKind;
  /**
   * True when a client built for the old spec, or code written against the SDK generated from it,
   * can fail with the new one: a removed endpoint, a new required parameter, an enum value a client
   * may not handle, ...
   */
  breaking: boolean;
  scope: ChangeScope;
  /** Operation key (`GET /pets/{petId}`) for `operation` changes; the new key when a path was renamed. */
  operation?: string | undefined;
  /** The operation's operationId, for display. */
  operationId?: string | undefined;
  /** `components.schemas` key for `schema` changes. */
  schema?: string | undefined;
  /** Security scheme key for `security` changes. */
  securityScheme?: string | undefined;
  /** Webhook key (its name) for `webhook` changes. */
  webhook?: string | undefined;
  /** Where inside the operation: `parameters/query/limit`, `requestBody/application/json`, `responses/200/...`, `security`. */
  location?: string | undefined;
  /** Where inside the schema: `owner.name`, `tags[]` (array items), `metadata{}` (map values). */
  schemaPath?: string | undefined;
  /** One sentence, Markdown inline code allowed. Does not repeat the subject (operation / schema). */
  message: string;
  before?: unknown;
  after?: unknown;
  /** For component schema changes: operations whose request or response uses the schema. */
  affects?: string[] | undefined;
}

export interface ApiDiff {
  version: typeof DIFF_FORMAT_VERSION;
  from: { title: string; version: string };
  to: { title: string; version: string };
  summary: { breaking: number; nonBreaking: number };
  /** In spec order: operations, webhooks, component schemas, then security schemes and servers. */
  changes: Change[];
}
