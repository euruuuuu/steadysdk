import type { CaseStyle, NamingConfig } from '../config/schema.js';
import { SdkgenError } from '../errors.js';
import type { Operation, Parameter } from '../ir/model.js';
import { applyCase, splitWords } from './case.js';
import { Pluralizer } from './plural.js';

export type GroupBy = 'tag' | 'path' | 'none';
export type DerivedTypeKind = 'params' | 'requestBody' | 'response';
export type TemplateKind = keyof NamingConfig['operations']['templates'];

const OPERATION_KEY = /^(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)\s+\//i;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The parts of a path that path-derived names are built from. */
export interface PathAnalysis {
  kind: TemplateKind;
  /** Item path (ends in a parameter, e.g. `/pets/{petId}`) vs. collection path. */
  item: boolean;
  action: string | undefined;
  /** Singular resource words, parents included: `/users/{id}/posts` → user, post. */
  resource: string[];
  /** Same, with the last word pluralized. */
  resources: string[];
  /** `By…` words for item paths: `/pets/{petId}` → By, Pet, Id. */
  by: string[];
}

/**
 * Turns spec names into desired SDK identifiers, following `naming` config.
 *
 * It is stateless: uniqueness and stability across regenerations are handled by `assignNames`.
 */
export class NamingEngine {
  readonly config: NamingConfig;
  private readonly pluralizer: Pluralizer;
  private readonly stripPrefixes: RegExp[];
  private readonly ignoreSegments: RegExp[];
  private readonly actions: Set<string>;

  constructor(config: NamingConfig) {
    this.config = config;
    this.pluralizer = new Pluralizer(config.pluralization);
    this.stripPrefixes = config.operations.stripPrefixes.map((pattern) => new RegExp(pattern));
    this.ignoreSegments = config.operations.ignoreSegments.map((pattern) => new RegExp(`^(?:${pattern})$`, 'i'));
    this.actions = new Set(config.operations.actions.map((action) => action.toLowerCase()));
  }

  /** Method name for an operation. Overrides (by `METHOD /path` or operationId) win over everything. */
  operationName(op: Operation): string {
    const override = this.operationOverride(op);
    if (override !== undefined) return this.checkOverride(override, `naming.overrides.operations["${op.key}"]`);

    const { operations } = this.config;
    let base: string[];
    if (operations.source === 'operationId' && op.operationId) {
      let id = op.operationId;
      for (const pattern of this.stripPrefixes) id = id.replace(pattern, '');
      base = splitWords(id);
    } else {
      base = splitWords(this.expandTemplate(op));
    }
    if (base.length === 0) base = [op.method, 'root'];
    return this.identifier([...splitWords(operations.prefix), ...base, ...splitWords(operations.suffix)], operations.case);
  }

  /** Type name for a `components.schemas` entry. */
  typeName(schemaKey: string): string {
    const override = this.config.overrides.schemas[schemaKey];
    if (override !== undefined) return this.checkOverride(override, `naming.overrides.schemas["${schemaKey}"]`);
    const { types } = this.config;
    const words = splitWords(schemaKey);
    return this.identifier(
      [...splitWords(types.prefix), ...(words.length > 0 ? words : ['schema']), ...splitWords(types.suffix)],
      types.case,
    );
  }

  /** Name of a helper type derived from an operation, e.g. `ListPetsParams`. */
  derivedTypeName(kind: DerivedTypeKind, methodName: string): string {
    const expanded = this.config.derived[kind].replaceAll('{Operation}', applyCase(splitWords(methodName), 'pascal'));
    return this.identifier(splitWords(expanded), this.config.types.case);
  }

  /** Client class name, from config or the spec title. */
  clientName(configured: string | undefined, title: string): string {
    if (configured !== undefined) return configured;
    const words = splitWords(title).filter((word) => !/^(api|client|sdk)$/i.test(word));
    return this.identifier([...(words.length > 0 ? words : ['api']), 'client'], 'pascal');
  }

  /** Group id for an operation: its first tag, first path segment, or `''` for the root client. */
  groupOf(op: Operation, groupBy: GroupBy): string {
    if (groupBy === 'tag') return op.tags[0] ?? '';
    if (groupBy === 'path') {
      const segment = op.path.split('/').find((part) => part !== '' && !isParamSegment(part) && !this.isIgnored(part));
      return segment ?? '';
    }
    return '';
  }

  /** Client property name for a group, e.g. `pets` in `client.pets.listPets()`. */
  groupProperty(groupId: string): string {
    const override = this.config.overrides.groups[groupId];
    if (override !== undefined) return this.checkOverride(override, `naming.overrides.groups["${groupId}"]`);
    return this.identifier(nonEmpty(splitWords(groupId), 'default'), this.config.groups.case);
  }

  /** Class name for a group, e.g. `PetsApi`. */
  groupClassName(groupId: string): string {
    const words = nonEmpty(splitWords(this.groupProperty(groupId)), 'default');
    const expanded = this.config.groups.className.replaceAll('{Group}', applyCase(words, 'pascal'));
    return this.identifier(splitWords(expanded), 'pascal');
  }

  /** Property name a parameter gets in the generated params object. */
  parameterName(param: Parameter): string {
    const override = this.config.overrides.parameters[param.name];
    if (override !== undefined) return this.checkOverride(override, `naming.overrides.parameters["${param.name}"]`);
    const style = this.config.parameters.case;
    if (style === 'preserve') return param.name;
    return this.identifier(nonEmpty(splitWords(param.name), 'param'), style);
  }

