import type { SteadySdkConfig } from '../config/schema.js';
import type { Diagnostics } from '../diagnostics.js';
import type { ApiModel, Operation } from '../ir/model.js';
import { canonicalJson, sha256 } from '../util/hash.js';
import { applyCase, splitWords } from './case.js';
import { NamingEngine, type DerivedTypeKind } from './engine.js';
import { NAME_LOCK_VERSION, type NameLock } from './lock.js';

export interface OperationNames {
  /** Group id; `''` means the method lives on the root client. */
  group: string;
  method: string;
  derived: Partial<Record<DerivedTypeKind, string>>;
  /** `${in}:${name}` → property name in the params object. */
  parameters: Map<string, string>;
}

export interface GroupNames {
  id: string;
  property: string;
  className: string;
}

export interface SdkNames {
  client: string;
  /** Schema key → type name. */
  schemas: Map<string, string>;
  /** Group id → names, in order of first use. The root group (`''`) is not included. */
  groups: Map<string, GroupNames>;
  /** Operation key → names. */
  operations: Map<string, OperationNames>;
}

export interface AssignNamesOptions {
  model: ApiModel;
  config: Pick<SteadySdkConfig, 'naming' | 'client'>;
  /** Names from the previous run. Ignored when it was written under a different naming config. */
  lock?: NameLock | undefined;
  /** Type names the generator itself exports or relies on (runtime classes, globals, ...). */
  reservedTypeNames: Iterable<string>;
  /** Member names client classes already use (e.g. `http`). */
  reservedMemberNames: Iterable<string>;
  /** Which helper types the generator wants for an operation. */
  derivedTypes: (op: Operation) => readonly DerivedTypeKind[];
  diagnostics: Diagnostics;
}

