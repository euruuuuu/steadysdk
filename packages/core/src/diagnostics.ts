export type DiagnosticLevel = 'warning' | 'info';

/** A non-fatal finding surfaced to the user (unsupported construct, renamed symbol, ...). */
export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** JSON pointer into the spec, or an operation key such as `GET /pets`. */
  location?: string | undefined;
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];

  warn(code: string, message: string, location?: string): void {
    this.items.push({ level: 'warning', code, message, location });
  }

  info(code: string, message: string, location?: string): void {
    this.items.push({ level: 'info', code, message, location });
  }
}
