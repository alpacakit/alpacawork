/** Concurrent conversations share optimistic versions, without a turn registration or exclusive Task claim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { call as spawned, callerWorkspace, claudeConversation, codexConversation } from './coordinator-caller.fixture.ts';
import { call, run } from './helpers/cli-session.ts';

/** The actor of a Task's newest record, as `task get` shows it; a write's receipt carries no History. */
const actorOf = async (url: string, task: { id: string }) =>
  (await call(url, ['task', 'get', '--task', task.id, '--log', '1'])).task.log.at(-1)?.actor;

// The CLI started as its own program names its caller from the environment it starts in; the other tests share one process.
test('another outside conversation rejects an old hash, rereads and writes immediately', async t => {
  const w = callerWorkspace(t), url = await w.start(), call = spawned;
  const a = claudeConversation('conversation-a'), b = codexConversation('conversation-b');
  const created = (await call(url, ['task', 'new', '--from-user', '--parent', w.project, '--title', 'Shared'], a)).task;
  const update = (title: string, hash: string, env: NodeJS.ProcessEnv, quote: string[] = []) =>
    call(url, ['task', 'update', '--task', created.id, '--title', title, '--expected-task-hash', hash, ...quote], env);
  const first = (await update('First writer', created.hash, a)).task;
  await assert.rejects(update('Old snapshot', created.hash, b), { code: 'conflict' });
  const read = (await call(url, ['task', 'get', '--task', created.id], b)).task;
  assert.equal(read.hash, first.hash);
  const second = (await update('Second writer', read.hash, b, ['--quote', 'Unverified optional record'])).task;
  assert.equal(second.title, 'Second writer');
  assert.deepEqual(await actorOf(url, second), { kind: 'main', provider: 'codex', conversationId: 'conversation-b', quote: 'Unverified optional record' });
});

test('one quote may create independent Tasks; only the same operation ID replays its receipt', async t => {
  const w = callerWorkspace(t), url = await w.start(), words = 'Create tasks for the preview and explanation';
  const fromUser = (args: string[], conversation = 'conversation-a') => call(url,
    ['task', 'new', '--from-user', '--quote', words, '--parent', w.project, ...args], claudeConversation(conversation));
  const first = await fromUser(['--plan-file', w.file('plan.json', JSON.stringify([{ title: 'Preview' }, { title: 'Explanation' }]))]);
  const ids = first.tasks.map((task: { id: string }) => task.id);
  assert.equal(first.tasks.some((task: object) => 'log' in task), false, 'created Tasks answer without History');
  assert.deepEqual((await Promise.all(first.tasks.map((task: { id: string }) => actorOf(url, task)))).map((actor: { quote: string }) => actor.quote), ids.map(() => words));
  const secondId = randomUUID(), args = ['--title', 'Preview', '--op-id', secondId];
  const again = await fromUser(args);
  assert.ok(!ids.includes(again.task.id));
  assert.deepEqual(await fromUser(args), again);
  await assert.rejects(fromUser(['--title', 'Different', '--op-id', secondId]), { code: 'idempotency_conflict' });
  const elsewhere = await fromUser(['--title', 'Other conversation'], 'conversation-b');
  assert.ok(!ids.includes(elsewhere.task.id), 'quote text belongs to the operation record and is not conversation authorization');
  const listed = await call(url, ['task', 'list', '--under', w.project]);
  assert.deepEqual(listed.tasks.filter((task: { id: string }) => task.id !== w.project).map((task: { id: string }) => task.id),
    [...ids, again.task.id, elsewhere.task.id]);
});

test('screen writes use their existing Request identity despite an old queued submission time', async t => {
  const w = callerWorkspace(t), session = randomUUID(), submittedAt = new Date(Date.now() - 7_200_000).toISOString();
  const screen = w.screenRun({ words: 'Create a preview task', submittedAt, session });
  const url = await w.start(); await w.startScreenRun(url, screen);
  const created = (await call(url, ['task', 'new', '--from-user', '--parent', w.project, '--title', 'Screen work'],
    claudeConversation(session))).task;
  assert.deepEqual(await actorOf(url, created), { kind: 'main', provider: 'claude', conversationId: screen.conversation, message: screen.requestId });
  const read = await call(url, ['task', 'get', '--task', created.id]);
  assert.equal(read.requestedByUser.at, submittedAt, 'the existing Request keeps the time the user asked');
});

test('an outside conversation cannot attach a source Request', async t => {
  const w = callerWorkspace(t), url = await w.start();
  for (const provider of ['claude', 'codex'] as const) await t.test(provider, async () => {
    const env = provider === 'claude' ? claudeConversation('outside') : codexConversation('outside');
    const rejected = await run(url, ['task', 'new', '--from-user', '--parent', w.project, '--title', 'Rejected',
      '--source-request', randomUUID()], env);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
    const accepted = await call(url, ['task', 'new', '--from-user', '--parent', w.project, '--title', 'Accepted'], env);
    assert.equal(accepted.task.userRequested, true);
  });
});
