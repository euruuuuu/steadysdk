import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildModel, loadSpec, parseConfig, SteadySdkError } from '@steadysdk/core';
import { parse as parseYaml } from 'yaml';
import type { Ui } from '../ui.js';

export interface InitCommandOptions {
  input?: string;
  output?: string;
  force?: boolean;
}

export const CONFIG_FILE = '.steadysdkrc.yml';
/** The npm package of this CLI (its command is `steadysdk`). */
const PACKAGE_NAME = '@steadysdk/cli';

const SPEC_CANDIDATES = /^(openapi|swagger|api|spec)([.-][\w.-]+)?\.(ya?ml|json)$/i;
/** Where specs usually live, besides the project root. */
const SPEC_DIRECTORIES = ['api', 'apis', 'spec', 'specs', 'openapi', 'docs', 'schema'];
const EXAMPLE_CONFIG = 'https://github.com/euruuuuu/steadysdk/blob/main/.steadysdkrc.example.yml';

export async function initCommand(ui: Ui, options: InitCommandOptions): Promise<number> {
  const target = path.join(ui.io.cwd, CONFIG_FILE);
  if (!options.force && (await stat(target).catch(() => undefined))) {
    throw new SteadySdkError('CONFIG_EXISTS', `${CONFIG_FILE} already exists`, { hint: 'Pass --force to overwrite it.' });
  }

  const candidates = options.input === undefined ? await detectSpecs(ui.io.cwd) : [];
  const input = options.input ?? candidates[0];
  const output = options.output ?? './sdk';
  const content = configTemplate(input ?? './openapi.yaml', output);
  parseConfig(parseYaml(content), 'init template'); // never write a config steadysdk itself would reject

  await writeFile(target, content, 'utf8');
  ui.success(`Created ${ui.c.bold(CONFIG_FILE)}`);
  if (input === undefined) {
    ui.warn('No OpenAPI file found here; set `input` in the config to your spec.');
  } else {
    const what = await describeSpec(ui, input);
    if (options.input === undefined) ui.info(`Detected spec ${ui.c.bold(input)}${what ? ` ${ui.c.dim(`(${what})`)}` : ''}`);
    else if (what) ui.info(`Spec ${ui.c.bold(input)} ${ui.c.dim(`(${what})`)}`);
    if (candidates.length > 1) ui.line(ui.c.dim(`  Also found: ${candidates.slice(1).join(', ')}. Change \`input\` to use one of those.`));
  }

  // When run through npx, suggest commands that work the same way, and installing first when it isn't yet
  // (`npx @steadysdk/cli init` runs a temporary copy; `npx steadysdk` needs the package in the project).
  const viaNpx = process.env['npm_command'] === 'exec';
  const cli = viaNpx ? 'npx steadysdk' : 'steadysdk';
  const installed = await stat(path.join(ui.io.cwd, 'node_modules', PACKAGE_NAME, 'package.json')).catch(() => undefined);
  const steps = [
    ...(viaNpx && !installed ? [`Add it to the project:      ${ui.c.cyan(`npm install --save-dev ${PACKAGE_NAME}`)}`] : []),
    `Review ${CONFIG_FILE}: naming rules, grouping, parts of the API to leave out\n     ${ui.c.dim(`Every option: ${EXAMPLE_CONFIG}`)}`,
    `Generate the SDK:           ${ui.c.cyan(`${cli} generate`)}`,
    `Commit ${output.replace(/^\.\//, '')}/, including its .steadysdk/ folder (it keeps names stable)`,
    `Keep it in sync in CI:      ${ui.c.cyan(`${cli} generate --check`)}`,
  ];
  ui.line();
  ui.line('Next steps:');
  steps.forEach((step, index) => ui.line(`  ${index + 1}. ${step}`));
  ui.line();
  ui.line(ui.c.dim(`While you edit the spec, ${cli} watch regenerates on every save.`));
  return 0;
}

/** Spec files in the project root, then in the usual spec directories; `openapi.*` first. */
async function detectSpecs(cwd: string): Promise<string[]> {
  const found: string[] = [];
  for (const directory of ['', ...SPEC_DIRECTORIES]) {
    const entries = await readdir(path.join(cwd, directory)).catch(() => [] as string[]);
    const matches = entries.filter((entry) => SPEC_CANDIDATES.test(entry)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    found.push(...matches.map((entry) => `./${directory === '' ? entry : `${directory}/${entry}`}`));
  }
  return found;
}

function rank(file: string): number {
  return file.toLowerCase().startsWith('openapi') ? 0 : 1;
}

/** `Petstore 1.0.0, OpenAPI 3.0.3, 11 operations`, or a warning when the file cannot be read. */
async function describeSpec(ui: Ui, input: string): Promise<string | undefined> {
  try {
    const spec = await loadSpec(input, { cwd: ui.io.cwd, validate: false });
    const model = buildModel(spec.document);
    const format = spec.convertedFrom ? `Swagger ${spec.convertedFrom}` : `OpenAPI ${spec.openapiVersion}`;
    const count = model.operations.length;
    return `${model.title} ${model.version}, ${format}, ${count} operation${count === 1 ? '' : 's'}`;
  } catch (error) {
    ui.warn(`Could not read ${input} as an OpenAPI spec yet: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function configTemplate(input: string, output: string): string {
  return `# steadysdk configuration. Paths are relative to this file.
# Every option is documented in .steadysdkrc.example.yml in the steadysdk repository.

# OpenAPI 3.0 / 3.1 document: YAML or JSON, file path or URL.
input: ${yamlString(input)}

# Where the SDK goes. steadysdk owns <output>/generated/ and .steadysdk/; everything else there is yours.
output: ${yamlString(output)}

client:
  # name: MyApiClient     # root client class; defaults to the spec title + "Client"
  groupBy: auto           # auto | tag | path | none  (auto: by tag if the spec uses tags, else by path)
  # baseUrl: https://api.example.com

naming:
  # Words kept in a fixed form, e.g. [ID, API, URL] turns userId into userID.
  acronyms: []
  operations:
    case: camel           # camel | pascal | snake | constant | preserve
    source: operationId   # operationId (fall back to path) | path
    # stripPrefixes: ['^\\w+Controller_']   # NestJS-style operationIds
  types:
    case: pascal
    # suffix: Dto
  parameters:
    case: camel
  # Keep names stable across regenerations (.steadysdk/names.lock.json).
  lock: true
  overrides:
    operations: {}        # "GET /users/{id}": fetchUser   or   listPets: getAllPets
    schemas: {}           # UserDTO: User
`;
}

function yamlString(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : JSON.stringify(value);
}
