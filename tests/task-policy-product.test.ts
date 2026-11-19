import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { currentTransition, taskRowFields, type TaskRowDTO } from '@alpacawork/contract/control';
import { controlTaskView } from '@alpacawork/backend/test-dist/control/task-dto.js';
import { projectRowFacts } from '@alpacawork/backend/test-dist/receiver/row-facts.js';
import { handlingFixture } from './return-handling.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskFlow } from './task-flow.fixture.ts';
import { readControlTree } from './helpers/control-tree.ts';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { startDecision } from '@alpacawork/backend/test-dist/control/task-start-facts.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';

test('an admitted owner start, failure, question answer and withdrawal preserve an explicit hold', async t => {
  const f = await taskFlow(t), task = await f.task('Held work', { userRequested: true });
  const queued = await f.request(task);
  await f.person(task.id, 'held'); f.start(queued);
  assert.deepEqual([(await f.get(task.id)).meta.baseState, (await f.get(task.id)).meta.hold], ['doing', true]);
  const first = await f.ask(queued, 'user');
  await f.answer(task.id, first);
  assert.equal((await f.get(task.id)).meta.hold, true);
  const second = await f.ask(queued, 'user'); await f.withdraw(queued, second);
  assert.equal((await f.get(task.id)).meta.hold, true);
  f.end(queued, 'failed');
  const current = await f.get(task.id);
  assert.deepEqual([current.meta.baseState, current.meta.hold, current.meta.state], ['error', true, 'held']);
  const tree = await readControlTree(f.root);
  assert.equal((await readWorkspaceProjection(f.root)).index.home.find(row => row.taskId === task.id)?.section, 'held');
});

test('a held review invalidates its base and reserves exactly one ordinary continuation with the original cause', async t => {
  const f = await taskFlow(t), parent = await f.task('Review', { userRequested: true });
  const child = await f.task('Finished child', { parentId: parent.id });
  const worker = await f.work(child); await f.report(worker, 'done'); f.end(worker);
  const owner = await f.work(parent); await f.report(owner, 'done'); f.end(owner); await f.person(parent.id, 'held');
  const before = await f.get(child.id);
  await f.commands.update({ id: child.id, values: { notes: 'Changed result' }, expectedTaskHash: before.hash });
  const changed = await f.get(parent.id);
  assert.deepEqual([changed.meta.baseState, changed.meta.hold], ['doing', true]);
  const link = changed.meta.log.find(log => log.stage?.ruleId === 'RW02')!;
  assert.ok(link.originCauseId);
  const notices = f.store(store => store.readReturns().filter(row => row.outcome === 'work_changed' && row.toTaskId === parent.id));
  assert.equal(notices.length, 1); assert.equal(notices[0]!.causeLogId, link.id);
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  assert.equal(f.store(store => store.readReturns().filter(row => row.outcome === 'work_changed' && row.toTaskId === parent.id)).length, 1);
  assert.equal((await f.get(parent.id)).meta.hold, true);
});

test('a child hold and its restoration keep an unchanged finished result and its ancestor review intact', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent review', { userRequested: true });
  const child = await f.task('Finished child', { parentId: parent.id });
  const worker = await f.work(child); await f.report(worker, 'done'); f.end(worker);
  const owner = await f.work(parent); await f.report(owner, 'done'); f.end(owner);
  const before = await f.get(parent.id);
  await f.person(child.id, 'held');
  assert.deepEqual([(await f.get(child.id)).meta.baseState, (await f.get(child.id)).meta.hold], ['done', true]);
  assert.equal((await f.get(parent.id)).hash, before.hash);
  await f.person(child.id, 'done');
  assert.equal((await f.get(parent.id)).hash, before.hash);
  assert.equal(f.store(store => store.readReturns().filter(row => row.outcome === 'work_changed' && row.toTaskId === parent.id)).length, 0);
});

