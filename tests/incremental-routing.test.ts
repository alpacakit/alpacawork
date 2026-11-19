/** Scoped routing must deliver exactly the same work as a full pass and leave no work for its safety sweep. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReturnRouter, routingSweep } from '@alpacawork/backend/test-dist/control/return-router.js';
import { RunEventImporter, releaseReserved } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { keepControlChanges, type ChangeSeq } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore, type CreateRunFields } from '@alpacawork/runs';
import { taskFlow } from './task-flow.fixture.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { closureOf, requesterSeat } from '@alpacawork/backend/test-dist/control/return-rules.js';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields } from './runs-fixtures.ts';

const seq = (value: number) => value as ChangeSeq;
const work = (tasks: Iterable<string>, mode: 'changed' | 'sweep' = 'changed') =>
  ({ tasks: new Set(tasks), after: seq(2), through: seq(7), mode });
const allTasks = (f: Awaited<ReturnType<typeof taskFlow>>) => f.store(store => store.connection
  .prepare("SELECT external_id FROM tasks WHERE kind='task' ORDER BY number").all().map(row => String(row.external_id)));

/** Ignore generated identifiers and clock values, retaining every observable business outcome. */
function business(f: { store: <T>(read: (store: RunStore) => T) => T }) {
  return f.store(store => {
    const snapshot = store.snapshot();
    const runOf = (id: string) => store.getRequest(id)?.runId ?? null;
    const identities = snapshot.placements.map(placement => [placement.id,
      `placement:${placement.taskId}:${snapshot.records!.find(run => run.placementId === placement.id)?.id ?? placement.profileKey}`]);
    const tasks = new TaskRepository(store.root, store.connection);
    for (const row of store.connection.prepare('SELECT external_id FROM tasks').all()) {
      const task = tasks.get(String(row.external_id));
      task.meta.log.forEach((log, ordinal) => identities.push([log.id, `log:${task.id}:${ordinal}`]));
    }
    identities.sort(([a], [b]) => b!.length - a!.length);
    // Each synthetic world allocates its own UUIDs; their corresponding placements and log positions are the same facts.
    const bodyOf = (body: string) => identities.reduce((body, [id, name]) => body.split(id!).join(name!), body);
    return {
      runs: snapshot.records!.map(run => ({ id: run.id, task: run.task, role: run.role, state: run.state,
        caller: run.caller?.run ?? null, request: store.getRequest(run.requestId)?.purpose,
        delivery: store.getRequest(run.requestId)?.deliveryState })),
      returns: snapshot.returns.map(row => ({ to: row.toTaskId, outcome: row.outcome, request: row.requestId && runOf(row.requestId),
        hold: row.holdReason, resolution: row.resolution?.reason ?? null,
        deliveries: row.deliveries.map(delivery => ({ run: runOf(delivery.wakeRequestId),
          received: !!delivery.receivedAt, consumed: !!delivery.consumedAt, released: delivery.releaseReason })) }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      cycles: snapshot.waitCycles.map(cycle => ({ task: cycle.taskId, closed: !!cycle.closedAt,
        requests: snapshot.requests.filter(request => request.waitCycleId === cycle.id).map(request => request.runId).sort() }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      continuations: snapshot.requests.filter(request => request.purpose === 'return_continuation')
        .map(request => ({ run: request.runId, task: request.taskId, body: bodyOf(request.body) }))
        .sort((a, b) => a.run!.localeCompare(b.run!)),
    };
  });
}

test('scoped and full routing agree on child closures, deliveries, receipts, resolution and automatic requests', async t => {
  const narrow = await taskFlow(t), full = await taskFlow(t);
  const worlds = [narrow, full];
  const states = [];
  for (const f of worlds) {
    const parent = await f.task('Parent'), child = await f.task('Child', { parentId: parent.id });
    const unrelated = await f.task('Unrelated');
    const owner = await f.work(parent), childRun = await f.work(child, owner);
    f.end(owner);
    await f.report(childRun, 'done'); f.end(childRun);
    states.push({ parent, child, unrelated, owner, question: undefined as { child: typeof owner; id: string } | undefined });
  }
  const compare = async () => {
    for (const [index, f] of worlds.entries()) {
      const state = states[index]!;
      const result = await new ReturnRouter(f.root).route(work(index === 0 ? [state.parent.id, state.child.id] : allTasks(f)));
      assert.equal(result.completedThrough, 7);
    }
    assert.deepEqual(business(narrow), business(full));
    const misses: unknown[] = [];
    const router = new ReturnRouter(narrow.root, miss => misses.push(miss));
    for (const slice of routingSweep(allTasks(narrow), seq(7), seq(7), 1)) await router.route(slice);
    assert.deepEqual(misses, [], 'a complete scoped pass leaves the full sweep no business writes');
  };
  await compare();
  for (const [index, f] of worlds.entries()) {
    const parent = states[index]!.parent;
    const wake = f.store(store => store.snapshot().records!.find(run => run.task === parent.id &&
      store.getRequest(run.requestId)?.purpose === 'return_continuation')!);
    assert.ok(wake);
    f.start({ ...parent, runId: wake.id });
    f.store(store => store.write(tx => tx.update({ ...tx.get(wake.id)!, pids: { manager: 1, agent: 2 } })));
  }
  await compare();
  for (const [index, f] of worlds.entries()) {
    const state = states[index]!;
    await f.person(state.parent.id, 'held');
    const child = await f.work(state.child);
    const question = await f.ask(child, state.parent.id);
    state.question = { child, id: question };
  }
  await compare();
  for (const [index, f] of worlds.entries()) {
    const question = states[index]!.question!;
    await f.withdraw(question.child, question.id);
  }
  await compare();
  assert.ok(business(narrow).returns.some(row => row.resolution !== null), 'withdrawing a held question resolves its notice');
  for (const [index, f] of worlds.entries()) await f.person(states[index]!.parent.id, 'stopped');
  await compare();
});

test('read context never becomes another seat to reconcile, close or wake', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent'), child = await f.task('Child', { parentId: parent.id });
  const other = await f.task('Other');
  const owner = await f.work(parent), member = await f.work(child, owner);
  f.end(owner); await f.report(member, 'done'); f.end(member);
  const misses: unknown[] = [];
  const router = new ReturnRouter(f.root, miss => misses.push(miss));
  const before = business(f);
  await router.route(work([other.id]));
  assert.deepEqual(business(f), before, 'a disjoint seat does not close another seat\'s request or wait');
  await router.route(work([child.id]));
  assert.deepEqual(business(f), before, 'the parent is read context, not a processed seat');
  const result = await router.route(work([parent.id]));
  assert.equal(result.acceptedRequestIds.length, 1);
  for (const slice of routingSweep(allTasks(f), seq(7), seq(7), 1)) await router.route(slice);
  assert.deepEqual(misses, []);
});

test('unreadable historical Runs do not prevent a scoped return from identifying its sender and joined work', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Sender'), child = await f.task('Selected child', { parentId: parent.id });
  const outside = await f.task('Earlier work');
  f.store(store => store.write(tx => {
    const make = (task: typeof parent, extra: Partial<CreateRunFields> = {}) =>
      createFixtureRun(store, tx, fields({ task: task.id, placementId: task.placementId, role: 'worker', ...extra }), 'Fixture work');
    const old = make(outside), older = make(outside, { resumes: old.id });
    const callerAncestor = make(outside);
    const caller = make(parent, { role: 'owner', resumes: older.id, caller: { run: callerAncestor.id } });
    const actual = make(outside, { resumes: older.id, caller: { run: callerAncestor.id } });
    tx.update({ ...actual, state: 'running', started_at: new Date().toISOString() });
    const requestId = 'selected-worker-request', cycle = 'sender-wait-cycle';
    store.connection.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,?,?)')
      .run(cycle, parent.id, new Date().toISOString());
    tx.insertRequest({ id: requestId, taskId: child.id, placementId: child.placementId, placementRevision: 1,
      taskHash: new TaskRepository(f.root, store.connection).get(child.id).hash, waitCycleId: cycle, headRunId: null,
      mode: 'new', body: 'Investigate', purpose: 'instruction', author: { kind: 'placement', placementId: parent.placementId },
      submittedAt: new Date().toISOString(), deliveryState: 'queued' });
    const joined = make(child, { requestId, resumes: older.id, caller: { run: caller.id } });
    tx.update({ ...joined, state: 'joined', into: actual.id, ended_at: new Date().toISOString() });
    tx.finish({ ...tx.get(actual.id)!, state: 'failed', reason: 'exit', ended_at: new Date().toISOString() },
      { state: 'missing', text: null });

    // These valid references remain stored, but their unrelated history cannot be decoded as Run records.
    store.connection.prepare(`UPDATE runs SET record=json_set(record,'$.state','unreadable-fixture')
      WHERE id IN (SELECT value FROM json_each(?))`)
      .run(JSON.stringify([old, older, callerAncestor].map(run => Number(run.id.slice(1)))));
    const tasks = new TaskRepository(f.root, store.connection).snapshot().tasks;
    const lifecycle = new ReturnLifecycle(store.connection, tx, tasks);
    lifecycle.reconcile(work([child.id]));
    const request = tx.getRequest(requestId)!;
    assert.equal(requesterSeat(request, lifecycle.current.facts), parent.id, 'the direct caller fixes the return destination');
    assert.deepEqual(closureOf(request, lifecycle.current.facts), { outcome: 'failed', runId: actual.id, causeLogId: null },
      'the joined worker closes at its actual work boundary');
  }));
});

test('scoped and full routing withdraw the same stale continuation and carry its result to a retry', async t => {
  const worlds = [await handlingFixture(t), await handlingFixture(t)];
  const read = (h: typeof worlds[number]) => business({ store: callback => callback(h.store) });
  const states = [];
  for (const [index, h] of worlds.entries()) {
    const outside = (await h.commands.create({ parentId: h.project, userRequested: false, tasks: [{ title: 'Unchanged' }] })).tasks[0]!;
    const owner = await h.human(); await h.start(owner.runId);
    const worker = await h.delegate(owner.runId); await h.start(worker.runId); h.end(worker.runId);
    const tasks = index === 0 ? [h.task.id] : [h.task.id, outside.id];
    const result = await new ReturnRouter(h.root).route(work(tasks));
    assert.equal(result.acceptedRequestIds.length, 1, 'a live seat accepting input gets a continuation');
    states.push({ owner, tasks, request: result.acceptedRequestIds[0]! });
  }
  assert.deepEqual(read(worlds[0]!), read(worlds[1]!));
  for (const [index, h] of worlds.entries()) {
    const state = states[index]!;
    h.end(state.owner.runId, 'failed');
    await new ReturnRouter(h.root).route(work(state.tasks));
    assert.equal(h.store.getRequest(state.request)!.deliveryState, 'aborted');
    assert.ok(h.store.readReturns().some(row => row.deliveries.some(delivery => delivery.releaseReason === 'seat_failed')));
  }
  assert.deepEqual(read(worlds[0]!), read(worlds[1]!));
  for (const [index, h] of worlds.entries()) {
    const retry = await h.human(); await h.start(retry.runId);
    await new ReturnRouter(h.root).route(work(states[index]!.tasks));
  }
  assert.deepEqual(read(worlds[0]!), read(worlds[1]!));
  const misses: unknown[] = [];
  await new ReturnRouter(worlds[0]!.root, miss => misses.push(miss)).route(work(states[1]!.tasks, 'sweep'));
  assert.deepEqual(misses, []);
});

test('a busy wake keeps the work range incomplete and retry sends its result once', async t => {
  const h = await handlingFixture(t);
  const owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId);
  h.end(owner.runId); h.end(worker.runId);
  const router = new ReturnRouter(h.root);
  const original = RequestService.prototype.request;
  const stub = t.mock.method(RequestService.prototype, 'request', async () => { throw new Problem(PROBLEM_CODE.busy, 'Busy'); });
  const first = await router.route(work([h.task.id]));
  assert.equal(first.completed, false); assert.equal(first.completedThrough, null);
  stub.mock.restore();
  assert.equal(RequestService.prototype.request, original);
  const retried = await router.route(work([h.task.id]));
  assert.equal(retried.completedThrough, 7); assert.equal(retried.acceptedRequestIds.length, 1);
  assert.equal((await router.route(work([h.task.id]))).acceptedRequestIds.length, 0);
});

