/**
 * A Task's state through TaskTransition, its only writer: a responsible Run's start and end, the Run's
 * reports, the user's confirmation, hold and stop, and the seat a change to work needs. The pure decisions (the state
 * table, doneTarget, unholdTarget, ownerRunOutcome) are state-rules.test.ts's; this drives them through the services
 * and the store as the server does. Which ancestors a change sends back is instruction-state.test.ts's.
 */
import { taskFlow } from './task-flow.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import type { Responsible } from './task-flow.fixture.ts';

const human = { kind: 'human' } as const;

test('a later Task state settles an old Run boundary without requiring its execution payload', async t => {
  const f = await taskFlow(t), task = await f.task('Superseded boundary'), seat = await f.request(task);
  f.store(store => store.write(tx => {
    tx.update({ ...tx.get(seat.runId)!, state: 'running', started_at: '2020-01-01T00:00:00Z' });
    tx.finish({ ...tx.get(seat.runId)!, state: 'failed', reason: 'exit', ended_at: '2020-01-01T00:00:01Z' },
      { state: 'missing', text: null });
  }));
  await f.person(task.id, 'held');
  assert(!(await f.get(task.id)).meta.log.some(entry => entry.id === `LEND${seat.runId}`), 'the old end has no log record');
  f.store(store => store.connection.prepare("UPDATE runs SET record=json_remove(record,'$.launch') WHERE id=?")
    .run(Number(seat.runId.slice(1))));
  f.reconcile();
  assert.equal(await f.state(task.id), 'held');
  assert(!(await f.get(task.id)).meta.log.some(entry => entry.id === `LEND${seat.runId}`), 'the superseded end cannot override the newer state');
});

test('a responsible Run\'s start brings its Task to doing and its failure errs it; a queued Run and a replay change nothing', async t => {
  const f = await taskFlow(t);
  const task = await f.task('Work');
  const first = await f.request(task);
  f.reconcile();
  assert.equal(await f.state(task.id), 'todo', 'a queued Run has not started');
  f.start(first);
  assert.equal(await f.state(task.id), 'doing');
  f.end(first, 'failed');
  assert.equal(await f.state(task.id), 'error');
  const retry = await f.request(task);
  f.reconcile();
  assert.equal(await f.state(task.id), 'error', 'a queued retry does not hide the failure');
  f.start(retry);
  assert.equal(await f.state(task.id), 'doing');
  await f.report(retry, 'done');
  f.end(retry, 'failed');
  assert.equal(await f.state(task.id), 'error', 'a failure errs a finished Task too');
  const log = (await f.get(task.id)).meta.log;
  // Each boundary is one record that names its Run, at the Run's own time.
  assert.deepEqual(log.filter(entry => entry.kind === 'linked').map(entry => [entry.id, entry.runId, entry.toState]), [
    [`LSTART${first.runId}`, first.runId, 'doing'], [`LEND${first.runId}`, first.runId, 'error'],
    [`LSTART${retry.runId}`, retry.runId, 'doing'], [`LEND${retry.runId}`, retry.runId, 'error']]);
  f.reconcile();
  assert.equal((await f.get(task.id)).meta.log.length, log.length, 'a replay adds no transition');
});

test('a turn that ends with no end, no question and no open Request errs its Task (design 4.1)', async t => {
  const f = await taskFlow(t);
  const silent = await f.task('Silent');
  const turn = await f.work(silent);
  f.end(turn);
  assert.equal(await f.state(silent.id), 'error', 'no report');
  assert.equal((await f.get(silent.id)).meta.log.at(-1)?.id, `LEND${turn.runId}`);
  const asking = await f.task('Asking');
  const asked = await f.work(asking);
  await f.ask(asked);
  f.end(asked);
  assert.equal(await f.state(asking.id), 'doing', 'its question is open');
  const parent = await f.task('Parent');
  const waiting = await f.work(parent);
  await f.request(await f.task('Child', { parentId: parent.id }), waiting);
  f.end(waiting);
  assert.equal(await f.state(parent.id), 'doing', 'its Request to the child is open');
  const finished = await f.task('Finished');
  const done = await f.work(finished);
  await f.report(done, 'done');
  f.end(done);
  assert.equal(await f.state(finished.id), 'done', 'it ended with its done');
});

