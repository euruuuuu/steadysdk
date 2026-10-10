/**
 * Who owns a file in the output directory:
 * - `generated`: steadysdk's. Rewritten on every run and tracked in the manifest; never edit it.
 * - `scaffold`: created once as a starting point, then yours. steadysdk never touches it again.
 */
export type FileOwnership = 'generated' | 'scaffold';

export interface GeneratedFile {
  /** POSIX path relative to the output directory. */
  path: string;
  content: string;
  ownership: FileOwnership;
}
