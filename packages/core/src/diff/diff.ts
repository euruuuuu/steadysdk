import type { ApiModel, MediaType, Operation, Parameter, SecurityScheme, Webhook } from '../ir/model.js';
import { SchemaComparer, schemaUsage, type Direction, type SchemaChange, type SchemaUsage } from './schema.js';
import { code, lowerFirst } from './text.js';
import { DIFF_FORMAT_VERSION, type ApiDiff, type Change } from './types.js';

/**
 * Compares two versions of an API at the IR level and classifies every change as breaking or not.
 * Documentation-only edits (summaries, descriptions, examples) are ignored.
 */
export function diffModels(from: ApiModel, to: ApiModel): ApiDiff {
  const changes = new ModelDiffer(from, to).run().map(canonical);
  const breaking = changes.filter((change) => change.breaking).length;
  return {
    version: DIFF_FORMAT_VERSION,
    from: { title: from.title, version: from.version },
    to: { title: to.title, version: to.version },
    summary: { breaking, nonBreaking: changes.length - breaking },
    changes,
  };
}

type OperationChange = Omit<Change, 'scope' | 'operation' | 'operationId'>;
/** Records a change on the operation being compared. */
type Push = (change: OperationChange) => Change;

const CHANGE_KEYS = [
  'kind', 'breaking', 'scope', 'operation', 'operationId', 'webhook', 'schema', 'securityScheme',
  'location', 'schemaPath', 'message', 'before', 'after', 'affects',
] as const satisfies ReadonlyArray<keyof Change>;

/** Same key order for every change, whatever built it, and no `undefined` entries: the JSON output is stable. */
function canonical(change: Change): Change {
  const out: Record<string, unknown> = {};
  for (const key of CHANGE_KEYS) if (change[key] !== undefined) out[key] = change[key];
  return out as unknown as Change;
}

const PARAMETER_LABEL = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie' } as const;

class ModelDiffer {
  private readonly from: ApiModel;
  private readonly to: ApiModel;
  private readonly schemas: SchemaComparer;
  private changes: Change[] = [];
  /** Per-operation security changes, collapsed into one API-wide change when every operation changed alike. */
  private readonly securityChanges: Change[] = [];

  constructor(from: ApiModel, to: ApiModel) {
    this.from = from;
    this.to = to;
    this.schemas = new SchemaComparer(from, to);
  }

  run(): Change[] {
    this.operations();
    this.webhooks();
    this.componentSchemas();
    this.securitySchemes();
    this.servers();
    return this.changes;
  }

  // ---------------------------------------------------------------------------------------------
  // Operations

  private operations(): void {
    const matches = matchOperations(this.from.operations, this.to.operations);
    const matched = new Set<Operation>();
    for (const op of this.to.operations) {
      const previous = matches.get(op);
      const push: Push = (change) => {
        const full: Change = { scope: 'operation', operation: op.key, operationId: op.operationId, ...change };
        this.changes.push(full);
        return full;
      };
      if (!previous) {
        push({ kind: 'operation-added', breaking: false, message: op.deprecated ? 'Endpoint added (deprecated).' : 'Endpoint added.' });
        continue;
      }
      matched.add(previous);
      this.operation(previous, op, push);
    }
    for (const op of this.from.operations) {
      if (matched.has(op)) continue;
      this.changes.push({
        scope: 'operation',
        operation: op.key,
        operationId: op.operationId,
        kind: 'operation-removed',
        breaking: true,
        message: op.deprecated ? 'Endpoint removed (it was deprecated).' : 'Endpoint removed.',
      });
    }

    // A change to the global `security` shows up on every operation; report it once.
    const [first] = this.securityChanges;
    const everyOperation = matched.size > 1 && this.securityChanges.length === matched.size;
    if (first && everyOperation && this.securityChanges.every((change) => change.message === first.message)) {
      const perOperation = new Set(this.securityChanges);
      this.changes = this.changes.filter((change) => !perOperation.has(change));
      this.changes.push({ ...first, scope: 'api', operation: undefined, operationId: undefined, message: `Every endpoint: ${lowerFirst(first.message)}` });
    }
  }

