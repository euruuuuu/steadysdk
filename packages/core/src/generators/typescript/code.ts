const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Line-based source builder with indentation and JSDoc helpers. */
export class CodeWriter {
  private readonly lines: string[] = [];
  private level = 0;

  /** Appends text; embedded newlines are indented to the current level too. */
  line(text = ''): this {
    for (const part of text.split('\n')) {
      this.lines.push(part === '' ? '' : '  '.repeat(this.level) + part);
    }
    return this;
  }

  /** A blank line, unless the previous line is already blank or opens a block. */
  blank(): this {
    const previous = this.lines.at(-1);
    if (previous !== undefined && previous !== '' && !previous.endsWith('{')) this.lines.push('');
    return this;
  }

  block(open: string, body: () => void, close = '}'): this {
    this.line(open);
    this.level++;
    body();
    this.level--;
    this.line(close);
    return this;
  }

  doc(lines: readonly string[]): this {
    const content = trimBlankEdges(lines.flatMap((line) => line.split('\n')).map((line) => line.trimEnd()));
    if (content.length === 0) return this;
    if (content.length === 1) return this.line(`/** ${escapeDoc(content[0]!)} */`);
    this.line('/**');
    for (const line of content) this.line(line === '' ? ' *' : ` * ${escapeDoc(line)}`);
    return this.line(' */');
  }

  toString(): string {
    const out = [...this.lines];
    while (out.at(-1) === '') out.pop();
    return `${out.join('\n')}\n`;
  }
}

export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

/** Single-quoted TS string literal. */
export function stringLiteral(value: string): string {
  const escaped = value.replace(/[\\'\n\r\u2028\u2029]/g, (char) => STRING_ESCAPES[char] ?? char);
  return `'${escaped}'`;
}

const STRING_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** Object property key: bare when it is an identifier, quoted otherwise. */
export function propertyKey(name: string): string {
  return isIdentifier(name) ? name : stringLiteral(name);
}

/** Property access expression: `obj.name` or `obj['na-me']`. */
export function propertyAccess(object: string, name: string): string {
  return isIdentifier(name) ? `${object}.${name}` : `${object}[${stringLiteral(name)}]`;
}

/** A JSON-compatible value as a TS literal (single-quoted strings). */
export function literal(value: unknown): string {
  if (typeof value === 'string') return stringLiteral(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${propertyKey(key)}: ${literal(item)}`).join(', ')} }`;
  }
  return 'undefined';
}

function escapeDoc(line: string): string {
  return line.replace(/\*\//g, '*\\/');
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end).filter((line, index, all) => line !== '' || all[index - 1] !== '');
}
