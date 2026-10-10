import {
  applyIgnore,
  buildModel,
  diffModels,
  diffTitle,
  loadConfig,
  loadSpec,
  loadSpecSnapshot,
  SdkgenError,
  serializeDiff,
  type ApiDiff,
  type LoadedSpec,
  type ResolvedConfig,
} from '@sdkgen/core';
import { printChanges } from '../changes.js';
import type { Ui } from '../ui.js';

export interface DiffCommandOptions {
  config?: string;
  input?: string;
  validate?: boolean;
  json?: boolean;
  failOnBreaking?: boolean;
}

export interface ComparedSpecs {
  diff: ApiDiff;
  /** Where each side came from (file path or URL). */
  from: string;
  to: string;
}

/**
 * Resolves the two sides of a comparison. `old` defaults to the spec the SDK was last generated from
 * (`<output>/.sdkgen/spec.json`), `new` to the configured input; a config is only needed for those defaults.
 */
export async function compareSpecs(
  ui: Ui,
  [oldSpec, newSpec]: ReadonlyArray<string | undefined>,
  options: Pick<DiffCommandOptions, 'config' | 'input' | 'validate'>,
): Promise<ComparedSpecs> {
  const validate = options.validate !== false;
  let pending: Promise<ResolvedConfig> | undefined;
  const config = (): Promise<ResolvedConfig> =>
    (pending ??= loadConfig({
      cwd: ui.io.cwd,
      configPath: options.config,
      overrides: {
        ...(options.input !== undefined && { input: options.input }),
        ...(!validate && { validate: false }),
      },
    }));

  const from = oldSpec !== undefined ? await loadSpec(oldSpec, { cwd: ui.io.cwd, validate }) : await lastGenerated(ui, await config());
  const to =
    newSpec !== undefined
      ? await loadSpec(newSpec, { cwd: ui.io.cwd, validate })
      : await config().then((resolved) => loadSpec(resolved.inputPath, { validate: resolved.validate }));

  // When the comparison involves the SDK's config, compare what the SDK covers: apply its ignore list.
  const ignore = pending && (await pending).ignore;
  const model = (spec: LoadedSpec) => (ignore ? applyIgnore(buildModel(spec.document), ignore) : buildModel(spec.document));
  return { diff: diffModels(model(from), model(to)), from: from.source, to: to.source };
}

async function lastGenerated(ui: Ui, config: ResolvedConfig): Promise<LoadedSpec> {
  const snapshot = await loadSpecSnapshot(config.outputDir);
  if (snapshot) return snapshot;
  throw new SdkgenError('BASELINE_NOT_FOUND', `No generated SDK found in ${ui.rel(config.outputDir)} to compare against`, {
    hint: 'Run `sdkgen generate` first, or compare two files: `sdkgen diff old.yaml new.yaml`.',
  });
}

export async function diffCommand(ui: Ui, options: DiffCommandOptions, args: ReadonlyArray<string | undefined>): Promise<number> {
  const { diff, from, to } = await compareSpecs(ui, args, options);

  if (options.json) {
    ui.io.stdout(serializeDiff(diff));
  } else {
    ui.line(ui.c.dim(`Comparing ${ui.rel(from)} → ${ui.rel(to)}`));
    if (diff.changes.length === 0) ui.success(`No API changes (${diffTitle(diff)})`);
    else printChanges(ui, diff, { heading: `API changes in ${diffTitle(diff)}` });
  }

  if (options.failOnBreaking && diff.summary.breaking > 0) {
    const { breaking } = diff.summary;
    ui.fail(`${breaking} breaking change${breaking === 1 ? '' : 's'} (--fail-on-breaking)`);
    return 1;
  }
  return 0;
}
