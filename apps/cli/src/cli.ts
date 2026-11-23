import { readPackageVersion } from '@alpacawork/core/package-version';
import { pinRestore } from './restore-pin.js';
import { accessHelp, accessHelpPointer } from '@alpacawork/contract/access-help';
import { createHash } from 'node:crypto';
import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { open, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { appRoot } from '../../../scripts/app-root.mjs';
import { Command, CommanderError } from 'commander';
import {
  commandFlag, commandRuleHelp, commandTree, cliWriteHelp, type Command as RemoteCommand, type CommandOption,
} from '@alpacawork/contract/commands';
import { commandPath } from '@alpacawork/contract/command-path';
import { RESTORE_HEADER, recoveryIdentitySchema } from '@alpacawork/contract/recovery';
import { taskFileRoute } from '@alpacawork/contract/task-file-route';
import { CLI_EXIT_CODE, defaultPolicy, failureExitCode, openBrowser } from '@alpacawork/cli-kit';
import { DEFAULT_SERVER_ORIGIN } from '@alpacawork/contract/default-server';
import { errorBody, parseInput, PROBLEM_CODE, Problem } from '@alpacawork/core';
import { operationId, writeAttempt } from './write-attempt.js';
import { actorHeaders, LostAnswer, RemoteProblem, prepareRequest, request, requestBytes } from './transport.js';
import { saveServer, selectServer, unsetServer, verifyServer } from './endpoint.js';
import { MAX_FILE_BYTES } from '@alpacawork/contract';
import { stopLocal } from '@alpacawork/contract/local-stop';
import { findDiffCommands } from '@alpacawork/contract/report-diff';
import { controlRunFilesSchema } from '@alpacawork/contract/control';
import { taskIdSchema } from '@alpacawork/contract/fields';
import { prepareReportDiffs, diffUploadId, type DiffSummary } from './report-diffs.js';

const tooLarge = (name: string, max: number) => new Problem(PROBLEM_CODE.tooLarge, `${name} exceeds ${max} bytes`);

/** A file option's text: the UTF-8 file at its absolute path, or stdin for `-`, at most the option's `max` bytes. */
async function document(path: string, option: CommandOption): Promise<unknown> {
  const name = commandFlag(option), max = option.max;
  if (max === undefined) throw new Error(`${name} has no size limit`);
  if (path !== '-' && !isAbsolute(path))
    throw new Problem(PROBLEM_CODE.invalidInput, `${name} needs an absolute path`);
  let bytes: Uint8Array;
  try { bytes = path === '-' ? await readStdin(max, name) : await boundedFile(path, max, name); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.invalidInput, `Cannot read ${name}`);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Problem(PROBLEM_CODE.invalidInput, `${name} must be UTF-8`); }
  return option.jsonFile ? jsonInput(option, text) : text;
}

function jsonInput(option: CommandOption, text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch {
    const message = `${commandFlag(option)} must contain JSON`;
    throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
      { issues: [{ path: option.key, code: 'invalid_json', message }] });
  }
}

/** A regular file's bytes; more than `max` is too large for the option `name` that names it. */
async function boundedFile(path: string, max: number, name: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Problem(PROBLEM_CODE.invalidInput, 'Expected a regular file');
    if (stat.size > max) throw tooLarge(name, max);
    // Allocate for the observed size first, then grow up to the limit if the file grows during this read.
    const limit = max + 1;
    let buffer = Buffer.alloc(Math.min(limit, stat.size + 1));
    let offset = 0;
    for (;;) {
      if (offset === buffer.length) {
        if (buffer.length === limit) break;
        const grown = Buffer.alloc(limit);
        buffer.copy(grown, 0, 0, offset);
        buffer = grown;
      }
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > max) throw tooLarge(name, max);
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function readStdin(max: number, name: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > max) throw tooLarge(name, max);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

const optionKey = (option: CommandOption) => option.kind === 'file' ? option.key + 'File' : option.key;
async function inputFor(spec: RemoteCommand, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const given = spec.options.filter(option => !option.local && values[optionKey(option)] !== undefined);
  if (given.filter(option => option.kind === 'file' && values[optionKey(option)] === '-').length > 1)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Only one option can read stdin');
  const input: Record<string, unknown> = {};
  for (const option of given) {
    const value = values[optionKey(option)];
    input[option.key] = option.kind === 'file' ? await document(String(value), option)
      : option.kind === 'json' ? jsonInput(option, String(value))
      : option.jsonScalar && (value === 'true' || value === 'false' || value === 'null') ? JSON.parse(value)
      : option.nullable && value === 'null' ? null : value;
  }
  return input;
}

// A Run uses its own Task. Other callers let the server resolve the project from their working directory.
function sendWorkingDirectory(headers: Headers): void {
  if (process.env.ALPACAWORK_RUN) return;
  let here: string;
  try { here = realpathSync(process.cwd()); } catch { return; /* A removed directory names no code location. */ }
  headers.set('X-Alpacawork-Cwd', encodeURIComponent(here));
}

/** The bytes of --file to upload, with the headers that describe them set on `headers`. */
async function uploadBytes(options: Record<string, unknown>, headers: Headers, contentDigest?: string): Promise<Uint8Array> {
  if (typeof options.file !== 'string') throw new Problem(PROBLEM_CODE.invalidInput, '--file is required');
  let bytes: Uint8Array;
  try { bytes = await boundedFile(options.file, MAX_FILE_BYTES, '--file'); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.invalidInput, 'Cannot read --file');
  }
  if (contentDigest) headers.set(contentDigest, createHash('sha256').update(bytes).digest('hex'));
  headers.set('Content-Type', 'application/octet-stream');
  return bytes;
}

