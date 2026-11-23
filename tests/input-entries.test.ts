import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { commandCatalog, commandRuleHelp } from '@alpacawork/contract/commands';
import { collectHttpRoutes } from '@alpacakit/channels/http';
import { Problem } from '@alpacawork/core';
import { DEFAULT_LIMITS } from '@alpacawork/contract';
import { taskReportRules, taskRequestRules } from '@alpacawork/contract/inputs';
import { MAX_INSTRUCTION_BYTES } from '@alpacawork/raw';
import { screenTree } from '@alpacawork/backend/test-dist/receiver/entries.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { isolatedServe, cliSync } from './helpers/http-cli.ts';
import { problemSchema } from '@alpacawork/contract/problem';
import { randomUUID } from 'node:crypto';

const digest = '0'.repeat(64);
/** A launch profile that never runs anything: no wake the server starts launches an agent. */
const AGENTS = stringify({ agents: { "codex": fixtureAgentSetting('codex') } });
function command(server: string, args: string[]) {
  const mutation = ['new', 'update', 'request', 'report', 'comment', 'set', 'release', 'stop'].includes(args[1] ?? '');
  const result = cliSync(server, mutation && !args.includes('--op-id') ? [...args, '--op-id', randomUUID()] : args);
  return { status: result.code, stdout: result.stdout, stderr: result.stderr };
}
/** The root project P1 and the test project below it (`project`), served. */
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-input-entry-')));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(AGENTS)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const server = await isolatedServe(root, t);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** A file the CLI reads an option from, with the same text the HTTP case sends. */
  const file = (name: string, text: string) => {
    const path = join(root, name);
    writeFileSync(path, text);
    return path;
  };
  return { root, server, project, file };
}
type Case = { path: string; field: string; code?: string; value: Record<string, unknown>; cli: string[] };
/** POSTs `value` (a GET for run/get) and runs `cli`: both refuse with the same Problem, naming `field`. */
async function sameRefusal(server: { url: string }, item: Case) {
  const get = item.path === 'commands/run/get';
  const url = new URL(`/api/${item.path}`, server.url);
  if (get) for (const [key, value] of Object.entries(item.value)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { method: get ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, ...(get ? {} : { body: JSON.stringify(item.value) }) });
  assert.equal(response.status, 400, item.path);
  const fromHttp = problemSchema.parse(await response.json()).error;
  assert.notEqual(fromHttp.issues, undefined);
  assert.ok(!Object.hasOwn(fromHttp.reason ?? {}, 'issues'));
  assert.equal(fromHttp.code, 'invalid_input', item.path);
  assert(fromHttp.issues?.some(issue => issue.path === item.field && (item.code === undefined || issue.code === item.code)),
    `${item.path} ${item.field}: ${JSON.stringify(fromHttp.issues)}`);
  const cli = command(server.url, item.cli);
  assert.equal(cli.status, 2, `${item.path}: ${cli.stderr}`);
  assert.deepEqual(problemSchema.parse(JSON.parse(cli.stderr)).error, fromHttp, item.path);
}