test('a person\'s stop of the responsible at work errs what it left; a handover\'s stop and a cancel before the start change nothing', async t => {
  const f = await taskFlow(t);
  const stopped = await f.task('Stopped');
  const turn = await f.work(stopped);
  f.end(turn, 'cancelled');
  assert.equal(await f.state(stopped.id), 'error');
  // Its placement had left the seat before the Run ended. The commands hand over only once the Run has finished
  // (handoff_pending), so the placement's end is written as the store keeps it.
  const swapped = await f.task('Swapped');
  const work = await f.work(swapped);
  const db = new DatabaseSync(controlDatabasePath(f.root));
  try { db.prepare('UPDATE placements SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), swapped.placementId); }
  finally { db.close(); }
  f.end(work, 'cancelled');
  assert.equal(await f.state(swapped.id), 'doing');
  assert.equal((await f.get(swapped.id)).meta.log.find(entry => entry.id === `LEND${work.runId}`)?.toState, null, 'its observed end changes no state');
  const unstarted = await f.task('Unstarted');
  f.end(await f.request(unstarted), 'cancelled');
  assert.equal(await f.state(unstarted.id), 'todo');
});

test('a Run\'s done finishes what an agent asked for and puts what the user asked for to their review', async t => {
  const f = await taskFlow(t);
  const internal = await f.task('Internal');
  await f.report(await f.work(internal), 'done');
  assert.equal(await f.state(internal.id), 'done');
  const asked = await f.task('Asked', { userRequested: true });
  const turn = await f.work(asked);
  await f.report(turn, 'done');
  assert.equal(await f.state(asked.id), 'waiting');
  f.end(turn);
  await f.confirm(asked.id, turn.runId);
  const confirmed = (await f.get(asked.id)).meta.log.at(-1)!;
  assert.deepEqual([confirmed.kind, confirmed.runId, confirmed.fromState, confirmed.toState, confirmed.actor],
    ['review_approved', turn.runId, 'waiting', 'done', human]);
  // A review the user held is confirmed as it is.
  const held = await f.task('Held', { userRequested: true });
  const work = await f.work(held);
  await f.report(work, 'done');
  f.end(work);
  await f.person(held.id, 'held');
  await f.confirm(held.id, work.runId);
  assert.equal(await f.state(held.id), 'done');
});

test('a stop finishes the Task and every unfinished Task below it, stops their Runs and expires their questions', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const own = await f.work(parent);
  const working = await f.task('Working', { parentId: parent.id });
  const work = await f.work(working, own);
  const question = await f.ask(work);
  const finished = await f.task('Finished', { parentId: parent.id });
  const done = await f.work(finished, own);
  await f.report(done, 'done');
  f.end(done);
  await f.person(parent.id, 'stopped');
  assert.deepEqual([await f.state(parent.id), await f.state(working.id), await f.state(finished.id)],
    ['stopped', 'stopped', 'done']);
  const stop = (await f.get(parent.id)).meta.log.at(-1)!, linked = (await f.get(working.id)).meta.log.at(-1)!;
  assert.deepEqual([linked.kind, linked.fromState, linked.toState, linked.causeAt, linked.actor],
    ['linked', 'doing', 'stopped', stop.at, human]);
  assert.deepEqual([f.run(own).stop_requested, f.run(work).stop_requested], [true, true]);
  await assert.rejects(f.answer(working.id, question), { code: 'question_expired' });
});

test('a stop stops the Runs of the whole subtree, also one still running on a child that already reported done', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const own = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id });
  const work = await f.work(child, own);
  // The child's done and its Run's end are separate events: its Run is still running when the parent stops.
  await f.report(work, 'done');
  f.end(own);
  assert.equal(await f.state(child.id), 'done');
  await f.person(parent.id, 'stopped');
  assert.deepEqual([await f.state(parent.id), await f.state(child.id)], ['stopped', 'done'],
    'a finished child keeps its state');
  assert.equal(f.run(work).stop_requested, true);
});

test('the user\'s confirmation finishes a Task only as a done report would: not while a Run below is unfinished', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent', { userRequested: true });
  const child = await f.task('Child', { parentId: parent.id });
  const first = await f.work(child);
  await f.report(first, 'done');
  f.end(first);
  const own = await f.work(parent);
  await f.report(own, 'done');
  f.end(own);
  assert.deepEqual([await f.state(parent.id), await f.state(child.id)], ['waiting', 'done']);
  // The user asks the done child again: its Run is queued, and nothing has changed the parent's review yet.
  const next = await f.request(child);
  f.reconcile();
  assert.equal(await f.state(parent.id), 'waiting');
  await assert.rejects(f.confirm(parent.id, own.runId), { code: 'handoff_pending', detail: { runs: [next.runId] } });
  assert.equal(await f.state(parent.id), 'waiting');
});