type CommandContext = { origin: string; options: Record<string, unknown>; opId?: string };

async function execute(spec: RemoteCommand, input: Record<string, unknown>, { origin, options, opId }: CommandContext): Promise<unknown> {
  const headers = actorHeaders(process.env);
  headers.set('X-Alpacawork-Client', 'cli');
  headers.set(CONTRACT_HEADER, String(CLI_CONTRACT));
  sendWorkingDirectory(headers);
  if (opId) headers.set('X-Alpacawork-Op-Id', opId);
  const send = (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', input: Record<string, unknown> | Uint8Array | undefined) =>
    opId ? writeAttempt(prepareRequest(origin, path, method, input, headers), opId, origin, undefined, undefined, pinRestore)
      : request(origin, path, method, input, headers);
  if (spec.file) {
    const { path, method, query, headers: inputHeaders, contentDigest, body, response } = spec.file;
    const route = path.replace(/:([^/]+)/g, (_match, key: string) => encodeURIComponent(String(input[key])));
    const search = new URLSearchParams(query?.map(key => [key, String(input[key])]));
    const target = search.size > 0 ? `${route}?${search}` : route;
    for (const [key, name] of Object.entries(inputHeaders ?? {})) {
      if (input[key] !== undefined) headers.set(name, String(input[key]));
    }
    if (response === 'bytes') {
      if (typeof options.output !== 'string' || options.output === '-')
        throw new Problem(PROBLEM_CODE.invalidInput, '--output file path is required');
      const bytes = await requestBytes(origin, target, headers);
      await writeFile(options.output, bytes, { flag: 'wx' });
      return { path: options.output, bytes: bytes.length };
    }
    if (body === 'bytes') return send(target, method, await uploadBytes(options, headers, contentDigest));
    return send(target, method, undefined);
  }
  if (spec.kind === 'run') {
    const identity = recoveryIdentitySchema.parse(await request(origin, '/api/runtime/recovery', 'GET', undefined, headers));
    headers.set(RESTORE_HEADER, identity.restoreId);
    try { return await send(spec.path, spec.method, input); }
    catch (error) {
      if (!(error instanceof LostAnswer)) throw error;
      throw new Problem(PROBLEM_CODE.unavailable, 'Execution result unknown; the server did not return a complete answer',
        { state: 'result_unknown' }, { cause: error });
    }
  }
  let diffs: DiffSummary[] | undefined;
  if (spec.attachesDiffs && typeof input[spec.attachesDiffs] === 'string') {
    const description = input[spec.attachesDiffs] as string, commands = findDiffCommands(description);
    if (commands.length) {
      const run = process.env.ALPACAWORK_RUN;
      const ownTask = run ? controlRunFilesSchema.parse(await request(origin, commandPath('run/get'), 'GET', { run }, headers)).taskId : undefined;
      const task = typeof input.task === 'string' ? input.task : ownTask;
      if (ownTask && ownTask !== task) diffs = commands.map(found => ({ command: found.command, attached: false,
        reason: 'A Run can attach files only to its own Task; this report is for another Task' }));
      else {
        const target = parseInput(taskIdSchema, task);
        const prepared = await prepareReportDiffs(description, process.cwd(), commands);
        input[spec.attachesDiffs] = prepared.description;
        // The expanded document must still satisfy the same public report contract, before uploading anything.
        parseInput(spec.schema, input);
        for (const file of prepared.files) {
          const route = taskFileRoute(target, file.path);
          let existing: Uint8Array | undefined;
          try { existing = await requestBytes(origin, route, headers); }
          catch (error) { if (!(error instanceof RemoteProblem && error.body.error.code === PROBLEM_CODE.notFound)) throw error; }
          if (existing) {
            if (createHash('sha256').update(existing).digest('hex') !== file.digest)
              throw new Problem(PROBLEM_CODE.conflict, `A different file already occupies the report diff path: ${file.path}`);
            continue;
          }
          const uploadId = diffUploadId(opId!, target, file.digest), uploadHeaders = new Headers(headers);
          uploadHeaders.set('X-Alpacawork-Op-Id', uploadId);
          uploadHeaders.set('X-Alpacawork-Content-Digest', file.digest);
          uploadHeaders.set('Content-Type', 'application/octet-stream');
          await writeAttempt(prepareRequest(origin, route, 'PUT', file.bytes, uploadHeaders), uploadId, origin,
            undefined, undefined, pinRestore);
        }
        diffs = prepared.summaries;
      }
    }
  }
  const result = await send(spec.path, spec.method, input);
  return diffs ? { ...(result as Record<string, unknown>), diffs } : result;
}

export async function main(args = process.argv.slice(2), local: { server?: string } = {}): Promise<number> {
  const own = appRoot(import.meta.url);
  try {
    if (args.length === 1 && (args[0] === 'version' || args[0] === '--version')) {
      const facts = readPackageVersion(own);
      process.stdout.write((args[0] === '--version' ? facts.version : JSON.stringify(facts)) + '\n');
      return 0;
    }
    return await runMain(args, local.server);
  }
  catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const body = error instanceof RemoteProblem ? error.body : errorBody(error instanceof CommanderError
      ? new Problem(PROBLEM_CODE.invalidInput, error.message) : error);
    process.stderr.write(JSON.stringify(body) + '\n');
    if (!(error instanceof RemoteProblem || error instanceof Problem || error instanceof CommanderError)) return 1;
    return failureExitCode(body.error.retry);
  }
}
/** Defined once here; option help that leaves out a Task points to it (`projectAtCwd` is the behavior). */
const cwdRuleHelp = 'cwd rule: a command that leaves out its Task uses the active project whose own code location ' +
  'on this PC holds the working directory, the deepest one; two projects at that same location are refused. ' +
  'When none holds it, the only active project; else none, and the command\'s option says what then.';