test('refusals resolved by a later seat write complete the range without holding or delivering the result', async t => {
  const h = await handlingFixture(t);
  const owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId);
  h.end(owner.runId); h.end(worker.runId);
  const router = new ReturnRouter(h.root);
  for (const code of [PROBLEM_CODE.conflict, PROBLEM_CODE.conversationBusy, PROBLEM_CODE.handoffPending]) {
    const stub = t.mock.method(RequestService.prototype, 'request', async () => { throw new Problem(code, 'Try after a seat write'); });
    const result = await router.route(work([h.task.id]));
    assert.equal(result.completed, true, code); assert.equal(result.completedThrough, 7, code);
    assert.deepEqual([result.acceptedRequestIds, result.held], [[], []]);
    const row = h.store.readReturns().find(row => row.requestId === worker.requestId)!;
    assert.equal(row.holdReason, null); assert.equal(row.deliveries.length, 0);
    stub.mock.restore();
  }
  assert.equal((await router.route(work([h.task.id]))).acceptedRequestIds.length, 1);
});

test('routing receipts exclude other seats and completions that arrived while processing', async t => {
  const f = await taskFlow(t);
  const a = await f.work(await f.task('First')), b = await f.work(await f.task('Second'));
  f.end(a); f.end(b);
  const store = new RunStore(f.root, { busyTimeoutMs: 1000 });
  t.after(() => store.close());
  store.write(() => {
    store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json,dirty) VALUES (?,?,?,1)').run(Number(a.runId.slice(1)), 'first', '{}');
    store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json,dirty) VALUES (?,?,?,1)').run(Number(b.runId.slice(1)), 'second', '{}');
  });
  const importer = new RunEventImporter(store), scope = work([a.id]);
  const receipts = importer.routingReceipts(scope);
  store.write(() => store.connection.prepare("UPDATE run_attempts SET completed_digest='later',next_seq=next_seq+1 WHERE attempt_id='first'").run());
  importer.acknowledgeRouting(scope, receipts);
  const dirty = () => store.connection.prepare('SELECT attempt_id,dirty FROM run_attempts ORDER BY attempt_id').all()
    .map(row => [row.attempt_id, row.dirty]);
  assert.deepEqual(dirty(), [['first', 1], ['second', 1]]);
  importer.acknowledgeRouting(scope, importer.routingReceipts(scope));
  assert.deepEqual(dirty(), [['first', 0], ['second', 1]]);
});