test('a hold sets the user\'s turn aside until the user returns it, or its question is answered or withdrawn', async t => {
  const f = await taskFlow(t);
  const task = await f.task('Asking', { userRequested: true });
  const turn = await f.work(task);
  await f.person(task.id, 'held');
  await f.person(task.id, 'doing');
  const first = await f.ask(turn);
  await f.person(task.id, 'held');
  assert.equal(await f.state(task.id), 'held');
  await f.person(task.id, 'doing');
  assert.equal(await f.state(task.id), 'doing');
  await f.person(task.id, 'held');
  await f.answer(task.id, first);
  assert.deepEqual((await f.get(task.id)).meta.log.slice(-2).map(entry => [entry.kind, entry.fromState, entry.toState]),
    [['reported', 'doing', 'held'], ['answered', null, null]]);
  assert.equal((await f.get(task.id)).meta.hold, true);
  assert.equal((await f.get(task.id)).meta.baseState, 'doing');
  const second = await f.ask(turn);
  await f.person(task.id, 'held');
  await f.withdraw(turn, second);
  assert.deepEqual((await f.get(task.id)).meta.log.slice(-2).map(entry => [entry.kind, entry.fromState, entry.toState]),
    [['reported', 'held', null], ['question_withdrawn', null, null]]);
  assert.equal((await f.get(task.id)).meta.hold, true);
  // A held review returns to waiting.
  const review = await f.task('Review', { userRequested: true });
  const work = await f.work(review);
  await f.report(work, 'done');
  f.end(work);
  await f.person(review.id, 'held');
  await f.person(review.id, 'waiting');
  assert.equal(await f.state(review.id), 'waiting');
});

test('a project has no working state', async t => {
  const f = await taskFlow(t);
  await assert.rejects(f.person(f.project, 'stopped'), { code: 'invalid_input' });
  assert.equal(await f.state(f.project), 'todo');
});

