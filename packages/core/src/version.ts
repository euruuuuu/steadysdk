import { readFileSync } from 'node:fs';

/** Version of @sdkgen/core, recorded in the manifest of every generated SDK. */
export const SDKGEN_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
