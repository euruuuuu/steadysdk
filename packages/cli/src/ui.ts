import path from 'node:path';
import pc from 'picocolors';
import { isSdkgenError, type Diagnostic } from '@sdkgen/core';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /** Colors are on for TTYs unless NO_COLOR is set; tests pass false. */
  color: boolean;
}

export function defaultIo(): Io {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    color: pc.isColorSupported,
  };
}

/** Small presentation layer so commands read as a sequence of steps. */
export class Ui {
  readonly io: Io;
  private readonly colors: ReturnType<typeof pc.createColors>;

  constructor(io: Io) {
    this.io = io;
    this.colors = pc.createColors(io.color);
  }

  get c(): ReturnType<typeof pc.createColors> {
    return this.colors;
  }

  line(text = ''): void {
    this.io.stdout(`${text}\n`);
  }

  success(text: string): void {
    this.line(`${this.colors.green('✔')} ${text}`);
  }

  warn(text: string): void {
    this.line(`${this.colors.yellow('⚠')} ${text}`);
  }

  info(text: string): void {
    this.line(`${this.colors.cyan('ℹ')} ${text}`);
  }

  fail(text: string): void {
    this.io.stderr(`${this.colors.red('✖')} ${text}\n`);
  }

  /** A path relative to the working directory, for display. */
  rel(target: string): string {
    if (/^https?:\/\//i.test(target)) return target;
    const relative = path.relative(this.io.cwd, target);
    return relative === '' ? '.' : relative.startsWith('..') ? target : relative;
  }

  diagnostics(items: readonly Diagnostic[], verbose: boolean): void {
    const warnings = items.filter((item) => item.level === 'warning');
    const notes = items.filter((item) => item.level === 'info');
    for (const item of warnings) this.warn(this.formatDiagnostic(item));
    if (verbose) {
      for (const item of notes) this.info(this.formatDiagnostic(item));
    } else if (notes.length > 0) {
      this.line(this.colors.dim(`  ${notes.length} note${notes.length === 1 ? '' : 's'} hidden (run with --verbose to see them)`));
    }
  }

  error(error: unknown): void {
    if (isSdkgenError(error)) {
      this.fail(error.message);
      for (const detail of error.details) this.io.stderr(`  ${this.colors.dim('•')} ${detail}\n`);
      if (error.hint) this.io.stderr(`  ${this.colors.cyan('Hint:')} ${error.hint}\n`);
      return;
    }
    this.fail('Unexpected error — this is a bug in sdkgen, please report it.');
    this.io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }

  private formatDiagnostic(item: Diagnostic): string {
    const where = item.location ? this.colors.dim(` (${item.location})`) : '';
    return `${item.message}${where}`;
  }
}