test('a sweep records a missed closure and a second sweep writes nothing', async t => {
  const h = await handlingFixture(t);
  const owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId);
  h.end(owner.runId); h.end(worker.runId);
  const events: unknown[] = [], errors: unknown[] = [];
  t.mock.method(console, 'error', value => errors.push(value));
  const router = new ReturnRouter(h.root, event => events.push(event));
  await router.route(work([h.task.id], 'sweep'));
  assert.equal(events.length, 1); assert.equal(errors.length, 1);
  await router.route(work([h.task.id], 'sweep'));
  assert.equal(events.length, 1, 'the same full work-set path becomes a no-op');
});

test('a deferred work set leaves a later independent work set deliverable', async t => {
  const f = await taskFlow(t), parents = [];
  for (const title of ['Busy', 'Ready']) {
    const parent = await f.work(await f.task(title));
    const child = await f.work(await f.task(`${title} child`, { parentId: parent.id }), parent);
    f.end(parent); await f.report(child, 'done'); f.end(child);
    parents.push(parent);
  }
  t.mock.method(console, 'error', () => {});
  const request = RequestService.prototype.request;
  t.mock.method(RequestService.prototype, 'request', function(input, context) {
    if (input.taskId === parents[0]!.id) throw new Problem(PROBLEM_CODE.busy, 'Busy first seat');
    return request.call(this, input, context);
  });
  const router = new ReturnRouter(f.root);
  const deferred = await router.route(work([parents[0]!.id], 'sweep'));
  assert.equal(deferred.completedThrough, null); assert.equal(deferred.completed, false);
  const result = await router.route(work([parents[1]!.id], 'sweep'));
  assert.equal(result.completedThrough, 7); assert.equal(result.completed, true);
  assert.equal(result.acceptedRequestIds.length, 1);
  assert.equal(f.store(store => store.getRequest(result.acceptedRequestIds[0]!)!.taskId), parents[1]!.id);
  const rows = f.store(store => store.readReturns());
  assert.equal(rows.find(row => row.toTaskId === parents[0]!.id)!.deliveries.length, 0);
  assert.equal(rows.find(row => row.toTaskId === parents[1]!.id)!.deliveries.length, 1);
});

