import type { ApiDiff } from './types.js';

export interface VersionCheck {
  /** False when breaking changes come without the version bump they need. */
  ok: boolean;
  /** `major` when there are breaking changes (in 0.x, where breaking changes bump the minor, a minor bump). */
  required: 'major' | 'none';
  from: string;
  to: string;
  /** The lowest version that passes, when the check fails and both versions are semver. */
  suggested?: string | undefined;
  message: string;
}

/** `1.2`, `1.2.3`, `v1.2.3-beta.1`. A lone number or a date (`2024-06-01`) is not treated as semver. */
const SEMVER = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]*)?$/;

/**
 * Breaking changes need a new major `info.version` (a new minor below 1.0.0, as semver tooling treats 0.x).
 * Versions that are not semver (`2024-06-01`, `beta`) only have to change.
 */
export function checkVersionBump(diff: ApiDiff): VersionCheck {
  const from = diff.from.version;
  const to = diff.to.version;
  const { breaking } = diff.summary;
  if (breaking === 0) return { ok: true, required: 'none', from, to, message: 'No breaking changes, so no version bump is required.' };

  const changes = `${breaking} breaking change${breaking === 1 ? '' : 's'}`;
  const before = parse(from);
  const after = parse(to);
  if (!before || !after) {
    return from !== to
      ? { ok: true, required: 'major', from, to, message: `${changes}; info.version changed from ${from} to ${to}.` }
      : { ok: false, required: 'major', from, to, message: `${changes}, but info.version is still ${to}.` };
  }

  const initial = before.major === 0;
  const ok = initial ? after.major > 0 || after.minor > before.minor : after.major > before.major;
  const suggested = initial ? `0.${before.minor + 1}.0` : `${before.major + 1}.0.0`;
  const kind = initial ? 'a new minor version (the 0.x way to mark breaking changes)' : 'a new major version';
  if (ok) return { ok, required: 'major', from, to, message: `${changes}; ${from} → ${to} is ${kind}.` };
  const now = from === to ? `info.version is still ${to}` : `info.version only went from ${from} to ${to}`;
  return { ok, required: 'major', from, to, suggested, message: `${changes}, but ${now}. They need ${kind}: ${suggested} or later.` };
}

function parse(version: string): { major: number; minor: number } | undefined {
  const match = SEMVER.exec(version.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}
