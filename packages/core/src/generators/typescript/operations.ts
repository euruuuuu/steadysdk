import type { MediaType, Operation, Response, SchemaNode } from '../../ir/model.js';
import type { DerivedTypeKind } from '../../naming/engine.js';
import type { OperationNames } from '../../naming/assign.js';
import { CodeWriter, propertyAccess, propertyKey, stringLiteral } from './code.js';
import { hasInlineObject, renderType, schemaDocs, type TypeContext } from './types.js';

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json\b/i;

type MediaKind = 'json' | 'form' | 'multipart' | 'text' | 'binary';

function mediaKind(contentType: string): MediaKind {
  if (JSON_MEDIA.test(contentType) || /^text\/json\b/i.test(contentType) || contentType === '*/*') return 'json';
  if (/^application\/x-www-form-urlencoded\b/i.test(contentType)) return 'form';
  if (/^multipart\/form-data\b/i.test(contentType)) return 'multipart';
  if (/^text\//i.test(contentType)) return 'text';
  return 'binary';
}

/** The media type a generated method uses: JSON first, then forms, text, and anything else. */
export function preferredMedia(content: readonly MediaType[]): MediaType | undefined {
  const order: MediaKind[] = ['json', 'form', 'multipart', 'text', 'binary'];
  for (const kind of order) {
    const match = content.find((media) => mediaKind(media.contentType) === kind);
    if (match) return match;
  }
  return undefined;
}

/** Whether the media type's schema describes the payload (vs. raw text or bytes). */
function isStructured(media: MediaType): boolean {
  const kind = mediaKind(media.contentType);
  return kind === 'json' || kind === 'form' || kind === 'multipart';
}

/** TS type of a body: its preferred media type's schema, `string` for text, `Blob` for binary; undefined without one. */
export function bodyType(content: readonly MediaType[], ctx: TypeContext): string | undefined {
  const media = preferredMedia(content);
  return media && mediaType(media, ctx);
}

function mediaType(media: MediaType, ctx: TypeContext): string {
  if (isStructured(media)) return renderType(media.schema, ctx);
  if (mediaKind(media.contentType) === 'text') return 'string';
  return 'Blob';
}

/** 2XX responses, falling back to `default` when the spec lists no 2XX at all. */
export function successResponses(op: Operation): Response[] {
  const success = op.responses.filter((response) => /^2(\d\d|XX)$/.test(response.status));
  if (success.length > 0) return success;
  return op.responses.filter((response) => response.status === 'default');
}

function responseSchemaToHoist(op: Operation): SchemaNode | undefined {
  const withContent = successResponses(op).flatMap((response) => {
    const media = preferredMedia(response.content);
    return media ? [media] : [];
  });
  const [only] = withContent;
  return withContent.length === 1 && only && isStructured(only) && hasInlineObject(only.schema) ? only.schema : undefined;
}

function bodyMedia(op: Operation): MediaType | undefined {
  return op.requestBody ? preferredMedia(op.requestBody.content) : undefined;
}

/** Helper types the TypeScript generator emits for an operation (fed to the naming engine). */
export function derivedTypesFor(op: Operation): DerivedTypeKind[] {
  const kinds: DerivedTypeKind[] = [];
  if (op.parameters.length > 0) kinds.push('params');
  const body = bodyMedia(op);
  if (body && isStructured(body) && hasInlineObject(body.schema)) kinds.push('requestBody');
  if (responseSchemaToHoist(op)) kinds.push('response');
  return kinds;
}

/** Writes the params interface and hoisted body/response types for an operation. */
export function writeOperationTypes(writer: CodeWriter, op: Operation, names: OperationNames, ctx: TypeContext): void {
  if (names.derived.params) {
    writer.blank();
    writer.doc([`Parameters for \`${names.method}\` (\`${op.key}\`).`]);
    writer.block(`export interface ${names.derived.params} {`, () => {
      for (const param of op.parameters) {
        const docs = schemaDocs(
          param.deprecated ? { ...param.schema, deprecated: true } : param.schema,
          param.description ?? param.schema.description,
        );
        writer.doc(docs);
        const property = names.parameters.get(`${param.in}:${param.name}`)!;
        writer.line(`${propertyKey(property)}${param.required ? '' : '?'}: ${renderType(param.schema, ctx)};`);
      }
    });
  }

  const body = bodyMedia(op);
  if (names.derived.requestBody && body) {
    writer.blank();
    writer.doc([op.requestBody?.description ?? body.schema.description ?? `Request body for \`${names.method}\`.`]);
    writer.line(`export type ${names.derived.requestBody} = ${renderType(body.schema, ctx)};`);
  }

  const response = responseSchemaToHoist(op);
  if (names.derived.response && response) {
    writer.blank();
    writer.doc([response.description ?? `Response of \`${names.method}\`.`]);
    writer.line(`export type ${names.derived.response} = ${renderType(response, ctx)};`);
  }
}

/** Writes one client method. `securitySchemes` lists the scheme keys the spec defines. */
export function writeOperationMethod(
  writer: CodeWriter,
  op: Operation,
  names: OperationNames,
  ctx: TypeContext,
  securitySchemes: ReadonlySet<string>,
): void {
  const body = bodyMedia(op);
  const bodyType = body ? (names.derived.requestBody ?? mediaType(body, ctx)) : undefined;
  const responseType = names.derived.response ?? successType(op, ctx);

  const args: string[] = [];
  if (names.derived.params) {
    const anyRequired = op.parameters.some((param) => param.required);
    const bodyRequired = op.requestBody?.required === true && body !== undefined;
    args.push(anyRequired || bodyRequired ? `params: ${names.derived.params}` : `params: ${names.derived.params} = {}`);
  }
  if (bodyType !== undefined) args.push(`body${op.requestBody?.required ? '' : '?'}: ${bodyType}`);
  args.push('options?: RequestOptions');

  const docs: string[] = [];
  if (op.summary) docs.push(op.summary, '');
  if (op.description && op.description !== op.summary) docs.push(op.description, '');
  docs.push(`\`${op.key}\``);
  if (op.deprecated) docs.push('@deprecated');

  writer.blank();
  writer.doc(docs);
  writer.block(`${names.method}(${args.join(', ')}): Promise<${responseType}> {`, () => {
    writer.block(`return this.http.request<${responseType}>({`, () => {
      writer.line(`method: ${stringLiteral(op.method.toUpperCase())},`);
      writer.line(`path: ${stringLiteral(op.path)},`);
      for (const location of ['path', 'query', 'header', 'cookie'] as const) {
        const params = op.parameters.filter((param) => param.in === location);
        if (params.length === 0) continue;
        const entries = params.map(
          (param) => `${propertyKey(param.name)}: ${propertyAccess('params', names.parameters.get(`${param.in}:${param.name}`)!)}`,
        );
        const key = { path: 'pathParams', query: 'query', header: 'headers', cookie: 'cookies' }[location];
        writer.line(`${key}: ${objectLiteral(entries)},`);
      }
      const serialization = op.parameters
        .filter((param) => param.in === 'query' && (param.style !== 'form' || !param.explode))
        .map((param) => `${propertyKey(param.name)}: { style: ${stringLiteral(param.style)}, explode: ${param.explode} }`);
      if (serialization.length > 0) writer.line(`querySerialization: ${objectLiteral(serialization)},`);
      if (body) {
        writer.line('body,');
        writer.line(`contentType: ${stringLiteral(body.contentType)},`);
      }
      // Empty alternatives (anonymous access allowed) need no runtime entry: the runtime only ever adds auth.
      const security = op.security
        .map((requirement) => requirement.filter((entry) => securitySchemes.has(entry.scheme)).map((entry) => stringLiteral(entry.scheme)))
        .filter((alternative) => alternative.length > 0);
      if (security.length > 0) {
        writer.line(`security: [${security.map((alternative) => `[${alternative.join(', ')}]`).join(', ')}],`);
      }
    }, '}, options);');
  });
}

/** TS type of a successful response: the 2XX bodies, `void` when none has content. */
function successType(op: Operation, ctx: TypeContext): string {
  const responses = successResponses(op);
  const types = new Set<string>();
  let withoutContent = false;
  for (const response of responses) {
    const media = preferredMedia(response.content);
    if (media) types.add(mediaType(media, ctx));
    else withoutContent = true;
  }
  if (types.size === 0) return 'void';
  if (withoutContent) types.add('undefined');
  return [...types].join(' | ');
}

function objectLiteral(entries: string[]): string {
  const inline = `{ ${entries.join(', ')} }`;
  if (inline.length <= 80 && !inline.includes('\n')) return inline;
  return `{\n${entries.map((entry) => `  ${entry},`).join('\n')}\n}`;
}
