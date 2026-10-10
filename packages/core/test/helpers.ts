import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { namingSchema, type NamingConfig } from '../src/config/schema.js';
import { buildModel } from '../src/ir/build.js';
import type { ApiModel, Operation } from '../src/ir/model.js';
import type { OpenApiDocument } from '../src/spec/load.js';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
export const PETSTORE_DIR = path.join(REPO_ROOT, 'examples/petstore');
export const FIXTURES = path.join(import.meta.dirname, 'fixtures');

export function naming(input: Record<string, unknown> = {}): NamingConfig {
  return namingSchema.parse(input);
}

export function op(key: string, extra: Partial<Operation> = {}): Operation {
  const [method = 'get', ...rest] = key.split(' ');
  const path = rest.join(' ');
  return {
    key: `${method.toUpperCase()} ${path}`,
    method: method.toLowerCase() as Operation['method'],
    path,
    tags: [],
    deprecated: false,
    parameters: [],
    responses: [],
    security: [],
    ...extra,
  };
}

/** A model from a YAML fragment of an OpenAPI document (`paths`, `components`, ...). */
export function apiModel(yaml: string): ApiModel {
  const doc = { openapi: '3.0.3', info: { title: 'Test', version: '1.0.0' }, paths: {}, ...(parseYaml(yaml) as object) };
  return buildModel(doc as OpenApiDocument);
}

/** A fresh temp directory, removed when the current test finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sdkgen-test-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
