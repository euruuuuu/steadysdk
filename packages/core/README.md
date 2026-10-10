# @steadysdk/core

The engine behind the [steadysdk](https://www.npmjs.com/package/steadysdk) CLI. Most people want the CLI; use
this package to build your own tooling on the same pieces:

- **Spec loading:** OpenAPI 3.0 / 3.1 and Swagger 2.0, from files, URLs or git revisions, multi-file specs included
- **A normalized model** of the API, with 3.0 and 3.1 differences resolved
- **The diff engine:** every change between two versions of an API, each one marked breaking or not
- **The TypeScript generator**, with the name lock and the output planner that protects hand-written code

```ts
import { buildModel, checkVersionBump, diffModels, loadSpec, renderChangelog } from '@steadysdk/core';

// What changed in the spec since main, and is the version bump big enough?
const before = buildModel((await loadSpec('openapi.yaml', { revision: 'main' })).document);
const after = buildModel((await loadSpec('openapi.yaml')).document);
const diff = diffModels(before, after);

console.log(renderChangelog(diff)); // Markdown, breaking changes first
if (!checkVersionBump(diff).ok) process.exitCode = 1;
```

```ts
import { generate, loadConfig } from '@steadysdk/core';

const result = await generate({ config: await loadConfig(), dryRun: true });
console.log(result.plan.changes, result.changes?.summary);
```

The API follows the CLI's version and may change before 1.0. Requires Node.js 22.19 or newer.
Documentation: <https://github.com/euruuuuu/steadysdk>

## License

MIT