  private operation(a: Operation, b: Operation, push: Push): void {
    if (a.operationId !== b.operationId) {
      const message =
        a.operationId === undefined
          ? `Now has operationId ${code(b.operationId)}.`
          : b.operationId === undefined
            ? `No longer has an operationId (was ${code(a.operationId)}).`
            : `operationId changed from ${code(a.operationId)} to ${code(b.operationId)}.`;
      push({ kind: 'operation-id-changed', breaking: false, message, before: a.operationId, after: b.operationId });
    }
    if (a.deprecated !== b.deprecated) {
      push(
        b.deprecated
          ? { kind: 'deprecated', breaking: false, message: 'Endpoint is now deprecated.' }
          : { kind: 'undeprecated', breaking: false, message: 'Endpoint is no longer deprecated.' },
      );
    }
    this.parameters(a, b, push);
    this.requestBody(a, b, push);
    this.responses(a, b, push);
    this.security(a, b, push);
  }

  private parameters(a: Operation, b: Operation, push: Push): void {
    const renames = pathParameterRenames(a.path, b.path);
    const id = (param: Parameter, renamed = false): string =>
      `${param.in}:${renamed && param.in === 'path' ? (renames.get(param.name) ?? param.name) : param.name}`;
    const before = new Map(a.parameters.map((param) => [id(param, true), param]));
    const after = new Set(b.parameters.map((param) => id(param)));

    for (const param of b.parameters) {
      const label = `${PARAMETER_LABEL[param.in]} parameter ${code(param.name)}`;
      const location = `parameters/${param.in}/${param.name}`;
      const previous = before.get(id(param));
      if (!previous) {
        push(
          param.required
            ? { kind: 'parameter-added', breaking: true, location, message: `Required ${lowerFirst(label)} was added.` }
            : { kind: 'parameter-added', breaking: false, location, message: `Optional ${lowerFirst(label)} was added.` },
        );
        continue;
      }
      if (previous.name !== param.name) {
        // The URL is unchanged, but the SDK's parameter property is named after it.
        push({
          kind: 'parameter-renamed',
          breaking: true,
          location,
          message: `Path parameter ${code(previous.name)} was renamed to ${code(param.name)}.`,
          before: previous.name,
          after: param.name,
        });
      }
      if (!previous.required && param.required) push({ kind: 'parameter-required', breaking: true, location, message: `${label} is now required.` });
      if (previous.required && !param.required) push({ kind: 'parameter-optional', breaking: false, location, message: `${label} is now optional.` });
      if (!previous.deprecated && param.deprecated) push({ kind: 'deprecated', breaking: false, location, message: `${label} is now deprecated.` });
      if (previous.deprecated && !param.deprecated) push({ kind: 'undeprecated', breaking: false, location, message: `${label} is no longer deprecated.` });
      if (previous.style !== param.style || previous.explode !== param.explode) {
        const style = (p: Parameter): string => code(`${p.style}${p.explode ? ', explode' : ''}`);
        push({
          kind: 'parameter-style-changed',
          breaking: true,
          location,
          message: `${label} is now serialized as ${style(param)} (was ${style(previous)}).`,
          before: { style: previous.style, explode: previous.explode },
          after: { style: param.style, explode: param.explode },
        });
      }
      this.schemaChanges(push, label, location, this.schemas.compare(previous.schema, param.schema, 'request'));
    }

    for (const param of a.parameters) {
      if (after.has(id(param, true))) continue;
      push({
        kind: 'parameter-removed',
        breaking: true,
        location: `parameters/${param.in}/${param.name}`,
        message: `${PARAMETER_LABEL[param.in]} parameter ${code(param.name)} was removed.`,
      });
    }
  }