// Refusals change nothing, so one serve answers both.
test('CLI and HTTP refuse alike', async t => {
  const { server, file } = await fixture(t);
  await t.test('shared entries return the same field issue and refusal', async () => {
    // A transport-only string check accepts this title; the entry's value rule must reject it.
    assert.equal(z.string().safeParse('x'.repeat(201)).success, true);
    const opId = randomUUID();
    const instruction = file('instruction.md', 'Work on it.');
    for (const item of [
      { path: 'commands/task/new', field: 'title', value: { title: 'x'.repeat(201), parent: 'P1' },
        cli: ['task', 'new', '--title', 'x'.repeat(201), '--parent', 'P1'] },
      { path: 'commands/task/report', field: 'task', value: { task: 'T0', state: 'doing', title: 'Report', opId, expectedTaskHash: digest },
        cli: ['task', 'report', '--task', 'T0', '--state', 'doing', '--title', 'Report', '--expected-task-hash', digest,
          '--op-id', opId] },
      // Unknown states remain invalid on both entries; todo/error are valid hold restoration inputs.
      { path: 'commands/task/report', field: 'askTo', value: { task: 'P1', state: 'waiting', askTo: 'requester', opId, expectedTaskHash: digest },
        cli: ['task', 'report', '--task', 'P1', '--state', 'waiting', '--ask-to', 'requester', '--expected-task-hash', digest,
          '--op-id', opId] },
      { path: 'commands/task/report', field: 'state', value: { task: 'P1', state: 'unknown', title: 'Report', opId, expectedTaskHash: digest },
        cli: ['task', 'report', '--task', 'P1', '--state', 'unknown', '--title', 'Report', '--expected-task-hash', digest,
          '--op-id', opId] },
      { path: 'commands/task/request', field: 'task', value: { task: 'T0', instruction: 'Work on it.', opId, expectedTaskHash: digest,
        expectedPlacementRevision: 1 },
      cli: ['task', 'request', '--task', 'T0', '--instruction-file', instruction, '--expected-task-hash', digest,
        '--expected-placement-revision', '1', '--op-id', opId] },
      { path: 'commands/run/get', field: 'run', value: { run: 'R0' }, cli: ['run', 'get', '--run', 'R0'] },
    ]) await sameRefusal(server, item);
  });
  await t.test('report and request refuse each of their own input rules, and -h states each rule', async () => {
    const values = file('values.json', '{"notes":"Done."}'), instruction = file('instruction.md', 'Work on it.');
    const description = file('description.md', 'Done.');
    const report = (field: string, code: string, value: Record<string, unknown>, cli: string[]): Case => {
      const opId = randomUUID();
      return { path: 'commands/task/report', field, code, value: { task: 'P1', ...value, opId, expectedTaskHash: digest },
        cli: ['task', 'report', '--task', 'P1', ...cli, '--expected-task-hash', digest, '--op-id', opId] };
    };
    const request = (field: string, code: string, value: Record<string, unknown>, cli: string[]): Case => {
      const opId = randomUUID();
      return { path: 'commands/task/request', field, code, value: { task: 'P1', instruction: 'Work on it.', ...value, opId },
        cli: ['task', 'request', '--task', 'P1', '--instruction-file', instruction, ...cli, '--op-id', opId] };
    };
    const versions = { expectedTaskHash: digest, expectedPlacementRevision: 1 };
    const versionFlags = ['--expected-task-hash', digest, '--expected-placement-revision', '1'];
    // One case per rule of each table, in the tables' order.
    const reportCases = [
      report('askTo', 'incompatible', { state: 'doing', askTo: 'user' }, ['--state', 'doing', '--ask-to', 'user']),
      report('values', 'required', { state: 'doing', nextConversation: 'new' }, ['--state', 'doing', '--next-conversation', 'new']),
      report('values', 'incompatible', { state: 'stopped', values: { notes: 'Done.' } }, ['--state', 'stopped', '--values-file', values]),
      report('state', 'exactly_one', { title: 'Report' }, ['--title', 'Report']),
      report('title', 'required', { state: 'doing', description: 'Done.' }, ['--state', 'doing', '--description-file', description]),
      report('title', 'incompatible', { withdraw: 'L1', title: 'Report' }, ['--withdraw', 'L1', '--title', 'Report']),
      report('urgent', 'incompatible', { state: 'doing', title: 'Report', urgent: 'Read it now' },
        ['--state', 'doing', '--title', 'Report', '--urgent', 'Read it now']),
      report('expectedPlacementRevision', 'required', { state: 'done', aboutRun: 'R1' }, ['--state', 'done', '--about-run', 'R1']),
      report('estimateMinutes', 'incompatible', { state: 'done', estimateMinutes: 30 }, ['--state', 'done', '--estimate-minutes', '30']),
    ];
    const requestCases = [
      request('agent', 'incompatible', { answers: 'L1', agent: 'P1' }, ['--answers', 'L1', '--agent', 'P1']),
      request('expectedTaskHash', 'required', {}, []),
      request('expectedPlacementRevision', 'required', { expectedTaskHash: digest }, ['--expected-task-hash', digest]),
    ];
    assert.deepEqual([reportCases.length, requestCases.length], [taskReportRules.length, taskRequestRules.length]);
    for (const item of [...reportCases, ...requestCases]) await sameRefusal(server, item);
    // The same tables are what -h says of each command.
    for (const [verb, rules] of (['report', 'request'] as const).map(name =>
      [name, commandRuleHelp(commandCatalog.commands.find(command => command.id === `task/${name}`)!, true)] as const)) {
      const help = command(server.url, ['task', verb, '-h']);
      assert.equal(help.status, 0, help.stderr);
      for (const line of rules) assert.ok(help.stdout.includes(line), `task ${verb} -h: ${line}`);
    }
  });
});

