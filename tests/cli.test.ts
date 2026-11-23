import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { syntheticStatusApp } from './helpers/agent-inspection.ts';
import { stringify } from 'yaml';
import { currentTaskLog, seedFixtureTask } from './helpers/control-fixture.ts';
import { cleanCliEnv, httpStatus, CLI_FIXTURE_WATCHDOG_MS } from './helpers/http-cli.ts';
/** CLI-specific contracts; task behavior and HTTP contracts live in platform.test.ts. */
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SCHEMA, fieldGetResultSchema } from '@alpacawork/contract';
import { DEFAULT_SERVER_PORT } from '@alpacawork/contract/default-server';
import { commandCatalog, commandFlag, type Command, type CommandOption } from '@alpacawork/contract/commands';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { tryLock, unlock } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { serve as serveEndpoint } from '@alpacawork/backend/test-dist/receiver/entries.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { isolatedServe } from './helpers/http-cli.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { withFixtureCleanup } from '../e2e/fixture-cleanup.ts';

const project = resolve(import.meta.dirname, '..');
let area: string;
let server: Awaited<ReturnType<typeof isolatedServe>> | undefined;
const children = new Set<ChildProcess>();
const locks = new Set<number>();
const executions: { pid?: number; argv: string[]; cwd: string; stdout: string; stderr: string; code?: number | null; signal?: NodeJS.Signals | null }[] = [];
beforeEach(() => { area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-cli-'))); server = undefined; executions.length = 0; });
afterEach(async t => {
  assert.ok('assert' in t, 'CLI cleanup belongs to an individual test');
  await withFixtureCleanup(async () => {}, [
    { name: 'server', run: async () => { await server?.stop(); } },
    { name: 'locks', run: async () => { for (const lock of locks) { unlock(lock); closeSync(lock); } locks.clear(); } },
    { name: 'children', run: async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await once(child, 'close');
      }
      children.clear();
    } },
    { name: 'remove', run: async () => { rmSync(area, { recursive: true, force: true }); } },
  ], failures => preserveTestFailure(t, area, { databaseRoot: join(area, 'tasks'),
    ...(failures.length ? { failure: { error: new AggregateError(failures.map(each => each.error), 'CLI cleanup failed') } } : {}),
    diagnostics: () => ({ executions, cleanupFailures: failures, server: server && { url: server.url, pid: server.child.pid } }) }));
});
const statusApp = mkdtempSync(join(tmpdir(), 'cli-status-app-'));
const BACKEND = syntheticStatusApp(project, statusApp);
after(() => rmSync(statusApp, { recursive: true, force: true }));
const CLI = 'apps/cli/dist/cli.js';
function launch(args: string[], entry = BACKEND, cwd = project, extraEnv: Record<string, string> = {}) {
  const env = cleanCliEnv({ HOME: area, XDG_CONFIG_HOME: join(area, '.config'), PATH: installAgentStub(area, 'claude'), ...extraEnv });
  const group = args[0] === '--workspace' ? args[2] : args[0];
  const local = group === 'workspace' && ['init', 'serve'].includes(args[0] === '--workspace' ? args[3]! : args[1]!);
  const selected = entry === BACKEND && !local ? CLI : entry;
  let argv = selected === CLI ? ['--server', server?.url ?? 'http://127.0.0.1:1', ...args] : args;
  if (selected === CLI && ['new', 'update', 'report', 'move', 'comment', 'set', 'returns', 'assign', 'release', 'stop'].includes(argv[3] ?? '') && !argv.includes('--op-id'))
    argv = [...argv, '--op-id', randomUUID()];
  const child = spawn(process.execPath, [resolve(project, selected), ...argv], {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
  const execution = { pid: child.pid, argv: [process.execPath, resolve(project, selected), ...argv], cwd, stdout: '', stderr: '' } as (typeof executions)[number];
  executions.push(execution);
  child.stdout.on('data', data => { execution.stdout += data; });
  child.stderr.on('data', data => { execution.stderr += data; });
  child.once('close', (code, signal) => { execution.code = code; execution.signal = signal; });
  children.add(child);
  return child;
}
async function run(args: string[], input = '', keepInputOpen = false, entry = BACKEND, cwd = project,
  extraEnv: Record<string, string> = {}) {
  const child = launch(args, entry, cwd, extraEnv);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  // This backstop detects a stuck fixture command; the command's exit, media checks and saved bytes own correctness.
  const watchdog = setTimeout(() => child.kill('SIGKILL'), CLI_FIXTURE_WATCHDOG_MS);
  if (!keepInputOpen) child.stdin.end(input);
  const [code, signal] = await once(child, 'close');
  clearTimeout(watchdog);
  assert.equal(signal, null, `CLI did not finish: ${args.join(' ')}\n${stderr}`);
  return { code, stdout, stderr };
}
/**
 * A served workspace as workspace init makes it: the root project P1 alone. Its agents never run anything, so no wake
 * the server starts launches an agent.
 */
async function initialize() {
  const root = join(area, 'tasks');
  const result = await run(['--workspace', root, 'workspace', 'init']);
  assert.equal(result.code, 0, result.stderr);
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { "codex": fixtureAgentSetting('codex') } }));
  server = await isolatedServe(root);
  return root;
}
/**
 * `work` written straight to the stores, which only the workspace's one writer may open: serve stops for it and serves
 * again after.
 */