export interface AssignNamesResult {
  names: SdkNames;
  lock: NameLock;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Fingerprint of everything that influences naming. A change re-derives names instead of using the lock. */
export function namingConfigHash(config: Pick<SteadySdkConfig, 'naming' | 'client'>): string {
  return sha256(
    canonicalJson({
      lockVersion: NAME_LOCK_VERSION,
      naming: config.naming,
      groupBy: config.client.groupBy,
      clientName: config.client.name ?? null,
    }),
  ).slice(0, 16);
}

/**
 * Assigns every SDK identifier: unique within its scope, and stable across runs via the name lock.
 *
 * Locked names are claimed first, so a new schema or operation can never take a name an existing one had;
 * the newcomer gets the suffix instead.
 */
export function assignNames(options: AssignNamesOptions): AssignNamesResult {
  const { model, config, diagnostics } = options;
  const engine = new NamingEngine(config.naming);
  const configHash = namingConfigHash(config);

  let locked: Record<string, string> = {};
  if (options.lock) {
    if (options.lock.configHash === configHash) {
      locked = options.lock.names;
    } else {
      diagnostics.info('NAMING_CONFIG_CHANGED', 'Naming config changed since the last run; names were re-derived from the rules.');
    }
  }

  const assigned = new Map<string, string>();
  const claim = (slots: Slot[]): void => {
    for (const slot of slots) {
      const name = locked[slot.id];
      if (name === undefined || !IDENTIFIER.test(name) || !slot.scope.isFree(name)) continue;
      slot.scope.take(name);
      assigned.set(slot.id, name);
      const desired = slot.desired();
      if (name !== desired) {
        diagnostics.info(
          'NAME_PINNED',
          `Kept ${slot.what} name \`${name}\` from the name lock (current rules give \`${desired}\`). Use --relock to adopt rule-based names.`,
          slot.location,
        );
      }
    }
    for (const slot of slots) {
      if (assigned.has(slot.id)) continue;
      const desired = slot.desired();
      const { name, collided, reserved } = slot.scope.claim(desired);
      assigned.set(slot.id, name);
      if (reserved && !collided) {
        diagnostics.info('NAME_RESERVED', `${capitalize(slot.what)} \`${desired}\` is a reserved name; using \`${name}\`.`, slot.location);
      }
      if (collided) {
        diagnostics.warn(
          'NAME_COLLISION',
          `${capitalize(slot.what)} name \`${desired}\` is already taken in ${slot.scope.label}; using \`${name}\`. Add a naming override to choose a better name.`,
          slot.location,
        );
      }
    }
  };
  const nameOf = (id: string): string => assigned.get(id)!;

  // Group ids, in order of first use.
  const groupBy = config.client.groupBy;
  const groupOfOp = new Map(model.operations.map((op) => [op.key, engine.groupOf(op, groupBy)]));
  const groupIds = [...new Set(groupOfOp.values())].filter((id) => id !== '');

  // Phase 1: members (group properties and methods), one scope per class.
  const reservedMembers = new Set(['constructor', ...options.reservedMemberNames]);
  const rootScope = new Scope('the root client', reservedMembers, '_');
  claim(
    groupIds.map((id) => ({
      id: `group:${id}#property`,
      scope: rootScope,
      desired: () => engine.groupProperty(id),
      what: 'group property',
      location: `tag ${id}`,
    })),
  );
  const memberScopes = new Map<string, Scope>([['', rootScope]]);
  for (const id of groupIds) memberScopes.set(id, new Scope(`group ${id}`, reservedMembers, '_'));
  claim(
    model.operations.map((op) => ({
      id: `operation:${op.key}`,
      scope: memberScopes.get(groupOfOp.get(op.key)!)!,
      desired: () => engine.operationName(op),
      what: 'method',
      location: op.key,
    })),
  );

  // Phase 2: exported type names share one scope.
  const typeScope = new Scope('exported types', new Set(options.reservedTypeNames), config.naming.types.reservedSuffix);
  claim([
    { id: 'client', scope: typeScope, desired: () => engine.clientName(config.client.name, model.title), what: 'client class', location: 'client' },
    ...groupIds.map((id) => ({
      id: `group:${id}`,
      scope: typeScope,
      desired: () => engine.groupClassName(id),
      what: 'group class',
      location: `tag ${id}`,
    })),
    ...model.schemas.map((schema) => ({
      id: `schema:${schema.key}`,
      scope: typeScope,
      desired: () => engine.typeName(schema.key),
      what: 'type',
      location: `#/components/schemas/${schema.key}`,
    })),
    ...model.operations.flatMap((op) =>
      options.derivedTypes(op).map((kind) => ({
        id: `operation:${op.key}#${kind}`,
        scope: typeScope,
        desired: () => engine.derivedTypeName(kind, nameOf(`operation:${op.key}`)),
        what: `${kind} type`,
        location: op.key,
      })),
    ),
  ]);

  const names: SdkNames = {
    client: nameOf('client'),
    schemas: new Map(model.schemas.map((schema) => [schema.key, nameOf(`schema:${schema.key}`)])),
    groups: new Map(
      groupIds.map((id) => [id, { id, property: nameOf(`group:${id}#property`), className: nameOf(`group:${id}`) }]),
    ),
    operations: new Map(
      model.operations.map((op) => {
        const derived: Partial<Record<DerivedTypeKind, string>> = {};
        for (const kind of options.derivedTypes(op)) derived[kind] = nameOf(`operation:${op.key}#${kind}`);
        return [
          op.key,
          { group: groupOfOp.get(op.key)!, method: nameOf(`operation:${op.key}`), derived, parameters: parameterNames(op, engine) },
        ];
      }),
    ),
  };

  if (options.lock && options.lock.configHash !== configHash) {
    for (const [id, previous] of Object.entries(options.lock.names)) {
      const current = assigned.get(id);
      if (current !== undefined && current !== previous) {
        // A rename breaks SDK callers, so it is a warning even though it was asked for.
        diagnostics.warn('NAME_CHANGED', `Renamed \`${previous}\` → \`${current}\``, id);
      }
    }
  }

  return {
    names,
    lock: { version: NAME_LOCK_VERSION, configHash, names: Object.fromEntries([...assigned].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) },
  };
}

function parameterNames(op: Operation, engine: NamingEngine): Map<string, string> {
  const scope = new Scope(`${op.key} parameters`, new Set(), '_');
  const out = new Map<string, string>();
  for (const param of op.parameters) {
    let desired = engine.parameterName(param);
    // An `id` in both path and query: the later one becomes `queryId` rather than `id2`.
    if (!scope.isFree(desired) && engine.config.parameters.case !== 'preserve') {
      desired = applyCase([param.in, ...splitWords(desired)], engine.config.parameters.case, {
        acronyms: engine.config.acronyms,
      });
    }
    out.set(`${param.in}:${param.name}`, scope.claim(desired).name);
  }
  return out;
}

interface Slot {
  /** Lock identity. */
  id: string;
  scope: Scope;
  desired: () => string;
  what: string;
  location: string;
}

class Scope {
  readonly label: string;
  private readonly reserved: ReadonlySet<string>;
  private readonly reservedSuffix: string;
  private readonly taken = new Set<string>();

  constructor(label: string, reserved: ReadonlySet<string>, reservedSuffix: string) {
    this.label = label;
    this.reserved = reserved;
    this.reservedSuffix = reservedSuffix;
  }

  isFree(name: string): boolean {
    return !this.taken.has(name) && !this.reserved.has(name);
  }

  take(name: string): void {
    this.taken.add(name);
  }

  /**
   * Claims `desired`, or the first free variant. `reserved`: the name is reserved and got the reserved suffix.
   * `collided`: another symbol was in the way and a number was appended.
   */
  claim(desired: string): { name: string; collided: boolean; reserved: boolean } {
    const reserved = this.reserved.has(desired);
    const base = reserved ? `${desired}${this.reservedSuffix}` : desired;
    let name = base;
    for (let n = 2; !this.isFree(name); n++) name = `${base}${n}`;
    this.take(name);
    return { name, collided: name !== base, reserved };
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