test('routing publishes the return, delivery and wait facts its next projection needs', async t => {
  const h = await handlingFixture(t);
  const owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId);
  h.end(owner.runId); h.end(worker.runId);
  const journal = keepControlChanges(h.root);
  t.after(() => journal.close());
  journal.log.register('test', journal.log.latest);
  await new ReturnRouter(h.root).route(work([h.task.id]));
  const read = journal.log.read('test');
  assert.equal(read.kind, 'changes');
  if (read.kind !== 'changes') throw new Error('Expected changes');
  const keys = read.batches.flatMap(batch => batch.keys);
  const row = h.store.readReturns().find(row => row.requestId === worker.requestId)!;
  assert.ok(keys.some(key => key.kind === 'return' && key.id === row.id));
  assert.ok(keys.some(key => key.kind === 'delivery' && key.id === JSON.stringify([row.id, row.deliveries[0]!.wakeRequestId])));
  const cycle = h.store.getRequest(worker.requestId)!.waitCycleId;
  assert.ok(keys.some(key => key.kind === 'wait_cycle' && key.id === cycle));
});

test('releasing reserved inputs publishes every changed input, excluding settled receipts', async t => {
  const f = await taskFlow(t), seat = await f.work(await f.task('Inputs'));
  const second = await f.request(seat), third = await f.request(seat);
  f.store(store => store.write(() => {
    store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)').run(Number(seat.runId.slice(1)), 'attempt', '{}');
    const insert = store.connection.prepare('INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES (?,?,?,?,?,0)');
    for (const [id, state, run] of [['one', 'reserved', seat.runId], ['two', 'reserved', second.runId], ['taken', 'taken', third.runId]])
      insert.run(id, 'attempt', Number(run.slice(1)), 'digest', state);
  }));
  const journal = keepControlChanges(f.root);
  t.after(() => journal.close());
  journal.log.register('test', journal.log.latest);
  f.store(store => store.write(() => releaseReserved(store.connection, 'attempt', { evidence: 'test' })));
  const read = journal.log.read('test');
  if (read.kind !== 'changes') throw new Error('Expected changes');
  assert.deepEqual(read.batches.flatMap(batch => batch.keys).filter(key => key.kind === 'input').map(key => key.id).sort(), ['one', 'two']);
  assert.deepEqual(f.store(store => store.connection.prepare('SELECT input_id,state FROM run_inputs ORDER BY input_id').all())
    .map(row => [row.input_id, row.state]), [['one', 'not_sent'], ['taken', 'taken'], ['two', 'not_sent']]);
});
