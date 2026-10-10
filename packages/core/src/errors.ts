/** Stable, machine-readable error codes. The CLI maps these to exit codes and hints. */
export type SdkgenErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'CONFIG_EXISTS'
  | 'SPEC_NOT_FOUND'
  | 'SPEC_PARSE_FAILED'
  | 'SPEC_INVALID'
  | 'SPEC_UNSUPPORTED'
  | 'NAMING_INVALID'
  | 'OUTPUT_UNSAFE'
  | 'OUTPUT_CONFLICT';

export interface SdkgenErrorOptions {
  hint?: string;
  details?: readonly string[];
  cause?: unknown;
}

/** An expected, user-facing failure (bad config, invalid spec, ...). Anything else is a bug. */
export class SdkgenError extends Error {
  readonly code: SdkgenErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];

  constructor(code: SdkgenErrorCode, message: string, options: SdkgenErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SdkgenError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? [];
  }
}

export function isSdkgenError(value: unknown): value is SdkgenError {
  return value instanceof SdkgenError;
}
