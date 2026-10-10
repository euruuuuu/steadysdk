import path from 'node:path';
import { Argument, Command, CommanderError } from 'commander';
import { STEADYSDK_VERSION, TEMPLATE_NAMES } from '@steadysdk/core';
import { changelogCommand, type ChangelogCommandOptions } from './commands/changelog.js';
import { diffCommand, type DiffCommandOptions } from './commands/diff.js';
import { ejectCommand, type EjectCommandOptions } from './commands/eject.js';
import { generateCommand, type GenerateCommandOptions } from './commands/generate.js';
import { initCommand, type InitCommandOptions } from './commands/init.js';
import { defaultIo, Ui, type Io } from './ui.js';

interface GlobalOptions {
  cwd?: string;
  color?: boolean;
}

/** Runs the CLI in-process and resolves to the exit code. */
export async function run(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  let exitCode = 0;
  const program = new Command('steadysdk')
    .description('Generate and maintain typed API client SDKs from OpenAPI specs')
    .version(STEADYSDK_VERSION, '-v, --version')
    .option('-C, --cwd <dir>', 'run as if started in <dir>')
    .option('--no-color', 'disable colored output')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const uiFor = (command: Command): Ui => {
    const globals = command.optsWithGlobals<GlobalOptions>();
    const cwd = globals.cwd === undefined ? io.cwd : path.resolve(io.cwd, globals.cwd);
    return new Ui({ ...io, cwd, color: io.color && globals.color !== false });
  };
  // Commander calls actions with the positional arguments, then the options, then the command.
  const action =
    <T>(handler: (ui: Ui, options: T, args: Array<string | undefined>) => Promise<number>) =>
    async (...received: unknown[]): Promise<void> => {
      const command = received.at(-1) as Command;
      const ui = uiFor(command);
      try {
        exitCode = await handler(ui, received.at(-2) as T, command.processedArgs as Array<string | undefined>);
      } catch (error) {
        ui.error(error);
        exitCode = 1;
      }
    };

  program
    .command('init')
    .description('create a .steadysdkrc.yml config in the current directory')
    .option('-i, --input <spec>', 'path or URL of the OpenAPI document (detected when omitted)')
    .option('-o, --output <dir>', 'output directory for the SDK', './sdk')
    .option('-f, --force', 'overwrite an existing config')
    .action(action<InitCommandOptions>(initCommand));

  program
    .command('generate')
    .alias('gen')
    .description('generate the SDK, keeping your own files and existing names intact')
    .option('-c, --config <file>', 'config file (default: nearest .steadysdkrc.yml)')
    .option('-i, --input <spec>', 'OpenAPI document, overriding the config')
    .option('-o, --output <dir>', 'output directory, overriding the config')
    .option('--no-validate', 'skip OpenAPI validation')
    .option('--dry-run', 'show what would change without writing')
    .option('--check', 'exit 1 if the SDK on disk is out of date (for CI)')
    .option('--relock', 'ignore the name lock and re-derive names from the rules')
    .option('-f, --force', 'overwrite generated files even if they were edited by hand')
    .option('--verbose', 'show notes and unchanged files')
    .action(action<GenerateCommandOptions>(generateCommand));

  const specArguments = (command: Command): Command =>
    command
      .argument('[old]', 'spec to compare from (default: the spec the SDK was last generated from)')
      .argument('[new]', 'spec to compare to (default: the configured input)')
      .option('-c, --config <file>', 'config file (default: nearest .steadysdkrc.yml)')
      .option('-i, --input <spec>', 'use this spec instead of the configured input as [new]')
      .option('--no-validate', 'skip OpenAPI validation')
      .option('--json', 'print the changes as JSON');

  specArguments(program.command('diff'))
    .description('list API changes, marking breaking ones (default: since the last generation)')
    .option('--fail-on-breaking', 'exit 1 if any change is breaking (for CI)')
    .action(action<DiffCommandOptions>(diffCommand));

  specArguments(program.command('changelog'))
    .description('write the API changes as a Markdown changelog entry')
    .option('--out <file>', 'write to a file instead of stdout')
    .action(action<ChangelogCommandOptions>(changelogCommand));

  program
    .command('eject')
    .description('copy a built-in template into your project to customize it')
    .addArgument(new Argument('<template>', 'template to copy').choices(TEMPLATE_NAMES))
    .option('-c, --config <file>', 'config file (default: nearest .steadysdkrc.yml)')
    .option('--out <file>', 'where to write it (default: templates.<template> from the config, or ./steadysdk/<template>.ts)')
    .option('--stdout', 'print it instead, e.g. to compare with your copy')
    .option('-f, --force', 'replace an existing file')
    .action(action<EjectCommandOptions>(ejectCommand));

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version also arrive here, with exit code 0.
      return error.exitCode;
    }
    throw error;
  }
  return exitCode;
}
