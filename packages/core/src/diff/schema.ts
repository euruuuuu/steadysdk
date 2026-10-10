import type { ApiModel, EnumValue, ObjectSchema, Operation, Property, SchemaMeta, SchemaNode } from '../ir/model.js';
import { capitalize, code } from './text.js';
import type { ChangeKind } from './types.js';

/**
 * Which way a schema travels: sent by clients (`request`), received by them (`response`), or both
 * (a component used on both sides, or not used by any operation).
 */
export type Direction = 'request' | 'response' | 'both';

/**
 * The direction in which a change breaks clients. Narrowing what a server accepts breaks requests
 * (a new required property); widening what it returns breaks responses (a new enum value a client
 * may not handle). Removing something breaks both: requests may still send it, responses no longer have it.
 */
type Breaks = Direction | 'none';

export interface SchemaChange {
  kind: ChangeKind;
  breaking: boolean;
  /** Path inside the compared schema: `owner.name`, `tags[]`, `metadata{}`, or '' for the schema itself. */
  path: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

interface Walk {
  direction: Direction;
  out: SchemaChange[];
  /** `from>to` reference pairs being expanded, so recursive schemas terminate. */
  expanding: Set<string>;
}

/** Structural, direction-aware comparison of IR schemas from two versions of an API. */
export class SchemaComparer {
  private readonly fromSchemas: ReadonlyMap<string, SchemaNode>;
  private readonly toSchemas: ReadonlyMap<string, SchemaNode>;

  constructor(from: ApiModel, to: ApiModel) {
    this.fromSchemas = new Map(from.schemas.map((named) => [named.key, named.schema]));
    this.toSchemas = new Map(to.schemas.map((named) => [named.key, named.schema]));
  }

  /**
   * Changes between two schemas. References to the same component are not expanded: changes inside a
   * component are reported once, on the component itself.
   */
  compare(from: SchemaNode, to: SchemaNode, direction: Direction): SchemaChange[] {
    const walk: Walk = { direction, out: [], expanding: new Set() };
    this.walk(from, to, [], walk);
    return walk.out;
  }

  private walk(a: SchemaNode, b: SchemaNode, path: string[], w: Walk): void {
    if (a.kind === 'ref' || b.kind === 'ref') {
      if (a.kind === 'ref' && b.kind === 'ref' && a.target === b.target) this.meta(a, b, path, w);
      else this.references(a, b, path, w);
      return;
    }
    this.meta(a, b, path, w);

    if (a.kind === 'union' || b.kind === 'union') {
      if (a.kind === b.kind || (a.kind !== 'unknown' && b.kind !== 'unknown')) return this.variants(a, b, path, w);
    }
    if (a.kind === 'intersection' || b.kind === 'intersection') {
      if (a.kind === b.kind || (a.kind !== 'unknown' && b.kind !== 'unknown')) return this.parts(a, b, path, w);
    }
    if (a.kind !== b.kind) return this.typeChanged(a, b, path, w);

    if (a.kind === 'scalar' && b.kind === 'scalar') {
      if (a.type !== b.type) return this.typeChanged(a, b, path, w);
      if (a.format !== b.format) {
        const binary = a.format === 'binary' || b.format === 'binary';
        this.emit(w, 'format-changed', binary ? 'both' : 'none', path, `${of('Format', path)} changed from ${code(a.format)} to ${code(b.format)}.`, a.format, b.format);
      }
      this.enums(a.enum, b.enum, path, w);
    } else if (a.kind === 'array' && b.kind === 'array') {
      this.walk(a.items, b.items, [...path, '[]'], w);
    } else if (a.kind === 'object' && b.kind === 'object') {
      this.objects(a, b, path, w);
    }
  }

  /** Nullability, deprecation and defaults: meaningful on any kind of schema, including `$ref`s. */
  private meta(a: SchemaMeta, b: SchemaMeta, path: string[], w: Walk): void {
    const where = path.length > 0 ? `${code(render(path))} ` : '';
    if (!a.nullable && b.nullable) {
      this.emit(w, 'nullable-added', 'response', path, path.length > 0 ? `${where}can now be null.` : 'Can now be null.');
    } else if (a.nullable && !b.nullable) {
      this.emit(w, 'nullable-removed', 'request', path, path.length > 0 ? `${where}can no longer be null.` : 'Can no longer be null.');
    }
    if (!a.deprecated && b.deprecated) {
      this.emit(w, 'deprecated', 'none', path, path.length > 0 ? `${where}is now deprecated.` : 'Now deprecated.');
    } else if (a.deprecated && !b.deprecated) {
      this.emit(w, 'undeprecated', 'none', path, path.length > 0 ? `${where}is no longer deprecated.` : 'No longer deprecated.');
    }
    if (JSON.stringify(a.default) !== JSON.stringify(b.default)) {
      this.emit(w, 'default-changed', 'none', path, `${of('Default', path)} changed from ${json(a.default)} to ${json(b.default)}.`, a.default, b.default);
    }
  }

