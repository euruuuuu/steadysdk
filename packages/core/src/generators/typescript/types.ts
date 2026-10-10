import type { ObjectSchema, SchemaNode } from '../../ir/model.js';
import { CodeWriter, literal, propertyKey } from './code.js';

export interface TypeContext {
  /** Type name for a `components.schemas` key; implementations also record it for imports. */
  ref(key: string): string;
}

/** How tightly an expression binds, to decide where parentheses are needed. */
type Precedence = 'atom' | 'object' | 'intersection' | 'union';

interface Rendered {
  text: string;
  precedence: Precedence;
}

/** Renders a schema as a TypeScript type expression. Inline objects span multiple lines. */
export function renderType(node: SchemaNode, ctx: TypeContext): string {
  return render(node, ctx).text;
}

function render(node: SchemaNode, ctx: TypeContext): Rendered {
  const base = renderBase(node, ctx);
  if (!node.nullable || base.text === 'unknown' || base.text === 'null') return base;
  const inner = base.precedence === 'intersection' ? `(${base.text})` : base.text;
  return { text: `${inner} | null`, precedence: 'union' };
}

function renderBase(node: SchemaNode, ctx: TypeContext): Rendered {
  switch (node.kind) {
    case 'ref':
      return { text: ctx.ref(node.target), precedence: 'atom' };
    case 'unknown':
      return { text: 'unknown', precedence: 'atom' };
    case 'scalar': {
      if (node.enum && node.enum.length > 0) {
        const values = [...new Set(node.enum.map(literal))];
        return { text: values.join(' | '), precedence: values.length > 1 ? 'union' : 'atom' };
      }
      if (node.type === 'string') return { text: node.format === 'binary' ? 'Blob' : 'string', precedence: 'atom' };
      if (node.type === 'integer' || node.type === 'number') return { text: 'number', precedence: 'atom' };
      return { text: node.type, precedence: 'atom' };
    }
    case 'array': {
      const items = render(node.items, ctx);
      return items.precedence === 'atom'
        ? { text: `${items.text}[]`, precedence: 'atom' }
        : { text: `Array<${items.text}>`, precedence: 'atom' };
    }
    case 'object':
      return renderObject(node, ctx);
    case 'union': {
      const variants = [...new Set(node.variants.map((variant) => render(variant, ctx).text))];
      if (variants.length === 0) return { text: 'unknown', precedence: 'atom' };
      return { text: variants.join(' | '), precedence: variants.length > 1 ? 'union' : 'atom' };
    }
    case 'intersection': {
      const parts = node.parts.map((part) => render(part, ctx));
      if (parts.length === 0) return { text: 'unknown', precedence: 'atom' };
      const text = parts.map((part) => (part.precedence === 'union' ? `(${part.text})` : part.text)).join(' & ');
      return { text, precedence: parts.length > 1 ? 'intersection' : (parts[0]?.precedence ?? 'atom') };
    }
  }
}

function renderObject(node: ObjectSchema, ctx: TypeContext): Rendered {
  if (node.properties.length === 0) {
    const values =
      node.additionalProperties === false
        ? 'never'
        : typeof node.additionalProperties === 'object'
          ? render(node.additionalProperties, ctx).text
          : 'unknown';
    return { text: `Record<string, ${values}>`, precedence: 'atom' };
  }
  const writer = new CodeWriter();
  writer.block('{', () => writeMembers(writer, node, ctx));
  return { text: writer.toString().trimEnd(), precedence: 'object' };
}

/** Writes an object's members (for interface bodies and inline object types). */
export function writeMembers(writer: CodeWriter, node: ObjectSchema, ctx: TypeContext): void {
  for (const property of node.properties) {
    writer.doc(schemaDocs(property.schema));
    writer.line(`${propertyKey(property.name)}${property.required ? '' : '?'}: ${renderType(property.schema, ctx)};`);
  }
  if (node.additionalProperties === true || typeof node.additionalProperties === 'object') {
    // Typed additionalProperties would have to admit every named property's type; `unknown` always does.
    writer.line('[key: string]: unknown;');
  }
}

/** JSDoc lines for a schema: description plus format/default/deprecation notes. */
export function schemaDocs(node: SchemaNode, description = node.description): string[] {
  const lines: string[] = [];
  if (description) lines.push(description);
  if (node.readOnly) lines.push('Read-only: returned by the server, ignored in requests.');
  if (node.writeOnly) lines.push('Write-only: accepted in requests, never returned.');
  // Block tags last: JSDoc treats everything after the first tag as part of a tag.
  if (node.kind === 'scalar' && node.format && node.format !== 'binary') lines.push(`@format ${node.format}`);
  if (node.default !== undefined) lines.push(`@default ${JSON.stringify(node.default)}`);
  if (node.deprecated) lines.push('@deprecated');
  return lines;
}

/** True when the schema contains an inline object, i.e. reads better as a named type. */
export function hasInlineObject(node: SchemaNode): boolean {
  switch (node.kind) {
    case 'object':
      return node.properties.length > 0;
    case 'array':
      return hasInlineObject(node.items);
    case 'union':
      return node.variants.some(hasInlineObject);
    case 'intersection':
      return node.parts.some(hasInlineObject);
    default:
      return false;
  }
}
