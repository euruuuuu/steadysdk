import { homedir } from 'node:os';
import path from 'node:path';
import type { ResolvedConfig } from './config/load.js';
import { Diagnostics, type Diagnostic } from './diagnostics.js';
import { SdkgenError } from './errors.js';
import { generateTypeScript } from './generators/typescript/index.js';
import { buildModel } from './ir/build.js';
import type { ApiModel } from './ir/model.js';
import type { SdkNames } from './naming/assign.js';
import { readNameLock, serializeNameLock, type NameLock } from './naming/lock.js';
import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  NAME_LOCK_FILE,
  SPEC_SNAPSHOT_FILE,
  readManifest,
  serializeManifest,
  type Manifest,
} from './output/manifest.js';
import { applyPlan, planOutput, type OutputPlan, type PlanFile } from './output/plan.js';
import { loadSpec, type LoadedSpec } from './spec/load.js';
import { sha256 } from './util/hash.js';
import { SDKGEN_VERSION } from './version.js';

export interface GenerateOptions {
  config: ResolvedConfig;
  /** Compute the plan without writing anything. */
  dryRun?: boolean;
  /** Ignore the name lock and derive every name from the current rules. */
  relock?: boolean;
  /** Overwrite generated files even when they were edited by hand. */
  force?: boolean;
}

export interface GenerateResult {
  spec: LoadedSpec;
  model: ApiModel;
  names: SdkNames;
  plan: OutputPlan;
  /** False for dry runs. */
  written: boolean;
  diagnostics: Diagnostic[];
}

/** Loads the spec, generates the SDK and writes it (unless `dryRun`). */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { config } = options;
  assertSafeOutputDir(config.outputDir);
  const diagnostics = new Diagnostics();

  const spec = await loadSpec(config.inputPath, { validate: config.validate });
  const model = buildModel(spec.document, diagnostics);

  const previous = await readManifest(config.outputDir);
  if (previous.status === 'invalid') {
    diagnostics.warn('MANIFEST_INVALID', `Ignoring unreadable ${MANIFEST_FILE}: ${previous.message}`);
  }

  let lock: NameLock | undefined;
  if (config.naming.lock && !options.relock) {
    const result = await readNameLock(path.join(config.outputDir, NAME_LOCK_FILE));
    if (result.status === 'ok') lock = result.lock;
    if (result.status === 'invalid') {
      diagnostics.warn('NAME_LOCK_INVALID', `Ignoring unreadable ${NAME_LOCK_FILE} (${result.message}); names were re-derived.`);
    }
  }

  const output = await generateTypeScript({ model, config, lock, diagnostics });

  const owned = output.files.filter((file) => file.ownership === 'generated');
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    generator: { name: 'sdkgen', version: SDKGEN_VERSION, target: config.target },
    spec: { title: model.title, version: model.version, openapi: spec.openapiVersion, hash: spec.hash },
    files: Object.fromEntries(owned.map((file) => [file.path, sha256(file.content)])),
  };

  const files: PlanFile[] = [
    ...output.files,
    // Document order is kept (unlike the hash's canonical form) so the snapshot reads like the spec.
    { path: SPEC_SNAPSHOT_FILE, content: `${JSON.stringify(spec.document, null, 2)}\n`, ownership: 'meta' },
    { path: MANIFEST_FILE, content: serializeManifest(manifest), ownership: 'meta' },
  ];
  if (config.naming.lock) files.push({ path: NAME_LOCK_FILE, content: serializeNameLock(output.lock), ownership: 'meta' });

  const plan = await planOutput(config.outputDir, files, previous.status === 'ok' ? previous.manifest : undefined);

  if (!options.dryRun) {
    if (plan.conflicts.length > 0 && !options.force) {
      throw new SdkgenError('OUTPUT_CONFLICT', 'Refusing to overwrite files that sdkgen did not write', {
        details: plan.conflicts.map((conflict) =>
          conflict.reason === 'edited' ? `${conflict.path} (edited since the last generation)` : `${conflict.path} (not created by sdkgen)`,
        ),
        hint: 'Move custom code out of generated/ (e.g. into client.ts), or re-run with --force to overwrite.',
      });
    }
    await applyPlan(plan);
  }

  return { spec, model, names: output.names, plan, written: !options.dryRun, diagnostics: diagnostics.items };
}

function assertSafeOutputDir(outputDir: string): void {
  const resolved = path.resolve(outputDir);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(homedir())) {
    throw new SdkgenError('OUTPUT_UNSAFE', `Refusing to generate into ${resolved}`, {
      hint: 'Point `output` at a dedicated directory such as ./sdk.',
    });
  }
}
