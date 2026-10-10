import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderChangelog, serializeDiff } from '@steadysdk/core';
import type { Ui } from '../ui.js';
import { compareSpecs, type DiffCommandOptions } from './diff.js';

export interface ChangelogCommandOptions extends Pick<DiffCommandOptions, 'config' | 'input' | 'validate' | 'json'> {
  out?: string;
}

/** Markdown (or JSON) release notes for the API changes, on stdout or into a file. */
export async function changelogCommand(ui: Ui, options: ChangelogCommandOptions, args: ReadonlyArray<string | undefined>): Promise<number> {
  const { diff } = await compareSpecs(ui, args, options);
  const content = options.json ? serializeDiff(diff) : renderChangelog(diff);
  if (options.out === undefined) {
    ui.io.stdout(content);
    return 0;
  }
  const target = path.resolve(ui.io.cwd, options.out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  const { breaking, nonBreaking } = diff.summary;
  ui.success(`Wrote ${ui.c.bold(ui.rel(target))} (${breaking} breaking, ${nonBreaking} non-breaking)`);
  return 0;
}
