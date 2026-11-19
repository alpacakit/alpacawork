/** Marks and parent notifications through the structure/report entries and the real return router. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { readControlTree } from './helpers/control-tree.ts';
import { taskFlow, type Seat } from './task-flow.fixture.ts';

const human = { kind: 'human' } as const;

async function waitingPair(t: Parameters<typeof taskFlow>[0]) {
  const f = await taskFlow(t), parent = await f.task('Parent'), owner = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id }), work = await f.work(child, owner);
  f.end(owner);
  const rows = () => f.store(runs => runs.readReturns().filter(row => row.toTaskId === parent.id));
  const pass = () => new ReturnRouter(f.root).pass(undefined, { project: f.project });
  return { f, parent, owner, child, work, rows, pass };
}

function failNotice(t: TestContext) {
  const prepare = DatabaseSync.prototype.prepare;
  return t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO returns(')) throw new Error('injected notice failure');
    return prepare.call(this, sql);
  });
}

test('move removes a mark with its move in one revision, tells the new parent, and never restores the mark', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), task = await f.task('Moving', { userRequested: true });
  const before = await f.get(task.id);
  await f.commands.move({ id: task.id, parentId: parent.id, expectedTaskHash: before.hash });
  const moved = await f.get(task.id), added = moved.meta.log.slice(before.meta.log.length);
  assert.deepEqual([moved.meta.parentId, moved.meta.userRequested, moved.meta.version], [parent.id, false, before.meta.version + 1n]);
  assert.deepEqual(added.map(log => [log.kind, log.userRequested]), [['moved', undefined], ['user_request_changed', false]]);
  assert.deepEqual(f.store(runs => runs.readReturns()).map(row => [row.outcome, row.toTaskId, row.causeLogId]),
    [['work_changed', parent.id, added[0]!.id]]);
  await assert.rejects(f.commands.update({ id: task.id, userRequested: true, expectedTaskHash: moved.hash }),
    { code: 'invalid_input', reason: { kind: 'user_request_belongs_to_top' } });
  assert.equal((await f.get(task.id)).hash, moved.hash);
  await f.commands.move({ id: task.id, parentId: f.project, expectedTaskHash: moved.hash });
  assert.equal((await f.get(task.id)).meta.userRequested, false);
});

test('a marked review, including a held review, must be decided before moving under a task', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), task = await f.task('Review', { userRequested: true });
  const owner = await f.work(task); await f.report(owner, 'done'); f.end(owner);
  for (const held of [false, true]) {
    if (held) await f.person(task.id, 'held');
    const before = await f.get(task.id), rows = f.store(runs => runs.readReturns());
    await assert.rejects(f.commands.move({ id: task.id, parentId: parent.id, expectedTaskHash: before.hash }),
      { code: 'conflict', reason: { kind: 'awaits_user_s_review_confirm_it_or_send_it_back_first', task: task.id } });
    assert.equal((await f.get(task.id)).hash, before.hash);
    assert.deepEqual(f.store(runs => runs.readReturns()), rows);
  }
});

test('a parent moving work under itself already knows, so it gets no work_changed', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), task = await f.plan('Moving');
  await new ControlTaskCommands(f.root, { kind: 'placement', placementId: parent.placementId })
    .move({ id: task, parentId: parent.id, expectedTaskHash: (await f.get(task)).hash });
  assert.deepEqual(f.store(runs => runs.readReturns()), []);
});

for (const action of ['hold', 'unhold'] as const) test(`${action} tells the waiting parent once and keeps the child's Request open`, async t => {
  const h = await waitingPair(t), { f, child, work, parent } = h;
  if (action === 'unhold') await f.person(child.id, 'held');
  const before = h.rows().length;
  await f.person(child.id, action === 'hold' ? 'held' : 'doing');
  const cause = (await f.get(child.id)).meta.log.at(-1)!;
  const notices = h.rows().slice(before);
  assert.deepEqual(notices.map(row => [row.outcome, row.causeLogId]), [['work_changed', cause.id]]);
  const requestId = f.run(work).requestId;
  assert.ok(!h.rows().some(row => row.requestId === requestId), 'a hold is not a closing result');
  const routed = await h.pass();
  assert.equal(routed.acceptedRequestIds.length, 1);
  assert.equal(f.store(runs => runs.getRequest(routed.acceptedRequestIds[0]!)!.taskId), parent.id);
});

test('holding a child with no open parent Request creates no notice', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), child = await f.task('Child', { parentId: parent.id });
  await f.person(child.id, 'held'); await f.person(child.id, 'todo');
  assert.deepEqual(f.store(runs => runs.readReturns()), []);
});

for (const change of ['hold', 'move', 'failure'] as const) {
  for (const barrier of ['held', 'failed'] as const) test(`${change} waits at a ${barrier} parent and arrives when the parent resumes`, async t => {
    const h = await waitingPair(t), { f, parent, child, work } = h;
    if (barrier === 'held') await f.person(parent.id, 'held');
    else f.end(await f.work(parent), 'failed');
    if (change === 'hold') await f.person(child.id, 'held');
    else if (change === 'move') {
      const moved = await f.plan('Incoming', { userRequested: true });
      await f.commands.move({ id: moved, parentId: parent.id, expectedTaskHash: (await f.get(moved)).hash });
    } else f.end(work, 'failed');
    const pass = await h.pass();
    assert.deepEqual(pass.acceptedRequestIds, []);
    assert.ok(h.rows().some(row => row.outcome === (change === 'failure' ? 'failed' : 'work_changed')));
    if (barrier === 'held') {
      await f.person(parent.id, 'doing');
      assert.equal((await h.pass()).acceptedRequestIds.length, 1);
    } else {
      const resumed = await f.request(parent);
      const requestId = f.run(resumed).requestId;
      assert.ok(h.rows().every(row => row.deliveries.some(delivery => delivery.wakeRequestId === requestId)),
        'a human retry carries the deferred changes');
    }
  });
}

test('moving under a waiting parent wakes it without requiring another instruction', async t => {
  const h = await waitingPair(t), moving = await h.f.plan('Incoming', { userRequested: true });
  await h.f.commands.move({ id: moving, parentId: h.parent.id, expectedTaskHash: (await h.f.get(moving)).hash });
  assert.equal((await h.pass()).acceptedRequestIds.length, 1);
});

test('an unmarked child failure wakes its parent and uses its failure identity when escalated to the user', async t => {
  const h = await waitingPair(t), { f, child, work } = h;
  f.end(work, 'failed');
  assert.equal((await f.get(child.id)).meta.userRequested, false);
  const failure = (await f.get(child.id)).meta.log.findLast(log => log.toState === 'error')!;
  const pass = await h.pass();
  assert.equal(pass.acceptedRequestIds.length, 1);
  const runId = f.store(runs => runs.getRequest(pass.acceptedRequestIds[0]!)!.runId!);
  const parent: Seat = { ...h.parent, runId }; f.start(parent);
  await f.ask(parent, 'user');
  assert.deepEqual((await readControlTree(f.root)).balls[child.id], { holder: 'parent', reason: 'failed' },
    'the parent is still working');
  f.end(parent);
  const ball = (await readControlTree(f.root)).balls[child.id];
  assert.equal(ball?.holder, 'user');
  if (ball?.holder === 'user') assert.deepEqual([ball.reason, ball.key, ball.at], ['failed', failure.id, failure.at]);
});

for (const action of ['hold', 'unhold', 'move'] as const) test(`${action} and its notice roll back together when the notice cannot be saved`, async t => {
  const h = await waitingPair(t), { f, child, parent } = h;
  if (action === 'unhold') await f.person(child.id, 'held');
  const id = action === 'move' ? await f.plan('Incoming', { userRequested: true }) : child.id;
  const before = await f.get(id), rows = f.store(runs => runs.readReturns());
  const hook = failNotice(t);
  try {
    await assert.rejects(action === 'move'
      ? f.commands.move({ id, parentId: parent.id, expectedTaskHash: before.hash })
      : f.person(id, action === 'hold' ? 'held' : 'doing'), /injected notice failure/);
  } finally { hook.mock.restore(); }
  assert.equal((await f.get(id)).hash, before.hash);
  assert.deepEqual(f.store(runs => runs.readReturns()), rows);
});

test('a child still returns its original result after a hold and its release', async t => {
  const h = await waitingPair(t), { f, child, work } = h;
  await f.person(child.id, 'held'); await f.person(child.id, 'doing');
  await f.report(work, 'done'); f.end(work);
  const pass = await h.pass(), requestId = f.run(work).requestId;
  const result = h.rows().find(row => row.requestId === requestId);
  assert.equal(result?.outcome, 'succeeded');
  assert.equal(pass.acceptedRequestIds.length, 1);
  assert.ok(result?.deliveries.some(delivery => delivery.wakeRequestId === pass.acceptedRequestIds[0]));
});

test('B05 reads the failure requester seat after a move, rather than the current logical parent', async t => {
  const h = await waitingPair(t), { f, child, work } = h;
  f.end(work, 'failed');
  const newParent = await f.task('New parent'), newOwner = await f.work(newParent);
  await f.ask(newOwner, 'user'); f.end(newOwner);
  await f.commands.move({ id: child.id, parentId: newParent.id, expectedTaskHash: (await f.get(child.id)).hash });
  assert.deepEqual((await readControlTree(f.root)).balls[child.id], { holder: 'parent', reason: 'failed' },
    'the new parent’s question is not an escalation by the failure requester');
  const originalOwner = await f.work(h.parent);
  await f.ask(originalOwner, 'user'); f.end(originalOwner);
  const escalated = (await readControlTree(f.root)).balls[child.id];
  assert.equal(escalated?.holder, 'user');
  if (escalated?.holder === 'user') assert.equal(escalated.reason, 'failed');
});


/** A real worker Request on the child's own Task, concurrent with the parent's Request to its responsible. */
async function withWorker(t: TestContext, parentRequest: boolean) {
  const f = await taskFlow(t), parent = await f.task('Parent'), owner = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id }), childOwner = await f.work(child, parentRequest ? owner : undefined);
  const member = (await new PlacementCommands(f.root).placeMember({ taskId: child.id, profileKey: 'fake',
    expectedTaskHash: (await f.get(child.id)).hash, expectedResponsibleRevision: 1 }, human)).placement;
  const worker = await new TaskRequestService(f.root).request({ task: child.id, body: 'Worker task', opId: randomUUID(),
    agent: member.id, expectedTaskHash: (await f.get(child.id)).hash, expectedPlacementRevision: member.revision },
  { kind: 'placement', placementId: child.placementId },
  { kind: 'run', runId: childOwner.runId, placementId: child.placementId, taskId: child.id, role: 'owner', responsible: true });
  f.end(owner); f.end(childOwner);
  const open = (taskId: string) => f.store(runs => runs.write(tx => new ReturnLifecycle(runs.connection, tx,
    new TaskRepository(f.root, runs.connection).related(child.id).tasks, f.project)
    .openRequests(taskId).map(request => request.id)));
  return { f, parent, child, childOwner, workerRequestId: f.store(runs => runs.get(worker.outcome.request.runId)!.requestId), open };
}

