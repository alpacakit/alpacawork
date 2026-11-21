import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecordSchema, runFolder, RUN_FILES, type RunRecord } from '@alpacawork/contract/run';
import { controlRunSchema, projectedIndexSchema, taskHistoryWindowSchema, taskProjectedViewSchema } from '@alpacawork/contract/control';
import { controlRuns } from '@alpacawork/backend/test-dist/control/tree.js';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { commandFetch } from './helpers/command-fetch.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/run-error-cause/${name}`, import.meta.url), 'utf8');
const codex = fixture('codex-stdout.jsonl'), claude = fixture('claude-stdout.jsonl');
const thread = '00000000-0000-4000-8000-000000000102', session = '00000000-0000-4000-8000-000000000101';
const capacity = 'Selected model is at capacity. Please try a different model.';
const weekly = "You've hit your weekly limit · resets Feb 4, 12am (UTC)";
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const prefix = jsonl({ type: 'thread.started', thread_id: thread }, { type: 'turn.started' });
const compact = prefix + jsonl(...JSON.parse(fixture('codex-events.json')));
const at = '2001-02-03T10:00:00.000Z';
const claudeLaunch = { adapter: 'claude' as const, env: [], argv: ['unused'], path: '/bin', values: {} };
function record(changes: Partial<RunRecord> = {}): RunRecord {
  return runRecordSchema.parse({ id: 'R1', task: 'T1', placementId: 'Ptest', requestId: 'Qtest', agent: 'custom', role: 'worker',
    resumes: null, continues: false, session: { provider: null, id: thread }, caller: null, cwd: '/tmp',
    launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} },
    state: 'failed', reason: 'exit', into: null, stop_requested: false, exit: { code: 1, signal: null }, usage: null,
    created_at: at, started_at: at, ended_at: at, pids: { manager: null, agent: null }, ...changes });
}
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-error-cause-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = runFolder(root, 'R1');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return { root, folder, project(log: string | Buffer, changes: Partial<RunRecord> = {}) {
    writeFileSync(join(folder, RUN_FILES.stdout), log);
    return controlRunSchema.parse(controlRuns(root, [record(changes)])[0]);
  } };
}

test('native error signatures reach the control projection as closed display keys', t => {
  const h = setup(t);
  assert.equal(h.project(codex).errorCause, 'model_capacity');
  assert.equal(h.project(compact, { reason: 'output' }).errorCause, 'model_capacity');
  assert.equal(h.project(claude, { launch: claudeLaunch, session: { provider: null, id: session } }).errorCause, 'weekly_limit');
  assert.equal(h.project(codex, { agent: 'claude', session: { provider: 'claude', id: thread } }).errorCause, 'model_capacity',
    'event shape and session identity matter, not the configured provider label');
  assert.equal(JSON.stringify(h.project(codex)).includes(capacity), false);
});

test('unknown, ordinary text, other sessions and successful turns omit the field', async t => {
  const h = setup(t);
  const cases: [string, string, Partial<RunRecord>?][] = [
    ['unknown error', prefix + jsonl({ type: 'error', message: 'capacity exhausted?' }, { type: 'turn.failed', error: { message: 'unknown failure' } })],
    ['unknown terminal overrides known error', codex + jsonl({ type: 'turn.failed', error: { message: 'unknown failure' } })],
    ['partial signature', prefix + jsonl({ type: 'error', message: 'Selected model is at capacity.' })],
    ['Codex assistant quotation', prefix + jsonl({ type: 'item.completed', item: { type: 'agent_message', text: capacity } })],
    ['Codex tool quotation', prefix + jsonl({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: capacity } })],
    ['Task text', jsonl({ type: 'task.report', text: capacity })],
    ['stderr only', ''],
    ['wrong Codex session', codex, { session: { provider: 'codex', id: 'other' } }],
    ['missing Run session', codex, { session: null }],
    ['missing thread witness', jsonl(...JSON.parse(fixture('codex-events.json')))],
    ['explicit foreign error', prefix + jsonl({ type: 'error', thread_id: 'child', message: capacity })],
    ['Codex child envelope', prefix + jsonl({ type: 'error', parent_tool_use_id: 'child', message: capacity })],
    ['same turn success', codex + jsonl({ type: 'turn.completed' })],
    ['later turn success', codex + jsonl({ type: 'turn.started' }, { type: 'turn.completed' })],
    ['later turn incomplete', codex + jsonl({ type: 'turn.started' })],
    ['wrong Claude session', claude, { launch: claudeLaunch }],
    ['Claude ordinary assistant', jsonl({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: weekly }] } }), { launch: claudeLaunch, session: { provider: null, id: session } }],
    ['Claude tool output', jsonl({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', content: weekly }] } }), { launch: claudeLaunch, session: { provider: null, id: session } }],
    ['Claude child result', jsonl({ type: 'result', session_id: session, parent_tool_use_id: 'child', is_error: true, result: weekly }), { launch: claudeLaunch, session: { provider: null, id: session } }],
    ['Claude successful result', claude + jsonl({ type: 'result', session_id: session, is_error: false, result: weekly }), { launch: claudeLaunch, session: { provider: null, id: session } }],
    ['Claude unknown terminal', claude + jsonl({ type: 'result', session_id: session, is_error: true, result: 'unknown' }), { launch: claudeLaunch, session: { provider: null, id: session } }],
    ['Claude later command', claude + jsonl({ type: 'command_lifecycle', session_id: session, state: 'started' }), { launch: claudeLaunch, session: { provider: null, id: session } }],
    ['malformed JSON after error', codex + '{oops\n'],
  ];
  writeFileSync(join(h.folder, RUN_FILES.stderr), capacity);
  for (const [name, log, changes] of cases) await t.test(name, () => {
    assert.equal(Object.hasOwn(h.project(log, changes), 'errorCause'), false);
  });
});

