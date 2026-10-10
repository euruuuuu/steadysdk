# steadysdk — OpenAPI SDK generator & maintainer

TypeScript CLI that generates typed API clients from OpenAPI 3.0/3.1 (and Swagger 2.0) and keeps them maintainable across
regenerations: user code is never overwritten, names stay stable (name lock), and API changes are reported
as a changelog with breaking-change detection. Portfolio project (featured on the author's portfolio site); README.md is the public face.
Repo: github.com/euruuuuu/steadysdk. Name history (all 2026-10-10): `sdkgen` → `steadysdk` → `apisteady` → back to
`steadysdk`. npm rejects the plain name `steadysdk` as too similar to the existing `steady-sdk`, so the packages are
scoped: `@steadysdk/cli` (command `steadysdk`) and `@steadysdk/core`; the user owns the `steadysdk` npm org (and
`apisteady`, where `apisteady@0.1.0` / `@apisteady/core@0.1.0` were briefly published). Config `.steadysdkrc.yml`,
bookkeeping `<output>/.steadysdk/`, region markers `// <steadysdk:custom name>`.

## Workflow

- Built milestone by milestone. After each milestone: stop, summarize, wait for the go-ahead. Update this
  file (status, architecture, rules) at the end of every milestone.
- Use the latest *stable* library versions and check current docs, not memory (TS 7, Vitest 5, Commander 15
  and Zod 4 all have breaking changes vs. older majors).
- Before finishing: `npm run typecheck && npm test`, and `npm run examples` if generator or diff output changed
  (the committed `examples/petstore/sdk` and `examples/petstore/next/CHANGELOG.md` are golden snapshots; tests
  fail when they are stale).

## Status

| Milestone | Scope | Status |
| --- | --- | --- |
| A | Workspace, spec loading + validation, IR, naming engine + name lock, TS generator, output planner (manifest, conflicts, stale deletion), CLI `init`/`generate` (`--dry-run --check --relock --force`), petstore example, CI | ✅ Done 2026-10-10 |
| B | Drift/changelog: IR-level diff (ops, params, bodies, responses, schemas, enums, required flags, security, servers), direction-aware breaking classification, Markdown + versioned JSON, `steadysdk diff` (`--json --fail-on-breaking -i`) / `steadysdk changelog` (`--out`), changes listed by `generate` (and `--check`), petstore `next/` changelog example | ✅ Done 2026-10-10 |
| C | Custom regions (`// <steadysdk:custom name>`) in generated files (API imports/members, models declarations) merged on regeneration; `ignore` (operations/paths/tags/schemas/unusedSchemas, unmatched-entry warnings); `templates.runtime` override + `steadysdk eject runtime` (export contract check, fingerprint outdated warning), `templates.header`; Petstore example carries a region helper | ✅ Done 2026-10-10 |
| D | `steadysdk watch` (directory watches, debounce, keeps going on errors, `Io.signal`); specs at git revisions (`loadSpec({revision})`, custom ref-parser resolver, `--base`, `<rev>:<path>`); `diff --require-bump` (`checkVersionBump`); composite GitHub Action (`action.yml` + `scripts/github-action.sh`, tested locally in a temp repo, dogfooded in CI) | ✅ Done 2026-10-10 |
| E | Release prep: real-world suite (`scripts/real-world.mjs`, GitHub/Stripe/OpenAI/Twilio/Kubernetes pinned) and what it surfaced (`groupBy: auto`, 3.1 null-variant normalization, wrapped imports, unsupported-version errors); Swagger 2.0 (built-in converter); webhooks (IR, `generated/webhooks.ts`, diff); npm packaging (metadata, READMEs, LICENSE, clean `prepack`, no source maps; verified by installing the tarballs); polished `init`; CHANGELOG.md; tag `v0.1.0` | ✅ Done 2026-10-10 (npm publish waits on the user's npm login) |
| F | VS Code extension reusing core (commands, out-of-sync status bar, CodeLens) | Next |

## Commands

```bash
npm run build        # tsc -b  → packages/*/dist
npm test             # vitest (runs against src via alias; no build needed)
npm run typecheck    # tsc -b + tsconfig.tests.json (tests + runtime template)
npm run examples     # build, then regenerate examples/petstore/sdk and examples/petstore/next/CHANGELOG.md
npm run test:real-world   # build, then generate + strictly type-check SDKs for pinned public specs (downloads to .cache/)
node packages/cli/dist/index.js generate -C examples/petstore --verbose
node packages/cli/dist/index.js diff -C examples/petstore -i next/openapi.yaml
```

## Architecture

npm workspaces, ESM only, Node ≥ 22.19 (swagger-parser 13 requires it).

```
packages/core/src
  spec/load.ts         swagger-parser bundle (external $refs in, internal kept) + validate; spec/semantic.ts adds
                       path-param and operationId checks (swagger-parser skips them for OAS3). `files` lists the local
                       files of the spec (for watch); `revision` reads them all from git via spec/git.ts. Swagger 2.0
                       is validated as 2.0, then converted by spec/swagger2.ts (`convertedFrom: '2.0'`)
  spec/swagger2.ts     Swagger 2.0 → OpenAPI 3.0 document: body/formData → requestBody, consumes/produces → media
                       types, collectionFormat → style/explode, host/basePath → servers, securityDefinitions, x-nullable
  ir/model.ts          IR types: ApiModel, Operation, Webhook, Parameter, SchemaNode (ref|scalar|array|object|union|intersection|unknown)
  ir/build.ts          OpenAPI → IR. Handles 3.0/3.1 (nullable, type arrays, const, `{type:null}` variants → nullable,
                       redundant `type` next to oneOf/anyOf dropped), $ref chains, param merging, security inheritance,
                       webhooks. Component schema refs stay `{kind:'ref', target: key}`; others are inlined.
  ir/refs.ts           refsOf / reachability / mapRefs over SchemaNode (shared by ignore and diff)
  ir/ignore.ts         applyIgnore(model, config.ignore): drops ops/schemas, ignored refs → unknown, warns on unmatched
  config/schema.ts     zod schema for .steadysdkrc.yml (strict objects; use .prefault({}) for nested defaults in Zod 4)
  config/load.ts       upward config search; config paths relative to config file, CLI flag paths relative to cwd
  naming/case.ts       splitWords / applyCase / acronyms
  naming/engine.ts     NamingEngine: stateless desired names (operationId or path templates, overrides, groups, params)
  naming/assign.ts     assignNames: uniqueness per scope + lock. Locked names claimed first; config hash change → re-derive
  naming/lock.ts       .steadysdk/names.lock.json (identity → name; identities like `operation:GET /pets#params`)
  generators/typescript/  index.ts (files, header, regions, runtime export contract), operations.ts (methods, media
                       selection), types.ts (SchemaNode → TS), code.ts (writer), templates.ts (built-in/override
                       runtime, eject + fingerprint)
  output/manifest.ts   .steadysdk/manifest.json: sha256 of every generated file
  output/regions.ts    parse/strip/merge `// <steadysdk:custom name>` … `// </steadysdk:custom>` regions
  output/plan.ts       planOutput (create/update/delete/unchanged/keep + conflicts incl. region-removed /
                       regions-invalid; region code merged into new content) and applyPlan; describeConflict
  diff/schema.ts       SchemaComparer: structural, direction-aware (request/response/both) schema diff; same-target refs
                       stop (component changes are reported on the component), differing refs are expanded and
                       compared (shape-preserving renames/extractions → `reference-changed`); allOf flattening; schemaUsage
  diff/diff.ts         diffModels(from, to): ops matched by key, then by path shape (path-param renames); params, bodies,
                       responses, media types, security (collapsed to one `api` change when every op changed alike),
                       component schemas (direction from usage in both versions), security schemes, default server
  diff/render.ts       renderChangelog (Markdown), serializeDiff (JSON), diffTitle, changeSubject
  diff/baseline.ts     loadSpecSnapshot(outputDir): `.steadysdk/spec.json`, loaded without validation
  diff/version.ts      checkVersionBump: breaking → new major info.version (new minor in 0.x; non-semver must change)
  generate.ts          orchestrator: load → model → ignore → baseline diff (ignore applied too) → lock → runtime
                       template → generate → plan → (refuse on conflicts unless force) → write
packages/core/templates/typescript/runtime.ts   copied verbatim into generated/runtime.ts (type-checked by tsconfig.tests.json)
packages/cli/src       commander program (cli.ts `run(argv, io)` is in-process testable; `io.signal` stops watch),
                       commands/ (init, generate, watch, diff + changelog share `compareSpecs`, eject), watcher.ts
                       (directory-based FileWatcher), changes.ts (terminal change list), ui.ts
action.yml             composite GitHub Action: Node check/setup, builds the CLI from its checkout (until npm),
                       runs scripts/github-action.sh (inputs via env, never interpolated into the script)
scripts/real-world.mjs pinned public specs → generate → strict tsc; prints a Markdown table (weekly workflow too)
```

Output layout: `<out>/generated/**` (steadysdk-owned, manifest-tracked), `<out>/index.ts` + `<out>/client.ts`
(scaffolded once, user-owned), `<out>/.steadysdk/{manifest,names.lock,spec}.json` (commit them).

## Rules

- Generated output must be deterministic: no timestamps, stable ordering. Version strings only where meaningful.
- Generated TS must compile under the strictest flags (see `typecheck()` in packages/core/test/generate.test.ts):
  `import type` for types, no parameter properties/enums (erasableSyntaxOnly), explicit types (isolatedDeclarations),
  never emit an unused import.
- Never delete or overwrite a file steadysdk did not write: only manifest-listed files whose hash matches are touched;
  anything else is a conflict (`OUTPUT_CONFLICT`) unless `--force`. Manifest hashes are of the content with custom
  region bodies stripped (generators emit regions empty, so that equals the generated content); region code must
  never be dropped silently: orphaned regions or broken markers are conflicts, stale files with region code are kept.
- Custom region names are a compatibility surface (users' code is keyed by them): don't rename or remove them.
- The built-in runtime template has no header line; the generator prepends `templates.header` + the notice to every
  generated file. Changing the runtime changes its fingerprint, so ejected copies get a TEMPLATE_OUTDATED warning.
- User-facing failures are `SteadySdkError` (code + message + details + hint). Anything else is a bug and the CLI says so.
- New exported names in runtime.ts are reserved automatically (scanned); names generated in client.ts must be
  added to `RESERVED_TYPE_NAMES`.
- Breaking = a client built for the old spec, or code written against the old SDK, can fail with the new one.
  Request side may only loosen, response side may only tighten, removals break both. Schema rules declare the
  direction they break in (`Breaks`), never a hard-coded boolean, so components get the right verdict from usage.
- The diff JSON (`ApiDiff`, `DIFF_FORMAT_VERSION`) is a public format: add fields, never rename/remove; new keys
  must also go into `CHANGE_KEYS` (fixed key order). Messages are one sentence, subject-free, Markdown inline code.
- Documentation-only edits (summary, description, examples) never produce changes.
- scripts/github-action.sh must run on bash 3.2 (macOS, where its tests run): guard empty arrays with
  `${arr[@]+"${arr[@]}"}`. CLI output parsed by the script is produced with `--no-color` (GitHub sets CI=true).
- packages/cli/test/github-action.test.ts runs `tsc -b` first, because the script runs the built CLI.
- Grouping `auto` (default) = tag when any operation has tags, else first path segment (see naming/assign.ts).
- Webhook keys (`WebhookPayloads` property names) are a compatibility surface like region names.
- Releasing: bump `version` in both packages (and the CLI's `@steadysdk/core` dependency), add a CHANGELOG.md section,
  commit, tag `vX.Y.Z` (the Action is pinned by tag), push with tags, then `npm publish -w packages/core` before
  `npm publish -w packages/cli` (the CLI depends on core). `prepack` rebuilds dist/ from scratch. Don't put `# comments`
  after commands you hand to the user: zsh passes them through as arguments.
- Tool quirk: typing ` `-style escapes through the Write tool turns them into raw characters; write them via
  a script (e.g. python with `chr(92)`) and grep for U+2028/2029 afterwards.
