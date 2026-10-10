import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  applyIgnore,
  buildModel,
  checkVersionBump,
  isSteadySdkError,
  diffModels,
  diffTitle,
  loadConfig,
  loadSpec,
  loadSpecSnapshot,
  parseRevisionArgument,
  SteadySdkError,
  serializeDiff,
  type ApiDiff,
  type ApiModel,
  type LoadedSpec,
  type ResolvedConfig,
} from '@steadysdk/core';
import { printChanges } from '../changes.js';
import type { Ui } from '../ui.js';

export interface DiffCommandOptions {
  config?: string;
  input?: string;
  base?: string;
  validate?: boolean;
  json?: boolean;
  failOnBreaking?: boolean;
  requireBump?: boolean;
}

export interface ComparedSpecs {
  diff: ApiDiff;
  /** Where each side came from (file path or URL). */
  from: string;
  to: string;
}

/**
 * Resolves the two sides of a comparison. `old` defaults to the spec the SDK was last generated from
 * (`<output>/.steadysdk/spec.json`), `new` to the configured input; a config is only needed for those defaults.
 */
export async function compareSpecs(
  ui: Ui,
  [oldSpec, newSpec]: ReadonlyArray<string | undefined>,
  options: Pick<DiffCommandOptions, 'config' | 'input' | 'base' | 'validate'>,
): Promise<ComparedSpecs> {
  if (oldSpec !== undefined && options.base !== undefined) {
    throw new SteadySdkError('ARGUMENTS_INVALID', 'Pass either an [old] spec or --base, not both', {
      hint: '`--base main` compares the configured spec as it is on main; `main:openapi.yaml` names a file at a revision.',
    });
  }
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

  const from =
    oldSpec !== undefined
      ? await loadArgument(ui, oldSpec, validate)
      : options.base !== undefined
        ? await atBase(ui, await config(), options.base)
        : await lastGenerated(ui, await config());
  const to =
    newSpec !== undefined
      ? await loadArgument(ui, newSpec, validate)
      : await config().then((resolved) => loadSpec(resolved.inputPath, { validate: resolved.validate }));

  // When the comparison involves the SDK's config, compare what the SDK covers: apply its ignore list.
  const ignore = pending && (await pending).ignore;
  const model = (spec: LoadedSpec) => (ignore ? applyIgnore(buildModel(spec.document), ignore) : buildModel(spec.document));
  const head = model(to);
  const base: ApiModel = from === 'missing' ? { ...head, version: 'none', operations: [], schemas: [], securitySchemes: [], servers: [] } : model(from);
  return { diff: diffModels(base, head), from: from === 'missing' ? `${options.base} (no spec yet)` : from.source, to: to.source };
}

/** A spec argument: a file, a URL, or `<revision>:<path>` to read it from git (`main:openapi.yaml`). */
async function loadArgument(ui: Ui, argument: string, validate: boolean): Promise<LoadedSpec> {
  const onDisk = await stat(path.resolve(ui.io.cwd, argument)).catch(() => undefined);
  const atRevision = onDisk ? undefined : parseRevisionArgument(argument);
  return atRevision
    ? loadSpec(atRevision.file, { cwd: ui.io.cwd, validate, revision: atRevision.revision })
    : loadSpec(argument, { cwd: ui.io.cwd, validate });
}

/** The configured spec at a git revision; 'missing' when it did not exist yet, so everything in it is new. */
async function atBase(ui: Ui, config: ResolvedConfig, revision: string): Promise<LoadedSpec | 'missing'> {
  try {
    return await loadSpec(config.inputPath, { validate: config.validate, revision });
  } catch (error) {
    if (!isSteadySdkError(error) || error.code !== 'SPEC_NOT_FOUND') throw error;
    ui.io.stderr(`${ui.c.dim(`${ui.rel(config.inputPath)} does not exist at ${revision}; every endpoint counts as new.`)}\n`);
    return 'missing';
  }
}

async function lastGenerated(ui: Ui, config: ResolvedConfig): Promise<LoadedSpec> {
  const snapshot = await loadSpecSnapshot(config.outputDir);
  if (snapshot) return snapshot;
  throw new SteadySdkError('BASELINE_NOT_FOUND', `No generated SDK found in ${ui.rel(config.outputDir)} to compare against`, {
    hint: 'Run `steadysdk generate` first, or compare two files: `steadysdk diff old.yaml new.yaml`.',
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

  let exitCode = 0;
  if (options.requireBump) {
    const check = checkVersionBump(diff);
    if (!check.ok) {
      ui.fail(`${check.message} (--require-bump)`);
      exitCode = 1;
    } else if (diff.summary.breaking > 0 && !options.json) {
      ui.success(check.message);
    }
  }
  if (options.failOnBreaking && diff.summary.breaking > 0) {
    const { breaking } = diff.summary;
    ui.fail(`${breaking} breaking change${breaking === 1 ? '' : 's'} (--fail-on-breaking)`);
    exitCode = 1;
  }
  return exitCode;
}
