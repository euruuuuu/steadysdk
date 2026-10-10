# steadysdk

**Generate typed API clients from OpenAPI, and keep them maintainable as the API evolves.**

Most OpenAPI generators are "generate once and forget": re-running them overwrites everything, wipes out
hand-written helpers, and silently renames methods when the spec shifts. steadysdk is built for the second,
tenth and hundredth generation.

| Situation | Typical generator | steadysdk |
| --- | --- | --- |
| First generation | Works | Works |
| API adds an endpoint | Rewrites everything | Adds the new method; every other file is untouched |
| You wrote a custom helper | Gets deleted | Lives in your own file or a custom region; kept on every run |
| Someone hand-edits generated code | Silently overwritten | Detected; regeneration stops and tells you |
| An `operationId` is renamed upstream | Your method is renamed (breaking) | Name pinned by the lock file until you opt in |
| The API changes | You diff the YAML by hand | `steadysdk diff` lists every change and marks the breaking ones |
| Release notes | Written by hand | `steadysdk changelog` writes them as Markdown or JSON |
| Naming conventions | Generator's choice, drifts | Your rules, in config, applied every time |
| CI | — | `generate --check` fails when the SDK is stale; `diff --fail-on-breaking` on breaking changes |

> **Status:** early development. Generation, naming rules, safe regeneration, the name lock, custom regions,
> ignore lists, template overrides and the API changelog with breaking-change detection work today. Watch mode,
> CI gating on version bumps and the VS Code extension are next (see [Roadmap](#roadmap)).

## Quick start

```bash
npm install --save-dev steadysdk     # not yet published; see "Development" to run from source

npx steadysdk init                   # writes .steadysdkrc.yml, detecting openapi.yaml/json
npx steadysdk generate               # writes ./sdk
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
├── generated/            ← owned by steadysdk, rewritten on every run. Edit only inside custom regions.
│   ├── runtime.ts        fetch wrapper: auth, query/path/header serialization, errors, timeouts, hooks
│   ├── models.ts         one type per components.schemas entry
│   ├── api/pets.ts       one class per tag: PetsApi with listPets(), createPet(), ...
│   ├── client.ts         GeneratedClient wiring the groups together
│   └── index.ts
├── client.ts             ← created once, then yours: class PetstoreClient extends GeneratedClient {}
├── index.ts              ← created once, then yours
└── .steadysdk/              ← bookkeeping, commit it
    ├── manifest.json     hash of every generated file (detects hand edits and stale files)
    ├── names.lock.json   every assigned name (keeps names stable)
    └── spec.json         the spec this SDK was generated from (the baseline for `steadysdk diff`)
```

Method signatures follow one rule: `method(params?, body?, options?)`, where `params` holds path, query, header
and cookie parameters, and is optional when nothing in it is required.

## Maintenance model

**Your code lives next to the generated code.** `client.ts` and `index.ts` are scaffolded once and never touched
again, so this survives every regeneration:

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

**Or inside it, in custom regions.** Some code belongs in a generated class, for example a helper on `PetsApi`,
which `GeneratedClient` creates for you. Generated files have named regions for that: the imports and the class
body of each API file, and extra declarations at the end of `models.ts`. Code between the markers is carried
into every new version of the file:

```ts
// sdk/generated/api/pets.ts
export class PetsApi {
  // ...generated methods...

  // <steadysdk:custom members>
  async findAvailablePet(name: string, options?: RequestOptions): Promise<Pet | undefined> {
    const pets = await this.listPets({ status: ['available'] }, options);
    return pets.find((pet) => pet.name === name);
  }
  // </steadysdk:custom>
}
```

The committed [Petstore example](examples/petstore/sdk/generated/api/pets.ts) carries this helper through every
regeneration. If a region with code in it would disappear, for example because its tag was removed from the
spec, `generate` stops instead of dropping the code. It also stops if the markers are broken. Set
`typescript.customRegions: false` to generate files without regions.

**Hand edits to generated code are detected, never silently lost.** The manifest records a hash of each file
steadysdk wrote, with custom regions left out. If a generated file changed outside its regions since then,
`steadysdk generate` stops and lists it. Move the change into a region or out of `generated/`, or pass `--force` to
overwrite it. Files that are no longer generated (say, a removed tag) are deleted, unless they were edited or
hold region code, in which case they are kept and reported.

**Names stay put.** Every name steadysdk assigns is recorded in `.steadysdk/names.lock.json` and reused on the
next run. Concretely:

- A new endpoint whose name collides with an existing one gets the suffix. The existing one keeps its name.
- If the backend renames an `operationId`, your method keeps its name and steadysdk notes the difference.
  `steadysdk generate --relock` adopts the new names when you are ready to make that change.
- Changing your naming config re-derives names on purpose and lists every rename.

**CI can enforce all of it.** `steadysdk generate --check` exits 1 if the committed SDK is not exactly what the
current spec and config produce.

## API changes and breaking changes

Each run stores the spec it used in `.steadysdk/spec.json`. steadysdk compares that baseline with the current spec,
so you see what changed in the API itself rather than which generated files changed:

```console
$ steadysdk diff
Comparing sdk/.steadysdk/spec.json → openapi.yaml
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

`steadysdk generate` prints the same list while it runs, and `generate --check` prints it when it finds the SDK out
of date. `steadysdk changelog` writes the changes as Markdown for a CHANGELOG, release or pull request. An excerpt
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
steadysdk diff                        # changes since the last generation
steadysdk diff -i candidate.yaml      # preview a new version of the spec against the SDK
steadysdk diff old.yaml new.yaml      # any two specs; no config needed
steadysdk diff --fail-on-breaking     # exit 1 on breaking changes, for CI
steadysdk diff --json                 # versioned, machine-readable format
steadysdk changelog --out CHANGES.md  # Markdown (or --json) to a file
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

## Leaving parts of the API out

Internal, admin or legacy endpoints don't have to end up in the SDK:

```yaml
ignore:
  paths: ['/internal/**', '/admin/**']      # `*` stays within a segment, `**` crosses segments
  operations: ['DELETE /users/{id}', 'legacy*']   # METHOD /path, or operationId
  tags: [internal]
  schemas: ['Legacy*']                      # references from kept operations become `unknown`
  unusedSchemas: true                       # also drop schemas that no kept operation uses
```

An entry that matches nothing is reported as a warning, so typos and entries left over from an older spec
surface. The ignore list also applies to the changes `generate` lists, and to `steadysdk diff` and `changelog`
whenever they read the config (that is, unless you pass both spec files). Changes to endpoints the SDK leaves
out are not reported.

## Customizing the generated code

**Your own HTTP runtime.** Every generated client goes through `generated/runtime.ts`, a dependency-free `fetch`
wrapper. To change it (retries, a different HTTP library, tracing), copy it into your project and point the
config at your copy:

```bash
steadysdk eject runtime          # writes ./steadysdk/runtime.ts and prints the config line to add
```

```yaml
templates:
  runtime: ./steadysdk/runtime.ts
```

steadysdk then uses your copy instead of the built-in runtime. If your copy no longer exports something the generated
code imports, `generate` lists exactly what is missing. The copy records which version of the built-in runtime it
started from, so when a newer steadysdk ships a changed runtime, `generate` warns you to review it
(`steadysdk eject runtime --stdout` prints the current one).

**A header for every file**, such as a license notice:

```yaml
templates:
  header: |
    // Copyright (c) Example Corp. {title} API client, generated for API version {version}.
```

## Naming conventions

Everything is driven by `.steadysdkrc.yml`; [`.steadysdkrc.example.yml`](.steadysdkrc.example.yml) documents every
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
steadysdk init        [-i spec] [-o dir] [--force]
steadysdk generate    [-c config] [-i spec] [-o dir] [--dry-run] [--check] [--relock] [--force]
                      [--no-validate] [--verbose]
steadysdk diff        [old] [new] [-c config] [-i spec] [--json] [--fail-on-breaking] [--no-validate]
steadysdk changelog   [old] [new] [-c config] [-i spec] [--json] [--out file] [--no-validate]
steadysdk eject       runtime [-c config] [--out file] [--stdout] [--force]
global:               [-C, --cwd dir] [--no-color]
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
| B | Changelog & drift detection: `steadysdk diff` / `changelog`, breaking vs non-breaking, JSON + Markdown | ✅ Done |
| C | Maintenance: custom regions in generated files, ignore lists, template overrides (`steadysdk eject`) | ✅ Done |
| D | `steadysdk watch`, CI gating on breaking changes without a version bump, GitHub Action | Next |
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
planning, diff); [`packages/cli`](packages/cli) is the `steadysdk` command.

## License

MIT
