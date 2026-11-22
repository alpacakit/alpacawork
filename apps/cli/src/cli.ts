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
  cliCommands, cliCommandWords, cliGroups, cliWriteHelp, taskFileRoute, type CliCommand, type CliOption,
} from '@alpacawork/contract/cli-commands';
import { CLI_EXIT_CODE, defaultPolicy, failureExitCode, openBrowser } from '@alpacawork/cli-kit';
import { DEFAULT_SERVER_ORIGIN } from '@alpacawork/contract/default-server';
import { errorBody, parseInput, PROBLEM_CODE, Problem } from '@alpacawork/core';
import { operationId, writeAttempt } from './write-attempt.js';
import { actorHeaders, RemoteProblem, prepareRequest, request, requestBytes } from './transport.js';
import { saveServer, selectServer, unsetServer, verifyServer } from './endpoint.js';
import { MAX_FILE_BYTES } from '@alpacawork/contract';
import { stopLocal } from '@alpacawork/contract/local-stop';
import { findDiffCommands } from '@alpacawork/contract/report-diff';
import { controlRunFilesSchema } from '@alpacawork/contract/control';
import { taskIdSchema } from '@alpacawork/contract/fields';
import { prepareReportDiffs, diffUploadId, type DiffSummary } from './report-diffs.js';

const flag = (key: string) => '--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
const tooLarge = (name: string, max: number) => new Problem(PROBLEM_CODE.tooLarge, `${name} exceeds ${max} bytes`);

/** A file option's text: the UTF-8 file at its absolute path, or stdin for `-`, at most the option's `max` bytes. */
async function document(path: string, option: CliOption): Promise<string> {
  const name = flag(option.key), max = option.max;
  if (max === undefined) throw new Error(`${name} has no size limit`);
  if (path !== '-' && !isAbsolute(path))
    throw new Problem(PROBLEM_CODE.invalidInput, `${name} needs an absolute path`);
  let bytes: Uint8Array;
  try { bytes = path === '-' ? await readStdin(max, name) : await boundedFile(path, max, name); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.invalidInput, `Cannot read ${name}`);
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Problem(PROBLEM_CODE.invalidInput, `${name} must be UTF-8`); }
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

function absoluteUrls(value: unknown, origin: string): unknown {
  if (Array.isArray(value)) return value.map(item => absoluteUrls(item, origin));
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = (key === 'folder' || key === 'path') && typeof item === 'string' && item.startsWith('/api/')
      ? new URL(item, origin).href : absoluteUrls(item, origin);
  }
  return result;
}

/**
 * What a command sends: each flag given, under its wire key, read the way its kind says. Flags that send the same key
 * (--from-user and --internal) exclude each other, and only one flag can read stdin; both are refused before anything
 * is read.
 */
async function inputFor(spec: CliCommand, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const given = spec.options.filter(option => values[option.key] !== undefined);
  const wire = (option: CliOption) => option.wire ?? option.key;
  for (const [at, option] of given.entries()) {
    const other = given.slice(0, at).find(each => wire(each) === wire(option));
    if (other) throw new Problem(PROBLEM_CODE.invalidInput,
      `${flag(other.key)} and ${flag(option.key)} cannot be used together`);
  }
  if (given.filter(option => option.kind === 'file' && values[option.key] === '-').length > 1)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Only one option can read stdin');
  const input: Record<string, unknown> = spec.mutation ? { opId: values.opId } : {};
  for (const option of given) {
    const value = values[option.key];
    input[wire(option)] = option.kind === 'boolean' ? option.value ?? true
      : option.kind === 'file' ? await document(String(value), option) : value;
  }
  const parsed = parseInput(spec.schema, input);
  return parsed as Record<string, unknown>;
}

/**
 * A person's command sends its working directory: the server starts a Task created without a parent, and a settings
 * read naming no Task, from the project whose code location on this PC holds it. A Run works in its own Task.
 */
function sendWorkingDirectory(headers: Headers): void {
  if (process.env.ALPACAWORK_RUN) return;
  let here: string;
  try { here = realpathSync(process.cwd()); } catch { return; /* A removed directory names no code location. */ }
  headers.set('X-Alpacawork-Cwd', encodeURIComponent(here));
}

/** The bytes of --file to upload, with the headers that describe them set on `headers`. */
async function uploadBytes(options: Record<string, unknown>, headers: Headers): Promise<Uint8Array> {
  if (typeof options.file !== 'string') throw new Problem(PROBLEM_CODE.invalidInput, '--file is required');
  let bytes: Uint8Array;
  try { bytes = await boundedFile(options.file, MAX_FILE_BYTES, '--file'); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.invalidInput, 'Cannot read --file');
  }
  headers.set('X-Alpacawork-Content-Digest', createHash('sha256').update(bytes).digest('hex'));
  headers.set('Content-Type', 'application/octet-stream');
  return bytes;
}