  /**
   * At least one side is a `$ref` and they differ (another component, or inline vs component).
   * Compares what they point to; a refactor that keeps the shape (extracting or renaming a component) is
   * reported as a non-breaking reference change.
   */
  private references(a: SchemaNode, b: SchemaNode, path: string[], w: Walk): void {
    const key = `${a.kind === 'ref' ? a.target : '~'}>${b.kind === 'ref' ? b.target : '~'}`;
    if (w.expanding.has(key)) return; // recursion: the outer comparison covers it
    const resolvedA = this.resolve(a, this.fromSchemas);
    const resolvedB = this.resolve(b, this.toSchemas);
    if (!resolvedA || !resolvedB) return this.typeChanged(a, b, path, w);

    const inner: Walk = { ...w, out: [] };
    w.expanding.add(key);
    this.walk(resolvedA, resolvedB, path, inner);
    w.expanding.delete(key);

    const subject = path.length > 0 ? `${code(render(path))} now uses` : 'Now uses';
    this.emit(w, 'reference-changed', 'none', path, `${subject} ${typeName(b)} instead of ${typeName(a)}.`, label(a), label(b));
    w.out.push(...inner.out);
  }

  private resolve(node: SchemaNode, schemas: ReadonlyMap<string, SchemaNode>): SchemaNode | undefined {
    if (node.kind !== 'ref') return node;
    const target = schemas.get(node.target);
    if (!target) return undefined;
    // Siblings of the $ref (nullable, deprecated, ...) apply on top of the component.
    const { kind: _kind, target: _target, ...meta } = node;
    return { ...target, ...meta };
  }

  private typeChanged(a: SchemaNode, b: SchemaNode, path: string[], w: Walk): void {
    let breaks: Breaks = 'both';
    if (a.kind === 'unknown') breaks = 'request'; // anything → specific: servers accept less
    else if (b.kind === 'unknown') breaks = 'response'; // specific → anything: clients get less certainty
    else if (a.kind === 'scalar' && b.kind === 'scalar') {
      if (a.type === 'integer' && b.type === 'number') breaks = 'response';
      if (a.type === 'number' && b.type === 'integer') breaks = 'request';
    }
    this.emit(w, 'type-changed', breaks, path, `${of('Type', path)} changed from ${code(label(a))} to ${code(label(b))}.`, label(a), label(b));
  }

  private enums(a: EnumValue[] | undefined, b: EnumValue[] | undefined, path: string[], w: Walk): void {
    const where = path.length > 0 ? code(render(path)) : '';
    if (!a && b) {
      this.emit(w, 'enum-added', 'request', path, `${where ? `${where} is now` : 'Now'} limited to ${values(b)}.`, undefined, b);
      return;
    }
    if (a && !b) {
      this.emit(w, 'enum-removed', 'response', path, `${where ? `${where} is` : 'Is'} no longer limited to a fixed set of values.`, a, undefined);
      return;
    }
    if (!a || !b) return;
    const added = b.filter((value) => !a.includes(value));
    const removed = a.filter((value) => !b.includes(value));
    if (added.length > 0) {
      const message = `Enum ${added.length === 1 ? 'value' : 'values'} ${values(added)} ${added.length === 1 ? 'was' : 'were'} added${where ? ` to ${where}` : ''}.`;
      this.emit(w, 'enum-value-added', 'response', path, message, undefined, added);
    }
    if (removed.length > 0) {
      const message = `Enum ${removed.length === 1 ? 'value' : 'values'} ${values(removed)} ${removed.length === 1 ? 'was' : 'were'} removed${where ? ` from ${where}` : ''}.`;
      this.emit(w, 'enum-value-removed', 'request', path, message, removed, undefined);
    }
  }

