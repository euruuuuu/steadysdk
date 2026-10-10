import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../util/hash.js';

/** Bookkeeping directory inside the output directory. Commit it along with the SDK. */
export const APISTEADY_DIR = '.apisteady';
export const MANIFEST_FILE = `${APISTEADY_DIR}/manifest.json`;
export const NAME_LOCK_FILE = `${APISTEADY_DIR}/names.lock.json`;
/** The bundled spec the SDK was last generated from; the baseline for drift detection. */
export const SPEC_SNAPSHOT_FILE = `${APISTEADY_DIR}/spec.json`;

export const MANIFEST_VERSION = 1;

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  generator: z.object({ name: z.string(), version: z.string(), target: z.string() }),
  spec: z.object({ title: z.string(), version: z.string(), openapi: z.string(), hash: z.string() }),
  /** Every file apisteady owns → sha256 of the content it last wrote. Used to spot hand edits and stale files. */
  files: z.record(z.string(), z.string()),
});

export type Manifest = z.infer<typeof manifestSchema>;

export type ReadManifestResult =
  | { status: 'missing' }
  | { status: 'invalid'; message: string }
  | { status: 'ok'; manifest: Manifest };

export async function readManifest(outputDir: string): Promise<ReadManifestResult> {
  let text: string;
  try {
    text = await readFile(path.join(outputDir, MANIFEST_FILE), 'utf8');
  } catch {
    return { status: 'missing' };
  }
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { status: 'ok', manifest: parsed.data };
    return { status: 'invalid', message: parsed.error.issues[0]?.message ?? 'unexpected shape' };
  } catch (error) {
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
}

export function serializeManifest(manifest: Manifest): string {
  return `${canonicalJson(manifest, 2)}\n`;
}
