import { describeConflict, generate, hasChanges, loadConfig, MANIFEST_FILE, type FileAction, type OutputPlan } from '@sdkgen/core';
import { printChanges } from '../changes.js';
import type { Ui } from '../ui.js';

export interface GenerateCommandOptions {
  config?: string;
  input?: string;
  output?: string;
  validate?: boolean;
  dryRun?: boolean;
  check?: boolean;
  relock?: boolean;
  force?: boolean;
  verbose?: boolean;
}

const SYMBOLS: Record<FileAction, string> = { create: '+', update: '~', delete: '-', unchanged: ' ', keep: '=' };

export async function generateCommand(ui: Ui, options: GenerateCommandOptions): Promise<number> {
  const started = performance.now();
  const config = await loadConfig({
    cwd: ui.io.cwd,
    configPath: options.config,
    overrides: {
      ...(options.input !== undefined && { input: options.input }),
      ...(options.output !== undefined && { output: options.output }),
      ...(options.validate === false && { validate: false }),
    },
  });
  if (config.configPath) ui.line(ui.c.dim(`Using ${ui.rel(config.configPath)}`));

  const dryRun = options.dryRun === true || options.check === true;
  const result = await generate({ config, dryRun, relock: options.relock === true, force: options.force === true });
  const { model, spec, plan } = result;

  ui.success(
    `Loaded ${ui.c.bold(`${model.title} ${model.version}`)} (OpenAPI ${spec.openapiVersion}): ` +
      `${count(model.operations.length, 'operation')}, ${count(model.schemas.length, 'schema')}`,
  );
  ui.diagnostics(result.diagnostics, options.verbose === true);
  if (result.changes && result.changes.changes.length > 0) {
    const { from, to } = result.changes;
    printChanges(ui, result.changes, {
      heading: `API changes since the last generation${from.version === to.version ? '' : ` (${from.version} → ${to.version})`}`,
      limit: options.verbose ? undefined : 10,
      moreHint: 'run with --verbose to list them all',
    });
  }

  if (options.check) return reportCheck(ui, plan);

  printPlan(ui, plan, options.verbose === true);
  const elapsed = Math.round(performance.now() - started);
  if (dryRun) {
    ui.info(`Dry run: nothing was written ${ui.c.dim(`(${elapsed} ms)`)}`);
    if (plan.conflicts.length > 0 && !options.force) {
      ui.warn('A real run would stop here: these files were changed outside sdkgen (use --force to overwrite):');
      for (const conflict of plan.conflicts) ui.line(`    ${describeConflict(conflict)}`);
    }
  } else {
    ui.success(`SDK written to ${ui.c.bold(ui.rel(plan.outputDir))} ${ui.c.dim(`(${elapsed} ms)`)}`);
  }
  return 0;
}

function printPlan(ui: Ui, plan: OutputPlan, verbose: boolean): void {
  const tally: Record<FileAction, number> = { create: 0, update: 0, delete: 0, unchanged: 0, keep: 0 };
  for (const change of plan.changes) {
    if (change.ownership === 'meta') continue;
    tally[change.action]++;
    const quiet = change.action === 'unchanged' || (change.action === 'keep' && change.ownership === 'scaffold');
    if (quiet && !verbose) continue;
    const color = { create: ui.c.green, update: ui.c.yellow, delete: ui.c.red, unchanged: ui.c.dim, keep: ui.c.dim }[change.action];
    const note = change.action === 'keep' ? ui.c.dim(change.ownership === 'scaffold' ? '  (yours, left as is)' : '  (edited, left in place)') : '';
    ui.line(`  ${color(`${SYMBOLS[change.action]} ${change.path}`)}${note}`);
  }
  const parts = [
    tally.create && `${tally.create} created`,
    tally.update && `${tally.update} updated`,
    tally.delete && `${tally.delete} deleted`,
    tally.unchanged && `${tally.unchanged} unchanged`,
  ].filter(Boolean);
  ui.line(ui.c.dim(`  ${parts.join(', ') || 'no files'}`));
}

/** `--check`: exit 1 when the SDK on disk is not what the current spec and config would produce. */
function reportCheck(ui: Ui, plan: OutputPlan): number {
  // The manifest also records the sdkgen version; upgrading sdkgen alone should not fail CI.
  const outdated = { ...plan, changes: plan.changes.filter((change) => change.path !== MANIFEST_FILE) };
  if (!hasChanges(outdated) && plan.conflicts.length === 0) {
    ui.success('SDK is up to date');
    return 0;
  }
  ui.fail('SDK is out of date with the spec or config. Run `sdkgen generate` and commit the result.');
  for (const change of outdated.changes) {
    if (change.action === 'create' || change.action === 'update' || change.action === 'delete') {
      ui.io.stderr(`  ${SYMBOLS[change.action]} ${change.path}\n`);
    }
  }
  for (const conflict of plan.conflicts) ui.io.stderr(`  ! ${describeConflict(conflict)}\n`);
  return 1;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
