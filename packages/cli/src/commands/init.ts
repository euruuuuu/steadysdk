import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig, SdkgenError } from '@sdkgen/core';
import { parse as parseYaml } from 'yaml';
import type { Ui } from '../ui.js';

export interface InitCommandOptions {
  input?: string;
  output?: string;
  force?: boolean;
}

export const CONFIG_FILE = '.sdkgenrc.yml';

const SPEC_CANDIDATES = /^(openapi|swagger|api|spec)([.-][\w.-]+)?\.(ya?ml|json)$/i;

export async function initCommand(ui: Ui, options: InitCommandOptions): Promise<number> {
  const target = path.join(ui.io.cwd, CONFIG_FILE);
  if (!options.force && (await stat(target).catch(() => undefined))) {
    throw new SdkgenError('CONFIG_EXISTS', `${CONFIG_FILE} already exists`, { hint: 'Pass --force to overwrite it.' });
  }

  const input = options.input ?? (await detectSpec(ui.io.cwd));
  const output = options.output ?? './sdk';
  const content = configTemplate(input ?? './openapi.yaml', output);
  parseConfig(parseYaml(content), 'init template'); // never write a config sdkgen itself would reject

  await writeFile(target, content, 'utf8');
  ui.success(`Created ${ui.c.bold(CONFIG_FILE)}`);
  if (input === undefined) {
    ui.warn('No OpenAPI file found here; set `input` in the config to your spec.');
  } else if (options.input === undefined) {
    ui.info(`Detected spec ${ui.c.bold(input)}`);
  }
  ui.line();
  ui.line('Next steps:');
  ui.line(`  1. Review naming rules in ${CONFIG_FILE}`);
  ui.line(`  2. Run ${ui.c.cyan('sdkgen generate')}`);
  return 0;
}

async function detectSpec(cwd: string): Promise<string | undefined> {
  const entries = await readdir(cwd).catch(() => [] as string[]);
  const match = entries.filter((entry) => SPEC_CANDIDATES.test(entry)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
  return match === undefined ? undefined : `./${match}`;
}

function rank(file: string): number {
  return file.toLowerCase().startsWith('openapi') ? 0 : 1;
}

function configTemplate(input: string, output: string): string {
  return `# sdkgen configuration. Paths are relative to this file.
# Every option is documented in .sdkgenrc.example.yml in the sdkgen repository.

# OpenAPI 3.0 / 3.1 document: YAML or JSON, file path or URL.
input: ${yamlString(input)}

# Where the SDK goes. sdkgen owns <output>/generated/ and .sdkgen/; everything else there is yours.
output: ${yamlString(output)}

client:
  # name: MyApiClient     # root client class; defaults to the spec title + "Client"
  groupBy: tag            # tag | path | none  ->  client.pets.listPets() vs client.listPets()
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
  # Keep names stable across regenerations (.sdkgen/names.lock.json).
  lock: true
  overrides:
    operations: {}        # "GET /users/{id}": fetchUser   or   listPets: getAllPets
    schemas: {}           # UserDTO: User
`;
}

function yamlString(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : JSON.stringify(value);
}