test('child work keeps the top row doing through a hold; its closure leaves the top awaited', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent', { userRequested: true }), own = await f.work(parent);
  const child = await f.task('Running child', { parentId: parent.id }), active = await f.work(child, own);
  f.end(own);
  const section = async () => {
    return (await readWorkspaceProjection(f.root)).index.home.find(row => row.taskId === parent.id)?.section; };
  assert.equal(await section(), 'doing');
  await f.person(child.id, 'held'); assert.equal(await section(), 'doing');
  f.end(active, 'failed'); assert.equal(await section(), 'awaited');
});

test('AI cannot resume a stopped path, a user grant binds all stop epochs, and a later stop invalidates it', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), caller = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id });
  await f.person(parent.id, 'stopped');
  const before = f.store(store => store.snapshot().requests.length);
  await assert.rejects(f.request(child, caller), /explicit_resume_scope_required/);
  assert.equal(f.store(store => store.snapshot().requests.length), before);
  const permitted = await f.request(child);
  assert.equal(f.store(store => startDecision(store.connection, store.get(permitted.runId)!.requestId, child.id).code), 'resume_scope_authorized');
  await f.person(parent.id, 'stopped');
  assert.equal(f.store(store => startDecision(store.connection, store.get(permitted.runId)!.requestId, child.id).code), 'request_invalidated_by_stop');
  assert.deepEqual([await f.state(child.id), await f.state(parent.id)], ['stopped', 'stopped']);
});

test('an actually observed start beyond its fence records the violation and a durable stop without reopening the branch', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), child = await f.task('Child', { parentId: parent.id });
  const queued = await f.request(child);
  f.store(store => store.write(runs => {
    const run = runs.get(queued.runId)!;
    runs.update({ ...run, state: 'running', started_at: new Date().toISOString() });
  }));
  await f.person(parent.id, 'stopped');
  f.store(store => store.write(runs => {
    const run = runs.get(queued.runId)!;
    runs.update({ ...run, state: 'running', reason: null, exit: null, ended_at: null, started_at: new Date(Date.now() + 1000).toISOString() });
  }));
  f.reconcile();
  const current = await f.get(child.id), observed = current.meta.log.find(log => log.id === `LSTART${queued.runId}`)!;
  assert.equal(observed.stage?.boundary, 'rejected_start'); assert.equal(observed.stage?.ruleId, 'RS02');
  assert.equal(observed.toState, null); assert.equal(current.meta.baseState, 'stopped');
  assert.equal(await f.state(parent.id), 'stopped');
  assert.equal(f.run(queued).stop_requested, true);
  const tree = await readControlTree(f.root);
  assert.equal(tree.tasks.find(task => task.id === child.id)!.baseState, 'stopped');
  assert.ok(tree.working!.includes(child.id));
  const logs = current.meta.log.length; f.reconcile(); assert.equal((await f.get(child.id)).meta.log.length, logs);
});

for (const [stage, table, condition] of [
  ['grant', 'task_start_grants', '1'],
  ['history reference', 'task_log', 'NEW.request_id IS NOT NULL'],
] as const) test(`admission ${stage} failure rolls back the grant, Request, Run and Task revision; same-ID retry commits once`, async t => {
  const f = await taskFlow(t), task = await f.task('Atomic admission', { userRequested: true });
  const before = await f.get(task.id), opId = randomUUID();
  const revision = f.store(s => s.getPlacement(task.placementId)!.revision);
  const input = { task: task.id, opId, body: 'Atomic work', expectedTaskHash: before.hash, expectedPlacementRevision: revision };
  const request = () => new TaskRequestService(f.root).request(input, { kind: 'human' }, { kind: 'human' });
  const counts = () => f.store(s => ['requests', 'runs', 'task_start_grants', 'task_log'].map(table =>
    Number(s.connection.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)));
  const prior = counts();
  f.store(s => s.connection.exec(`CREATE TRIGGER stage_fault BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'stage-fault'); END`));
  await assert.rejects(request());
  assert.deepEqual(counts(), prior); assert.equal((await f.get(task.id)).hash, before.hash);
  f.store(s => s.connection.exec('DROP TRIGGER stage_fault'));
  await request(); const committed = counts();
  assert.deepEqual(committed.map((count, i) => count - prior[i]!), [1, 1, 1, 1]);
  await request(); assert.deepEqual(counts(), committed);
});