  private requestBody(a: Operation, b: Operation, push: Push): void {
    const location = 'requestBody';
    if (!a.requestBody && !b.requestBody) return;
    if (!a.requestBody) {
      const required = b.requestBody?.required === true;
      push({ kind: 'request-body-added', breaking: required, location, message: `${required ? 'Required' : 'Optional'} request body was added.` });
      return;
    }
    if (!b.requestBody) {
      push({ kind: 'request-body-removed', breaking: true, location, message: 'Request body was removed.' });
      return;
    }
    if (!a.requestBody.required && b.requestBody.required) push({ kind: 'request-body-required', breaking: true, location, message: 'Request body is now required.' });
    if (a.requestBody.required && !b.requestBody.required) push({ kind: 'request-body-optional', breaking: false, location, message: 'Request body is now optional.' });
    this.content(a.requestBody.content, b.requestBody.content, 'Request body', location, 'request', push);
  }

  private responses(a: Operation, b: Operation, push: Push): void {
    const before = new Map(a.responses.map((response) => [response.status, response]));
    const after = new Set(b.responses.map((response) => response.status));
    for (const response of b.responses) {
      const location = `responses/${response.status}`;
      const previous = before.get(response.status);
      if (!previous) {
        // A new success status changes what a call can return; new error statuses are already handled as errors.
        const success = isSuccess(response.status);
        push({
          kind: 'response-added',
          breaking: success,
          location,
          message: success ? `Can now respond with ${code(response.status)}.` : `Documents a ${code(response.status)} response.`,
        });
        continue;
      }
      this.content(previous.content, response.content, `Response ${code(response.status)}`, location, 'response', push);
    }
    for (const response of a.responses) {
      if (after.has(response.status)) continue;
      const success = isSuccess(response.status);
      push({
        kind: 'response-removed',
        breaking: success,
        location: `responses/${response.status}`,
        message: success ? `No longer responds with ${code(response.status)}.` : `No longer documents a ${code(response.status)} response.`,
      });
    }
  }

  private content(
    a: readonly MediaType[],
    b: readonly MediaType[],
    label: string,
    location: string,
    direction: Direction,
    push: Push,
    verb = direction === 'request' ? 'accepted' : 'returned',
  ): void {
    const several = a.length > 1 || b.length > 1;
    const before = new Map(a.map((media) => [media.contentType, media]));
    const after = new Set(b.map((media) => media.contentType));
    for (const media of b) {
      const previous = before.get(media.contentType);
      if (!previous) {
        push({ kind: 'media-type-added', breaking: false, location, message: `${label}: ${code(media.contentType)} is now ${verb}.`, after: media.contentType });
        continue;
      }
      const where = several ? `${label} (${code(media.contentType)})` : label;
      this.schemaChanges(push, where, `${location}/${media.contentType}`, this.schemas.compare(previous.schema, media.schema, direction));
    }
    for (const media of a) {
      if (after.has(media.contentType)) continue;
      push({ kind: 'media-type-removed', breaking: true, location, message: `${label}: ${code(media.contentType)} is no longer ${verb}.`, before: media.contentType });
    }
    // A single media type that changed (`application/json` → `application/vnd.api+json`): still compare the payloads.
    const [onlyA] = a;
    const [onlyB] = b;
    if (a.length === 1 && b.length === 1 && onlyA && onlyB && onlyA.contentType !== onlyB.contentType) {
      this.schemaChanges(push, label, `${location}/${onlyB.contentType}`, this.schemas.compare(onlyA.schema, onlyB.schema, direction));
    }
  }

  private security(a: Operation, b: Operation, push: Push): void {
    const before = securityAlternatives(a);
    const after = securityAlternatives(b);
    if (before.join('|') === after.join('|')) return;
    const describe = (alternatives: string[]): string =>
      alternatives.map((alternative) => (alternative === '' ? 'none' : code(alternative))).join(' or ');
    const change = push({
      kind: 'security-changed',
      // Dropping an accepted way to authenticate (including anonymous access) breaks the clients using it.
      breaking: before.some((alternative) => !after.includes(alternative)),
      location: 'security',
      message: `Authentication changed from ${describe(before)} to ${describe(after)}.`,
      before: before.map((alternative) => alternative || null),
      after: after.map((alternative) => alternative || null),
    });
    this.securityChanges.push(change);
  }