test('CLI-only entries name the rejected option, including file content and stdin', async t => {
  const { root, server, project, file } = await fixture(t);
  const instruction = file('instruction.md', 'Start.');
  const cases: { args: string[]; field?: string; message?: RegExp; exit: number }[] = [
    { args: ['task', 'get', '--task', 'T0'], field: 'task', exit: 2 },
    { args: ['task', 'list', '--under', 'T0'], field: 'under', exit: 2 },
    { args: ['agent', 'release', '--task', 'T0', '--agent', 'P1', '--expected-task-hash', digest,
      '--expected-placement-revision', '1'], field: 'task', exit: 2 },
    { args: ['task', 'update', '--task', 'P1', '--values-file', 'relative.json', '--expected-task-hash', digest],
      message: /--values-file/, exit: 2 },
    { args: ['task', 'update', '--task', 'P1', '--values-file', file('not-json.json', '- goal: x'), '--expected-task-hash', digest],
      field: 'values', exit: 2 },
    // The CLI names the option when its JSON cannot be decoded.
    { args: ['task', 'request', '--task', 'P1', '--instruction-file', instruction, '--selected', '{',
      '--expected-task-hash', digest, '--expected-placement-revision', '1'], field: 'selected', exit: 2 },
    { args: ['agent', 'assign', '--task', 'P1', '--role', 'responsible', '--profile', 'codex', '--selected', '{',
      '--expected-task-hash', digest], field: 'selected', exit: 2 },
    // Two flags that send the same field, or two that read stdin, are refused before anything is read.
    { args: ['task', 'new', '--title', 'Both marks', '--parent', project, '--from-user', '--no-from-user'],
      message: /--from-user and --no-from-user cannot be used together/, exit: 2 },
    { args: ['task', 'new', '--title', 'Two stdins', '--parent', project, '--values-file', '-',
      '--plan-file', '-'], message: /Only one option can read stdin/, exit: 2 },
  ];
  for (const item of cases) {
    const result = command(server.url, item.args);
    assert.equal(result.status, item.exit, `${item.args.join(' ')}: ${result.stderr}`);
    const error = problemSchema.parse(JSON.parse(result.stderr)).error;
    assert.equal(error.code, 'invalid_input', item.args.join(' '));
    if (item.message) assert.match(error.message, item.message, item.args.join(' '));
    else assert(error.issues?.some(issue => issue.path === item.field), item.args.join(' '));
  }
  assert.deepEqual((await new ControlTaskStore(root).snapshot()).tasks.map(task => task.id), ['P1', project]);
});

test('agent assign exposes and sends selected JSON over the public CLI and rejects invalid HTTP choices atomically', async t => {
  const { root, server, project } = await fixture(t);
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { codex: { ...fixtureAgentSetting('codex'), params: { ...fixtureAgentSetting('codex').params, model: ['large', 'small'] } } } }));
  const created = command(server.url, ['task', 'new', '--title', 'Selected agent', '--parent', project]);
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  const help = command(server.url, ['agent', 'assign', '-h']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--selected/);
  const selected = { model: 'small' };
  const placed = command(server.url, ['agent', 'assign', '--task', task.id, '--role', 'responsible', '--profile', 'codex',
    '--selected', JSON.stringify(selected), '--expected-task-hash', task.hash, '--op-id', randomUUID()]);
  assert.equal(placed.status, 0, placed.stderr);
  const current = await new ControlTaskStore(root).get(task.id);
  assert.deepEqual(current.meta.log.at(-1)?.launchValues, selected);
  const response = await fetch(new URL('/api/commands/agent/assign', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: task.id, role: 'responsible',
      profile: 'codex', selected: { model: 'missing' }, expectedTaskHash: current.hash }) });
  assert.equal(response.status, 400);
  assert.equal(problemSchema.parse(await response.json()).error.code, 'invalid_input');
  assert.equal((await new ControlTaskStore(root).get(task.id)).hash, current.hash);
  const store = new PlacementStore(root, true);
  try { assert.equal(store.agents().length, 1); assert.equal(store.placements().length, 1); }
  finally { store.close(); }
});

