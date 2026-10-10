import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ejectTemplate, isSteadySdkError, loadConfig, SteadySdkError, type ResolvedConfig, type TemplateName } from '@steadysdk/core';
import type { Ui } from '../ui.js';

export interface EjectCommandOptions {
  config?: string;
  out?: string;
  stdout?: boolean;
  force?: boolean;
}

/** Copies a built-in template into the project so it can be customized (`templates.<name>` in the config). */
export async function ejectCommand(ui: Ui, options: EjectCommandOptions, [name]: ReadonlyArray<string | undefined>): Promise<number> {
  const template = name as TemplateName;
  const content = await ejectTemplate(template);
  if (options.stdout) {
    ui.io.stdout(content);
    return 0;
  }

  const config = await findConfig(ui, options.config);
  const base = config?.rootDir ?? ui.io.cwd;
  const target = options.out !== undefined ? path.resolve(ui.io.cwd, options.out) : (config?.runtimeTemplatePath ?? path.join(base, 'steadysdk', `${template}.ts`));
  if (!options.force && (await stat(target).catch(() => undefined))) {
    throw new SteadySdkError('FILE_EXISTS', `${ui.rel(target)} already exists`, {
      hint: 'Pass --force to replace it (your changes to it are lost), or --stdout to compare it with the built-in version.',
    });
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');

  ui.success(`Copied the built-in ${template} template to ${ui.c.bold(ui.rel(target))}`);
  if (config?.runtimeTemplatePath === target) {
    ui.line(`steadysdk uses it for generated/${template}.ts from the next run on.`);
  } else {
    const relative = path.relative(base, target).split(path.sep).join('/');
    ui.line(`To use it, add this to ${config?.configPath ? ui.rel(config.configPath) : 'your steadysdk config'}:`);
    ui.line(ui.c.cyan(`  templates:\n    ${template}: ${relative.startsWith('.') ? relative : `./${relative}`}`));
  }
  return 0;
}

async function findConfig(ui: Ui, configPath: string | undefined): Promise<ResolvedConfig | undefined> {
  try {
    return await loadConfig({ cwd: ui.io.cwd, configPath });
  } catch (error) {
    if (isSteadySdkError(error) && error.code === 'CONFIG_NOT_FOUND' && configPath === undefined) return undefined;
    throw error;
  }
}
