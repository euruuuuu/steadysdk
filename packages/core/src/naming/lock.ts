import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonicalJson } from '../util/hash.js';

export const NAME_LOCK_VERSION = 1;

const nameLockSchema = z.object({
  version: z.literal(NAME_LOCK_VERSION),
  /** Fingerprint of the naming config the names were assigned under. */
  configHash: z.string(),
  /** Identity → assigned name. Identities: `client`, `schema:<key>`, `group:<id>`, `group:<id>#property`,
   *  `operation:<METHOD /path>`, `operation:<METHOD /path>#<derived kind>`. */
  names: z.record(z.string(), z.string()),
});

/**
 * Records every SDK name handed out, so regenerating keeps existing names even when the spec changes
 * in ways that would otherwise shift them (renamed operationIds, new colliding names, reordered paths).
 */
export type NameLock = z.infer<typeof nameLockSchema>;

export type ReadNameLockResult =
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'ok'; lock: NameLock };

export async function readNameLock(file: string): Promise<ReadNameLockResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  try {
    const parsed = nameLockSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { status: 'ok', lock: parsed.data };
    return { status: 'invalid', message: parsed.error.issues[0]?.message ?? 'unexpected shape' };
  } catch (error) {
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
}

export function serializeNameLock(lock: NameLock): string {
  return `${canonicalJson(lock, 2)}\n`;
}