  private objects(a: ObjectSchema, b: ObjectSchema, path: string[], w: Walk): void {
    const before = new Map(a.properties.map((property) => [property.name, property]));
    const after = new Map(b.properties.map((property) => [property.name, property]));
    for (const property of b.properties) {
      const previous = before.get(property.name);
      const name = code(render([...path, property.name]));
      if (!previous) {
        const at = [...path, property.name];
        if (property.required) this.emit(w, 'property-added', 'request', at, `Required property ${name} was added.`);
        else this.emit(w, 'property-added', 'none', at, `Optional property ${name} was added.`);
        continue;
      }
      if (!previous.required && property.required) {
        this.emit(w, 'property-required', 'request', [...path, property.name], `Property ${name} is now required.`);
      } else if (previous.required && !property.required) {
        this.emit(w, 'property-optional', 'response', [...path, property.name], `Property ${name} is now optional.`);
      }
      this.walk(previous.schema, property.schema, [...path, property.name], w);
    }
    for (const property of a.properties) {
      if (!after.has(property.name)) {
        const at = [...path, property.name];
        this.emit(w, 'property-removed', 'both', at, `Property ${code(render(at))} was removed.`);
      }
    }
    this.additionalProperties(a.additionalProperties, b.additionalProperties, path, w);
  }

  private additionalProperties(a: ObjectSchema['additionalProperties'], b: ObjectSchema['additionalProperties'], path: string[], w: Walk): void {
    const where = path.length > 0 ? `${code(render(path))} ` : '';
    const subject = where ? where : 'The object ';
    if (typeof a === 'object' && typeof b === 'object') return this.walk(a, b, [...path, '{}'], w);
    const closedA = a === false;
    const closedB = b === false;
    if (closedA && !closedB) {
      return this.emit(w, 'additional-properties-changed', 'response', path, `${capitalize(subject)}now allows additional properties.`);
    }
    if (!closedA && closedB) {
      return this.emit(w, 'additional-properties-changed', 'request', path, `${capitalize(subject)}no longer allows additional properties.`);
    }
    if (typeof a === 'object' && typeof b !== 'object' && !closedB) {
      this.emit(w, 'additional-properties-changed', 'response', path, `${capitalize(subject)}now allows additional properties of any type.`);
    } else if (typeof a !== 'object' && typeof b === 'object' && !closedA) {
      this.emit(w, 'additional-properties-changed', 'request', path, `${capitalize(subject)}now only allows additional properties of type ${code(label(b))}.`);
    }
  }

  /** oneOf / anyOf. A plain schema on one side is treated as a single variant (`string` → `string | number`). */
  private variants(a: SchemaNode, b: SchemaNode, path: string[], w: Walk): void {
    // A plain schema becomes a lone variant; its meta (nullable, ...) was already compared on the outside.
    const from = a.kind === 'union' ? a.variants : [bare(a)];
    const to = b.kind === 'union' ? b.variants : [bare(b)];
    const { pairs, removed, added } = match(from, to);
    for (const [x, y] of pairs) this.walk(x, y, path, w);
    const where = path.length > 0 ? ` ${code(render(path))}` : '';
    for (const variant of added) {
      this.emit(w, 'variant-added', 'response', path, `Variant ${code(label(variant))} was added${where ? ` to${where}` : ''}.`, undefined, label(variant));
    }
    for (const variant of removed) {
      this.emit(w, 'variant-removed', 'request', path, `Variant ${code(label(variant))} was removed${where ? ` from${where}` : ''}.`, label(variant), undefined);
    }
    if (a.kind === 'union' && b.kind === 'union') this.discriminator(a.discriminator, b.discriminator, path, w);
  }

  private discriminator(
    a: Extract<SchemaNode, { kind: 'union' }>['discriminator'],
    b: Extract<SchemaNode, { kind: 'union' }>['discriminator'],
    path: string[],
    w: Walk,
  ): void {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const mappingA = a?.mapping ?? {};
    const mappingB = b?.mapping ?? {};
    // Only additions (a new property-less discriminator, new mapping entries) keep old payloads valid.
    const onlyAdditions =
      (a === undefined || a.propertyName === b?.propertyName) &&
      Object.entries(mappingA).every(([value, target]) => mappingB[value] === target);
    const where = path.length > 0 ? ` of ${code(render(path))}` : '';
    const describe = (d: typeof a): string => (d ? code(d.propertyName) : 'none');
    const message =
      a?.propertyName === b?.propertyName
        ? `Discriminator mapping${where} changed.`
        : `Discriminator${where} changed from ${describe(a)} to ${describe(b)}.`;
    this.emit(w, 'discriminator-changed', onlyAdditions ? 'none' : 'both', path, message, a, b);
  }

