import { createHash } from 'node:crypto';

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** JSON.stringify with object keys sorted, so semantically equal documents hash equally. */
export function canonicalJson(value: unknown, space?: number): string {
  return JSON.stringify(sortKeys(value), null, space);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
