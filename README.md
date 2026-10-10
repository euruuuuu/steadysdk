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
| The API changes | You diff the YAML by hand | `sdkgen diff` lists every change and marks the breaking ones |
| Release notes | Written by hand | `sdkgen changelog` writes them as Markdown or JSON |
| Naming conventions | Generator's choice, drifts | Your rules, in config, applied every time |
| CI | — | `generate --check` fails when the SDK is stale; `diff --fail-on-breaking` on breaking changes |

> **Status:** early development. Generation, naming rules, safe regeneration, the name lock and the API
> changelog with breaking-change detection work today. Watch mode, CI gating on version bumps and the VS Code
> extension are next (see [Roadmap](#roadmap)).

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
    └── spec.json         the spec this SDK was generated from (the baseline for `sdkgen diff`)
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

## API changes and breaking changes

Each run stores the spec it used in `.sdkgen/spec.json`. sdkgen compares that baseline with the current spec,
so you see what changed in the API itself rather than which generated files changed:

```console
$ sdkgen diff
Comparing sdk/.sdkgen/spec.json → openapi.yaml
ℹ API changes in Swagger Petstore 1.0.0 → 1.1.0: 5 breaking, 7 non-breaking
    ! GET /pets: Query parameter `limit` is now required.
    ! GET /pets/{id}: Path parameter `petId` was renamed to `id`.
    ! PATCH /pets/{id}: Path parameter `petId` was renamed to `id`.
    ! DELETE /pets/{petId}: Endpoint removed (it was deprecated).
    ! schema PetStatus: Enum value `archived` was added.
    ~ GET /store/inventory: Authentication changed from `apiKey` to `apiKey` or `bearerAuth`.
    + GET /store/orders: Endpoint added.
    ~ GET /health: Response `200`: now uses `Health` instead of an inline schema.
    + schema NewPet: Optional property `birthDate` was added.
    - schema Order: Enum value `delivered` was removed from `status`.
    + schema Health: Added.
    ~ API: Default server URL changed from `https://petstore.example.com/v1` to `https://petstore.example.com/v2`.
```

`sdkgen generate` prints the same list while it runs, and `generate --check` prints it when it finds the SDK out
of date. `sdkgen changelog` writes the changes as Markdown for a CHANGELOG, release or pull request. An excerpt
of the [full example](examples/petstore/next/CHANGELOG.md), generated from [this spec change](examples/petstore/next/openapi.yaml):

```markdown
### Breaking changes

- **`GET /pets`** (`listPets`): query parameter `limit` is now required.
- **Schema `PetStatus`** (used by `GET /pets`, `POST /pets`, `GET /pets/{id}` and 3 more): enum value `archived` was added.

### Non-breaking changes

- **`GET /health`** (`healthCheck`)
  - Response `200`: now uses `Health` instead of an inline schema.
```

```bash
sdkgen diff                        # changes since the last generation
sdkgen diff -i candidate.yaml      # preview a new version of the spec against the SDK
sdkgen diff old.yaml new.yaml      # any two specs; no config needed
sdkgen diff --fail-on-breaking     # exit 1 on breaking changes, for CI
sdkgen diff --json                 # versioned, machine-readable format
sdkgen changelog --out CHANGES.md  # Markdown (or --json) to a file
```

**What counts as breaking.** A change is breaking when a client built for the old spec, or code written against
the SDK generated from it, can fail with the new one. Direction matters: what clients send may only get looser,
and what they receive may only get stricter.

| Change | In a request | In a response |
| --- | --- | --- |
| Required property added | Breaking | Non-breaking |
| Enum value added | Non-breaking | Breaking: clients may not handle it |
| Enum value removed | Breaking | Non-breaking |
| Property became optional | Non-breaking | Breaking |
| Became nullable | Non-breaking | Breaking |
| `integer` → `number`, `oneOf` variant added | Non-breaking | Breaking |
| Property removed | Breaking: the SDK type rejects it | Breaking |

A component schema is judged by where the operations use it. A schema used on both sides gets the stricter rule.
Each change is reported once, on the component, with the operations it affects. Renaming a component, or
moving an inline schema into one, without changing its shape is reported as a non-breaking reference change.
Parameters follow the request rules: adding a required one, removing one, renaming a path parameter or changing
how one is serialized is breaking. Also detected: added and removed endpoints, success statuses and media types,
request bodies, authentication requirements, security schemes and the default server URL.
Documentation-only edits are ignored. Validation keywords (`maxLength`, `pattern`, `minimum`, ...) are not
compared yet.

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
sdkgen diff        [old] [new] [-c config] [-i spec] [--json] [--fail-on-breaking] [--no-validate]
sdkgen changelog   [old] [new] [-c config] [-i spec] [--json] [--out file] [--no-validate]
global:            [-C, --cwd dir] [--no-color]
```

`old` defaults to the spec the SDK was last generated from and `new` to the configured input.

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
| B | Changelog & drift detection: `sdkgen diff` / `changelog`, breaking vs non-breaking, JSON + Markdown | ✅ Done |
| C | Maintenance: marker regions for partial updates, ignore lists, template overrides | Next |
| D | `sdkgen watch`, CI gating on breaking changes without a version bump, GitHub Action | Planned |
| E | VS Code extension (generate/diff commands, out-of-sync status bar), npm publish | Planned |

## Development

```bash
npm install
npm run build          # tsc -b (TypeScript 7)
npm test               # vitest: unit, golden-file, type-check and live-HTTP tests
npm run typecheck      # sources, tests and the runtime template
npm run examples       # regenerate examples/petstore/sdk and next/CHANGELOG.md after generator changes
```

Layout: [`packages/core`](packages/core) holds the engine (spec loading, IR, naming, generators, output
planning, diff); [`packages/cli`](packages/cli) is the `sdkgen` command.

## License

MIT