  /**
   * allOf. When the parts line up (same components, same number of inline parts) they are compared pairwise,
   * so changes inside a referenced component stay on that component. Otherwise both sides are flattened into
   * one object if possible, which makes refactors such as inlining an allOf compare property by property.
   */
  private parts(a: SchemaNode, b: SchemaNode, path: string[], w: Walk): void {
    const from = a.kind === 'intersection' ? a.parts : [bare(a)];
    const to = b.kind === 'intersection' ? b.parts : [bare(b)];
    const { pairs, removed, added } = match(from, to);
    if (removed.length === 0 && added.length === 0) {
      for (const [x, y] of pairs) this.walk(x, y, path, w);
      return;
    }
    const flatA = this.flatten(a, this.fromSchemas, new Set());
    const flatB = this.flatten(b, this.toSchemas, new Set());
    if (flatA && flatB) return this.objects(flatA, flatB, path, w);

    for (const [x, y] of pairs) this.walk(x, y, path, w);
    const where = path.length > 0 ? ` ${code(render(path))}` : '';
    for (const part of added) {
      this.emit(w, 'part-added', 'request', path, `${code(label(part))} was added to the allOf${where ? ` of${where}` : ''}.`, undefined, label(part));
    }
    for (const part of removed) {
      this.emit(w, 'part-removed', 'both', path, `${code(label(part))} was removed from the allOf${where ? ` of${where}` : ''}.`, label(part), undefined);
    }
  }

  /** Merges an object or an allOf of objects (through `$ref`s) into a single object; undefined otherwise. */
  private flatten(node: SchemaNode, schemas: ReadonlyMap<string, SchemaNode>, seen: Set<string>): ObjectSchema | undefined {
    if (node.kind === 'ref') {
      if (seen.has(node.target)) return undefined;
      const target = schemas.get(node.target);
      return target ? this.flatten(target, schemas, new Set([...seen, node.target])) : undefined;
    }
    if (node.kind === 'object') return node;
    if (node.kind !== 'intersection') return undefined;
    const properties = new Map<string, Property>();
    let additionalProperties: ObjectSchema['additionalProperties'];
    for (const part of node.parts) {
      const object = this.flatten(part, schemas, seen);
      if (!object) return undefined;
      for (const property of object.properties) {
        const existing = properties.get(property.name);
        properties.set(property.name, existing ? { ...existing, required: existing.required || property.required } : property);
      }
      if (object.additionalProperties === false) additionalProperties = false;
      else if (additionalProperties === undefined) additionalProperties = object.additionalProperties;
    }
    return { kind: 'object', properties: [...properties.values()], additionalProperties };
  }