  /** Breaks a path into the parts used by path-derived names. Exposed for tests and tooling. */
  analyzePath(op: Operation): PathAnalysis {
    let segments = op.path.split('/').filter((segment) => segment !== '');

    // Google-style custom methods: /v1/{name}:cancel
    let action: string | undefined;
    const last = segments.at(-1);
    const colon = last?.match(/^(.*[^:]):([A-Za-z][\w-]*)$/);
    if (last !== undefined && colon?.[1] !== undefined && colon[2] !== undefined) {
      action = colon[2];
      segments = [...segments.slice(0, -1), colon[1]];
    }

    segments = segments.filter((segment) => isParamSegment(segment) || !this.isIgnored(segment));

    const tail = segments.at(-1);
    if (action === undefined && tail !== undefined && !isParamSegment(tail) && this.actions.has(tail.toLowerCase())) {
      action = tail;
      segments = segments.slice(0, -1);
    }

    const item = segments.length > 0 && isParamSegment(segments.at(-1)!);
    const trailingParams: string[] = [];
    for (let index = segments.length - 1; index >= 0 && isParamSegment(segments[index]!); index--) {
      trailingParams.unshift(segments[index]!.slice(1, -1));
    }

    const parents: string[] = [];
    let final: string[] = [];
    segments.forEach((segment, index) => {
      if (isParamSegment(segment)) return;
      const words = splitWords(segment).map((word) => word.toLowerCase());
      if (words.length === 0) return;
      if (final.length > 0) parents.push(...this.singularizeIfFollowedByParam(final, segments, index));
      final = words;
    });
    if (final.length === 0) final = ['root'];

    const withLast = (words: string[], form: (word: string) => string): string[] => [
      ...words.slice(0, -1),
      form(words.at(-1)!),
    ];
    const resource = [...parents, ...withLast(final, (word) => this.pluralizer.singular(word))];
    const resources = [...parents, ...withLast(final, (word) => this.pluralizer.plural(word))];
    const by = item ? ['by', ...trailingParams.flatMap((param, index) => [...(index > 0 ? ['and'] : []), ...splitWords(param)])] : [];

    let kind: TemplateKind;
    if (action !== undefined) kind = 'action';
    else if (op.method === 'get') kind = item ? 'get' : 'list';
    else if (op.method === 'post') kind = 'create';
    else if (op.method === 'put') kind = 'update';
    else if (op.method === 'patch') kind = 'patch';
    else if (op.method === 'delete') kind = 'delete';
    else kind = 'other';

    return { kind, item, action, resource, resources, by };
  }

  private expandTemplate(op: Operation): string {
    const analysis = this.analyzePath(op);
    const pascal = (words: string[]): string => applyCase(words, 'pascal');
    const verb = analysis.kind === 'action' || analysis.kind === 'other' ? op.method : analysis.kind;
    return this.config.operations.templates[analysis.kind]
      .replaceAll('{verb}', verb)
      .replaceAll('{method}', op.method)
      .replaceAll('{action}', pascal(splitWords(analysis.action ?? '')))
      .replaceAll('{Resource}', pascal(analysis.resource))
      .replaceAll('{Resources}', pascal(analysis.resources))
      .replaceAll('{Target}', pascal(analysis.item ? analysis.resource : analysis.resources))
      .replaceAll('{By}', pascal(analysis.by));
  }

  /** `/users/{id}/posts`: the parent `users` is a single user, so it reads as `UserPosts`. */
  private singularizeIfFollowedByParam(words: string[], segments: string[], nextIndex: number): string[] {
    const followedByParam = isParamSegment(segments[nextIndex - 1] ?? '');
    return followedByParam ? [...words.slice(0, -1), this.pluralizer.singular(words.at(-1)!)] : words;
  }

  private operationOverride(op: Operation): string | undefined {
    const overrides = this.config.overrides.operations;
    for (const [key, value] of Object.entries(overrides)) {
      if (OPERATION_KEY.test(key) && normalizeOperationKey(key) === op.key) return value;
    }
    return op.operationId !== undefined ? overrides[op.operationId] : undefined;
  }

  private identifier(words: string[], style: CaseStyle): string {
    let name = style === 'preserve' ? words.join('') : applyCase(words, style, { acronyms: this.config.acronyms });
    if (name === '') name = '_';
    return /^[0-9]/.test(name) ? `_${name}` : name;
  }

  private checkOverride(name: string, where: string): string {
    if (!IDENTIFIER.test(name)) {
      throw new SdkgenError('NAMING_INVALID', `${where} is "${name}", which is not a valid identifier`);
    }
    return name;
  }

  private isIgnored(segment: string): boolean {
    return this.ignoreSegments.some((pattern) => pattern.test(segment));
  }
}

export function isParamSegment(segment: string): boolean {
  return /^\{[^}]+\}$/.test(segment);
}

/** `get  /Pets/{id}` → `GET /Pets/{id}` (paths are case-sensitive, methods are not). */
export function normalizeOperationKey(key: string): string {
  const [method = '', ...rest] = key.trim().split(/\s+/);
  return `${method.toUpperCase()} ${rest.join(' ')}`;
}

function nonEmpty(words: string[], fallback: string): string[] {
  return words.length > 0 ? words : [fallback];
}
