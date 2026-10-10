# sdkgen — OpenAPI SDK generator & maintainer

TypeScript CLI that generates typed API clients from OpenAPI 3.0/3.1 and keeps them maintainable across
regenerations: user code is never overwritten, names stay stable (name lock), and API changes are reported
as a changelog with breaking-change detection. Portfolio project; README.md is the public face.

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
| B | Drift/changelog: IR-level diff (ops, params, bodies, responses, schemas, enums, required flags, security, servers), direction-aware breaking classification, Markdown + versioned JSON, `sdkgen diff` (`--json --fail-on-breaking -i`) / `sdkgen changelog` (`--out`), changes listed by `generate` (and `--check`), petstore `next/` changelog example | ✅ Done 2026-10-10 |
| C | Custom regions (`// <sdkgen:custom name>`) in generated files (API imports/members, models declarations) merged on regeneration; `ignore` (operations/paths/tags/schemas/unusedSchemas, unmatched-entry warnings); `templates.runtime` override + `sdkgen eject runtime` (export contract check, fingerprint outdated warning), `templates.header`; Petstore example carries a region helper | ✅ Done 2026-10-10 |
| D | `sdkgen watch`, CI gating (fail on breaking changes without a version bump), GitHub Action example | Next |
| E | VS Code extension reusing core (commands, out-of-sync status bar, CodeLens), npm publish prep, README polish/GIF | Planned |

## Commands

```bash
npm run build        # tsc -b  → packages/*/dist
npm test             # vitest (runs against src via alias; no build needed)
npm run typecheck    # tsc -b + tsconfig.tests.json (tests + runtime template)
npm run examples     # build, then regenerate examples/petstore/sdk and examples/petstore/next/CHANGELOG.md
node packages/cli/dist/index.js generate -C examples/petstore --verbose
node packages/cli/dist/index.js diff -C examples/petstore -i next/openapi.yaml
```

## Architecture

npm workspaces, ESM only, Node ≥ 22.19 (swagger-parser 13 requires it).

```
packages/core/src
  spec/load.ts         swagger-parser bundle (external $refs in, internal kept) + validate; spec/semantic.ts adds
                       path-param and operationId checks (swagger-parser skips them for OAS3)
  ir/model.ts          IR types: ApiModel, Operation, Parameter, SchemaNode (ref|scalar|array|object|union|intersection|unknown)
  ir/build.ts          OpenAPI → IR. Handles 3.0/3.1 (nullable, type arrays, const), $ref chains, param merging,
                       security inheritance. Component schema refs stay `{kind:'ref', target: key}`; others are inlined.
  ir/refs.ts           refsOf / reachability / mapRefs over SchemaNode (shared by ignore and diff)
  ir/ignore.ts         applyIgnore(model, config.ignore): drops ops/schemas, ignored refs → unknown, warns on unmatched
  config/schema.ts     zod schema for .sdkgenrc.yml (strict objects; use .prefault({}) for nested defaults in Zod 4)
  config/load.ts       upward config search; config paths relative to config file, CLI flag paths relative to cwd
  naming/case.ts       splitWords / applyCase / acronyms
  naming/engine.ts     NamingEngine: stateless desired names (operationId or path templates, overrides, groups, params)
  naming/assign.ts     assignNames: uniqueness per scope + lock. Locked names claimed first; config hash change → re-derive
  naming/lock.ts       .sdkgen/names.lock.json (identity → name; identities like `operation:GET /pets#params`)
  generators/typescript/  index.ts (files, header, regions, runtime export contract), operations.ts (methods, media
                       selection), types.ts (SchemaNode → TS), code.ts (writer), templates.ts (built-in/override
                       runtime, eject + fingerprint)
  output/manifest.ts   .sdkgen/manifest.json: sha256 of every generated file
  output/regions.ts    parse/strip/merge `// <sdkgen:custom name>` … `// </sdkgen:custom>` regions
  output/plan.ts       planOutput (create/update/delete/unchanged/keep + conflicts incl. region-removed /
                       regions-invalid; region code merged into new content) and applyPlan; describeConflict
  diff/schema.ts       SchemaComparer: structural, direction-aware (request/response/both) schema diff; same-target refs
                       stop (component changes are reported on the component), differing refs are expanded and
                       compared (shape-preserving renames/extractions → `reference-changed`); allOf flattening; schemaUsage
  diff/diff.ts         diffModels(from, to): ops matched by key, then by path shape (path-param renames); params, bodies,
                       responses, media types, security (collapsed to one `api` change when every op changed alike),
                       component schemas (direction from usage in both versions), security schemes, default server
  diff/render.ts       renderChangelog (Markdown), serializeDiff (JSON), diffTitle, changeSubject
  diff/baseline.ts     loadSpecSnapshot(outputDir): `.sdkgen/spec.json`, loaded without validation
  generate.ts          orchestrator: load → model → ignore → baseline diff (ignore applied too) → lock → runtime
                       template → generate → plan → (refuse on conflicts unless force) → write
packages/core/templates/typescript/runtime.ts   copied verbatim into generated/runtime.ts (type-checked by tsconfig.tests.json)
packages/cli/src       commander program (cli.ts `run(argv, io)` is in-process testable), commands/ (init, generate,
                       diff + changelog share `compareSpecs`, eject), changes.ts (terminal change list), ui.ts
```

Output layout: `<out>/generated/**` (sdkgen-owned, manifest-tracked), `<out>/index.ts` + `<out>/client.ts`
(scaffolded once, user-owned), `<out>/.sdkgen/{manifest,names.lock,spec}.json` (commit them).

## Rules

- Generated output must be deterministic: no timestamps, stable ordering. Version strings only where meaningful.
- Generated TS must compile under the strictest flags (see `typecheck()` in packages/core/test/generate.test.ts):
  `import type` for types, no parameter properties/enums (erasableSyntaxOnly), explicit types (isolatedDeclarations),
  never emit an unused import.
- Never delete or overwrite a file sdkgen did not write: only manifest-listed files whose hash matches are touched;
  anything else is a conflict (`OUTPUT_CONFLICT`) unless `--force`. Manifest hashes are of the content with custom
  region bodies stripped (generators emit regions empty, so that equals the generated content); region code must
  never be dropped silently: orphaned regions or broken markers are conflicts, stale files with region code are kept.
- Custom region names are a compatibility surface (users' code is keyed by them): don't rename or remove them.
- The built-in runtime template has no header line; the generator prepends `templates.header` + the notice to every
  generated file. Changing the runtime changes its fingerprint, so ejected copies get a TEMPLATE_OUTDATED warning.
- User-facing failures are `SdkgenError` (code + message + details + hint). Anything else is a bug and the CLI says so.
- New exported names in runtime.ts are reserved automatically (scanned); names generated in client.ts must be
  added to `RESERVED_TYPE_NAMES`.
- Breaking = a client built for the old spec, or code written against the old SDK, can fail with the new one.
  Request side may only loosen, response side may only tighten, removals break both. Schema rules declare the
  direction they break in (`Breaks`), never a hard-coded boolean, so components get the right verdict from usage.
- The diff JSON (`ApiDiff`, `DIFF_FORMAT_VERSION`) is a public format: add fields, never rename/remove; new keys
  must also go into `CHANGE_KEYS` (fixed key order). Messages are one sentence, subject-free, Markdown inline code.
- Documentation-only edits (summary, description, examples) never produce changes.
- Tool quirk: typing ` `-style escapes through the Write tool turns them into raw characters; write them via
  a script (e.g. python with `chr(92)`) and grep for U+2028/2029 afterwards.
