import { stat } from 'node:fs/promises';
import path from 'node:path';
import { SPEC_SNAPSHOT_FILE } from '../output/manifest.js';
import { loadSpec, type LoadedSpec } from '../spec/load.js';

/** The spec an SDK was last generated from (`<output>/.sdkgen/spec.json`); undefined before the first run. */
export async function loadSpecSnapshot(outputDir: string): Promise<LoadedSpec | undefined> {
  const file = path.join(outputDir, SPEC_SNAPSHOT_FILE);
  if (!(await stat(file).catch(() => undefined))?.isFile()) return undefined;
  // Written by sdkgen itself, from a spec that was validated (or deliberately not) back then.
  return loadSpec(file, { validate: false });
}