async function execute(spec: CliCommand, options: Record<string, unknown>, origin: string): Promise<unknown> {
  if (spec.mutation) options = { ...options, opId: operationId(options.opId) };
  const headers = actorHeaders(process.env);
  headers.set('X-Alpacawork-Client', 'cli');
  headers.set(CONTRACT_HEADER, String(CLI_CONTRACT));
  sendWorkingDirectory(headers);
  if (spec.mutation) headers.set('X-Alpacawork-Op-Id', options.opId as string);
  const send = (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', input: Record<string, unknown> | Uint8Array | undefined) =>
    spec.mutation ? writeAttempt(prepareRequest(origin, path, method, input, headers), options.opId as string, origin,undefined,undefined,pinRestore)
      : request(origin, path, method, input, headers);
  if (spec.file === 'get' || spec.file === 'put') {
    const task = options.task, path = options.path;
    const wire = parseInput(spec.schema, { task, path, expectedDigest: options.expectedDigest }) as
      { task: string; path: string };
    const route = taskFileRoute(wire.task, wire.path);
    if (spec.file === 'get') {
      if (typeof options.output !== 'string' || options.output === '-')
        throw new Problem(PROBLEM_CODE.invalidInput, '--output file path is required');
      const bytes = await requestBytes(origin, route, headers);
      await writeFile(options.output, bytes, { flag: 'wx' });
      return { path: options.output, bytes: bytes.length };
    }
    const bytes = await uploadBytes(options, headers);
    if (options.expectedDigest !== undefined) headers.set('X-Alpacawork-Expected-Digest', String(options.expectedDigest));
    return send(route, 'PUT', bytes);
  }
  if (spec.file?.startsWith('attachment-')) {
    const task = options.task, requestId = options.requestId, name = options.name;
    parseInput(spec.schema, options);
    const base = `/api/tasks/${encodeURIComponent(String(task))}/attachments`;
    if (spec.file === 'attachment-move') {
      if (typeof options.from !== 'string' || typeof options.to !== 'string')
        throw new Problem(PROBLEM_CODE.invalidInput, '--from and --to are required');
      return send(base + '/move', 'POST', { from: options.from, to: options.to, opId: options.opId });
    }
    if (typeof requestId !== 'string' || typeof name !== 'string' || !requestId || !name)
      throw new Problem(PROBLEM_CODE.invalidInput, '--request-id and --name are required');
    const route = `${base}?requestId=${encodeURIComponent(requestId)}&name=${encodeURIComponent(name)}`;
    if (spec.file === 'attachment-remove') return send(route, 'DELETE', undefined);
    return send(route, 'POST', await uploadBytes(options, headers));
  }
  const input = await inputFor(spec, options);
  let diffs: DiffSummary[] | undefined;
  if (spec.attachesDiffs && typeof input[spec.attachesDiffs] === 'string') {
    const description = input[spec.attachesDiffs] as string, commands = findDiffCommands(description);
    if (commands.length) {
      const run = process.env.ALPACAWORK_RUN;
      const ownTask = run ? controlRunFilesSchema.parse(await request(origin, '/api/run/get', 'GET', { run }, headers)).taskId : undefined;
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
          const uploadId = diffUploadId(input.opId as string, target, file.digest), uploadHeaders = new Headers(headers);
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
  return absoluteUrls(diffs ? { ...(result as Record<string, unknown>), diffs } : result, origin);
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
      const urlSpec = cliCommands.find(spec => spec.group === 'workspace' && spec.name === 'url')!;
      const published = (await execute(urlSpec, {}, server) as { publicUrl: string | null }).publicUrl;
      if (published) { process.stdout.write(published + '\n'); process.stderr.write('Open the URL in the browser on your own PC.\n'); return; }
      process.stdout.write(url.href + '\n');
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      process.stderr.write(outcome === 'remote' && loopback
        ? `Over SSH, run ssh -N -L ${port}:${url.hostname}:${port} <this host> on your own PC, then open the URL there.\n`
        : 'No browser could be started here. Open the URL in your own browser.\n');
    });
  const groups = new Map<string, Command>();
  /** The command for the words before a command's name (`task file`), as the contract's table describes it. */
  const groupOf = (words: string): Command => {
    const known = groups.get(words);
    if (known) return known;
    const description = cliGroups[words];
    if (description === undefined) throw new Error(`CLI group ${words} has no description`);
    const at = words.lastIndexOf(' ');
    const group = (at < 0 ? program : groupOf(words.slice(0, at))).command(words.slice(at + 1))
      .description(description).addHelpText('after', '\n' + accessHelpPointer);
    groups.set(words, group);
    return group;
  };
  for (const spec of cliCommands) {
    const words = cliCommandWords(spec);
    const command = groupOf(words.slice(0, -1).join(' ')).command(words.at(-1)!).description(spec.description).allowExcessArguments(false);
    command.addHelpText('after', () => accessHelp(`${spec.group}.${spec.name}`));
    if (spec.mutation) command.addHelpText('after', '\n' + cliWriteHelp);
    if (spec.help) command.addHelpText('after', spec.help);
    for (const option of spec.options) {
      const syntax = flag(option.key);
      if (option.kind === 'boolean') command.option(syntax, option.description);
      else if (option.kind === 'number') command.option(`${syntax} <value>`, option.description, Number);
      else if (option.kind === 'list') command.option(`${syntax} <value>`, option.description,
        (value: string, previous: string[] = []) => [...previous, ...value.split(',')]);
      else command.option(`${syntax} <${option.kind === 'file' ? 'path' : 'value'}>`, option.description);
    }
    if (spec.mutation) command.option('--op-id <id>', 'Operation key (random UUID when omitted; specify to check after process loss)');
    command.action(async (options: Record<string, unknown>) => {
      const result = await execute(spec, options, (await selectedServer()).server);
      if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = defaultPolicy.exitCode(result);
    });
  }
  groupOf('run').command('stop-local').description('Save an offline local-human stop request')
    .addHelpText('after', accessHelp('run.stop-local'))
    .requiredOption('--workspace <root>').requiredOption('--run <id>').requiredOption('--op-id <uuid>')
    .action((values: { workspace: string; run: string; opId: string }) => {
      process.stdout.write(JSON.stringify(stopLocal(values.workspace, values.run, values.opId)) + '\n');
    });
  await program.parseAsync(args, { from: 'user' });
  return Number(process.exitCode || 0);
}