  private schemaChanges(push: Push, label: string, location: string, changes: SchemaChange[]): void {
    for (const change of changes) {
      push({
        kind: change.kind,
        breaking: change.breaking,
        location,
        ...(change.path !== '' && { schemaPath: change.path }),
        message: `${label}: ${lowerFirst(change.message)}`,
        ...(change.before !== undefined && { before: change.before }),
        ...(change.after !== undefined && { after: change.after }),
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Webhooks: the payload travels to the client, so it follows the response rules.

  private webhooks(): void {
    const before = new Map(this.from.webhooks.map((hook) => [hook.key, hook]));
    const after = new Set(this.to.webhooks.map((hook) => hook.key));
    const pusher =
      (hook: Webhook): Push =>
      (change) => {
        const full: Change = { scope: 'webhook', webhook: hook.key, ...change };
        this.changes.push(full);
        return full;
      };
    for (const hook of this.to.webhooks) {
      const push = pusher(hook);
      const previous = before.get(hook.key);
      if (!previous) {
        push({ kind: 'webhook-added', breaking: false, message: 'Webhook added.' });
        continue;
      }
      if (!previous.deprecated && hook.deprecated) push({ kind: 'deprecated', breaking: false, message: 'Webhook is now deprecated.' });
      if (previous.deprecated && !hook.deprecated) push({ kind: 'undeprecated', breaking: false, message: 'Webhook is no longer deprecated.' });
      this.content(previous.payload?.content ?? [], hook.payload?.content ?? [], 'Payload', 'payload', 'response', push, 'sent');
    }
    for (const hook of this.from.webhooks) {
      // Handlers typed with the SDK's WebhookPayloads lose their type.
      if (!after.has(hook.key)) pusher(hook)({ kind: 'webhook-removed', breaking: true, message: 'Webhook removed.' });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Components and API-wide settings

  private componentSchemas(): void {
    const usageFrom = schemaUsage(this.from);
    const usageTo = schemaUsage(this.to);
    const before = new Map(this.from.schemas.map((named) => [named.key, named.schema]));
    const after = new Set(this.to.schemas.map((named) => named.key));
    const order = new Map<string, number>();
    for (const op of [...this.to.operations, ...this.from.operations]) if (!order.has(op.key)) order.set(op.key, order.size);
    const affects = (key: string): string[] | undefined => {
      const ops = new Set<string>();
      for (const usage of [usageTo.get(key), usageFrom.get(key)]) {
        for (const op of [...(usage?.request ?? []), ...(usage?.response ?? [])]) ops.add(op);
      }
      return ops.size > 0 ? [...ops].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0)) : undefined;
    };

    for (const { key, schema } of this.to.schemas) {
      const previous = before.get(key);
      if (!previous) {
        this.changes.push({ kind: 'schema-added', breaking: false, scope: 'schema', schema: key, message: 'Added.', affects: affects(key) });
        continue;
      }
      const direction = directionOf(usageFrom.get(key), usageTo.get(key));
      const ops = affects(key);
      for (const change of this.schemas.compare(previous, schema, direction)) {
        this.changes.push({
          kind: change.kind,
          breaking: change.breaking,
          scope: 'schema',
          schema: key,
          ...(change.path !== '' && { schemaPath: change.path }),
          message: change.message,
          ...(change.before !== undefined && { before: change.before }),
          ...(change.after !== undefined && { after: change.after }),
          affects: ops,
        });
      }
    }
    for (const { key } of this.from.schemas) {
      if (after.has(key)) continue;
      // The SDK exports a type per schema, so removing one breaks code that imports it.
      this.changes.push({ kind: 'schema-removed', breaking: true, scope: 'schema', schema: key, message: 'Removed.', affects: affects(key) });
    }
  }

  private securitySchemes(): void {
    const before = new Map(this.from.securitySchemes.map((scheme) => [scheme.key, scheme]));
    const after = new Set(this.to.securitySchemes.map((scheme) => scheme.key));
    for (const scheme of this.to.securitySchemes) {
      const previous = before.get(scheme.key);
      const base = { scope: 'security', securityScheme: scheme.key } as const;
      if (!previous) {
        this.changes.push({ ...base, kind: 'security-scheme-added', breaking: false, message: `Added: ${describeScheme(scheme)}.` });
      } else if (describeScheme(previous) !== describeScheme(scheme)) {
        this.changes.push({
          ...base,
          kind: 'security-scheme-changed',
          breaking: true,
          message: `Changed from ${describeScheme(previous)} to ${describeScheme(scheme)}.`,
        });
      }
    }
    for (const scheme of this.from.securitySchemes) {
      if (after.has(scheme.key)) continue;
      // Its credentials option disappears from the generated client.
      this.changes.push({ kind: 'security-scheme-removed', breaking: true, scope: 'security', securityScheme: scheme.key, message: 'Removed.' });
    }
  }

  private servers(): void {
    const before = this.from.servers[0]?.url;
    const after = this.to.servers[0]?.url;
    if (before === after) return;
    this.changes.push({
      kind: 'server-changed',
      breaking: false,
      scope: 'api',
      message: `Default server URL changed from ${code(before)} to ${code(after)}.`,
      before,
      after,
    });
  }
}

/**
 * Pairs operations across versions: by key, then by path shape so that renaming a path parameter
 * (`/pets/{petId}` → `/pets/{id}`) reads as a renamed parameter rather than a removed and an added endpoint.
 */
function matchOperations(from: readonly Operation[], to: readonly Operation[]): Map<Operation, Operation> {
  const byKey = new Map(from.map((op) => [op.key, op]));
  const matches = new Map<Operation, Operation>();
  const used = new Set<Operation>();
  for (const op of to) {
    const previous = byKey.get(op.key);
    if (previous) {
      matches.set(op, previous);
      used.add(previous);
    }
  }
  const shape = (op: Operation): string => `${op.method} ${op.path.replace(/\{[^}]*\}/g, '{}')}`;
  const group = (ops: readonly Operation[]): Map<string, Operation[]> => {
    const groups = new Map<string, Operation[]>();
    for (const op of ops) groups.set(shape(op), [...(groups.get(shape(op)) ?? []), op]);
    return groups;
  };
  const leftFrom = group(from.filter((op) => !used.has(op)));
  for (const [key, ops] of group(to.filter((op) => !matches.has(op)))) {
    const candidates = leftFrom.get(key);
    if (ops.length === 1 && candidates?.length === 1) matches.set(ops[0]!, candidates[0]!);
  }
  return matches;
}

/** Old → new path parameter names for two paths of the same shape. */
function pathParameterRenames(from: string, to: string): Map<string, string> {
  const names = (path: string): string[] => [...path.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '');
  const before = names(from);
  const after = names(to);
  return new Map(before.flatMap((name, index) => (after[index] !== undefined && after[index] !== name ? [[name, after[index]] as const] : [])));
}

/** Each accepted way to authenticate, e.g. `bearerAuth`, `apiKey + session`; '' is anonymous access. */
function securityAlternatives(op: Operation): string[] {
  if (op.security.length === 0) return [''];
  const alternatives = op.security.map((requirement) =>
    requirement
      .map((entry) => (entry.scopes.length > 0 ? `${entry.scheme} (${[...entry.scopes].sort().join(', ')})` : entry.scheme))
      .sort()
      .join(' + '),
  );
  return [...new Set(alternatives)].sort();
}

function describeScheme(scheme: SecurityScheme): string {
  switch (scheme.type) {
    case 'apiKey':
      return `API key in ${scheme.in} ${code(scheme.name)}`;
    case 'http':
      return `HTTP ${code(scheme.scheme)} authentication`;
    case 'oauth2':
      return 'OAuth 2';
    case 'openIdConnect':
      return `OpenID Connect (${code(scheme.url)})`;
  }
}

function directionOf(from: SchemaUsage | undefined, to: SchemaUsage | undefined): Direction {
  const request = (from?.request.length ?? 0) + (to?.request.length ?? 0) > 0;
  const response = (from?.response.length ?? 0) + (to?.response.length ?? 0) > 0;
  if (request && !response) return 'request';
  if (response && !request) return 'response';
  return 'both';
}

function isSuccess(status: string): boolean {
  return /^2(\d\d|XX)$/.test(status);
}

