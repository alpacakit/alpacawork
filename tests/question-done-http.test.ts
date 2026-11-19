import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { taskFlow } from './task-flow.fixture.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { readControlTree } from './helpers/control-tree.ts';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { authorize } from '@alpacawork/backend/test-dist/control/authorize.js';
import { openQuestions } from '@alpacawork/raw';

async function post(url: string, task: { id: string; hash: string }, extra: Record<string, unknown> = {}) {
  const input = { task: task.id, state: 'done', expectedTaskHash: task.hash, opId: randomUUID(), ...extra };
  const response = await fetch(new URL('/api/task/report', url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': input.opId }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json(), input };
}

for (const userRequested of [false, true]) test(`human HTTP completes a question directly (userRequested=${userRequested}) through replyWait`, async t => {
  const f = await taskFlow(t), task = await f.task('Question completion', { userRequested }), seat = await f.work(task);
  const question = await f.ask(seat, 'user'); f.end(seat);
  const before = await f.get(task.id);
  assert.equal(before.meta.baseState, 'doing'); assert.equal(openQuestions(before.meta.log).length, 1);
  const tree = await readControlTree(f.root);
  assert.ok(tree.tasks.find(row => row.id === task.id)!.allowedActions.includes('confirm'));
  const server = await startServer(f.root, 0);
  try {
    const result = await post(server.url, before);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.task.baseState, 'done');
    const after = await f.get(task.id), withdrawal = after.meta.log.find(row => row.kind === 'question_withdrawn');
    assert.equal(openQuestions(after.meta.log).length, 0);
    assert.equal(withdrawal?.questionId, question); assert.equal(withdrawal?.originCauseId, result.input.opId);
    assert.ok(withdrawal?.id.startsWith('LRW'), 'withdrawal comes from the existing replyWait write path');
    assert.equal(after.meta.log.find(row => row.id === result.input.opId)?.stage?.ruleId, 'T07a');
    assert.equal(after.meta.log.slice(before.meta.log.length).some(row => row.toState === 'waiting'), false);
    const replay = await post(server.url, before, result.input);
    assert.equal(replay.status, 200); assert.equal((await f.get(task.id)).hash, after.hash);
  } finally { await server.close(); }
});

test('HTTP preserves the unfinished-child refusal and the open question atomically', async t => {
  const f = await taskFlow(t), task = await f.task('Parent', { userRequested: true });
  const seat = await f.work(task); const question = await f.ask(seat, 'user'); f.end(seat);
  const child = await f.task('Unfinished child', { parentId: task.id });
  const before = await f.get(task.id), server = await startServer(f.root, 0);
  try {
    const result = await post(server.url, before);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error.reason.kind, 'unfinished_tasks_below_make_them_done_or_stopped_first');
    assert.ok(result.body.error.message.includes(child.id));
    const after = await f.get(task.id);
    assert.equal(after.hash, before.hash); assert.equal(after.meta.baseState, 'doing');
    assert.deepEqual(openQuestions(after.meta.log).map(row => row.id), [question]);
  } finally { await server.close(); }
});

test('human HTTP completes a held question and H04 releases the hold', async t => {
  const f = await taskFlow(t), task = await f.task('Held question', { userRequested: true }), seat = await f.work(task);
  await f.ask(seat, 'user'); await f.person(task.id, 'held'); f.end(seat);
  const before = await f.get(task.id), server = await startServer(f.root, 0);
  try {
    assert.equal(before.meta.hold, true); assert.equal(before.meta.baseState, 'doing');
    const result = await post(server.url, before);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.task.baseState, 'done'); assert.equal(result.body.task.hold, false);
    assert.equal(openQuestions((await f.get(task.id)).meta.log).length, 0);
  } finally { await server.close(); }
});

