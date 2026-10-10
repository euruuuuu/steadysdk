import type { ApiModel, SchemaNode } from './model.js';

/** `components.schemas` keys a schema references directly. */
export function refsOf(node: SchemaNode, out: Set<string> = new Set()): Set<string> {
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

/** Returns `key` → every component it reaches through references (itself included), memoized per model. */
export function reachability(model: ApiModel): (key: string) => ReadonlySet<string> {
  const components = new Map(model.schemas.map((named) => [named.key, named.schema]));
  const memo = new Map<string, Set<string>>();
  return (key) => {
    let result = memo.get(key);
    if (result) return result;
    result = new Set([key]);
    memo.set(key, result);
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
}

/** Rebuilds a schema with every reference passed through `replace` (return the node to keep it). */
export function mapRefs(node: SchemaNode, replace: (ref: Extract<SchemaNode, { kind: 'ref' }>) => SchemaNode): SchemaNode {
  switch (node.kind) {
    case 'ref':
      return replace(node);
    case 'array':
      return { ...node, items: mapRefs(node.items, replace) };
    case 'object':
      return {
        ...node,
        properties: node.properties.map((property) => ({ ...property, schema: mapRefs(property.schema, replace) })),
        additionalProperties:
          typeof node.additionalProperties === 'object' ? mapRefs(node.additionalProperties, replace) : node.additionalProperties,
      };
    case 'union':
      return { ...node, variants: node.variants.map((variant) => mapRefs(variant, replace)) };
    case 'intersection':
      return { ...node, parts: node.parts.map((part) => mapRefs(part, replace)) };
    default:
      return node;
  }
}
