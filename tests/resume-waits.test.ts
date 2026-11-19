/** Resuming settles waits at the real admission/report boundary, not at later execution notifications. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openQuestions, questionsOf } from '@alpacawork/raw';
import { controlDatabasePath } from '@alpacawork/db';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { taskFlow, type Seat } from './task-flow.fixture.ts';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { readControlTree } from './helpers/control-tree.ts';
import { holdingKeys } from '@alpacawork/backend/test-dist/receiver/push.js';
const human = { kind: 'human' } as const;
type Flow = Awaited<ReturnType<typeof taskFlow>>;
const prompt = (f: Flow, seat: Seat) => f.store(s => s.getText(seat.runId))!.prompt!;
const closed = async (f: Flow, task: string, id: string) => questionsOf((await f.get(task)).meta.log).find(q => q.asked.id === id)!.closing;

test('owner admission withdraws the canonical question and notification key; replay preserves a newer question', async t => {
  const f = await taskFlow(t), task = await f.task('Resume', { userRequested: true }), owner = await f.work(task);
  const q = await f.ask(owner, 'user');
  const before = await readControlTree(f.root);
  assert.equal(before.balls[task.id]?.holder, 'user');
  assert.ok(holdingKeys(before.tasks, before.balls).has(`${task.id}:${q}`));
  const input = { task: task.id, body: 'New work', opId: randomUUID(), expectedTaskHash: (await f.get(task.id)).hash, expectedPlacementRevision: 1 };
  const service = new TaskRequestService(f.root), accepted = await service.request(input, human, human);
  assert.equal((await closed(f, task.id, q))?.kind, 'question_withdrawn');
  assert.equal((await closed(f, task.id, q))?.originCauseId, input.opId);
  const after = await readControlTree(f.root);
  assert.equal(after.balls[task.id]?.holder, 'owner');
  assert.equal(holdingKeys(after.tasks, after.balls).has(`${task.id}:${q}`), false);
  const newer = await f.ask(owner, 'user');
  assert.deepEqual((await service.request(input, human, human)).outcome, accepted.outcome);
  assert.deepEqual(openQuestions((await f.get(task.id)).meta.log).map(q => q.id), [newer]);
});

test('doing is a resumption even on the same Run; a body save alone preserves the question and missing final report still fails', async t => {
  const f = await taskFlow(t), task = await f.task('Doing'), owner = await f.work(task), q = await f.ask(owner, 'user');
  await f.commands.update({ id: task.id, expectedTaskHash: (await f.get(task.id)).hash, body: 'Saved progress' });
  assert.equal(await closed(f, task.id, q), null);
  await f.report(owner, 'doing');
  assert.equal((await closed(f, task.id, q))?.kind, 'question_withdrawn');
  f.end(owner);
  assert.equal((await f.get(task.id)).meta.baseState, 'error');
});

test('child intermediate state/body preserve the parent question; its returned result resumes and withdraws it without a new estimate round', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), owner = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id }), worker = await f.work(child, owner);
  const q = await f.ask(owner, 'user');
  const rounds = (await f.get(parent.id)).meta.log.filter(l => l.startsEstimateRound).length;
  await f.report(worker, 'doing');
  await f.commands.update({ id: child.id, expectedTaskHash: (await f.get(child.id)).hash, body: 'Intermediate result' });
  assert.equal(await closed(f, parent.id, q), null);
  assert.equal(f.store(s => s.snapshot(f.project).returns).filter(r => r.toTaskId === parent.id && r.outcome === 'work_changed').length, 0);
  await f.report(worker, 'done'); f.end(worker);
  assert.equal(await closed(f, parent.id, q), null);
  const received = await f.receive(owner);
  assert.equal((await closed(f, parent.id, q))?.kind, 'question_withdrawn');
  assert.match(prompt(f, received), new RegExp(`--question ${q}`));
  const request = f.store(s => s.getRequest(f.run(received).requestId))!;
  assert.equal(request.purpose, 'return_continuation');
  assert.equal((await f.get(parent.id)).meta.log.filter(l => l.startsEstimateRound).length, rounds);
  assert.equal((await f.get(parent.id)).meta.log.some(l => l.id === request.id), false, 'automatic Request stays in its canonical store, not an explicit-instruction history reference');
  assert.doesNotMatch(prompt(f, received), /Any estimate you gave earlier is void with this request/);
});

test('an answer return withdraws the question published while its automatic input was still pending', async t => {
  const f = await taskFlow(t), task = await f.task('Answer'), owner = await f.work(task), old = await f.ask(owner, 'user');
  await f.answer(task.id, old);
  const newer = await f.ask(owner, 'user');
  const received = await f.receive(owner);
  assert.equal((await closed(f, task.id, old))?.kind, 'answered');
  assert.equal((await closed(f, task.id, newer))?.kind, 'question_withdrawn');
  assert.match(prompt(f, received), /This way/);
  assert.match(prompt(f, received), new RegExp(`--question ${newer}`));
});

test('member admission and start keep the owner wait; the member result resumes the owner', async t => {
  const f = await taskFlow(t), task = await f.task('Member'), owner = await f.work(task);
  const member = (await new PlacementCommands(f.root).placeMember({ taskId: task.id, profileKey: 'fake',
    expectedTaskHash: (await f.get(task.id)).hash, expectedResponsibleRevision: 1 }, human)).placement;
  const q = await f.ask(owner, 'user');
  const result = await new TaskRequestService(f.root).request({ task: task.id, agent: member.id, body: 'Investigate', opId: randomUUID(),
    expectedTaskHash: (await f.get(task.id)).hash, expectedPlacementRevision: member.revision },
    { kind: 'placement', placementId: owner.placementId },
    { kind: 'run', runId: owner.runId, placementId: owner.placementId, taskId: owner.id, role: 'owner', responsible: true });
  if (result.outcome.kind !== 'request_accepted') throw new Error('Expected member admission');
  const worker = { id: task.id, placementId: member.id, runId: result.outcome.request.runId };
  f.start(worker);
  assert.equal(await closed(f, task.id, q), null);
  f.end(worker);
  await f.receive(owner);
  assert.equal((await closed(f, task.id, q))?.kind, 'question_withdrawn');
});

for (const joined of [false, true]) test(`an instruction ${joined ? 'joined into this Run requires a replacement report' : 'still waiting for another Run does not erase its predecessor outcome'}`, async t => {
  const f = await taskFlow(t), task = await f.task('Run boundary'), owner = await f.work(task), q = await f.ask(owner, 'user');
  const next = await f.request(task);
  assert.equal((await closed(f, task.id, q))?.kind, 'question_withdrawn');
  if (joined) f.store(s => s.write(tx => tx.finish({ ...tx.get(next.runId)!, state: 'joined', into: owner.runId,
    ended_at: new Date().toISOString() }, { state: 'missing', text: null })));
  f.end(owner);
  assert.equal((await f.get(task.id)).meta.baseState, joined ? 'error' : 'doing');
});

test('cancelling an unreceived input cannot lose the withdrawn fixed question, including equal timestamps', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00Z') });
  const f = await taskFlow(t), task = await f.task('Cancelled'), owner = await f.work(task), q = await f.ask(owner, 'user');
  const first = await f.request(task);
  assert.match(prompt(f, first), new RegExp(`--question ${q}`));
  f.end(first, 'cancelled');
  const next = await f.request(task);
  assert.match(prompt(f, next), new RegExp(`--question ${q}`));
  assert.match(prompt(f, next), /Your waits withdrawn on resume/);
});

test('resumption save failure rolls back the Request and entire canonical wait', async t => {
  const f = await taskFlow(t), task = await f.task('Rollback'), owner = await f.work(task), q = await f.ask(owner, 'user');
  const before = await f.get(task.id), requests = f.store(s => s.snapshot(f.project).requests);
  const db = new DatabaseSync(controlDatabasePath(f.root));
  try {
    db.exec("CREATE TRIGGER fail_resume BEFORE INSERT ON task_log WHEN json_extract(NEW.entry,'$.kind')='question_withdrawn' BEGIN SELECT RAISE(ABORT,'resume fault'); END");
    await assert.rejects(f.request(task), /resume fault/);
    assert.deepEqual(await f.get(task.id), before);
    assert.deepEqual(f.store(s => s.snapshot(f.project).requests), requests);
    assert.equal(await closed(f, task.id, q), null);
  } finally { db.close(); }
});

test('held owner instruction closes the question without releasing hold; delayed starts and reconciliation keep a newer question', async t => {
  const f = await taskFlow(t), task = await f.task('Held'), owner = await f.work(task), q = await f.ask(owner, 'user');
  await f.person(task.id, 'held');
  const next = await f.request(task);
  assert.equal((await closed(f, task.id, q))?.kind, 'question_withdrawn');
  assert.equal((await f.get(task.id)).meta.hold, true);
  const newer = await f.ask(owner, 'user');
  f.reconcile(); f.reconcile();
  assert.equal(await closed(f, task.id, newer), null);
  f.end(next, 'cancelled');
  await f.person(task.id, 'doing');
  assert.equal(await closed(f, task.id, q) !== null, true);
});

test('the asking Run applies its delayed start before its new question, only once', async t => {
  const f = await taskFlow(t), task = await f.task('Delayed'), owner = await f.request(task);
  f.store(s => s.write(tx => tx.update({ ...tx.get(owner.runId)!, state: 'running', started_at: new Date().toISOString() })));
  const q = await f.ask(owner, 'user');
  f.reconcile(); f.reconcile();
  const log = (await f.get(task.id)).meta.log;
  assert.equal(log.filter(l => l.id === `LSTART${owner.runId}`).length, 1);
  assert.ok(log.findIndex(l => l.id === `LSTART${owner.runId}`) < log.findIndex(l => l.id === q));
  assert.equal(await closed(f, task.id, q), null);
});

test('review resumption survives cancelled prompts and is superseded by the next publication', async t => {
  const f = await taskFlow(t), task = await f.task('Review prompt', { userRequested: true }), owner = await f.work(task);
  await f.report(owner, 'done'); f.end(owner);
  const mark = (await f.get(task.id)).meta.log.find(l => l.stage?.action === 'report_done')!;
  const first = await f.request(task); f.end(first, 'cancelled');
  const next = await f.request(task);
  assert.match(prompt(f, next), new RegExp(mark.id));
  assert.match(prompt(f, next), new RegExp(owner.runId));
  f.start(next);
  await f.ask(next, 'user');
  const last = await f.request(task);
  assert.doesNotMatch(prompt(f, last), new RegExp(`Awaiting review ${mark.id}`));
});

test('oversized question metadata still exposes the original ID and fixed-text command in a continued prompt', async t => {
  const f = await taskFlow(t), task = await f.task('Large question'), owner = await f.work(task), q = randomUUID();
  const child = await f.task('Incoming', { parentId: task.id }), other = await f.work(child, owner);
  await new TaskReportService(f.root).report({ task: child.id, state: 'waiting', askTo: task.id, title: 'Incoming',
    description: '長'.repeat(1000), opId: randomUUID(), expectedTaskHash: (await f.get(child.id)).hash },
    { kind: 'placement', placementId: other.placementId },
    { kind: 'run', runId: other.runId, placementId: other.placementId, taskId: other.id, role: 'owner', responsible: true });
  await new TaskReportService(f.root).report({ task: task.id, state: 'waiting', askTo: 'user', title: 'Original',
    description: '長'.repeat(1000), opId: q, expectedTaskHash: (await f.get(task.id)).hash },
    { kind: 'placement', placementId: owner.placementId },
    { kind: 'run', runId: owner.runId, placementId: owner.placementId, taskId: owner.id, role: 'owner', responsible: true });
  const next = await f.request(task), text = prompt(f, next);
  assert.match(text, new RegExp(`--question ${q}`));
  assert.ok(Buffer.byteLength(text) <= PROTOCOL_LIMITS.prompt);
  assert.doesNotMatch(text, /長{100}/);
});

test('an unreceived instruction does not excuse a later explicit doing report with no final outcome', async t => {
  const f = await taskFlow(t), task = await f.task('Later own decision'), owner = await f.work(task);
  await f.ask(owner, 'user');
  await f.request(task);
  await f.report(owner, 'doing');
  f.end(owner);
  assert.equal((await f.get(task.id)).meta.baseState, 'error');
});

test('a new conversation also carries the cancelled admission withdrawal until a fresh publication', async t => {
  const f = await taskFlow(t), task = await f.task('New conversation'), owner = await f.work(task), q = await f.ask(owner, 'user');
  f.end(owner);
  const cancelled = await f.request(task); f.end(cancelled, 'cancelled');
  const result = await new TaskRequestService(f.root).request({ task: task.id, body: 'Start anew', newConversation: true,
    opId: randomUUID(), expectedTaskHash: (await f.get(task.id)).hash, expectedPlacementRevision: 1 }, human, human);
  if (result.outcome.kind !== 'request_accepted') throw new Error('Expected admission');
  const text = prompt(f, { ...task, runId: result.outcome.request.runId });
  assert.match(text, /You are the owner of this task/);
  assert.match(text, new RegExp(`--question ${q}`));
});

test('an actual predecessor failure remains an error even when an instruction withdrew its question', async t => {
  const f = await taskFlow(t), task = await f.task('Failure'), owner = await f.work(task);
  await f.ask(owner, 'user');
  await f.request(task);
  f.end(owner, 'failed');
  assert.equal((await f.get(task.id)).meta.baseState, 'error');
});
