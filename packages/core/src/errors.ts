/** Stable, machine-readable error codes. The CLI maps these to exit codes and hints. */
export type SteadySdkErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'CONFIG_EXISTS'
  | 'SPEC_NOT_FOUND'
  | 'SPEC_PARSE_FAILED'
  | 'SPEC_INVALID'
  | 'SPEC_UNSUPPORTED'
  | 'BASELINE_NOT_FOUND'
  | 'NAMING_INVALID'
  | 'OUTPUT_UNSAFE'
  | 'OUTPUT_CONFLICT'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_INVALID'
  | 'FILE_EXISTS';

export interface SteadySdkErrorOptions {
  hint?: string;
  details?: readonly string[];
  cause?: unknown;
}

/** An expected, user-facing failure (bad config, invalid spec, ...). Anything else is a bug. */
export class SteadySdkError extends Error {
  readonly code: SteadySdkErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];

  constructor(code: SteadySdkErrorCode, message: string, options: SteadySdkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SteadySdkError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? [];
  }
}

export function isSteadySdkError(value: unknown): value is SteadySdkError {
  return value instanceof SteadySdkError;
}
