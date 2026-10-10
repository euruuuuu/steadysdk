import { readFileSync } from 'node:fs';

/** Version of @apisteady/core, recorded in the manifest of every generated SDK. */
export const APISTEADY_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
