import type { IgnoreConfig } from '../config/schema.js';
import { Diagnostics } from '../diagnostics.js';
import type { ApiModel, Operation, SchemaNode, Webhook } from './model.js';
import { mapRefs, reachability, refsOf } from './refs.js';

interface Rule {
  /** `ignore.<section>` entry, for diagnostics. */
  label: string;
  matches: (op: Operation) => boolean;
}

/**
 * Leaves out what the `ignore` config names: operations (by key, operationId, path or tag) and component
 * schemas. References from what is kept to an ignored schema become `unknown`. Entries that match nothing
 * are reported, since they are usually typos or leftovers from an older spec.
 */
export function applyIgnore(model: ApiModel, ignore: IgnoreConfig, diagnostics: Diagnostics = new Diagnostics()): ApiModel {
  const rules: Rule[] = [
    ...ignore.operations.map((entry) => ({ label: `ignore.operations entry "${entry}"`, matches: operationMatcher(entry) })),
    ...ignore.paths.map((entry) => {
      const pattern = glob(entry, true);
      return { label: `ignore.paths entry "${entry}"`, matches: (op: Operation) => pattern.test(op.path) };
    }),
    ...ignore.tags.map((entry) => {
      const pattern = glob(entry, false);
      return { label: `ignore.tags entry "${entry}"`, matches: (op: Operation) => op.tags.some((tag) => pattern.test(tag)) };
    }),
  ];
  const used = new Set<string>();

  const operations = model.operations.filter((op) => {
    const matching = rules.filter((rule) => rule.matches(op));
    for (const rule of matching) used.add(rule.label);
    return matching.length === 0;
  });

  const ignored = new Set<string>();
  for (const entry of ignore.schemas) {
    const pattern = glob(entry, false);
    const label = `ignore.schemas entry "${entry}"`;
    for (const { key } of model.schemas) {
      if (!pattern.test(key)) continue;
      ignored.add(key);
      used.add(label);
    }
  }
  for (const label of [...rules.map((rule) => rule.label), ...ignore.schemas.map((entry) => `ignore.schemas entry "${entry}"`)]) {
    if (!used.has(label)) diagnostics.warn('IGNORE_UNMATCHED', `${label} matches nothing in the spec`);
  }

  // Kept operations and schemas may still point at an ignored schema: type those spots as `unknown`.
  const stillUsedBy = new Map<string, string[]>();
  const detach = (node: SchemaNode, user: string): SchemaNode =>
    mapRefs(node, (ref) => {
      if (!ignored.has(ref.target)) return ref;
      stillUsedBy.set(ref.target, [...new Set([...(stillUsedBy.get(ref.target) ?? []), user])]);
      const { kind: _kind, target: _target, ...meta } = ref;
      return { kind: 'unknown', ...meta };
    });
  let result: ApiModel = {
    ...model,
    operations: operations.map((op) => mapOperationSchemas(op, (node) => detach(node, `\`${op.key}\``))),
    webhooks: model.webhooks.map((hook) => mapWebhookSchemas(hook, (node) => detach(node, `webhook \`${hook.key}\``))),
    schemas: model.schemas
      .filter(({ key }) => !ignored.has(key))
      .map(({ key, schema }) => ({ key, schema: detach(schema, `schema \`${key}\``) })),
  };
  for (const [key, users] of stillUsedBy) {
    const more = users.length > 1 ? ` and ${users.length - 1} more` : '';
    diagnostics.warn('IGNORED_SCHEMA_USED', `Ignored schema \`${key}\` is used by ${users[0]}${more}; typed as unknown there`, `#/components/schemas/${key}`);
  }

  if (ignore.unusedSchemas) {
    const reachable = reachability(result);
    const kept = new Set<string>();
    const payloads = result.webhooks.flatMap((hook) => (hook.payload?.content ?? []).map((media) => media.schema));
    for (const node of [...result.operations.flatMap(operationSchemas), ...payloads]) {
      for (const ref of refsOf(node)) for (const key of reachable(ref)) kept.add(key);
    }
    for (const { key } of result.schemas) if (!kept.has(key)) ignored.add(key);
    result = { ...result, schemas: result.schemas.filter(({ key }) => kept.has(key)) };
  }

  const left = model.operations.length - operations.length;
  if (left > 0 || ignored.size > 0) {
    const parts = [left > 0 && plural(left, 'operation'), ignored.size > 0 && plural(ignored.size, 'schema')].filter(Boolean);
    diagnostics.info('IGNORED', `Left out ${parts.join(' and ')} (ignore config)`);
  }
  return result;
}

/** `METHOD /path` (method may be `*`) or an operationId pattern. */
function operationMatcher(entry: string): (op: Operation) => boolean {
  const keyed = /^(\*|[A-Za-z]+)\s+(\/.*)$/.exec(entry.trim());
  if (keyed) {
    const method = keyed[1]!.toLowerCase();
    const path = glob(keyed[2]!, true);
    return (op) => (method === '*' || op.method === method) && path.test(op.path);
  }
  const id = glob(entry, false);
  return (op) => op.operationId !== undefined && id.test(op.operationId);
}

/**
 * Wildcard pattern → RegExp. Names: `*` matches anything. Paths: `*` stays within a segment, `**` crosses
 * segments, and `/**` also matches nothing at all (`/admin/**` covers `/admin`).
 */
function glob(pattern: string, isPath: boolean): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (isPath && pattern.startsWith('/**', index) && (index + 3 === pattern.length || pattern[index + 3] === '/')) {
      source += '(?:/.*)?';
      index += 2;
    } else if (char === '*') {
      const double = pattern[index + 1] === '*';
      source += isPath && !double ? '[^/]*' : '.*';
      if (double) index++;
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function operationSchemas(op: Operation): SchemaNode[] {
  return [
    ...op.parameters.map((param) => param.schema),
    ...(op.requestBody?.content ?? []).map((media) => media.schema),
    ...op.responses.flatMap((response) => response.content.map((media) => media.schema)),
  ];
}

function mapWebhookSchemas(hook: Webhook, map: (node: SchemaNode) => SchemaNode): Webhook {
  return {
    ...hook,
    payload: hook.payload && { ...hook.payload, content: hook.payload.content.map((media) => ({ ...media, schema: map(media.schema) })) },
  };
}

function mapOperationSchemas(op: Operation, map: (node: SchemaNode) => SchemaNode): Operation {
  return {
    ...op,
    parameters: op.parameters.map((param) => ({ ...param, schema: map(param.schema) })),
    requestBody: op.requestBody && {
      ...op.requestBody,
      content: op.requestBody.content.map((media) => ({ ...media, schema: map(media.schema) })),
    },
    responses: op.responses.map((response) => ({
      ...response,
      content: response.content.map((media) => ({ ...media, schema: map(media.schema) })),
    })),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
