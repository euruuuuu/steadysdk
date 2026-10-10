import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ApiSteadyError } from '../errors.js';
import { configSchema, type ApiSteadyConfig, type ApiSteadyConfigInput } from './schema.js';

/** Looked up in this order, from the working directory upwards. */
export const CONFIG_FILE_NAMES = [
  '.apisteadyrc.yml',
  '.apisteadyrc.yaml',
  '.apisteadyrc.json',
  'apisteady.config.yml',
  'apisteady.config.yaml',
  'apisteady.config.json',
] as const;

export interface ResolvedConfig extends ApiSteadyConfig {
  /** Absolute path of the config file; undefined when the config came from flags alone. */
  configPath: string | undefined;
  /** Directory relative paths in the config are resolved against. */
  rootDir: string;
  /** Absolute path (or URL) of the OpenAPI document. */
  inputPath: string;
  /** Absolute output directory. */
  outputDir: string;
  /** Absolute path of `templates.runtime`, when set. */
  runtimeTemplatePath: string | undefined;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config file; skips the upward search. */
  configPath?: string;
  /** Values that win over the config file (typically CLI flags). Paths are resolved against `cwd`. */
  overrides?: Partial<Pick<ApiSteadyConfigInput, 'input' | 'output' | 'validate'>>;
}

export async function findConfigFile(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name);
      if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ? path.resolve(cwd, options.configPath) : await findConfigFile(cwd);

  let fileConfig: Record<string, unknown> = {};
  if (configPath) {
    fileConfig = await readConfigFile(configPath);
  } else if (options.overrides?.input === undefined) {
    throw new ApiSteadyError('CONFIG_NOT_FOUND', 'No apisteady config file found', {
      hint: 'Run `apisteady init` to create .apisteadyrc.yml, or pass --input <spec>.',
    });
  }

  const rootDir = configPath ? path.dirname(configPath) : cwd;
  const overrides = options.overrides ?? {};
  // Flag paths are relative to where the command runs, not to the config file.
  const merged = {
    ...fileConfig,
    ...(overrides.input !== undefined && { input: absolutize(cwd, overrides.input) }),
    ...(overrides.output !== undefined && { output: absolutize(cwd, overrides.output) }),
    ...(overrides.validate !== undefined && { validate: overrides.validate }),
  };

  const config = parseConfig(merged, configPath ?? 'command-line options');
  return {
    ...config,
    configPath,
    rootDir,
    inputPath: absolutize(rootDir, config.input),
    outputDir: path.resolve(rootDir, config.output),
    runtimeTemplatePath: config.templates.runtime === undefined ? undefined : path.resolve(rootDir, config.templates.runtime),
  };
}

export function parseConfig(value: unknown, source = 'config'): ApiSteadyConfig {
  const result = configSchema.safeParse(withoutNulls(value));
  if (!result.success) {
    throw new ApiSteadyError('CONFIG_INVALID', `Invalid apisteady config (${source})`, {
      details: formatIssues(result.error.issues),
      hint: 'See .apisteadyrc.example.yml for every supported option.',
    });
  }
  return result.data;
}

async function readConfigFile(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ApiSteadyError('CONFIG_NOT_FOUND', `Cannot read config file ${file}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ApiSteadyError('CONFIG_INVALID', `Config file ${file} is not valid YAML/JSON`, {
      details: [error instanceof Error ? error.message : String(error)],
      cause: error,
    });
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiSteadyError('CONFIG_INVALID', `Config file ${file} must contain a mapping of options`);
  }
  return parsed as Record<string, unknown>;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/** YAML reads a key whose options are all commented out (`templates:`) as null; treat that as unset. */
function withoutNulls(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, withoutNulls(item)]),
  );
}

function absolutize(base: string, target: string): string {
  return /^https?:\/\//i.test(target) ? target : path.resolve(base, target);
}