test('normal Runs and existing non-provider failure reasons are preserved', async t => {
  const h = setup(t);
  const cases: Partial<RunRecord>[] = [
    { state: 'succeeded', reason: null }, { state: 'running', reason: null, ended_at: null },
    { state: 'cancelled', reason: 'stopped' }, { reason: 'timeout' }, { reason: 'attachment_save' }, { reason: 'launch' },
  ];
  for (const changes of cases) await t.test(String(changes.reason ?? changes.state), () => {
    const run = record(changes), projected = h.project(codex, changes);
    assert.equal(Object.hasOwn(projected, 'errorCause'), false);
    assert.deepEqual([projected.state, projected.reason], [run.state, run.reason]);
  });
});

test('bounded reads and ordinary Run file access preserve diagnostic evidence', t => {
  const h = setup(t), stdout = join(h.folder, RUN_FILES.stdout);
  const working = jsonl({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(256 * 1024) } });
  assert.equal(Object.hasOwn(controlRuns(h.root, [record()])[0]!, 'errorCause'), false, 'absent log');
  assert.equal(h.project(prefix + working + jsonl({ type: 'turn.failed', error: { message: capacity } })).errorCause, 'model_capacity',
    'a failure at the end of a log longer than the old 256KiB bound is still read');
  assert.equal(Object.hasOwn(h.project(jsonl({ type: 'x', item: 'y'.repeat(2 * 1024 * 1024 + 1) }) + codex), 'errorCause'), false,
    'a line over the line bound');
  assert.equal(Object.hasOwn(h.project(Buffer.concat([Buffer.from(codex), Buffer.from([0xff])])), 'errorCause'), false, 'invalid UTF8');
  assert.equal(Object.hasOwn(h.project(codex + working + jsonl({ type: 'turn.completed' })), 'errorCause'), false,
    'a known prefix must not hide a success outside the bound');
  rmSync(stdout);
  const target = join(h.root, 'outside.jsonl');
  writeFileSync(target, codex);
  symlinkSync(target, stdout);
  assert.equal(controlRuns(h.root, [record()])[0]!.errorCause, 'model_capacity', 'ordinary symlink access reads the same failure');
  writeFileSync(target, prefix + jsonl({ type: 'turn.failed', error: { message: 'changed target' } }));
  assert.equal(Object.hasOwn(controlRuns(h.root, [record()])[0]!, 'errorCause'), false, 'target changes invalidate cached classification');
  writeFileSync(target, codex);
  rmSync(stdout);
  linkSync(target, stdout);
  assert.equal(controlRuns(h.root, [record()])[0]!.errorCause, 'model_capacity', 'ordinary hard-link access reads the same failure');
  rmSync(stdout);
  mkdirSync(stdout);
  assert.equal(Object.hasOwn(controlRuns(h.root, [record()])[0]!, 'errorCause'), false, 'directory');
});

