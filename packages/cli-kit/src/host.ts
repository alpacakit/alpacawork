/** One Commander adapter over channels registration views. No command-specific dispatch. */
import {
  CLI_ARG_KIND,
  CLI_OPTION_KIND,
  CLI_OPTION_VALUE_MODE,
  collectCliCommands,
  type CliParameterView,
  type CliRegistrationCollection,
} from '@alpacakit/channels/cli';
import { EntryInputError, PARAMETER_REQUIREMENT_KIND, type ParameterSet, type RawValueMap } from '@alpacakit/channels';
import { Command, CommanderError, Option } from 'commander';
import { ZodError } from 'zod';
import { CLI_EXIT_CODE, CLI_STREAM, failureExitCode, type CliPolicy } from './policy.js';
import { errorBody, failure, PROBLEM_CODE, Problem } from '@alpacawork/core';

/** What `collectCliCommands` accepts, and the context and output it reports for a tree. */
type TreeSource = Parameters<typeof collectCliCommands>[0];
type Commands<Source extends TreeSource> = ReturnType<typeof collectCliCommands<Source>>;
type ContextOfTree<Source extends TreeSource> =
  Commands<Source>['root']['commands'] extends CliRegistrationCollection<infer Context, infer _Output>
    ? Context
    : never;
type OutputOfTree<Source extends TreeSource> =
  Commands<Source>['root']['commands'] extends CliRegistrationCollection<infer _Context, infer Output>
    ? Output
    : never;

interface CliSetup<Tree extends TreeSource, WorkspaceTree extends TreeSource> {
  /** The command tree this process exposes. */
  readonly tree: Tree;
  /** A second tree holding only the common options of the root. */
  readonly workspaceTree: WorkspaceTree;
  readonly defaultPolicy: CliPolicy;
  readonly policyFor: (handler: object) => CliPolicy;
  /**
   * The capabilities this application lends its handlers. It is a function
   * because `serve` publishes through the same stream policy the host owns.
   */
  readonly runtime: (publish: (value: unknown) => void) => ContextOfTree<Tree>;
}

const commandHelp = new WeakMap<object, () => readonly string[]>();
const commandOutput = new WeakMap<object, (value: unknown) => string | null>();
/** A local interactive command can render its result while retaining the host's normal error and exit handling. */
export function withCliOutput<Endpoint extends { readonly handler: object }>(endpoint: Endpoint, render: (value: unknown) => string | null): Endpoint {
  commandOutput.set(endpoint.handler, render); return endpoint;
}
/** Keep conditional help beside the rule used by the entry or service. */
export function withCliHelp<Endpoint extends { readonly handler: object }>(
  endpoint: Endpoint, help: () => readonly string[],
): Endpoint {
  commandHelp.set(endpoint.handler, help);
  return endpoint;
}

type Requirement = ParameterSet[number]['requirement'];
const requirementSuffixes: {
  [Kind in Requirement['kind']]: (requirement: Extract<Requirement, { kind: Kind }>) => string;
} = {
  [PARAMETER_REQUIREMENT_KIND.required]: () => ' (required)',
  [PARAMETER_REQUIREMENT_KIND.optional]: () => '',
  [PARAMETER_REQUIREMENT_KIND.optionalWithDefault]: (requirement) =>
    ` (default: ${JSON.stringify(requirement.defaultValue)})`,
};

function requirementSuffix<Kind extends Requirement['kind']>(
  requirement: Extract<Requirement, { kind: Kind }>,
): string {
  return requirementSuffixes[requirement.kind](requirement);
}

