import { lowerFirst } from './text.js';
import type { ApiDiff, Change } from './types.js';

/** `steadysdk diff --json` / `steadysdk changelog --json`: stable key order, trailing newline. */
export function serializeDiff(diff: ApiDiff): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}

/**
 * A Markdown changelog entry: a `##` title, breaking changes first, each change grouped under its operation
 * or schema. Meant to be pasted into a CHANGELOG.md, a release or a pull request.
 */
export function renderChangelog(diff: ApiDiff): string {
  const lines = [`## ${diffTitle(diff)}`, ''];
  if (diff.changes.length === 0) return `${[...lines, 'No API changes.'].join('\n')}\n`;

  const { breaking, nonBreaking } = diff.summary;
  lines.push(
    `${breaking > 0 ? `**${plural(breaking, 'breaking change')}**` : 'No breaking changes'}, ${plural(nonBreaking, 'non-breaking change')}.`,
    '',
  );
  for (const [heading, isBreaking] of [['Breaking changes', true], ['Non-breaking changes', false]] as const) {
    const changes = diff.changes.filter((change) => change.breaking === isBreaking);
    if (changes.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const group of groupBySubject(changes)) {
      const [first] = group;
      if (!first) continue;
      const subject = `${markdownSubject(first)}${usedBy(first.affects)}`;
      // One change goes on the subject's line, unless its message has a location prefix of its own.
      if (group.length === 1 && !first.message.includes(': ')) {
        lines.push(`- ${subject}: ${lowerFirst(first.message)}`);
      } else {
        lines.push(`- ${subject}`, ...group.map((change) => `  - ${change.message}`));
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** `Petstore 1.0.0 → 1.1.0`, or just `Petstore 1.0.0` when the version did not change. */
export function diffTitle(diff: ApiDiff): string {
  const { from, to } = diff;
  if (from.title !== to.title) return `${from.title} ${from.version} → ${to.title} ${to.version}`;
  return from.version === to.version ? `${to.title} ${to.version}` : `${to.title} ${from.version} → ${to.version}`;
}

/** Plain-text subject of a change: `GET /pets`, `schema Pet`, `security scheme apiKey`, `API`. */
export function changeSubject(change: Change): string {
  switch (change.scope) {
    case 'operation':
      return change.operation ?? '';
    case 'schema':
      return `schema ${change.schema ?? ''}`;
    case 'security':
      return `security scheme ${change.securityScheme ?? ''}`;
    case 'api':
      return 'API';
  }
}

/** Consecutive-or-not changes about the same subject, in order of first appearance. */
export function groupBySubject(changes: readonly Change[]): Change[][] {
  const groups = new Map<string, Change[]>();
  for (const change of changes) {
    const key = `${change.scope}:${changeSubject(change)}`;
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return [...groups.values()];
}

function markdownSubject(change: Change): string {
  switch (change.scope) {
    case 'operation':
      return `**\`${change.operation}\`**${change.operationId ? ` (\`${change.operationId}\`)` : ''}`;
    case 'schema':
      return `**Schema \`${change.schema}\`**`;
    case 'security':
      return `**Security scheme \`${change.securityScheme}\`**`;
    case 'api':
      return '**API**';
  }
}

function usedBy(affects: readonly string[] | undefined, limit = 3): string {
  if (!affects || affects.length === 0) return '';
  const shown = affects.slice(0, limit).map((op) => `\`${op}\``);
  const more = affects.length - shown.length;
  return ` (used by ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
