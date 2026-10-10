#!/usr/bin/env node
// Generates SDKs for large public API specs and type-checks them under the strictest compiler settings.
// Specs are pinned to commits, so results only change when apisteady does. Run after `npm run build`:
//
//   node scripts/real-world.mjs [name...]        (all specs when no names are given)
//
// Downloads are cached in .cache/real-world/. Exits 1 if any spec fails to generate or type-check.
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'packages/cli/dist/index.js');
const TSC = path.join(ROOT, 'node_modules/.bin/tsc');
const CACHE = path.join(ROOT, '.cache/real-world');

const raw = (repo, sha, file) => `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
const SPECS = [
  { name: 'GitHub (OpenAPI 3.0)', id: 'github', url: raw('github/rest-api-description', '355db395991cb7e421fae2cc720189ad86558cbe', 'descriptions/api.github.com/api.github.com.json') },
  { name: 'GitHub (OpenAPI 3.1)', id: 'github-3.1', url: raw('github/rest-api-description', 'd17591440ab6ec876a8d94ad85d685d03267f42f', 'descriptions-next/api.github.com/api.github.com.json') },
  { name: 'Stripe', id: 'stripe', url: raw('stripe/openapi', 'bcfd59f49dcac84a84d63d304c62793dff6e5916', 'openapi/spec3.json') },
  { name: 'OpenAI', id: 'openai', url: raw('openai/openai-openapi', 'e95c0fe615f45a19e8878af923a729948445a6bd', 'openapi.yaml') },
  { name: 'Twilio', id: 'twilio', url: raw('twilio/twilio-oai', '157fb094bd08957183278242d7622c8560b7a4c4', 'spec/json/twilio_api_v2010.json') },
  { name: 'Kubernetes (Swagger 2.0)', id: 'kubernetes', url: raw('kubernetes/kubernetes', 'a82cbf7896e0895ccd1dd059bf48fb0491aa2456', 'api/openapi-spec/swagger.json') },
];

const STRICT = {
  target: 'es2022', lib: ['es2022', 'dom'], module: 'nodenext', types: [], strict: true, noEmit: true,
  noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true, noUnusedParameters: true,
  noImplicitReturns: true, noImplicitOverride: true, noPropertyAccessFromIndexSignature: true,
  verbatimModuleSyntax: true, erasableSyntaxOnly: true, isolatedDeclarations: true, declaration: true,
};

async function download(spec) {
  const file = path.join(CACHE, spec.id, `openapi${path.extname(new URL(spec.url).pathname)}`);
  if (await stat(file).catch(() => undefined)) return file;
  const response = await fetch(spec.url);
  if (!response.ok) throw new Error(`${spec.url}: HTTP ${response.status}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

async function check(spec) {
  const file = await download(spec);
  const dir = path.dirname(file);
  const out = path.join(dir, 'sdk');
  await rm(out, { recursive: true, force: true });

  let started = performance.now();
  const generated = await run('node', [CLI, 'generate', '--no-color', '-i', file, '-o', out], { cwd: dir, maxBuffer: 1 << 28 }).catch((error) => error);
  const generateMs = Math.round(performance.now() - started);
  if (generated instanceof Error) return { spec, ok: false, problem: `generate failed:\n${generated.stderr ?? generated.message}` };
  const loaded = /Loaded .*?: (\d+) operations?, (\d+) schemas?/.exec(generated.stdout);

  await writeFile(path.join(out, 'package.json'), '{ "type": "module" }\n');
  await writeFile(path.join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions: STRICT, include: ['**/*.ts'] }));
  started = performance.now();
  const checked = await run(TSC, ['-p', out], { maxBuffer: 1 << 28 }).catch((error) => error);
  const tscMs = Math.round(performance.now() - started);
  const errors = checked instanceof Error ? (checked.stdout ?? '').split('\n').filter((line) => /error TS\d+/.test(line)) : [];
  return {
    spec,
    ok: errors.length === 0,
    operations: Number(loaded?.[1] ?? 0),
    schemas: Number(loaded?.[2] ?? 0),
    generateMs,
    tscMs,
    problem: errors.length > 0 ? `${errors.length} type errors:\n${errors.slice(0, 10).join('\n')}` : undefined,
  };
}

const wanted = process.argv.slice(2);
const specs = wanted.length > 0 ? SPECS.filter((spec) => wanted.includes(spec.id)) : SPECS;
const results = [];
for (const spec of specs) {
  process.stderr.write(`${spec.name}... `);
  const result = await check(spec);
  process.stderr.write(result.ok ? 'ok\n' : 'FAILED\n');
  results.push(result);
}

console.log('| API | Operations | Schemas | Generate | Type-check (strict) |');
console.log('| --- | ---: | ---: | ---: | --- |');
for (const result of results) {
  const status = result.ok ? `✅ 0 errors` : '❌';
  console.log(`| ${result.spec.name} | ${result.operations ?? '-'} | ${result.schemas ?? '-'} | ${result.generateMs ?? '-'} ms | ${status} |`);
}
for (const result of results) if (result.problem) console.error(`\n${result.spec.name}: ${result.problem}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
