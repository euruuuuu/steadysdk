/**
 * Custom regions: the parts of a generated file that belong to the user.
 *
 *     // <apisteady:custom members>
 *     ...your code, kept when the file is regenerated...
 *     // </apisteady:custom>
 *
 * The generator emits them empty. On regeneration the bodies are carried over from the file on disk, and
 * edit detection hashes files with region bodies emptied, so only edits outside regions count as conflicts.
 */

const OPEN = /^[ \t]*\/\/ <apisteady:custom ([\w.-]+)>[ \t]*$/;
const CLOSE = /^[ \t]*\/\/ <\/apisteady:custom>[ \t]*$/;

export type ParsedRegions = { ok: true; regions: Map<string, string[]> } | { ok: false; error: string };

/** Region name → body lines. Fails on unbalanced, nested or duplicate markers. */
export function parseRegions(content: string): ParsedRegions {
  const regions = new Map<string, string[]>();
  let open: { name: string; line: number; body: string[] } | undefined;
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    const opening = OPEN.exec(line);
    if (opening) {
      const name = opening[1]!;
      if (open) return { ok: false, error: `region "${open.name}" (line ${open.line}) is not closed before line ${index + 1}` };
      if (regions.has(name)) return { ok: false, error: `region "${name}" appears twice` };
      open = { name, line: index + 1, body: [] };
    } else if (CLOSE.test(line)) {
      if (!open) return { ok: false, error: `line ${index + 1} closes a region that was never opened` };
      regions.set(open.name, open.body);
      open = undefined;
    } else if (open) {
      open.body.push(line);
    }
  }
  if (open) return { ok: false, error: `region "${open.name}" (line ${open.line}) is never closed` };
  return { ok: true, regions };
}

/** The content with every region body removed: what apisteady wrote, minus the user's code. */
export function stripRegions(content: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of content.split('\n')) {
    if (OPEN.test(line)) inside = true;
    else if (CLOSE.test(line)) inside = false;
    else if (inside) continue;
    out.push(line);
  }
  return out.join('\n');
}

export interface MergedRegions {
  content: string;
  /** Regions holding code that the fresh content no longer has a place for. */
  orphaned: string[];
}

/** Fresh generator output with the user's region bodies put back in. */
export function mergeRegions(fresh: string, kept: ReadonlyMap<string, readonly string[]>): MergedRegions {
  const out: string[] = [];
  const placed = new Set<string>();
  let replacing = false;
  for (const line of fresh.split('\n')) {
    if (replacing && !CLOSE.test(line)) continue;
    replacing = false;
    out.push(line);
    const name = OPEN.exec(line)?.[1];
    const body = name === undefined ? undefined : kept.get(name);
    if (name !== undefined && body) {
      out.push(...body);
      placed.add(name);
      replacing = true;
    }
  }
  const orphaned = [...kept].filter(([name, body]) => !placed.has(name) && hasCode(body)).map(([name]) => name);
  return { content: out.join('\n'), orphaned };
}

/** Names of regions that contain anything besides blank lines. */
export function regionsWithCode(regions: ReadonlyMap<string, readonly string[]>): string[] {
  return [...regions].filter(([, body]) => hasCode(body)).map(([name]) => name);
}

function hasCode(body: readonly string[]): boolean {
  return body.some((line) => line.trim() !== '');
}

/** The marker lines for an empty region, for generators. */
export function emptyRegion(name: string): [string, string] {
  return [`// <apisteady:custom ${name}>`, '// </apisteady:custom>'];
}
