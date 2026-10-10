/** Stable, machine-readable error codes. The CLI maps these to exit codes and hints. */
export type ApiSteadyErrorCode =
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
  | 'FILE_EXISTS'
  | 'GIT_FAILED'
  | 'GIT_REVISION_NOT_FOUND'
  | 'WATCH_UNSUPPORTED'
  | 'ARGUMENTS_INVALID';

export interface ApiSteadyErrorOptions {
  hint?: string;
  details?: readonly string[];
  cause?: unknown;
}

/** An expected, user-facing failure (bad config, invalid spec, ...). Anything else is a bug. */
export class ApiSteadyError extends Error {
  readonly code: ApiSteadyErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];

  constructor(code: ApiSteadyErrorCode, message: string, options: ApiSteadyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiSteadyError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? [];
  }
}

export function isApiSteadyError(value: unknown): value is ApiSteadyError {
  return value instanceof ApiSteadyError;
}