  private emit(w: Walk, kind: ChangeKind, breaks: Breaks, path: string[], message: string, before?: unknown, after?: unknown): void {
    const breaking = breaks === 'both' || (breaks !== 'none' && (w.direction === 'both' || w.direction === breaks));
    const change: SchemaChange = { kind, breaking, path: render(path), message };
    if (before !== undefined) change.before = before;
    if (after !== undefined) change.after = after;
    w.out.push(change);
  }
}

/** Pairs up variants/parts: components by name, then inline schemas of the same shape in order. */
function match(from: readonly SchemaNode[], to: readonly SchemaNode[]) {
  const pairs: Array<[SchemaNode, SchemaNode]> = [];
  const remaining = [...to];
  const removed: SchemaNode[] = [];
  const unmatched: SchemaNode[] = [];
  for (const node of from) {
    const index = node.kind === 'ref' ? remaining.findIndex((other) => other.kind === 'ref' && other.target === node.target) : -1;
    if (index >= 0) pairs.push([node, remaining.splice(index, 1)[0]!]);
    else unmatched.push(node);
  }
  for (const node of unmatched) {
    const index = node.kind === 'ref' ? -1 : remaining.findIndex((other) => other.kind !== 'ref' && shape(other) === shape(node));
    if (index >= 0) pairs.push([node, remaining.splice(index, 1)[0]!]);
    else removed.push(node);
  }
  return { pairs, removed, added: remaining };
}

function bare(node: SchemaNode): SchemaNode {
  const { title: _t, description: _d, deprecated: _p, nullable: _n, readOnly: _r, writeOnly: _w, default: _f, ...rest } = node;
  return rest as SchemaNode;
}

function shape(node: SchemaNode): string {
  return node.kind === 'scalar' ? `scalar:${node.type}` : node.kind;
}

/** Short type description for messages: `Pet`, `string`, `Pet[]`, `string | number`. */
export function label(node: SchemaNode): string {
  switch (node.kind) {
    case 'ref':
      return node.target;
    case 'scalar':
      return node.type;
    case 'array': {
      const items = label(node.items);
      return /^[\w.$-]+$/.test(items) ? `${items}[]` : `Array<${items}>`;
    }
    case 'object':
      return node.properties.length === 0 && typeof node.additionalProperties === 'object'
        ? `Record<string, ${label(node.additionalProperties)}>`
        : 'object';
    case 'union':
      return node.variants.length > 0 && node.variants.length <= 3 ? node.variants.map(label).join(' | ') : node.exclusive ? 'oneOf' : 'anyOf';
    case 'intersection':
      return node.parts.length > 0 && node.parts.length <= 3 ? node.parts.map(label).join(' & ') : 'allOf';
    case 'unknown':
      return 'any';
  }
}

function typeName(node: SchemaNode): string {
  return node.kind === 'ref' ? code(node.target) : 'an inline schema';
}

/** `owner.name`, `tags[]`, `[].id`, `metadata{}`. */
function render(path: readonly string[]): string {
  return path.reduce((out, segment) => (segment === '[]' || segment === '{}' || out === '' ? out + segment : `${out}.${segment}`), '');
}

function of(noun: string, path: readonly string[]): string {
  return path.length > 0 ? `${noun} of ${code(render(path))}` : noun;
}

function json(value: unknown): string {
  return value === undefined ? 'none' : code(JSON.stringify(value));
}

function values(list: readonly EnumValue[]): string {
  return list.map((value) => code(typeof value === 'string' ? value : JSON.stringify(value))).join(', ');
}

export interface SchemaUsage {
  /** Operations sending the schema (parameters, request bodies), in model order. */
  request: string[];
  /** Operations receiving it (responses), in model order. */
  response: string[];
}

/** Which operations use each component schema, directly or through other components. */
export function schemaUsage(model: ApiModel): Map<string, SchemaUsage> {
  const components = new Map(model.schemas.map((named) => [named.key, named.schema]));
  const closure = new Map<string, Set<string>>();
  const reachable = (key: string): Set<string> => {
    let result = closure.get(key);
    if (result) return result;
    result = new Set([key]);
    closure.set(key, result);
    const queue = [key];
    while (queue.length > 0) {
      const schema = components.get(queue.pop()!);
      if (!schema) continue;
      for (const ref of refsOf(schema)) {
        if (!result.has(ref)) {
          result.add(ref);
          queue.push(ref);
        }
      }
    }
    return result;
  };

  const usage = new Map<string, SchemaUsage>();
  const record = (node: SchemaNode, op: Operation, side: keyof SchemaUsage): void => {
    for (const ref of refsOf(node)) {
      for (const key of reachable(ref)) {
        let entry = usage.get(key);
        if (!entry) usage.set(key, (entry = { request: [], response: [] }));
        if (entry[side].at(-1) !== op.key) entry[side].push(op.key);
      }
    }
  };
  for (const op of model.operations) {
    for (const param of op.parameters) record(param.schema, op, 'request');
    for (const media of op.requestBody?.content ?? []) record(media.schema, op, 'request');
    for (const response of op.responses) for (const media of response.content) record(media.schema, op, 'response');
  }
  return usage;
}

function refsOf(node: SchemaNode, out: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'ref':
      out.add(node.target);
      break;
    case 'array':
      refsOf(node.items, out);
      break;
    case 'object':
      for (const property of node.properties) refsOf(property.schema, out);
      if (typeof node.additionalProperties === 'object') refsOf(node.additionalProperties, out);
      break;
    case 'union':
      for (const variant of node.variants) refsOf(variant, out);
      break;
    case 'intersection':
      for (const part of node.parts) refsOf(part, out);
      break;
  }
  return out;
}
