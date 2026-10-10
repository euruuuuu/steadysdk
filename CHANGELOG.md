# Changelog

All notable changes to steadysdk. Versions follow [semver](https://semver.org); before 1.0, minor versions
may contain breaking changes.

## 0.1.0

First release.

**Generation**

- Typed, dependency-free TypeScript clients from OpenAPI 3.0, OpenAPI 3.1 and Swagger 2.0, from local files,
  URLs or git revisions, including multi-file specs.
- One class per tag (or per path segment when the spec has no tags), helper types for parameters, request
  bodies and responses, and a `fetch` runtime covering auth, parameter serialization, errors, timeouts and hooks.
- Types for webhook payloads (OpenAPI 3.1 `webhooks`).
- Output that compiles under the strictest TypeScript settings and is deterministic, so regenerating gives clean diffs.

**Maintenance**

- Safe regeneration: files you own are never touched, hand edits to generated files are detected, and code in
  `// <steadysdk:custom>` regions is carried over.
- A name lock keeps method and type names stable when the spec changes.
- Configurable naming (cases, acronyms, path templates, overrides), ignore lists, a file header, and your own
  HTTP runtime (`steadysdk eject runtime`).

**API changes**

- `steadysdk diff` and `steadysdk changelog`: every change between two versions of a spec as text, Markdown or
  JSON, with breaking changes marked by whether the data is sent or received.
- `--base <git-rev>` and `<rev>:<path>` compare against any git revision without a second checkout.
- `--require-bump` fails on breaking changes without a new major `info.version`; `--fail-on-breaking` on any.

**Workflow**

- `steadysdk init` finds your spec and writes a documented config.
- `steadysdk watch` regenerates on every save.
- `steadysdk generate --check`, and a GitHub Action that checks the SDK and gates breaking changes on pull requests.

Tested against the GitHub, Stripe, OpenAI, Twilio and Kubernetes specs (`npm run test:real-world`).