async function withServeStopped<T>(root: string, work: () => T): Promise<T> {
  await server!.stop();
  try { return work(); } finally { server = await isolatedServe(root); }
}
/**
 * The first Run of `task`'s responsible, running and kept alive for serve by its manager's lock (taken before it
 * runs), its start applied to the Task as a pass applies it (so the Task's hash no longer moves under the test), and
 * the environment its CLI commands carry.
 */
async function responsibleRun(root: string, task: string) {
  return withServeStopped(root, () => {
    const id = 'R1';
    mkdirSync(runFolder(root, id), { recursive: true, mode: 0o700 });
    const lock = openSync(join(runFolder(root, id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
    assert.equal(tryLock(lock), true);
    locks.add(lock);
    const people = new PlacementStore(root);
    let placementId: string;
    try { placementId = people.createAndPlace({ taskId: task, profileKey: 'codex', responsible: true }).placement.id; }
    finally { people.close(); }
    const store = new RunStore(root, { busyTimeoutMs: 10_000 });
    try {
      const run = store.write(tx => {
        const created = createFixtureRun(store, tx, { task, placementId, requestId: randomUUID(), agent: 'codex', role: 'owner',
          resumes: null, continues: false, session: null, caller: null, cwd: root,
          launch: { adapter: 'codex', env: [], argv: ['NEVER-EXECUTE'], path: '/bin', values: {} } },
        'Owner prompt');
        tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
        return created;
      });
      assert.equal(run.id, id);
    } finally { store.close(); }
    reconcileLinks(root, 'P1');
    return { placementId, env: { ALPACAWORK_RUN: id, ALPACAWORK_RUN_TOKEN: issueRunCredential(root, id) } };
  });
}
/** What -h shows for an option, as the CLI registers it. */
const optionTerm = (option: CommandOption) => commandFlag(option) +
  (option.kind === 'boolean' ? '' : option.kind === 'file' ? ' <path>' : ' <value>');
const commandWords = (spec: Command) => spec.words;
const oneLine = (text: string) => text.replace(/\s+/g, ' ');

test('HTTP CLI help performs no work and exposes the server selector', async () => {
  const root = join(area, 'uncreated');
  const topHelp = await run(['-h']);
  assert.equal(topHelp.code, 0, topHelp.stderr);
  assert.match(topHelp.stdout, /--server <url>/);
  assert.match(topHelp.stdout, /server/);
  const serverHelp = await run(['server', '-h']);
  assert.match(serverHelp.stdout, /set <url>/);
  assert.match(serverHelp.stdout, /show/);
  assert.match(serverHelp.stdout, /unset/);
  assert.match((await run(['server', 'set', '-h'])).stdout, /Verify an alpacawork server/);
  assert.match((await run(['server', 'show', '-h'])).stdout, /where it came from/);
  assert.match((await run(['server', 'unset', '-h'])).stdout, /saved server/);
  assert.doesNotMatch(topHelp.stdout, /--workspace/);
  const groupHelp = await run(['task', '-h']);
  assert.match(groupHelp.stdout, /report/);
  const reportHelp = await run(['task', 'report', '-h']);
  assert.match(reportHelp.stdout, /--description-file <path>/);
  assert.match(reportHelp.stdout, /--op-id <id>/);
  assert.match(reportHelp.stdout, /--estimate-minutes <value>/);
  assert.match(reportHelp.stdout, /no --estimate-minutes\b/);
  const fieldHelp = (await run(['field', 'set', '-h'])).stdout;
  for (const flag of ['--many', '--no-many', '--required', '--no-required'])
    assert.match(fieldHelp, new RegExp(`^\\s+${flag}\\s{2,}`, 'm'));
  const help = await run(['--workspace', root, 'workspace', 'serve', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--workspace/);
  assert.match(help.stdout, /--workspace <WORKSPACE>/);
  assert.doesNotMatch(help.stdout, /--root/);
  assert.match(help.stdout, /--port/);
  assert.match(help.stdout, new RegExp(`default ${DEFAULT_SERVER_PORT}`));
  assert.match(help.stdout, /Environment file: as it starts, serve reads NAME=VALUE lines from \$\{XDG_CONFIG_HOME:-~\/\.config\}\/alpacawork\/env/);
  assert.equal(existsSync(root), false);
});

test('serve defaults to the shared CLI port and reserves port 0 for explicit selection', () => {
  const port = serveEndpoint.entry.parameters.find(parameter => parameter.name === 'port');
  assert.deepEqual(port?.requirement, { kind: 'optional_with_default', defaultValue: String(DEFAULT_SERVER_PORT) });
  assert.notEqual(DEFAULT_SERVER_PORT, 0);
});

test('every command\'s -h says what it does, its options and its rules; removed flags, commands and groups are unknown', async () => {
  await Promise.all(commandCatalog.commands.map(async spec => {
    const help = await run([...commandWords(spec), '-h']);
    const name = commandWords(spec).join(' ');
    assert.equal(help.code, 0, `${name}: ${help.stderr}`);
    // The help wraps long lines; the words are the contract's.
    const text = oneLine(help.stdout);
    assert.ok(text.includes(oneLine(spec.description)), name);
    for (const option of spec.options) {
      if (option.key === 'opId' && spec.kind === 'write') continue;
      assert.ok(text.includes(optionTerm(option)), `${name} ${optionTerm(option)}`);
      assert.ok(text.includes(oneLine(option.description)), `${name} ${optionTerm(option)}: ${option.description}`);
    }
    for (const line of (spec.help ?? '').split('\n').filter(Boolean)) assert.ok(help.stdout.includes(line), `${name}: ${line}`);
  }));
  // An instruction, a send-back and an answer are task request's; a Task with its subtree stops by task report.
  const reportHelp = (await run(['task', 'report', '-h'])).stdout;
  for (const removed of ['--instruction-file', '--agent', '--new-conversation', '--cwd', '--selected', '--waiting-intent',
    '--processed-returns', '--restore-report-id'])
    assert.doesNotMatch(reportHelp, new RegExp(`${removed}\\b`), removed);
  assert.doesNotMatch((await run(['run', 'stop', '-h'])).stdout, /--task\b/);
  const hash = 'a'.repeat(64);
  for (const args of [
    ['task', 'report', '--task', 'P1', '--state', 'doing', '--title', 'Go', '--instruction-file', '/tmp/x', '--expected-task-hash', hash],
    ['task', 'report', '--task', 'P1', '--state', 'waiting', '--waiting-intent', 'review', '--expected-task-hash', hash],
    ['task', 'report', '--task', 'P1', '--restore-report-id', 'L1', '--expected-task-hash', hash],
    ['run', 'stop', '--task', 'P1'],
  ]) {
    const refused = await run(args);
    assert.equal(refused.code, 2, args.join(' '));
    assert.match(refused.stderr, /unknown option/, args.join(' '));
  }
  // Project lifecycle has its own command group; agents do not wait on Runs; this PC's folders are the screen's to list.
  for (const args of [['project', 'list'], ['run', 'wait', '--run', 'R1'], ['run', 'wait-state', '--run', 'R1'],
    ['workspace', 'folders'], ['workspace', 'migrate']]) {
    const refused = await run(args);
    assert.equal(refused.code, 2, args.join(' '));
    assert.match(refused.stderr, /unknown command/, args.join(' '));
  }
  assert.match((await run(['-h'])).stdout, /^\s+project\b/m);
  assert.doesNotMatch((await run(['workspace', '-h'])).stdout, /folders/);
  assert.equal(commandCatalog.commands.some(spec => spec.id === 'workspace/folders' as string), false);
});

test('HTTP CLI writes through the selected server and leaves a local workspace hint untouched', async () => {
  await initialize();
  const decoy = join(area, 'decoy-workspace');
  mkdirSync(decoy);
  // Without --parent a person's Task goes under the project the cwd rule gives: here the only one.
  const created = await run(['task', 'new', '--title', 'On the selected server'],
    '', false, CLI, decoy, { ALPACAWORK_WORKSPACE: decoy, ALPACAWORK_SERVER: 'http://127.0.0.1:1' });
  assert.equal(created.code, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  assert.equal(task.title, 'On the selected server');
  assert.equal(task.parentId, 'P1');
  assert.deepEqual(readdirSync(decoy), [], 'ordinary CLI must not initialize or write its local workspace hint');
  const fetched = await run(['task', 'get', '--task', task.id]);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.equal(JSON.parse(fetched.stdout).task.title, task.title);
});

test('task comment records a quiet state-free line and report rejects one', async () => {
  const root = await initialize();
  const parent = JSON.parse((await run(['task', 'new', '--title', 'Parent', '--parent', 'P1'])).stdout).task;
  // A task with children keeps its responsible; the child is the agents' own, so no notice wakes the parent.
  await withServeStopped(root, () => {
    const people = new PlacementStore(root);
    try { people.createAndPlace({ taskId: parent.id, profileKey: 'codex', responsible: true }); } finally { people.close(); }
  });
  const child = await withServeStopped(root, () => seedFixtureTask(root, parent.id, 'Child'));
  const parentBefore = JSON.parse((await run(['task', 'get', '--task', parent.id])).stdout).task;
  // A comment is the record of a Run at work on the Task.
  const { placementId, env } = await responsibleRun(root, child.id);
  const working = JSON.parse((await run(['task', 'get', '--task', child.id])).stdout).task;
  const comment = await run(['task', 'comment', '--task', child.id, '--title', 'Keep this option open',
    '--expected-task-hash', working.hash], '', false, CLI, project, env);
  assert.equal(comment.code, 0, comment.stderr);
  const saved = JSON.parse(comment.stdout).task;
  assert.equal(saved.state, working.state);
  const record = currentTaskLog(root, child.id).at(-1)!;
  assert.equal(record.kind, 'reported');
  assert.equal(record.toState, null);
  assert.deepEqual(record.actor, { kind: 'placement', placementId });
  assert.equal(record.title, 'Keep this option open');
  assert.equal(record.estimateMinutes, undefined);
  const parentAfter = JSON.parse((await run(['task', 'get', '--task', parent.id])).stdout).task;
  assert.equal(parentAfter.hash, parentBefore.hash);
  const rejected = await run(['task', 'report', '--task', child.id, '--title', 'Old short report',
    '--expected-task-hash', saved.hash], '', false, CLI, project, env);
  assert.equal(rejected.code, 2);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
});

test('extra positional ID explains the option and command help without changing the error shape', async () => {
  const result = await run(['task', 'get', 'P1']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /too many arguments|unknown command/);
});

test('unknown command and option errors identify the rejected input', async () => {
  const command = await run(['init']);
  assert.equal(command.code, 2);
  assert.match(command.stderr, /unknown command.*init/);

  const option = await run(['task', 'get', '--taks', 'P1']);
  assert.equal(option.code, 2);
  assert.match(option.stderr, /unknown option/);
});

test('CLI field get gives the fields\' JSON Schema with how to write each, and leaves it out for a held version', async () => {
  await initialize();
  const first = await run(['field', 'get']);
  assert.equal(first.code, 0, first.stderr);
  const read = fieldGetResultSchema.parse(JSON.parse(first.stdout));
  assert.match(read.version, /^[0-9a-f]{64}$/);
  // Without --task the cwd rule names the only project: the answer is for the Tasks below it.
  assert.deepEqual([read.fields, read.from], [[...DEFAULT_SCHEMA], null]);
  const properties = read.schema!.properties as Record<string, { description?: string; anyOf: unknown[] }>;
  assert.deepEqual(Object.keys(properties), [...DEFAULT_SCHEMA]);
  // Each field is its value or null (null clears it); how to write it is the field's own description.
  assert.match(properties.conclusion!.description ?? '', /\S/);
  const again = await run(['field', 'get', '--version', read.version]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(fieldGetResultSchema.parse(JSON.parse(again.stdout)), { ...read, schema: null });
});

test('workspace returns finds the current workspace and init never reinitializes it', async () => {
  const root = await initialize();
  const recovered = await run(['workspace', 'returns'], '', false, BACKEND, root);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout).acceptedRequestIds, []);
  const init = await run(['workspace', 'init'], '', false, BACKEND, root);
  assert.notEqual(init.code, 0);
  assert.equal(JSON.parse(init.stderr).error.code, 'already_initialized');
});

test('explicit server takes precedence over an invalid environment source', async () => {
  const root = await initialize();
  const result = await run(['task', 'list'], '', false, BACKEND, project, { ALPACAWORK_SERVER: 'ftp://invalid' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).tasks.map((task: { id: string }) => task.id), ['P1']);
  assert.equal(existsSync(root), true);
});

test('CLI rejects malformed options before side effects', async () => {
  const root = join(area, 'uncreated');
  for (const args of [
    ['workspace', 'init', '--title', 'first', '--title', 'second'],
    ['workspace', 'init', '--title'],
    ['workspace', 'init', '--title', 'x', '--unknown', 'x'],
    ['workspace', 'init', '--title', 'x', 'extra'],
    ['workspace', 'serve', '--port', '65536'],
  ]) {
    const result = await run(['--workspace', root, ...args]);
    assert.equal(result.code, 2, JSON.stringify({args, ...result}));
    assert.equal(result.stdout, '');
    assert.ok(['invalid_input', 'invalid_option'].includes(JSON.parse(result.stderr).error.code));
  }
  assert.equal(existsSync(root), false);
});

test('serve accepts explicit ephemeral port, keeps CLI-only operations private and closes on signal', async t => {
  const root = await initialize();
  await server!.stop();
  const child = launch(['--workspace', root, 'workspace', 'serve', '--port', '0']);
  t.diagnostic(`serve PID ${child.pid}`);
  child.stdin.end();
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({input: child.stdout});
  const [line] = await Promise.race([once(lines, 'line'), once(child, 'close').then(() => { throw new Error(stderr); })]);
  const startup = JSON.parse(line);
  assert.equal("control" in startup,false);
  assert.deepEqual(Object.keys(startup).sort(),["connection","root","url"]);
  const base = new URL(startup.url).origin;
  assert.ok(new URL(base).port);
  assert.equal(await httpStatus(base + '/api/field/get'), 200);
  assert.equal(await httpStatus(base + '/api/field/get?root=other'), 400);
  assert.equal(await httpStatus(base + '/api/field/get-rules'), 404);
  assert.equal((await run(['schema', 'get-rules'])).code, 2);
  for (const operation of ['workspace', 'serve', 'capture', 'flush'])
    assert.equal(await httpStatus(base + '/api/' + operation), 404);
  const done = once(child, 'close');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
  child.kill('SIGTERM');
  const [code, signal] = await done;
  clearTimeout(watchdog);
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  await assert.rejects(fetch(base + '/api/field/get'));
});

for (const explicit of [false, true]) test(`a Run cannot serve another workspace through ${explicit ? '--workspace' : 'ALPACAWORK_WORKSPACE'}`, async () => {
  const rootA = await initialize(), rootB = join(area, 'other');
  const initialized = await run(['--workspace', rootB, 'workspace', 'init'], '', false, BACKEND, area,
    { XDG_CONFIG_HOME: join(area, 'other-installation') });
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.ok(rootA.startsWith(realpathSync(tmpdir()) + '/alpacawork-cli-'));
  assert.ok(rootB.startsWith(realpathSync(tmpdir()) + '/alpacawork-cli-'));
  const args = explicit ? ['--workspace', rootB, 'workspace', 'serve', '--port', '0']
    : ['workspace', 'serve', '--port', '0'];
  const result = await run(args, '', false, BACKEND, area, {
    ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: 'synthetic-token', ALPACAWORK_WORKSPACE: explicit ? rootA : rootB,
    PATH: '/usr/bin:/bin',
    XDG_CONFIG_HOME: join(area, 'unregistered-run-environment'),
  });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.stdout, '');
  // A named workspace refuses the Run; ALPACAWORK_WORKSPACE is not read, so it names no workspace to serve.
  assert.equal(JSON.parse(result.stderr).error.code, explicit ? 'forbidden' : 'invalid_root');
  assert.equal(existsSync(join(rootB, '.alpacawork/connection.json')), false);
});

for (const degraded of [false, true]) test(`serve startup failure releases its listener and temporary connection file${degraded ? ' with a degraded watcher' : ''}`, async t => {
  const root = await initialize();
  await server!.stop();
  rmSync(join(root, '.alpacawork/connection.json'), { force: true });
  mkdirSync(join(root, '.alpacawork/connection.json'));
  const preload = join(area, 'watch-fault.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
fs.watch=()=>{throw Object.assign(new Error('synthetic watch capacity fault'),{code:'EMFILE'})}; syncBuiltinESMExports();\n`);
  const result = await run(['--workspace', root, 'workspace', 'serve', '--port', '0'], '', false, BACKEND, project,
    degraded ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}` } : {});
  // Serve diagnostics are JSON lines on stderr. Keep every raw byte before checking the command error.
  t.diagnostic(JSON.stringify({ startupFailure: result, degraded }));
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  const records = result.stderr.trim().split('\n').map(line => JSON.parse(line));
  const errors = records.filter(record => record.error);
  assert.equal(errors.length, 1, result.stderr);
  assert.equal(errors[0].error.code, 'unavailable');
  for (const record of records) assert.ok(record.error || record.workspaceWatch, result.stderr);
  if (degraded) assert.ok(records.some(record => record.workspaceWatch?.code === 'EMFILE'), result.stderr);
  assert.equal(readdirSync(join(root, '.alpacawork')).some(name => name.endsWith('.tmp')), false);
});
