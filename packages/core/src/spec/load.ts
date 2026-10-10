import { stat } from 'node:fs/promises';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import { SteadySdkError } from '../errors.js';
import { canonicalJson, sha256 } from '../util/hash.js';
import { semanticErrors } from './semantic.js';

export type OpenApiDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface LoadedSpec {
  /** The bundled document: external `$ref`s are pulled in, internal `$ref`s are kept. */
  document: OpenApiDocument;
  /** The `openapi` field verbatim, e.g. `3.0.3`. */
  openapiVersion: string;
  dialect: '3.0' | '3.1';
  /** Absolute file path or URL the spec was read from. */
  source: string;
  /** sha256 of the canonical JSON of the bundled document. */
  hash: string;
}

export interface LoadSpecOptions {
  /** Validate against the OpenAPI schema and spec rules. Defaults to true. */
  validate?: boolean;
  /** Base directory for relative `source` paths. Defaults to `process.cwd()`. */
  cwd?: string;
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** Reads, bundles and (optionally) validates an OpenAPI 3.0 / 3.1 document in YAML or JSON. */
export async function loadSpec(source: string, options: LoadSpecOptions = {}): Promise<LoadedSpec> {
  const resolved = isUrl(source) ? source : path.resolve(options.cwd ?? process.cwd(), source);

  if (!isUrl(resolved)) {
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isFile()) {
      throw new SteadySdkError('SPEC_NOT_FOUND', `OpenAPI spec not found: ${resolved}`, {
        hint: 'Check the `input` path in your config, or pass --input <file>.',
      });
    }
  }

  let document: OpenApiDocument;
  try {
    document = (await SwaggerParser.bundle(resolved)) as OpenApiDocument;
  } catch (error) {
    throw new SteadySdkError('SPEC_PARSE_FAILED', `Could not read OpenAPI spec ${resolved}`, {
      details: [errorMessage(error)],
      hint: 'The file must be valid YAML or JSON, and every external $ref must resolve.',
      cause: error,
    });
  }

  const raw = document as unknown as Record<string, unknown>;
  if (typeof raw['swagger'] === 'string') {
    throw new SteadySdkError('SPEC_UNSUPPORTED', `Swagger ${raw['swagger']} documents are not supported`, {
      hint: 'Convert the spec to OpenAPI 3 first, e.g. `npx swagger2openapi swagger.yaml -o openapi.yaml`.',
    });
  }
  const openapiVersion = typeof raw['openapi'] === 'string' ? raw['openapi'] : '';
  const dialect = openapiVersion.startsWith('3.0.') ? '3.0' : openapiVersion.startsWith('3.1.') ? '3.1' : undefined;
  if (!dialect) {
    throw new SteadySdkError('SPEC_UNSUPPORTED', `Unsupported OpenAPI version "${openapiVersion || '(missing)'}"`, {
      hint: 'steadysdk supports OpenAPI 3.0.x and 3.1.x.',
    });
  }

  if (options.validate ?? true) {
    let details: string[];
    try {
      // validate() dereferences in place, so hand it a copy and keep the bundled $refs intact.
      details = semanticErrors(await SwaggerParser.validate(structuredClone(document)));
    } catch (error) {
      details = validationDetails(error);
    }
    if (details.length > 0) {
      throw new SteadySdkError('SPEC_INVALID', `OpenAPI spec failed validation: ${resolved}`, {
        details,
        hint: 'Fix the reported problems, or set `validate: false` in your config to generate anyway.',
      });
    }
  }

  return { document, openapiVersion, dialect, source: resolved, hash: sha256(canonicalJson(document)) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationDetails(error: unknown): string[] {
  return errorMessage(error)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'Swagger schema validation failed.')
    .map((line) => line.replace(/^Validation failed\.\s*/, ''));
}
