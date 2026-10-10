# apisteady

**Generate typed TypeScript API clients from OpenAPI, and keep them maintainable as the API evolves.**

apisteady turns an OpenAPI 3.0 / 3.1 or Swagger 2.0 spec into a dependency-free, fully typed TypeScript
client. Then it keeps that client maintainable: regenerating never overwrites your code, names stay stable when
the spec shifts, and every API change is listed, with breaking ones marked.

```bash
npm install --save-dev apisteady
npx apisteady init        # writes .apisteadyrc.yml, detecting your openapi.yaml / .json
npx apisteady generate    # writes ./sdk
```

```ts
import { PetstoreClient } from './sdk/index.js';

const client = new PetstoreClient({ auth: { bearerAuth: process.env.TOKEN } });
const pets = await client.pets.listPets({ limit: 20, status: ['available'] });
```

## What it does

- **Safe regeneration.** `generated/` is rewritten on every run. Your own code lives in `client.ts` (created once,
  then yours) or in `// <apisteady:custom>` regions inside generated files, and is carried over. Hand edits to
  generated code are detected instead of silently overwritten.
- **Stable names.** Every assigned name is recorded in a lock file, so a renamed `operationId` or a new
  colliding endpoint never renames an existing method.
- **API changelog.** `apisteady diff` and `apisteady changelog` list what changed between two versions of the
  spec, and mark breaking changes, judged by whether the data is sent or received.
- **CI gating.** `apisteady generate --check` fails when the committed SDK is stale, and
  `apisteady diff --base origin/main --require-bump` fails on breaking changes without a new major version.
  A [GitHub Action](https://github.com/euruuuuu/steadysdk#github-action) runs both.
- **Watch mode.** `apisteady watch` regenerates on every save of the spec, or of any file it references.
- **Configurable naming, ignore lists, your own HTTP runtime** (`apisteady eject runtime`), and webhook payload types.

## Commands

| Command | |
| --- | --- |
| `apisteady init` | Create `.apisteadyrc.yml` |
| `apisteady generate` | Generate the SDK (`--dry-run`, `--check`, `--relock`, `--force`) |
| `apisteady watch` | Regenerate on every change |
| `apisteady diff [old] [new]` | List API changes (`--base <git-rev>`, `--json`, `--fail-on-breaking`, `--require-bump`) |
| `apisteady changelog [old] [new]` | Write the changes as Markdown or JSON (`--out <file>`) |
| `apisteady eject runtime` | Copy the HTTP runtime into your project to customize it |

The CLI needs Node.js 22.19 or newer. The generated SDK has no dependencies and runs anywhere `fetch` exists:
Node.js 18+, browsers, Deno and Bun.

**Documentation, examples and the full option reference:** <https://github.com/euruuuuu/steadysdk>

## License

MIT