test('a change that puts a Task to work needs its responsible; a Run\'s boundary is written whoever holds the seat', async t => {
  const f = await taskFlow(t);
  // A held Task loses its responsible outside the commands, which keep it (uncoveredTasks): its return is refused.
  const held = await f.task('Held', { userRequested: true });
  await f.ask(await f.work(held));
  await f.person(held.id, 'held');
  const db = new DatabaseSync(controlDatabasePath(f.root));
  try { db.prepare('UPDATE placements SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), held.placementId); }
  finally { db.close(); }
  await assert.rejects(f.person(held.id, 'doing'), { code: 'responsible_missing', detail: { tasks: [held.id] } });
  assert.equal(await f.state(held.id), 'held');
  // A Run whose launch failed ends, as the scheduler records it, and its todo Task's responsible is released before
  // its boundaries are applied: they are applied all the same, and the Task errs.
  const unstarted = await f.task('Unstarted');
  const run = await f.request(unstarted);
  f.store(runs => runs.write(tx => {
    tx.update({ ...tx.get(run.runId)!, state: 'running', started_at: new Date().toISOString() });
    tx.finish({ ...tx.get(run.runId)!, state: 'failed', reason: 'launch', ended_at: new Date().toISOString() },
      { state: 'missing', text: null });
  }));
  await new PlacementCommands(f.root).release({ taskId: unstarted.id, placementId: unstarted.placementId,
    expectedTaskHash: (await f.get(unstarted.id)).hash,
    expectedPlacementRevision: f.store(runs => runs.getPlacement(unstarted.placementId)!.revision) }, human);
  f.reconcile();
  assert.equal(await f.state(unstarted.id), 'error');
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
});

test('a handover is the server\'s own Request (W0): it wakes the new responsible of a failed or a waiting Task, whose start brings it back to work', async t => {
  const f = await taskFlow(t);
  const failed = await f.task('Failed');
  f.end(await f.work(failed), 'failed');
  const review = await f.task('Review', { userRequested: true });
  const reviewed = await f.work(review);
  await f.report(reviewed, 'done');
  f.end(reviewed);
  assert.deepEqual([await f.state(failed.id), await f.state(review.id)], ['error', 'waiting']);
  const replace = async (task: Responsible): Promise<Responsible> => ({ id: task.id,
    placementId: (await new PlacementCommands(f.root).placeNewResponsible({ taskId: task.id, profileKey: 'fake',
      expectedTaskHash: (await f.get(task.id)).hash, replacePlacementId: task.placementId,
      expectedPlacementRevision: f.store(runs => runs.getPlacement(task.placementId)!.revision) }, human)).placement.id });
  const seats = [await replace(failed), await replace(review)];
  const router = new ReturnRouter(f.root);
  await router.pass(undefined, { project: f.project });
  // A second pass aborts what wakes a failed seat W1–W3; the server's Request goes on.
  await router.pass(undefined, { project: f.project });
  for (const seat of seats) {
    const [run] = f.store(runs => runs.read().filter(item => item.placementId === seat.placementId));
    assert.ok(run, `${seat.id}'s new responsible is asked`);
    assert.equal(run.state, 'queued', seat.id);
    const handover = f.store(runs => runs.readReturns().find(row => row.toTaskId === seat.id && row.outcome === 'handover'))!;
    assert.deepEqual(handover.deliveries.map(delivery => [delivery.wakeRequestId, delivery.releasedAt]),
      [[run.requestId, null]], `${seat.id}'s Request carries the handover`);
    f.start({ ...seat, runId: run.id });
    assert.equal(await f.state(seat.id), 'doing', `${seat.id} is back at work`);
  }
});

for (const origin of ['todo', 'doing', 'error', 'waiting', 'done', 'stopped'] as const) {
  test(`a hold from ${origin} preserves its source through repetition and restores it without finishing or restarting work`, async t => {
    const f = await taskFlow(t);
    const task = await f.task(`Hold ${origin}`, { userRequested: origin === 'waiting' });
    if (origin !== 'todo') {
      const turn = await f.work(task);
      if (origin === 'error') f.end(turn, 'failed');
      else if (origin === 'stopped') { await f.person(task.id, 'stopped'); f.end(turn, 'cancelled'); }
      else if (origin !== 'doing') { await f.report(turn, 'done'); f.end(turn); }
    }
    assert.equal(await f.state(task.id), origin);
    const before = f.store(runs => runs.read());
    await f.person(task.id, 'held');
    await f.person(task.id, 'held');
    assert.equal(await f.state(task.id), 'held');
    assert.equal((await f.get(task.id)).meta.baseState, origin);
    await f.person(task.id, origin);
    assert.equal(await f.state(task.id), origin);
    assert.deepEqual(f.store(runs => runs.read()), before, 'neither holding nor restoring alters Runs');
  });
}

test('an unassigned plan can be held and restored, and a hold refuses a different restoration or a stale version', async t => {
  const f = await taskFlow(t);
  const id = await f.plan('Unassigned');
  const stale = (await f.get(id)).hash;
  await f.person(id, 'held');
  await assert.rejects(f.person(id, 'doing'), { code: 'conflict' });
  const { TaskReportService } = await import('@alpacawork/backend/test-dist/control/report.js');
  await assert.rejects(new TaskReportService(f.root).report({ task: id, state: 'held', opId: 'stale-hold',
    expectedTaskHash: stale }, human, human), { code: 'conflict' });
  const seats = new (await import('@alpacawork/backend/test-dist/control/placements.js')).PlacementStore(f.root);
  try { assert.deepEqual(seats.uncoveredTasks([id]), []); } finally { seats.close(); }
  await f.person(id, 'todo');
  assert.equal(await f.state(id), 'todo');
});

test('holding work keeps its running owner, queued child request and child state; ending the owner leaves the hold in place', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const owner = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id });
  const queued = await f.request(child, owner);
  const before = f.store(runs => runs.read());
  await f.person(parent.id, 'held');
  assert.deepEqual(f.store(runs => runs.read()), before);
  assert.equal(f.run(owner).state, 'running');
  assert.equal(f.run(queued).state, 'queued');
  assert.equal(await f.state(child.id), 'todo');
  f.end(owner);
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  assert.equal(await f.state(parent.id), 'held');
  await f.person(parent.id, 'doing');
  assert.equal(await f.state(parent.id), 'doing');
});

test('restoring a failed child keeps its original failure, requester, key and time; a Run failure during hold is still new', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const child = await f.task('Failed child requested by a person', { parentId: parent.id });
  const turn = await f.work(child);
  f.end(turn, 'failed');
  const { readControlTree } = await import('./helpers/control-tree.ts');
  const ball = async (id: string) => (await readControlTree(f.root)).balls[id];
  const original = await ball(child.id);
  assert.equal(original?.holder, 'user');
  await f.person(child.id, 'held');
  assert.deepEqual(await ball(child.id), original);
  await f.person(child.id, 'error');
  assert.deepEqual(await ball(child.id), original);
  const running = await f.task('Failure while held');
  const active = await f.work(running);
  await f.person(running.id, 'held');
  f.end(active, 'failed');
  assert.equal(await f.state(running.id), 'held');
  assert.equal((await f.get(running.id)).meta.baseState, 'error', 'the Run failure changes the base while preserving the hold');
  assert.equal((await ball(running.id))?.holder, 'user');
});