const exitCodeHelp = `Exit codes: ${CLI_EXIT_CODE.success} success or accepted; ` +
  `${CLI_EXIT_CODE.failure} refused, nothing saved (error.retry says what next); ` +
  `${CLI_EXIT_CODE.unavailable} save result unknown: check with the command in the error; ` +
  `${CLI_EXIT_CODE.partial} partial result: errors lists what could not be read; 1 unexpected.`;
/** The order `selectServer` follows. */
const serverOrderHelp = 'Selection order: --server, ALPACAWORK_SERVER, client.json (server set), else this PC\'s ' +
  `server installation (installation.json, the port setup chose), else ${DEFAULT_SERVER_ORIGIN}.`;

async function runMain(args: string[], installedServer?: string): Promise<number> {
  const program = new Command().name('alpacawork').description('Task tree and agent runs over HTTP')
    .exitOverride().allowExcessArguments(false).enablePositionalOptions()
    .addHelpText('after', '\n' + accessHelpPointer + '\n\n' + cwdRuleHelp + '\n\n' + exitCodeHelp + '\n\nLocal commands:\n  alpacawork deploy <from>  Install or update from path[#ref] or npm:name[@version]\n  alpacawork setup          Install or repair this server; run again to change its port, public host or Node.js path\n  alpacawork skills update  Update only the distributed skills\n  alpacawork uninstall      Remove alpacawork from this PC; the data folder stays\n  alpacawork telemetry      This PC\'s usage reporting: status, show or off\n  alpacawork start          Start this server\n  alpacawork stop           Stop this server\n  alpacawork restart        Restart this server\n  alpacawork status         Show whether this server is running and its URL\n  alpacawork --version      Show the version');
  program.option('--server <url>', 'Use this server for one command (overrides environment and saved server)');
  const bound = commandTree<CommandContext>(spec => (input, context) => execute(spec, input, context));
  const selectedServer = () => selectServer(program.opts().server as string | undefined, process.env, installedServer);
  // Local removal delegates to the backend, which owns installation records and deletion policy.
  program.command('uninstall', { hidden: true }).helpOption(false).allowUnknownOption().allowExcessArguments()
    .action(async () => {
      const backend = await import(pathToFileURL(join(appRoot(import.meta.url), 'apps/backend/dist/backend.js')).href);
      await backend.main(args);
    });
  const server = program.command('server').description('Show or change this client\'s HTTP server')
    .addHelpText('after', '\n' + serverOrderHelp);
  server.command('show').description('Show the selected server and where it came from')
    .addHelpText('after', accessHelp('server.show'))
    .action(async () => {
      process.stdout.write(JSON.stringify(await selectedServer()) + '\n');
    });
  server.command('set <url>').description('Verify an alpacawork server and save it for this client')
    .addHelpText('after', accessHelp('server.set'))
    .action(async (url: string) => {
      process.stdout.write(JSON.stringify(await saveServer(url, process.env)) + '\n');
    });
  server.command('unset').description('Remove this client\'s saved server')
    .addHelpText('after', accessHelp('server.unset'))
    .action(async () => {
      process.stdout.write(JSON.stringify(await unsetServer(process.env)) + '\n');
    });
  program.command('open').description('Open the screen of the selected server in this PC\'s browser')
    .addHelpText('after', accessHelp('open') + '\nOn WSL it opens the Windows default browser. Where no browser can be opened here (over SSH, or ' +
      'without a desktop), it prints the URL and what to do instead.\n' + serverOrderHelp)
    .action(async () => {
      const { server } = await selectedServer();
      await verifyServer(server);
      const url = new URL(server), outcome = await openBrowser(url.href, process.env);
      if (outcome === 'opened') { process.stdout.write(`Opened ${url.href} in the browser.\n`); return; }
      const urlSpec = bound.commands.find(spec => spec.id === 'workspace/url')!;
      const published = (await urlSpec.handler({}, { origin: server, options: {} }) as { publicUrl: string | null }).publicUrl;
      if (published) { process.stdout.write(published + '\n'); process.stderr.write('Open the URL in the browser on your own PC.\n'); return; }
      process.stdout.write(url.href + '\n');
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      process.stderr.write(outcome === 'remote' && loopback
        ? `Over SSH, run ssh -N -L ${port}:${url.hostname}:${port} <this host> on your own PC, then open the URL there.\n`
        : 'No browser could be started here. Open the URL in your own browser.\n');
    });
  const groups = new Map<string, Command>();
  const registerGroups = (node: (typeof bound.cliRoot.children)[number], parent: Command, words: string[]) => {
    for (const child of node.children) {
      const path = [...words, child.name];
      if (child.children.length === 0) continue;
      const group = parent.command(child.name).description(child.description).addHelpText('after', '\n' + accessHelpPointer);
      groups.set(path.join('/'), group);
      registerGroups(child, group, path);
    }
  };
  registerGroups(bound.cliRoot, program, []);
  for (const spec of bound.commands) {
    const words = spec.words;
    const group = groups.get(words.slice(0, -1).join('/'))!;
    const command = group.command(words.at(-1)!).description(spec.description).allowExcessArguments(false);
    const writes = spec.kind === 'write';
    command.addHelpText('after', () => accessHelp(spec.access));
    if (writes) command.addHelpText('after', '\n' + cliWriteHelp);
    if (spec.rules?.length) command.addHelpText('after', '\n' + commandRuleHelp(spec, true).join('\n'));
    if (spec.help) command.addHelpText('after', spec.help);
    for (const option of spec.options) {
      const syntax = commandFlag(option);
      if (option.kind === 'boolean') {
        const negative = syntax.replace(/^--/, '--no-');
        const positiveOption = syntax.slice(2), negativeOption = negative.slice(2);
        let first: string | undefined;
        const mark = (name: string) => () => {
          if (first && first !== name)
            throw new Problem(PROBLEM_CODE.invalidInput, `${syntax} and ${negative} cannot be used together`);
          first = name;
        };
        command.option(syntax, option.description).option(negative, 'Disable ' + syntax)
          .on(`option:${positiveOption}`, mark(syntax)).on(`option:${negativeOption}`, mark(negative));
      } else if (option.kind === 'number') command.option(`${syntax} <value>`, option.description, (value: string) => {
        if (option.nullable && value === 'null') return value;
        if (!/^[0-9]+$/.test(value)) throw new Problem(PROBLEM_CODE.invalidInput, `${syntax} needs a positive integer`);
        return Number(value);
      });
      else if (option.kind === 'list') command.option(`${syntax} <value>`, option.description,
        (value: string, previous: string[] = []) => [...previous, ...value.split(',')]);
      else command.option(`${syntax} <${option.kind === 'file' ? 'path' : 'value'}>`, option.description);
    }
    if (writes) command.option('--op-id <id>', 'Operation key (random UUID when omitted; specify to check after process loss)');
    command.action(async (options: Record<string, unknown>) => {
      const opId = writes ? operationId(options.opId) : undefined;
      const input = spec.parse(await inputFor(spec, options));
      const result = await spec.handler(input, { origin: (await selectedServer()).server, options, opId });
      if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = defaultPolicy.exitCode(result);
    });
  }
  groups.get('run')!.command('stop-local').description('Save an offline local-human stop request')
    .addHelpText('after', accessHelp('run.stop-local'))
    .requiredOption('--workspace <root>').requiredOption('--run <id>').requiredOption('--op-id <uuid>')
    .action((values: { workspace: string; run: string; opId: string }) => {
      process.stdout.write(JSON.stringify(stopLocal(values.workspace, values.run, values.opId)) + '\n');
    });
  await program.parseAsync(args, { from: 'user' });
  return Number(process.exitCode || 0);
}