function registerOptions(
  command: Command,
  parameters: readonly CliParameterView[],
): () => RawValueMap {
  const positions = parameters.filter(parameter => parameter.kind === CLI_ARG_KIND.positional);
  for (const parameter of positions) {
    const name = parameter.valueName + (parameter.variadic ? '...' : '');
    command.argument(parameter.requirement.kind === PARAMETER_REQUIREMENT_KIND.required ? `<${name}>` : `[${name}]`, parameter.description);
  }
  const mappings = parameters.filter(parameter => parameter.kind === CLI_ARG_KIND.option).map((parameter) => {
    if (parameter.kind === CLI_ARG_KIND.option && parameter.optionKind === CLI_OPTION_KIND.booleanFlag) {
      const option = new Option(parameter.flags.join(', '), parameter.description + requirementSuffix(parameter.requirement));
      command.addOption(option);
      return { name: parameter.parameterName, attribute: option.attributeName() };
    }
    if (parameter.kind !== CLI_ARG_KIND.option || parameter.optionKind !== CLI_OPTION_KIND.value ||
        parameter.valueMode !== CLI_OPTION_VALUE_MODE.replace &&
        parameter.valueMode !== CLI_OPTION_VALUE_MODE.commaOrRepeat &&
        parameter.valueMode !== CLI_OPTION_VALUE_MODE.repeat)
      throw new Error('CLI host requires value options or boolean flags');
    const option = new Option(
      `${parameter.flags.join(', ')} <${parameter.valueName}>`,
      parameter.description + requirementSuffix(parameter.requirement),
    );
    option.argParser((value: string, previous: unknown) => {
      if (parameter.valueMode === CLI_OPTION_VALUE_MODE.commaOrRepeat ||
          parameter.valueMode === CLI_OPTION_VALUE_MODE.repeat)
        return [...(Array.isArray(previous) ? previous : []), value];
      if (previous !== undefined)
        throw new Problem(PROBLEM_CODE.invalidInput, `Option ${parameter.flags[0]} must not be repeated`);
      return value;
    });
    command.addOption(option);
    return { name: parameter.parameterName, attribute: option.attributeName() };
  });
  return () =>
    Object.fromEntries(
      [...positions.flatMap((parameter, index) => command.processedArgs[index] === undefined ? [] : [[parameter.parameterName, command.processedArgs[index]]]), ...mappings
        .filter((mapping) => command.getOptionValueSource(mapping.attribute) === 'cli')
        .map((mapping) => [mapping.name, command.getOptionValue(mapping.attribute)])],
    );
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1,
        previous + Number(left[i - 1] !== right[j - 1]));
      previous = above;
    }
  }
  return row[right.length]!;
}

function suggestions(program: Command | null, args: readonly string[], error: CommanderError): string[] {
  if (!program) return [];
  let current = program;
  for (const token of args) {
    const child = current.commands.find(item => item.name() === token);
    if (child) current = child;
  }
  const unknown = /'([^']+)'/.exec(error.message)?.[1] ?? '';
  const choices = error.code === 'commander.unknownCommand'
    ? current.commands.flatMap(item => current === program
      ? [item.name(), ...item.commands.map(child => `${item.name()} ${child.name()}`)]
      : [item.name()])
    : [...program.options, ...current.options].flatMap(option => option.flags.match(/--[a-z][a-z-]*/g) ?? []);
  const ranked = [...new Set(choices)].map(candidate => ({ candidate,
    score: distance(unknown, candidate.split(' ').at(-1)!) }))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  const close = ranked.filter(item => item.score <= Math.max(2, Math.floor(unknown.length / 3)));
  return (close.length ? close : error.code === 'commander.unknownCommand' ? ranked : []).slice(0, 5)
    .map(item => item.candidate);
}

function excessArgumentsHint(program: Command | null, args: readonly string[]): string {
  if (!program) return '';
  let current = program;
  const path: string[] = [];
  for (const token of args) {
    const child = current.commands.find(item => item.name() === token);
    if (child) {
      current = child;
      path.push(token);
    }
  }
  const idOptions = ['--task', '--run', '--agent'].filter(flag =>
    current.options.some(option => option.long === flag));
  const help = `${program.name()} ${path.join(' ')} -h`.replace(/ +/g, ' ');
  return idOptions.length > 0
    ? ` Pass IDs with options such as ${idOptions.join(', ')}. See ${help}.`
    : ` See ${help} for positional argument usage.`;
}

