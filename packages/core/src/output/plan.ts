import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileOwnership } from '../generators/types.js';
import { sha256 } from '../util/hash.js';
import type { Manifest } from './manifest.js';

/**
 * - `create` / `update` / `delete`: what the run will do to the file.
 * - `unchanged`: content already matches.
 * - `keep`: a scaffold file that already exists (it is yours now), or an edited stale file left in place.
 */
export type FileAction = 'create' | 'update' | 'delete' | 'unchanged' | 'keep';

export interface PlannedChange {
  /** POSIX path relative to the output directory. */
  path: string;
  action: FileAction;
  /** `meta` = bookkeeping under `.sdkgen/`. */
  ownership: FileOwnership | 'meta';
  content?: string | undefined;
}

export interface Conflict {
  path: string;
  reason: 'edited' | 'untracked';
}

export interface OutputPlan {
  outputDir: string;
  changes: PlannedChange[];
  /**
   * Files sdkgen would overwrite or delete that were not written by it: generated files edited by hand
   * since the last run, or files at generated paths that the manifest does not know about.
   */
  conflicts: Conflict[];
}

export interface PlanFile {
  path: string;
  content: string;
  ownership: FileOwnership | 'meta';
}

export async function planOutput(outputDir: string, files: readonly PlanFile[], previous: Manifest | undefined): Promise<OutputPlan> {
  const changes: PlannedChange[] = [];
  const conflicts: Conflict[] = [];
  const current = new Set(files.map((file) => file.path));

  for (const file of files) {
    const existing = await readIfExists(outputDir, file.path);
    if (file.ownership === 'scaffold') {
      changes.push({ path: file.path, action: existing === undefined ? 'create' : 'keep', ownership: 'scaffold', content: file.content });
      continue;
    }
    if (existing === undefined) {
      changes.push({ path: file.path, action: 'create', ownership: file.ownership, content: file.content });
      continue;
    }
    if (existing === file.content) {
      changes.push({ path: file.path, action: 'unchanged', ownership: file.ownership });
      continue;
    }
    if (file.ownership === 'generated') {
      const recorded = previous?.files[file.path];
      if (recorded === undefined) conflicts.push({ path: file.path, reason: 'untracked' });
      else if (recorded !== sha256(existing)) conflicts.push({ path: file.path, reason: 'edited' });
    }
    changes.push({ path: file.path, action: 'update', ownership: file.ownership, content: file.content });
  }

  // Files generated last time but not this time (a removed tag, ...): delete them unless edited by hand.
  for (const [stale, hash] of Object.entries(previous?.files ?? {})) {
    if (current.has(stale) || !isInside(outputDir, stale)) continue;
    const existing = await readIfExists(outputDir, stale);
    if (existing === undefined) continue;
    if (sha256(existing) === hash) {
      changes.push({ path: stale, action: 'delete', ownership: 'generated' });
    } else {
      conflicts.push({ path: stale, reason: 'edited' });
      changes.push({ path: stale, action: 'keep', ownership: 'generated' });
    }
  }

  return { outputDir, changes, conflicts };
}

/** Writes the plan to disk. Edited stale files (`keep`) are left alone. */
export async function applyPlan(plan: OutputPlan): Promise<void> {
  for (const change of plan.changes) {
    const target = path.join(plan.outputDir, change.path);
    if ((change.action === 'create' || change.action === 'update') && change.content !== undefined) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, change.content, 'utf8');
    } else if (change.action === 'delete') {
      await rm(target, { force: true });
      await removeEmptyParents(plan.outputDir, path.dirname(target));
    }
  }
}

export function hasChanges(plan: OutputPlan): boolean {
  return plan.changes.some((change) => change.action === 'create' || change.action === 'update' || change.action === 'delete');
}

async function readIfExists(outputDir: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(outputDir, file), 'utf8');
  } catch {
    return undefined;
  }
}

function isInside(root: string, relative: string): boolean {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function removeEmptyParents(root: string, dir: string): Promise<void> {
  const stop = path.resolve(root);
  let current = path.resolve(dir);
  while (current.startsWith(stop + path.sep)) {
    const entries = await readdir(current).catch(() => undefined);
    if (!entries || entries.length > 0) return;
    await rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
}
