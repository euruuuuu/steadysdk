import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileOwnership } from '../generators/types.js';
import { sha256 } from '../util/hash.js';
import type { Manifest } from './manifest.js';
import { mergeRegions, parseRegions, regionsWithCode, stripRegions } from './regions.js';

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
  /**
   * - `edited`: changed outside custom regions since sdkgen wrote it.
   * - `untracked`: at a generated path, but not written by sdkgen.
   * - `region-removed`: custom regions with code that the new version of the file no longer has.
   * - `regions-invalid`: custom region markers are unbalanced, so the user's code cannot be carried over.
   */
  reason: 'edited' | 'untracked' | 'region-removed' | 'regions-invalid';
  /** Region names or the marker problem, for the region reasons. */
  detail?: string | undefined;
}

export function describeConflict(conflict: Conflict): string {
  switch (conflict.reason) {
    case 'edited':
      return `${conflict.path} (edited since the last generation)`;
    case 'untracked':
      return `${conflict.path} (not created by sdkgen)`;
    case 'region-removed':
      return `${conflict.path} (code in custom region ${conflict.detail} would be lost: the region is no longer generated)`;
    case 'regions-invalid':
      return `${conflict.path} (broken custom region markers: ${conflict.detail})`;
  }
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
    let content = file.content;
    let conflict: Conflict | undefined;
    if (file.ownership === 'generated') {
      // Code in custom regions moves into the new version of the file.
      const parsed = parseRegions(existing);
      if (parsed.ok) {
        const merged = mergeRegions(file.content, parsed.regions);
        content = merged.content;
        if (merged.orphaned.length > 0) conflict = { path: file.path, reason: 'region-removed', detail: merged.orphaned.join(', ') };
      } else {
        conflict = { path: file.path, reason: 'regions-invalid', detail: parsed.error };
      }
    }
    if (existing === content) {
      changes.push({ path: file.path, action: 'unchanged', ownership: file.ownership });
      continue;
    }
    if (file.ownership === 'generated') {
      // The manifest hashes files with empty regions, so code inside regions is not an edit.
      const recorded = previous?.files[file.path];
      if (recorded === undefined) conflict = { path: file.path, reason: 'untracked' };
      else if (!conflict && recorded !== sha256(stripRegions(existing))) conflict = { path: file.path, reason: 'edited' };
      if (conflict) conflicts.push(conflict);
    }
    changes.push({ path: file.path, action: 'update', ownership: file.ownership, content });
  }

  // Files generated last time but not this time (a removed tag, ...): delete them unless edited by hand.
  for (const [stale, hash] of Object.entries(previous?.files ?? {})) {
    if (current.has(stale) || !isInside(outputDir, stale)) continue;
    const existing = await readIfExists(outputDir, stale);
    if (existing === undefined) continue;
    const parsed = parseRegions(existing);
    const custom = parsed.ok ? regionsWithCode(parsed.regions) : [];
    if (parsed.ok && sha256(stripRegions(existing)) === hash && custom.length === 0) {
      changes.push({ path: stale, action: 'delete', ownership: 'generated' });
    } else {
      conflicts.push(
        parsed.ok && custom.length > 0 && sha256(stripRegions(existing)) === hash
          ? { path: stale, reason: 'region-removed', detail: custom.join(', ') }
          : { path: stale, reason: 'edited' },
      );
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
