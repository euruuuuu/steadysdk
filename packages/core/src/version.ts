import { readFileSync } from 'node:fs';

/** Version of @steadysdk/core, recorded in the manifest of every generated SDK. */
export const STEADYSDK_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