test('HTTP entries report their public field before touching state', async t => {
  const { server } = await fixture(t);
  const cases: { path: string; method: 'GET' | 'POST'; field: string; value: Record<string, unknown> }[] = [
    { path: 'task/view', method: 'GET', field: 'task', value: { task: 'T0' } },
    { path: 'task/search', method: 'GET', field: 'limit', value: { text: '', limit: 0 } },
    { path: 'commands/config/set', method: 'POST', field: '', value: { config: 'limits: [', agents: 'agents: {}', expectedConfigHash: digest } },
    { path: 'commands/settings/set', method: 'POST', field: 'key', value: { key: 'unknown', value: true, expectedRevision: 'r' } },
    { path: 'person/notices/save', method: 'POST', field: 'state', value: { state: {}, expectedRevision: null } },
    { path: 'notify/subscribe', method: 'POST', field: 'subscription', value: { subscription: {
      endpoint: 'https://example.com/push', keys: { p256dh: 'a', auth: 'b' } }, label: 'device' } },
    { path: 'notify/unsubscribe', method: 'POST', field: 'id', value: { id: '' } },
  ];
  for (const item of cases) {
    const url = new URL(`/api/${item.path}`, server.url);
    if (item.method === 'GET') for (const [key, value] of Object.entries(item.value)) url.searchParams.set(key, String(value));
    const response = await fetch(url, { method: item.method, headers: { 'content-type': 'application/json' },
      ...(item.method === 'POST' ? { body: JSON.stringify(item.value) } : {}) });
    assert.equal(response.status, 400, item.path);
    const error = problemSchema.parse(await response.json()).error;
    assert.equal(error.code, 'invalid_input', item.path);
    assert(error.issues?.some(issue => issue.path === item.field || issue.path.startsWith(`${item.field}.`)), item.path);
  }
  const file = await fetch(new URL('/api/tasks/T0/file?path=safe.txt', server.url));
  assert.equal(file.status, 400);
  assert(problemSchema.parse(await file.json()).error.issues?.some(issue => issue.path === 'task'));
});

test('invalid HTTP entry fields win over unavailable push and index services', () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  collectHttpRoutes(screenTree).forEach(route => handlers.set(route.path, route.handler as (input: unknown, context: unknown) => unknown));
  for (const { path, input, field } of [
    { path: '/notify/unsubscribe', input: { id: '' }, field: 'id' },
    { path: '/task/view', input: { task: 'T0' }, field: 'task' },
    { path: '/task/search', input: { text: '', limit: '0' }, field: 'limit' },
  ]) {
    const handler = handlers.get(path);
    assert(handler, path);
    assert.throws(() => handler(input, {}), (error: unknown) => error instanceof Problem &&
      error.code === 'invalid_input' && error.issues?.some(issue => issue.path === field) === true, path);
  }
});

test('oversized local CLI files and HTTP fields both refuse before writing', async t => {
  const { root, server } = await fixture(t);
  for (const item of [
    { path: 'commands/task/request', option: '--instruction-file', limit: MAX_INSTRUCTION_BYTES,
      input: { task: 'P1', expectedTaskHash: digest, opId: 'oversized-test', expectedPlacementRevision: 1 } },
  ]) {
    const body = 'x'.repeat(item.limit + 1);
    const file = join(root, `${item.path.split('/').at(-1)}-oversized.md`);
    writeFileSync(file, body);
    const response = await fetch(new URL(`/api/${item.path}`, server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...item.input, instruction: body }) });
    assert.equal(response.status, 400, item.path);
    const http = problemSchema.parse(await response.json()).error;
    const cli = command(server.url, [item.path.split('/').at(-2)!, item.path.split('/').at(-1)!, '--task', 'P1',
      item.option, file, '--expected-task-hash', digest,
      ...(item.path === 'commands/task/request' ? ['--op-id', 'oversized-test', '--expected-placement-revision', '1'] : [])]);
    assert.equal(cli.status, 2, `${item.path}: ${cli.stderr}`);
    const fileError = problemSchema.parse(JSON.parse(cli.stderr)).error;
    assert.equal(fileError.code, 'too_large', item.path);
    assert.match(fileError.message, /exceeds/, item.path);
    assert(http.issues?.some(issue => issue.path === 'instruction' && issue.code === 'too_big' &&
      issue.params?.maximum === item.limit), item.path);
  }
});

