import { generate, SteadySdkError, type ResolvedConfig } from '@steadysdk/core';
import type { Ui } from '../ui.js';
import { FileWatcher } from '../watcher.js';
import { loadGenerateConfig, printGeneration, type GenerateCommandOptions } from './generate.js';

export type WatchCommandOptions = Pick<GenerateCommandOptions, 'config' | 'input' | 'output' | 'validate' | 'verbose'>;

/** Saves arrive as bursts of file events; wait for the burst to end before regenerating. */
const SETTLE_MS = 100;

/**
 * Generates, then regenerates whenever the spec (including files it `$ref`s), the config or the runtime
 * template changes. Errors (an invalid spec mid-edit, a conflict) are reported and watching continues.
 */
export async function watchCommand(ui: Ui, options: WatchCommandOptions): Promise<number> {
  // Without a usable config there is nothing to watch, so that one is fatal.
  let config = await loadGenerateConfig(ui, options);
  assertWatchable(config);
  if (config.configPath) ui.line(ui.c.dim(`Using ${ui.rel(config.configPath)}`));

  const interrupt = ui.io.signal ? { signal: ui.io.signal, dispose: () => {} } : onInterrupt();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let queued: string | undefined;

  const watcher = new FileWatcher((file) => {
    queued ??= file;
    clearTimeout(timer);
    timer = setTimeout(() => void cycle(), SETTLE_MS);
  });

  const regenerate = async (): Promise<void> => {
    const started = performance.now();
    const files = new Set([config.inputPath, config.configPath, config.runtimeTemplatePath].filter((file) => file !== undefined));
    try {
      const result = await generate({ config });
      for (const file of result.spec.files) files.add(file);
      printGeneration(ui, result, { dryRun: false, verbose: options.verbose }, started);
    } catch (error) {
      ui.error(error);
    }
    watcher.set(files);
  };

  const cycle = async (): Promise<void> => {
    if (running) return; // the running cycle picks up `queued` when it finishes
    const file = queued;
    queued = undefined;
    if (file === undefined || interrupt.signal.aborted) return;
    running = (async () => {
      ui.line();
      ui.line(ui.c.dim(`[${new Date().toTimeString().slice(0, 8)}] ${ui.rel(file)} changed`));
      try {
        config = await loadGenerateConfig(ui, options);
        assertWatchable(config);
        await regenerate();
      } catch (error) {
        ui.error(error); // e.g. the config is mid-edit: keep watching what we had
      }
    })();
    await running;
    running = undefined;
    if (queued !== undefined) await cycle();
  };

  await regenerate();
  ui.info(`Watching ${watcher.size} file${watcher.size === 1 ? '' : 's'} for changes. Press Ctrl+C to stop.`);

  await new Promise<void>((resolve) => {
    if (interrupt.signal.aborted) resolve();
    else interrupt.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  clearTimeout(timer);
  watcher.close();
  interrupt.dispose();
  await running;
  ui.line(ui.c.dim('Stopped watching.'));
  return 0;
}

function assertWatchable(config: ResolvedConfig): void {
  if (/^https?:\/\//i.test(config.inputPath)) {
    throw new SteadySdkError('WATCH_UNSUPPORTED', `Cannot watch ${config.inputPath}: it is a URL`, {
      hint: 'Watch mode needs the spec on disk. Download it, or run `steadysdk generate` when it changes.',
    });
  }
}

function onInterrupt(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}