test('synthetic fixture logs reach the live index while opened views carry durable facts', async t => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(() => server?.close());
  const h = setup(t), writer = new FileWriter(h.root);
  writeFileSync(join(h.root, 'config.yaml'), 'agents: {}\n');
  let project: string;
  try { project = initializeControlFixture(h.root); } finally { writer.close(); }
  const commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const task = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'Failure display' }] })).tasks[0]!;
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => store.close());
  const seeded: { id: string; expected?: string }[] = [];
  for (const [log, sid, expected, state] of [[codex, thread, 'model_capacity', 'failed'], [compact, thread, 'model_capacity', 'failed'],
    [claude, session, 'weekly_limit', 'failed'], [prefix + jsonl({ type: 'error', message: 'unknown' }), thread, undefined, 'failed'],
    [codex + jsonl({ type: 'turn.completed' }), thread, undefined, 'failed'],
    [prefix + jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }, { type: 'turn.completed' }), thread, undefined, 'succeeded'],
    [jsonl({ type: 'result', session_id: session, is_error: false, result: 'Done.' }), session, undefined, 'succeeded']] as const) {
    const run = store.write(tx => {
      const created = createFixtureRun(store, tx, { task: task.id, placementId: `Ptest-${seeded.length}`, requestId: crypto.randomUUID(),
        agent: 'custom', role: 'owner', resumes: null, continues: false, session: { provider: null, id: sid }, caller: null,
        cwd: h.root, launch: sid === session ? claudeLaunch : record().launch }, 'Prompt');
      tx.update({ ...created, state: 'running', started_at: at });
      const ended = { ...tx.get(created.id)!, state, reason: state === 'failed' ? 'exit' as const : null,
        ended_at: at, exit: { code: state === 'failed' ? 1 : 0, signal: null } };
      if (state === 'succeeded') tx.finish(ended, { state: 'present', text: 'Done.' });
      else tx.update(ended);
      return tx.get(created.id)!;
    });
    mkdirSync(runFolder(h.root, run.id), { recursive: true });
    writeFileSync(join(runFolder(h.root, run.id), RUN_FILES.stdout), log);
    seeded.push({ id: run.id, expected });
  }
  server = await startServer(h.root, 0);
  const response = await commandFetch(new URL('/api/workspace/live', server.url));
  assert.equal(response.status, 200);
  const body = await response.json(), index = projectedIndexSchema.parse(body);
  for (const { id, expected } of seeded) {
    const run = index.runs.find(run => run.id === id);
    assert.ok(run, id);
    assert.equal(run.errorCause, expected, id);
    assert.equal(Object.hasOwn(run, 'errorCause'), expected !== undefined, id);
    assert.equal(Object.hasOwn(store.get(id)!, 'errorCause'), false, 'derived value never saved');
  }
  const view = taskProjectedViewSchema.parse(await (await commandFetch(new URL(`/api/task/view?task=${task.id}`, server.url))).json());
  assert.ok(view.runs.every(run => !Object.hasOwn(run, 'errorCause')));
  // History's row for each failed Run says the same cause, and a failure without one keeps its general reason.
  const history = taskHistoryWindowSchema.parse(await (await commandFetch(new URL(`/api/task/history?task=${task.id}&mode=latest`, server.url))).json());
  const rows = new Map(history.events.filter(event => event.kind === 'error').map(event => [event.id, event.cause]));
  for (const { id, expected } of seeded) if (rows.has(id)) assert.equal(rows.get(id), expected, `history ${id}`);
  assert.equal([...rows.values()].filter(Boolean).length, seeded.filter(each => each.expected).length);
  assert.equal(JSON.stringify(body).includes(capacity), false);
  assert.equal(JSON.stringify(body).includes(weekly), false);
});

test('the shared diagnostic keeps the reset words and redacts general errors before bounding them', async t => {
  const { readRunFailure } = await import('@alpacawork/backend/test-dist/runs/error-cause.js');
  const h = setup(t);
  const project = (log: string, changes: Partial<RunRecord> = {}) => {
    writeFileSync(join(h.folder, RUN_FILES.stdout), log);
    return readRunFailure(h.root, record(changes));
  };
  const reset = "You've hit your weekly limit · resets Nov 8, 8pm (Asia/Tokyo)";
  const claudeError = jsonl({ type: 'assistant', session_id: session, is_api_error_message: true,
    message: { content: [{ type: 'text', text: reset }] } });
  assert.deepEqual(project(claudeError, { launch: claudeLaunch, session: { provider: null, id: session } }), { cause: 'weekly_limit', message: reset });
  assert.deepEqual(project(claudeError + jsonl({ type: 'result', session_id: session, is_error: true, result: '' }),
    { launch: claudeLaunch, session: { provider: null, id: session } }), { cause: 'weekly_limit', message: reset }, 'empty terminal preserves the explicit API error');
  const modelLimit = "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
  assert.deepEqual(project(jsonl({ type: 'result', session_id: session, is_error: true, result: modelLimit }),
    { launch: claudeLaunch, session: { provider: null, id: session } }), { cause: 'model_limit', message: modelLimit }, 'a model limit without a period is still a known cause');
  assert.equal(project(jsonl({ type: 'result', session_id: session, is_error: true, result: "You've reached your weekly limit. Try again later." }),
    { launch: claudeLaunch, session: { provider: null, id: session } })?.cause, undefined, 'another limit is not said as a model limit');
  assert.deepEqual(project(codex + jsonl({ type: 'turn.failed' })), { cause: 'model_capacity', message: capacity }, 'terminal without words retains this turn’s explicit error');
  const secret = 'sk-syntheticSecret123456';
  const general = project(prefix + jsonl({ type: 'turn.failed', error: { message: `Service unavailable. token=${secret}` } }));
  assert.ok(general?.message.includes('Service unavailable.'));
  assert.ok(general?.message.includes('[redacted]'));
  assert.ok(!JSON.stringify(general).includes(secret));
  assert.equal(general?.cause, undefined);
  assert.equal(project(prefix + jsonl({ type: 'turn.failed', error: { message: '' } })), undefined);
  assert.equal(project(claudeError + jsonl({ type: 'result', session_id: session, is_error: false, result: 'Done.' }),
    { launch: claudeLaunch, session: { provider: null, id: session } }), undefined);
  assert.equal(project(prefix + jsonl({ type: 'item.completed', item: { type: 'agent_message', text: reset } })), undefined);
  const long = project(prefix + jsonl({ type: 'turn.failed', error: { message: `${'x'.repeat(1990)} token=${secret}` } }));
  assert.ok(long && long.message.length <= 2000);
  assert.ok(!long.message.includes('sk-synthetic'));
});