test('HTTP refuses doing without a user question, ancestor questions and stale completion hashes', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), task = await f.task('Ancestor question', { parentId: parent.id });
  const seat = await f.work(task); await f.ask(seat, parent.id); f.end(seat);
  const server = await startServer(f.root, 0);
  try {
    const refused = await post(server.url, await f.get(task.id)); assert.equal(refused.status, 403);
    const idle = await f.task('No question');
    assert.equal((await post(server.url, await f.get(idle.id))).status, 403);
    // A separate question, with no open child or return to confound freshness.
    const own = await f.task('User question'), run = await f.work(own); await f.ask(run, 'user'); f.end(run);
    const stale = await post(server.url, await f.get(own.id), { expectedTaskHash: '0'.repeat(64) });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.reason.kind, 'task_changed_reload_before_review');
    assert.equal((await f.get(own.id)).meta.baseState, 'doing');
  } finally { await server.close(); }
});

test('coordinator uses the same facts and done input, and unfinished execution still blocks it', async t => {
  const f = await taskFlow(t), task = await f.task('Proxy completion', { userRequested: true }), seat = await f.work(task);
  await f.ask(seat, 'user');
  const actor = { kind: 'main', provider: 'codex', conversationId: 'question-done-test' } as const;
  const caller = { kind: 'coordinator', source: 'codex', conversation: 'question-done-test' } as const;
  const service = new TaskReportService(f.root);
  const report = async () => service.report({ task: task.id, state: 'done', opId: randomUUID(),
    expectedTaskHash: (await f.get(task.id)).hash }, actor, caller);
  await assert.rejects(report(), (error: any) => error.reason?.kind === 'runs_on_or_below_unfinished');
  assert.equal(openQuestions((await f.get(task.id)).meta.log).length, 1);
  f.end(seat); await f.person(task.id, 'held'); await report();
  assert.equal((await f.get(task.id)).meta.baseState, 'done');
  assert.equal((await f.get(task.id)).meta.hold, false);
  assert.equal(openQuestions((await f.get(task.id)).meta.log).length, 0);
});

test('authorization reads question history only for the report target, never unrelated acts or the caller Task', async t => {
  const f = await taskFlow(t), task = await f.task('Question'), seat = await f.work(task);
  await f.ask(seat, 'user');
  const other = await f.task('Other task');
  f.store(store => {
    const db = store.connection, prepare = db.prepare.bind(db), sql: string[] = [];
    db.prepare = statement => { sql.push(statement); return prepare(statement); };
    const target = { task: task.id, quote: null }, human = { kind: 'human' } as const;
    const caller = { kind: 'run', runId: seat.runId, placementId: seat.placementId,
      taskId: task.id, role: 'owner', responsible: true } as const;
    try {
      authorize(db, human, { name: 'task.comment', urgent: false }, target);
      authorize(db, human, { name: 'file.write' }, target);
      authorize(db, caller, { name: 'task.comment', urgent: false }, { task: other.id, quote: null });
      assert.equal(sql.some(statement => /\btask_log\b/.test(statement)), false);
      sql.length = 0;
      authorize(db, caller, { name: 'task.report', state: 'doing' }, target);
      assert.equal(sql.filter(statement => /\btask_log\b/.test(statement)).length, 1);
      sql.length = 0;
      authorize(db, human, { name: 'task.report', state: 'done' }, target);
      assert.equal(sql.filter(statement => /\btask_log\b/.test(statement)).length, 1);
    } finally { db.prepare = prepare; }
  });
});

test('question completion retains the open sent Request guard before unfinished children', async t => {
  const f = await taskFlow(t), parent = await f.task('Waiting for child'), seat = await f.work(parent);
  const child = await f.task('Requested child', { parentId: parent.id }); await f.request(child, seat);
  const question = await f.ask(seat, 'user'); f.end(seat);
  await assert.rejects(f.person(parent.id, 'done'), (error: any) =>
    error.reason?.kind === 'has_open_requests_finish_after_their_returns');
  assert.equal((await f.get(parent.id)).meta.baseState, 'doing');
  assert.deepEqual(openQuestions((await f.get(parent.id)).meta.log).map(row => row.id), [question]);
});
