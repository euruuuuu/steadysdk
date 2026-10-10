import { readFile } from 'node:fs/promises';
import type { Diagnostics } from '../../diagnostics.js';
import { SdkgenError } from '../../errors.js';
import { sha256 } from '../../util/hash.js';

const BUILTIN_RUNTIME = new URL('../../../templates/typescript/runtime.ts', import.meta.url);
const FINGERPRINT = /built-in runtime template \(fingerprint ([0-9a-f]{12})\)/;

/** Templates `sdkgen eject` can copy out for customization. */
export const TEMPLATE_NAMES = ['runtime'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** The fetch-based HTTP runtime shipped with sdkgen. */
export function builtinRuntime(): Promise<string> {
  return readFile(BUILTIN_RUNTIME, 'utf8');
}

/** The built-in runtime, prefixed with a note recording which version of it the copy started from. */
export async function ejectTemplate(_name: TemplateName): Promise<string> {
  const source = await builtinRuntime();
  return [
    `// Your copy of the sdkgen HTTP runtime, ejected from the built-in runtime template (fingerprint ${fingerprint(source)}).`,
    '// While `templates.runtime` points at this file, sdkgen copies it to generated/runtime.ts on every run.',
    '// Keep the exports the generated code imports: `sdkgen generate` lists any that go missing.',
    '',
    source,
  ].join('\n');
}

/**
 * The runtime to generate with: the `templates.runtime` override when configured, else the built-in one.
 * Warns when an ejected override started from a different version of the built-in runtime.
 */
export async function loadRuntime(overridePath: string | undefined, diagnostics: Diagnostics): Promise<string> {
  const builtin = await builtinRuntime();
  if (overridePath === undefined) return builtin;
  let source: string;
  try {
    source = await readFile(overridePath, 'utf8');
  } catch (error) {
    throw new SdkgenError('TEMPLATE_NOT_FOUND', `Runtime template not found: ${overridePath}`, {
      hint: 'Create it with `sdkgen eject runtime`, or remove `templates.runtime` from the config.',
      cause: error,
    });
  }
  const recorded = FINGERPRINT.exec(source)?.[1];
  const current = fingerprint(builtin);
  if (recorded !== undefined && recorded !== current) {
    diagnostics.warn(
      'TEMPLATE_OUTDATED',
      `templates.runtime was ejected from another version of the built-in runtime (fingerprint ${recorded}, now ${current}). ` +
        `Compare it with \`sdkgen eject runtime --stdout\`, merge what you need, then update the fingerprint in its first line.`,
      overridePath,
    );
  }
  return source;
}

function fingerprint(source: string): string {
  return sha256(source).slice(0, 12);
}