export async function runCli<Tree extends TreeSource, WorkspaceTree extends TreeSource>(
  args: readonly string[],
  setup: CliSetup<Tree, WorkspaceTree>,
): Promise<number> {
  const { tree, workspaceTree, policyFor } = setup;
  let selectedPolicy: CliPolicy = setup.defaultPolicy;
  let exitCode: number = CLI_EXIT_CODE.success;
  const streams = {
    [CLI_STREAM.stdout]: process.stdout,
    [CLI_STREAM.stderr]: process.stderr,
  } satisfies Record<CliPolicy['stream'], NodeJS.WritableStream>;
  const write = (value: unknown) => {
    if (value === undefined) return;
    const stream = streams[selectedPolicy.stream];
    stream.write(JSON.stringify(value) + '\n');
  };
  let program: Command | null = null;
  try {
    const runtime = setup.runtime(write);
    const view = collectCliCommands(tree);
    program = new Command()
      .name(view.root.token)
      .description(view.root.description)
      .exitOverride()
      .enablePositionalOptions()
      .allowExcessArguments(false)
      .configureHelp({ showGlobalOptions: true })
      .configureOutput({ writeErr: () => {} });
    let contextForInvocation: () => Promise<OutputOfTree<WorkspaceTree>>;
    const rootCommand = program;
    collectCliCommands(workspaceTree).root.commands.forEach((spec) => {
      const supplied = registerOptions(rootCommand, spec.parameters);
      // The workspace tree holds only the root's own options and its handler
      // ignores the context, so the two trees' context types need not agree.
      contextForInvocation = async () =>
        spec.handler(spec.input.parseOptions(supplied()), runtime as never);
    });

    const hasCli = (node: typeof view.root): boolean =>
      node.commands.length > 0 || node.children.some(hasCli);
    function register(node: typeof view.root, command: Command): void {
      command.description(node.description).allowExcessArguments(false);
      node.commands.forEach((spec) => {
        const supplied = registerOptions(command, spec.parameters);
        const guidance = commandHelp.get(spec.handler);
        if (guidance) command.addHelpText('after', () => {
          const lines = guidance();
          return lines.length ? `\nConditions:\n${lines.map(line => `  ${line}`).join('\n')}` : '';
        });
        const policy = policyFor(spec.handler);
        command.parent!.hook('preSubcommand', (_parent, child) => {
          if (child === command) selectedPolicy = policy;
        });
        command.action(async () => {
          const input = spec.input.parseOptions(supplied());
          const workspace = await contextForInvocation();
          // Both halves are objects: the runtime this application lends, and the
          // root options parsed for this invocation.
          const context = {
            ...(runtime as object),
            ...(workspace as object),
          } as ContextOfTree<Tree>;
          const result = await spec.handler(input, context);
          const render = commandOutput.get(spec.handler);
          if (render) { const text = render(result); if (text) streams[selectedPolicy.stream].write(text + '\n'); }
          else write(result);
          exitCode = policy.exitCode(result);
        });
      });
      for (const child of node.children) if (hasCli(child)) register(child, command.command(child.token));
    }
    for (const child of view.root.children) if (hasCli(child)) register(child, rootCommand.command(child.token));
    if (args.length === 0) {
      rootCommand.outputHelp();
      return CLI_EXIT_CODE.success;
    }
    await rootCommand.parseAsync([...args], { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === CLI_EXIT_CODE.success)
      return CLI_EXIT_CODE.success;
    const problem =
      error instanceof CommanderError
        ? new Problem(
            error.code === 'commander.unknownCommand' ? PROBLEM_CODE.unknownCommand :
              error.code === 'commander.unknownOption' ? PROBLEM_CODE.invalidOption : PROBLEM_CODE.invalidInput,
            error.message + (error.code === 'commander.excessArguments'
              ? excessArgumentsHint(program, args) : ''),
            error.code === 'commander.unknownCommand' || error.code === 'commander.unknownOption'
              ? { suggestions: suggestions(program, args, error) } : undefined,
          )
        : error;
    process.stderr.write(JSON.stringify(errorBody(problem)) + '\n');
    return selectedPolicy.errorExitCode ??
      (!(error instanceof CommanderError || error instanceof Problem ||
        error instanceof EntryInputError || error instanceof ZodError)
        ? 1 : failureExitCode(failure(problem).retry));
  }
}