test('config set gives CLI and HTTP the same screen field paths', async t => {
  const { server } = await fixture(t);
  const current = await (await fetch(new URL('/api/commands/config/get', server.url))).json() as { hash: string };
  const limits = { ...DEFAULT_LIMITS };
  const valid = { limits };
  const examples: { field: string; code?: string; config: string; agents: string; line?: number }[] = [
    { field: 'limits.parallel', config: JSON.stringify({ limits: { ...limits, parallel: 0 } }), agents: 'agents: {}\n' },
    { field: 'limits.coordinator_run_minutes', config: JSON.stringify({ limits: { ...limits, coordinator_run_minutes: 0 } }),
      agents: 'agents: {}\n' },
    { field: 'limits.coordinator_command_seconds', config: JSON.stringify({ limits: { ...limits, coordinator_command_seconds: 0 } }),
      agents: 'agents: {}\n' },
    // A project's fields are its Task's (field use); config set takes the limits alone.
    { field: '', code: 'unrecognized_keys', config: JSON.stringify({ ...valid, extracts: [] }), agents: 'agents: {}\n' },
    { field: 'agentsText', config: JSON.stringify(valid), agents: 'agents:\n  invalid: [\n' },
    { field: 'agentsText', config: JSON.stringify(valid), line: 4,
      agents: 'agents:\n  fake:\n    adapter: claude\n    params: {model: [one, one], effort: []}\n' },
  ];
  for (const { field, code, config, agents, line } of examples) {
    const input = { config, agents, expectedConfigHash: current.hash };
    const response = await fetch(new URL('/api/commands/config/set', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 400, field);
    const http = problemSchema.parse(await response.json()).error;
    const cli = command(server.url, ['config', 'set', '--config', config, '--agents', agents,
      '--expected-config-hash', current.hash]);
    assert.equal(cli.status, 2, `${field}: ${cli.stderr}`);
    const fromCli = problemSchema.parse(JSON.parse(cli.stderr)).error;
    const { detail, ...wireError } = fromCli;
    const operation = (detail as { operation: { attempts: number; server: string } }).operation;
    assert.equal(operation.attempts, 1);
    assert.equal(operation.server, new URL(server.url).origin);
    assert.deepEqual(wireError, http, field);
    assert(http.issues?.some(issue => issue.path === field && (code === undefined || issue.code === code)), field);
    if (line) assert(http.issues?.some(issue => issue.path === field && issue.params?.line === line), field);
  }
});


test('task new and update save values through CLI and HTTP, only the fields sent', async t => {
  const { root, server, project, file } = await fixture(t);
  const stored = async (id: string) => (await new ControlTaskStore(root).get(id)).values;
  const values = { goal: 'Recorded at creation', policy: ['One', 'Two'], notes: 'The context\nis known.' };
  const viaCli = command(server.url, ['task', 'new', '--title', 'By CLI', '--parent', project,
    '--values-file', file('initial.json', JSON.stringify(values))]);
  assert.equal(viaCli.status, 0, viaCli.stderr);
  const cliTask = JSON.parse(viaCli.stdout).task as { id: string; hash: string; values: unknown };
  assert.deepEqual(cliTask.values, values);
  const response = await fetch(new URL('/api/commands/task/new', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'By HTTP', parent: project, values }) });
  assert.equal(response.status, 200, await response.clone().text());
  const httpTask = (await response.json() as { task: { id: string } }).task;
  assert.deepEqual(await stored(httpTask.id), values);
  // A field left out keeps its value, null clears one, a list is replaced whole.
  const updated = command(server.url, ['task', 'update', '--task', cliTask.id, '--expected-task-hash', cliTask.hash,
    '--values-file', file('update.json', JSON.stringify({ goal: null, policy: ['Three'] }))]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(await stored(cliTask.id), { policy: ['Three'], notes: 'The context\nis known.' });
});

test('values that do not fit the schema are refused alike over CLI and HTTP, naming each field, writing nothing', async t => {
  const { root, server, project, file } = await fixture(t);
  for (const [field, values] of [['unknown', { unknown: 'x' }], ['goal', { goal: 'x'.repeat(401) }],
    ['policy.1', { policy: ['ok', 42] }], ['decide.0.decide_question', { decide: [{ decide_question: ' ' }] }]] as const) {
    const response = await fetch(new URL('/api/commands/task/new', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Invalid', parent: project, values }) });
    assert.equal(response.status, 400, field);
    const http = problemSchema.parse(await response.json()).error;
    assert(http.issues?.some(issue => issue.path === field),
      `${field}: ${JSON.stringify(http.issues)}`);
    const cli = command(server.url, ['task', 'new', '--title', 'Invalid', '--parent', project,
      '--values-file', file('invalid.json', JSON.stringify(values))]);
    assert.equal(cli.status, 2, cli.stderr);
    assert.deepEqual(problemSchema.parse(JSON.parse(cli.stderr)).error.issues, http.issues, field);
  }
  assert.deepEqual((await new ControlTaskStore(root).snapshot()).tasks.map(task => task.id), ['P1', project]);
});
