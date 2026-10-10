import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { namingSchema, type NamingConfig } from '../src/config/schema.js';
import type { Operation } from '../src/ir/model.js';

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

/** A fresh temp directory, removed when the current test finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sdkgen-test-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
