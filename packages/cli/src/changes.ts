import { changeSubject, type ApiDiff, type Change } from '@steadysdk/core';
import type { Ui } from './ui.js';

export interface PrintChangesOptions {
  /** Shown before the counts, e.g. `API changes since the last generation`. */
  heading: string;
  /** Maximum number of changes listed (breaking ones first); the rest are counted. */
  limit?: number;
  /** Shown when `limit` cuts the list short. */
  moreHint?: string;
}

/** Terminal view of a diff: a summary line, then one line per change, breaking changes first. */
export function printChanges(ui: Ui, diff: ApiDiff, options: PrintChangesOptions): void {
  const { breaking, nonBreaking } = diff.summary;
  const counts = [
    breaking > 0 ? ui.c.red(ui.c.bold(`${breaking} breaking`)) : undefined,
    nonBreaking > 0 ? `${nonBreaking} non-breaking` : undefined,
  ].filter(Boolean);
  ui.info(`${options.heading}: ${counts.join(', ')}`);

  const ordered = [...diff.changes.filter((change) => change.breaking), ...diff.changes.filter((change) => !change.breaking)];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (const change of ordered.slice(0, limit)) {
    ui.line(`    ${symbol(ui, change)} ${ui.c.bold(changeSubject(change))}: ${inlineCode(ui, change.message)}`);
  }
  if (ordered.length > limit) {
    ui.line(ui.c.dim(`    … ${ordered.length - limit} more${options.moreHint ? ` (${options.moreHint})` : ''}`));
  }
}

function symbol(ui: Ui, change: Change): string {
  if (change.breaking) return ui.c.red('!');
  if (change.kind.endsWith('-added')) return ui.c.green('+');
  if (change.kind.endsWith('-removed')) return ui.c.yellow('-');
  return ui.c.yellow('~');
}

/** `code` spans become colored text on a color terminal and stay as backticks otherwise. */
function inlineCode(ui: Ui, text: string): string {
  return ui.io.color ? text.replace(/`([^`]+)`/g, (_match, inner: string) => ui.c.cyan(inner)) : text;
}