test('a real worker is work, while a closed Request awaiting its Return is idle', async t => {
  const h = await handlingFixture(t), owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId); h.end(owner.runId); h.reconcile();
  assert.deepEqual((await readControlTree(h.root)).working, [h.task.id]);
  h.end(worker.runId);
  assert.equal(h.store.readReturns().some(row => row.requestId === worker.requestId), false);
  assert.deepEqual((await readControlTree(h.root)).working, []);
});

test('a held failure retains the hold clock and releases to the original failure clock in the actual row projection', async t => {
  const f = await taskFlow(t), task = await f.task('Hold clock', { userRequested: true }), run = await f.work(task);
  await f.person(task.id, 'held'); const hold = (await f.get(task.id)).meta.log.at(-1)!;
  f.end(run, 'failed');
  const rowOf = async () => ({ ...taskRowFields(controlTaskView(await f.get(task.id))), ball: null, question: '' });
  const liveRow = async (): Promise<TaskRowDTO> => {
    return (await readWorkspaceProjection(f.root)).index.tasks.find(row => row.id === task.id)!;
  };
  const held = await rowOf();
  assert.equal(currentTransition(await liveRow())?.id, hold.id);
  assert.equal(currentTransition(held)?.id, hold.id);
  assert.deepEqual(projectRowFacts(held, [], [], 0, 0, 0).status, { kind: 'since', at: Date.parse(hold.at) });
  const failure = (await f.get(task.id)).meta.log.find(log => log.id === `LEND${run.runId}`)!;
  await f.person(task.id, 'error'); const released = await rowOf();
  assert.equal(currentTransition(released)?.id, failure.id);
  assert.equal(currentTransition(await liveRow())?.id, failure.id);
  assert.deepEqual(projectRowFacts(released, [], [], 0, 0, 0).status, { kind: 'since', at: Date.parse(failure.causeAt ?? failure.at) });
});


test('descendant work updates the top home row, counts and deltas on child start and stop', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent', { userRequested: true }), owner = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id }), work = await f.request(child, owner);
  f.end(owner);
  const publish = async () => (await readWorkspaceProjection(f.root)).index;
  const first = await publish();
  assert.deepEqual(first.home.map((r: any) => [r.taskId, r.section]), [[parent.id, 'doing']], 'queued work already counts as progress');
  assert.equal(first.tasks.find((row: any) => row.id === parent.id).rowFacts.status, null);
  assert.equal(first.tasks.find((row: any) => row.id === parent.id).rowFacts.childrenRunning, 0);
  await f.ask((f.start(work), work), 'user'); f.end(work);
  const waiting = await publish();
  assert.equal(waiting.home.find((r: any) => r.taskId === parent.id).section, 'awaited');
  assert.equal(waiting.home.find((r: any) => r.taskId === child.id).section, 'review');
  assert.deepEqual(waiting.counts.home.root, {doing:0,error:0,review:1,awaited:1,held:0,todo:0});
  // Answering admits new child work: the parent changes without an unrelated write on it.
  const q = (await readControlTree(f.root)).tasks.find(t => t.id === child.id)!.log.filter(l => l.kind === 'asked').at(-1)!;
  await f.answer(child.id, q.id);
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  const resumed = await publish();
  assert.equal(resumed.home.find((r: any) => r.taskId === parent.id).section, 'doing');
  assert.equal(resumed.home.some((r: any) => r.taskId === child.id), false);
  assert.deepEqual(resumed.counts.home.root, {doing:1,error:0,review:0,awaited:0,held:0,todo:0});

});

test('a grandchild user question is its own row and the top waits without duplicating destinations', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent', { userRequested: true }), parentRun = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id }), childRun = await f.work(child, parentRun);
  const grandchild = await f.task('Grandchild', { parentId: child.id }), grandchildRun = await f.work(grandchild, childRun);
  await f.ask(grandchildRun, 'user'); f.end(grandchildRun); f.end(childRun); f.end(parentRun);
  assert.deepEqual((await readWorkspaceProjection(f.root)).index.home.map(row => [row.taskId, row.section]).sort(),
    [[parent.id, 'awaited'], [grandchild.id, 'review']].sort());
});
