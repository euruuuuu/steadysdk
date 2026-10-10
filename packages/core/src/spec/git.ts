import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SteadySdkError } from '../errors.js';

const run = promisify(execFile);

/** Reads files as they were at one git revision (`main`, `origin/main`, a SHA, `HEAD~1`, ...). */
export interface GitRevision {
  revision: string;
  /** Absolute repository root. */
  root: string;
  /** Contents of a working-tree path at the revision. */
  read(file: string): Promise<Buffer>;
  /** `main:openapi.yaml`, for messages. */
  label(file: string): Promise<string>;
}

/** Opens `revision` in the repository containing `near` (a file or directory path). */
export async function openRevision(revision: string, near: string): Promise<GitRevision> {
  const dir = await existingDirectory(near);
  let root: string;
  try {
    root = (await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (error) {
    throw new SteadySdkError('GIT_FAILED', `Cannot read git revision "${revision}": ${dir} is not inside a git repository`, {
      hint: 'Run this inside the repository that holds the spec, with git installed.',
      cause: error,
    });
  }
  try {
    await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  } catch (error) {
    throw new SteadySdkError('GIT_REVISION_NOT_FOUND', `Git revision "${revision}" not found`, {
      hint: 'Fetch it first (e.g. `git fetch origin main`); in GitHub Actions, check out with `fetch-depth: 0` or let the steadysdk action fetch it.',
      cause: error,
    });
  }
  const relative = async (file: string): Promise<string> => {
    const real = path.join(await existingDirectory(path.dirname(file)), path.basename(file));
    return path.relative(root, real).split(path.sep).join('/');
  };
  return {
    revision,
    root,
    async read(file) {
      const inRepo = await relative(file);
      try {
        const { stdout } = await run('git', ['-C', root, 'show', `${revision}:${inRepo}`], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
        return stdout;
      } catch (error) {
        throw new SteadySdkError('SPEC_NOT_FOUND', `${inRepo} does not exist at git revision "${revision}"`, { cause: error });
      }
    },
    label: async (file) => `${revision}:${await relative(file)}`,
  };
}

/**
 * `<revision>:<path>` as typed on the command line (`main:openapi.yaml`), or undefined for anything else.
 * A one-letter revision is a Windows drive (`C:\\api.yaml`), not a git revision.
 */
export function parseRevisionArgument(argument: string): { revision: string; file: string } | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument)) return undefined;
  const match = /^([^:]{2,}):(.+)$/.exec(argument);
  return match ? { revision: match[1]!, file: match[2]! } : undefined;
}

/** The path itself if it is a directory, else its closest existing ancestor, with symlinks resolved. */
async function existingDirectory(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
