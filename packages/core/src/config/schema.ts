import { z } from 'zod';

const regex = z.string().refine(
  (pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid regular expression' },
);

export const CASE_STYLES = ['camel', 'pascal', 'snake', 'constant', 'preserve'] as const;
export const caseStyleSchema = z.enum(CASE_STYLES);
export type CaseStyle = z.infer<typeof caseStyleSchema>;

/** Path segments that read as verbs: `POST /orders/{id}/cancel` becomes `cancelOrder`. */
export const DEFAULT_ACTION_WORDS = [
  'activate', 'approve', 'archive', 'cancel', 'check', 'clone', 'close', 'complete', 'confirm', 'copy',
  'deactivate', 'disable', 'download', 'enable', 'export', 'import', 'invite', 'lock', 'login', 'logout',
  'merge', 'move', 'open', 'publish', 'refresh', 'register', 'reject', 'reset', 'restore', 'retry', 'revoke',
  'search', 'send', 'start', 'stop', 'submit', 'sync', 'unlock', 'unpublish', 'upload', 'validate', 'verify',
];

const operationNamingSchema = z.strictObject({
  /** Case style for method names. */
  case: caseStyleSchema.default('camel'),
  /** `operationId`: use the spec's operationId when present, else derive from the path. `path`: always derive. */
  source: z.enum(['operationId', 'path']).default('operationId'),
  /** Regular expressions removed from operationIds before naming, e.g. `^\\w+Controller_`. */
  stripPrefixes: z.array(regex).default([]),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
  /**
   * Templates for path-derived names. Placeholders: `{verb}`, `{method}`, `{action}`, `{Resource}` (singular),
   * `{Resources}` (plural), `{Target}` (singular for item paths, plural for collections), `{By}` (`ById`).
   */
  templates: z
    .strictObject({
      list: z.string().default('list{Resources}'),
      get: z.string().default('get{Resource}{By}'),
      create: z.string().default('create{Resource}'),
      update: z.string().default('update{Target}'),
      patch: z.string().default('patch{Target}'),
      delete: z.string().default('delete{Target}'),
      action: z.string().default('{action}{Target}'),
      other: z.string().default('{method}{Target}'),
    })
    .prefault({}),
  /** Static path segments treated as verbs (see DEFAULT_ACTION_WORDS); replaces the default list. */
  actions: z.array(z.string().min(1)).default(DEFAULT_ACTION_WORDS),
  /** Path segments (regular expressions, matched whole) ignored when deriving names. */
  ignoreSegments: z.array(regex).default(['api', 'v\\d+']),
});

export const namingSchema = z.strictObject({
  /** Words kept in a fixed form, e.g. `ID` turns `userId` into `userID` and `IdToken` into `IDToken`. */
  acronyms: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'Acronyms must be alphanumeric words')).default([]),
  operations: operationNamingSchema.prefault({}),
  types: z
    .strictObject({
      case: caseStyleSchema.default('pascal'),
      prefix: z.string().default(''),
      suffix: z.string().default(''),
      /** Appended when a type name clashes with a built-in or runtime name (e.g. `Error` → `ErrorModel`). */
      reservedSuffix: z.string().min(1).default('Model'),
    })
    .prefault({}),
  parameters: z.strictObject({ case: caseStyleSchema.default('camel') }).prefault({}),
  groups: z
    .strictObject({
      /** Case style of the client property for a group, e.g. `client.petStore`. */
      case: caseStyleSchema.default('camel'),
      /** Class name template for a group. Placeholder: `{Group}`. */
      className: z.string().default('{Group}Api'),
    })
    .prefault({}),
  /** Names of helper types derived from operations. Placeholder: `{Operation}` (PascalCase method name). */
  derived: z
    .strictObject({
      params: z.string().default('{Operation}Params'),
      requestBody: z.string().default('{Operation}Request'),
      response: z.string().default('{Operation}Response'),
    })
    .prefault({}),
  pluralization: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Extra singular → plural pairs, e.g. `{ person: people }`. */
      irregular: z.record(z.string(), z.string()).default({}),
      uncountable: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Keep previously generated names stable across regenerations (`.steadysdk/names.lock.json`). */
  lock: z.boolean().default(true),
  overrides: z
    .strictObject({
      /** Keyed by `METHOD /path` or by operationId. */
      operations: z.record(z.string(), z.string()).default({}),
      /** Keyed by `components.schemas` name. */
      schemas: z.record(z.string(), z.string()).default({}),
      /** Keyed by tag (or first path segment when grouping by path). Value is the client property name. */
      groups: z.record(z.string(), z.string()).default({}),
      /** Keyed by the parameter's name in the spec. */
      parameters: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
});

const pattern = z.string().min(1);

/** Comment lines only, so a header can never break the generated code. */
const header = z.string().refine(
  (text) => text.split('\n').every((line) => /^\s*($|\/\/|\/\*|\*)/.test(line)),
  { message: 'Every line must be a comment (//, /* ... */) or blank' },
);

export const ignoreSchema = z.strictObject({
  /** `METHOD /path` (`*` for any method, path wildcards as in `paths`) or operationId (`*` wildcards). */
  operations: z.array(pattern).default([]),
  /** Path patterns: `*` matches within one segment, `**` across segments, e.g. `/internal/**`. */
  paths: z.array(pattern).default([]),
  /** Operations carrying any of these tags. */
  tags: z.array(pattern).default([]),
  /** `components.schemas` names (`*` wildcards). References from kept operations become `unknown`. */
  schemas: z.array(pattern).default([]),
  /** Also leave out component schemas that no kept operation uses. */
  unusedSchemas: z.boolean().default(false),
});

export type IgnoreConfig = z.output<typeof ignoreSchema>;

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Path or URL of the OpenAPI document, relative to the config file. */
  input: z.string().min(1),
  /** Output directory, relative to the config file. */
  output: z.string().min(1).default('./sdk'),
  target: z.literal('typescript').default('typescript'),
  /** Validate the spec before generating. */
  validate: z.boolean().default(true),
  client: z
    .strictObject({
      /** Root client class name. Defaults to the spec title + `Client`. */
      name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'Must be a valid identifier').optional(),
      /** How operations are grouped into sub-clients: by first tag, by first path segment, or not at all. */
      groupBy: z.enum(['tag', 'path', 'none']).default('tag'),
      /** Overrides the default base URL taken from `servers[0]`. */
      baseUrl: z.string().optional(),
    })
    .prefault({}),
  typescript: z
    .strictObject({
      /** Extension used in relative imports of generated files. `.js` suits Node ESM and bundlers alike. */
      importExtension: z.enum(['.js', '.ts', 'none']).default('.js'),
      /** Emit `// <steadysdk:custom ...>` regions in generated files; code inside them survives regeneration. */
      customRegions: z.boolean().default(true),
    })
    .prefault({}),
  /** Leave parts of the API out of the SDK. */
  ignore: ignoreSchema.prefault({}),
  templates: z
    .strictObject({
      /** Your copy of the HTTP runtime (see `steadysdk eject runtime`), used instead of the built-in one. */
      runtime: z.string().min(1).optional(),
      /** Comment lines at the top of every generated file, e.g. a license. Placeholders: `{title}`, `{version}`. */
      header: header.optional(),
    })
    .prefault({}),
  naming: namingSchema.prefault({}),
});

export type SteadySdkConfigInput = z.input<typeof configSchema>;
export type SteadySdkConfig = z.output<typeof configSchema>;
export type NamingConfig = z.output<typeof namingSchema>;