test('holding and releasing a child with its own worker notifies only the parent and keeps both Requests open', async t => {
  const { f, parent, child, childOwner, workerRequestId, open } = await withWorker(t, true);
  const parentRequestId = f.run(childOwner).requestId;
  const expected: { seat: string; cause: string }[] = [];
  for (const state of ['held', 'doing'] as const) {
    const before = await f.get(child.id);
    await f.person(child.id, state);
    const after = await f.get(child.id);
    assert.equal(after.meta.hold, state === 'held');
    assert.equal(after.meta.version, before.meta.version + 1n);
    expected.push({ seat: parent.id, cause: after.meta.log.at(-1)!.id });
    const notices = f.store(runs => runs.readReturns().filter(row => row.outcome === 'work_changed'));
    assert.deepEqual(notices.map(row => ({ seat: row.toTaskId, cause: row.causeLogId })), expected);
    assert.deepEqual(open(parent.id), [parentRequestId]);
    assert.deepEqual(open(child.id), [workerRequestId]);
  }
  const routed = await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  assert.equal(routed.acceptedRequestIds.length, 1);
  assert.equal(f.store(runs => runs.getRequest(routed.acceptedRequestIds[0]!)!.taskId), parent.id);
});

test('a worker Request alone never turns a child hold or release into a notice to itself', async t => {
  const { f, child, workerRequestId, open } = await withWorker(t, false);
  for (const state of ['held', 'doing'] as const) {
    await f.person(child.id, state);
    assert.deepEqual(f.store(runs => runs.readReturns()), []);
    assert.deepEqual(open(child.id), [workerRequestId]);
  }
});

for (const self of [false, true]) test(`moving a child with an open parent Request and its own worker ${self ? 'does not notify its acting new parent' : 'notifies its new parent once'}`, async t => {
  const { f, parent: oldParent, child, workerRequestId, open } = await withWorker(t, true);
  const parent = await f.task('New parent'), before = await f.get(child.id);
  const commands = self ? new ControlTaskCommands(f.root, { kind: 'placement', placementId: parent.placementId }) : f.commands;
  await commands.move({ id: child.id, parentId: parent.id, expectedTaskHash: before.hash });
  const moved = (await f.get(child.id)).meta.log.findLast(log => log.kind === 'moved')!;
  const notices = f.store(runs => runs.readReturns().filter(row => row.outcome === 'work_changed'));
  assert.deepEqual(notices.map(row => [row.toTaskId, row.causeLogId]), self ? [] : [[parent.id, moved.id]]);
  assert.deepEqual(open(child.id), [workerRequestId]);
  assert.deepEqual(open(oldParent.id), [], 'moving closes the old parent’s Request while its worker Request stays open');
});
