# sdkgen

**Generate typed API clients from OpenAPI, and keep them maintainable as the API evolves.**

Most OpenAPI generators are "generate once and forget": re-running them overwrites everything, wipes out
hand-written helpers, and silently renames methods when the spec shifts. sdkgen is built for the second,
tenth and hundredth generation.

| Situation | Typical generator | sdkgen |
| --- | --- | --- |
| First generation | Works | Works |
| API adds an endpoint | Rewrites everything | Adds the new method; every other file is untouched |
| You wrote a custom helper | Gets deleted | Lives outside `generated/`, never touched |
| Someone hand-edits generated code | Silently overwritten | Detected; regeneration stops and tells you |
| An `operationId` is renamed upstream | Your method is renamed (breaking) | Name pinned by the lock file until you opt in |
| Naming conventions | Generator's choice, drifts | Your rules, in config, applied every time |
| CI | — | `sdkgen generate --check` fails when the SDK is stale |

> **Status:** early development. Generation, naming rules, safe regeneration and the name lock work today.
> The changelog / breaking-change detection, watch mode and VS Code extension are next (see [Roadmap](#roadmap)).

## Quick start

```bash
npm install --save-dev sdkgen     # not yet published; see "Development" to run from source

npx sdkgen init                   # writes .sdkgenrc.yml, detecting openapi.yaml/json
npx sdkgen generate               # writes ./sdk
```

```ts
import { PetstoreClient } from './sdk/index.js';

const client = new PetstoreClient({ auth: { bearerAuth: process.env.TOKEN } });

const pets = await client.pets.listPets({ limit: 20, status: ['available'] });
const pet = await client.pets.createPet({ name: 'Rex', tag: 'dog' });
await client.pets.updatePet({ petID: pet.id }, { name: 'Max' });
```

The generated code has no dependencies (it uses `fetch`) and type-checks under the strictest compiler settings
(`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`, ...).
See [`examples/petstore/sdk`](examples/petstore/sdk) for real output.

## What gets generated

```
sdk/
├── generated/            ← owned by sdkgen, rewritten on every run. Don't edit.
│   ├── runtime.ts        fetch wrapper: auth, query/path/header serialization, errors, timeouts, hooks
│   ├── models.ts         one type per components.schemas entry
│   ├── api/pets.ts       one class per tag: PetsApi with listPets(), createPet(), ...
│   ├── client.ts         GeneratedClient wiring the groups together
│   └── index.ts
├── client.ts             ← created once, then yours: class PetstoreClient extends GeneratedClient {}
├── index.ts              ← created once, then yours
└── .sdkgen/              ← bookkeeping, commit it
    ├── manifest.json     hash of every generated file (detects hand edits and stale files)
    ├── names.lock.json   every assigned name (keeps names stable)
    └── spec.json         the spec this SDK was generated from (baseline for drift detection)
```

Method signatures follow one rule: `method(params?, body?, options?)`, where `params` holds path, query, header
and cookie parameters, and is optional when nothing in it is required.

## Maintenance model

**Your code lives next to the generated code, not inside it.** `client.ts` and `index.ts` are scaffolded once
and never touched again, so this survives every regeneration:

```ts
// sdk/client.ts
import { GeneratedClient } from './generated/index.js';

export class PetstoreClient extends GeneratedClient {
  async findAvailable(name: string) {
    const pets = await this.pets.listPets({ status: ['available'] });
    return pets.filter((pet) => pet.name === name);
  }
}
```

**Hand edits to generated code are detected, never silently lost.** The manifest records a hash of each file
sdkgen wrote. If a generated file changed since then, `sdkgen generate` stops and lists it; move the change
out of `generated/`, or pass `--force` to overwrite it. Files that are no longer generated (say, a removed
tag) are deleted, unless they were edited, in which case they are kept and reported.

**Names stay put.** Every name sdkgen assigns is recorded in `.sdkgen/names.lock.json` and reused on the
next run. Concretely:

- A new endpoint whose name collides with an existing one gets the suffix. The existing one keeps its name.
- If the backend renames an `operationId`, your method keeps its name and sdkgen notes the difference.
  `sdkgen generate --relock` adopts the new names when you are ready to make that change.
- Changing your naming config re-derives names on purpose and lists every rename.

**CI can enforce all of it.** `sdkgen generate --check` exits 1 if the committed SDK is not exactly what the
current spec and config produce.

## Naming conventions

Everything is driven by `.sdkgenrc.yml`; [`.sdkgenrc.example.yml`](.sdkgenrc.example.yml) documents every
option with its default.

```yaml
naming:
  acronyms: [ID, URL]                 # userId -> userID, avatarUrl -> avatarURL
  operations:
    source: operationId               # or `path` to ignore operationIds
    stripPrefixes: ['^\w+Controller_'] # UsersController_findOne -> findOne
    templates:                        # used when deriving names from paths
      get: fetch{Resource}            # GET /users/{id} -> fetchUser (default: getUserById)
  types:
    suffix: Dto                       # Pet -> PetDto
  parameters:
    case: camel                       # X-Request-ID -> xRequestID (with the acronym above)
  pluralization:
    irregular: { person: people }
  overrides:
    operations:
      "GET /users/{id}": fetchUser
      listPets: getAllPets            # by operationId
    schemas:
      UserDTO: User
```

When an operation has no `operationId`, names are derived from the path:

| Path | Name |
| --- | --- |
| `GET /users` | `listUsers` |
| `GET /users/{id}` | `getUserById` |
| `POST /users` | `createUser` |
| `GET /users/{userId}/posts` | `listUserPosts` |
| `POST /orders/{id}/cancel` | `cancelOrder` |
| `GET /api/v2/people` | `listPeople` |

Case styles (`camel`, `pascal`, `snake`, `constant`, `preserve`), prefixes/suffixes, grouping (`tag`, `path`,
`none`) and helper-type templates (`{Operation}Params`, ...) are all configurable. Names that clash with
built-ins or with each other are resolved deterministically and reported.

## CLI

```
sdkgen init        [-i spec] [-o dir] [--force]
sdkgen generate    [-c config] [-i spec] [-o dir] [--dry-run] [--check] [--relock] [--force]
                   [--no-validate] [--verbose]
global:            [-C, --cwd dir] [--no-color]
```

Specs are validated before generation: the OpenAPI schema, plus checks that matter for code generation
(every `{param}` in a path is declared, operationIds are unique). Errors come with the offending location
and a hint.

## Supported OpenAPI

- OpenAPI 3.0.x and 3.1.x, YAML or JSON, local files or URLs, multi-file specs with external `$ref`s
- Schemas: objects, arrays, enums, `const`, `nullable` and 3.1 type arrays, `allOf` / `oneOf` / `anyOf`,
  `additionalProperties`, recursive references
- Parameters in path, query (all `style`/`explode` combinations), header and cookie
- Bodies: JSON, `application/x-www-form-urlencoded`, `multipart/form-data` (with files), text, binary
- Security: HTTP bearer/basic, API keys (header/query/cookie), OAuth2 and OpenID Connect tokens
- Not yet: webhooks and callbacks (skipped with a note), Swagger 2.0 (convert with `swagger2openapi`)

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| A | Spec loading, model, naming engine, name lock, TypeScript generator, `init` / `generate` | ✅ Done |
| B | Changelog & drift detection: `sdkgen diff` / `changelog`, breaking vs non-breaking, JSON + Markdown | Next |
| C | Maintenance: marker regions for partial updates, ignore lists, template overrides | Planned |
| D | `sdkgen watch`, CI gating on breaking changes without a version bump, GitHub Action | Planned |
| E | VS Code extension (generate/diff commands, out-of-sync status bar), npm publish | Planned |

## Development

```bash
npm install
npm run build          # tsc -b (TypeScript 7)
npm test               # vitest: unit, golden-file, type-check and live-HTTP tests
npm run typecheck      # sources, tests and the runtime template
npm run examples       # regenerate examples/petstore/sdk after generator changes
```

Layout: [`packages/core`](packages/core) holds the engine (spec loading, IR, naming, generators, output
planning); [`packages/cli`](packages/cli) is the `sdkgen` command.

## License

MIT
