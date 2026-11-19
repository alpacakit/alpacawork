import { managerScript } from '@alpacawork/backend/test-dist/runs/scheduler.js';
/** Accepted work ends into the existing closing/delivery Owner; an admission abort owes no result. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, mkdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { assignResponsible } from './helpers/control-fixture.ts';
import { taskFlow } from './task-flow.fixture.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { readControlTree } from './helpers/control-tree.ts';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { decide } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { reserveAttempt } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { tryLock, unlock } from '@alpacawork/core';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';

const decideIn = store => store.write(tx => decide(tx, { store, settings: readAgentsSettings(store.root),
  launches: [], prepared: new Set(), folderFailures: new Map(), unmanaged: new Map() }));
const settle = f => f.store(decideIn);
const managerLock = (root: string, id: string) => {
  mkdirSync(runFolder(root, id), { recursive: true });
  const fd = openSync(join(runFolder(root, id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(fd), true);
  return () => { unlock(fd); closeSync(fd); };
};
const branch = async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B');
  const x = await f.task('X', { parentId: a.id }), owner = await f.work(x);
  const y = await f.task('Y', { parentId: x.id }), child = await f.request(y, owner);
  f.end(owner);
  return { f, b, x, y, child, requestId: f.run(child).requestId };
};
const move = async (f, task, parent) => f.commands.move({ id: task.id, parentId: parent.id,
  expectedTaskHash: (await f.get(task.id)).hash });
const answers = (f, id) => f.store(s => s.readReturns().filter(r => r.requestId === id));
const pass = f => new ReturnRouter(f.root).pass(undefined, { project: f.project });

// Through the same CLI -> product HTTP -> scheduler -> router path as a real request.
test('CLI ancestor move closes accepted child work to its original requester, without starting stale scope', { timeout: 120_000 }, async t => {
  const { f, b, x, y, child, requestId } = await branch(t), unlockManager = managerLock(f.root, child.runId);
  const server = await startServer(f.root, 0);
  try {
    const moved = await cliRun(server.url, ['task', 'move', '--task', x.id, '--parent', b.id,
      '--expected-task-hash', (await f.get(x.id)).hash]);
    assert.equal(moved.code, 0, moved.stderr);
    const summary = settle(f);
    assert.ok(summary.skipped.some(s => s.run === child.runId && s.reason === 'request_invalidated_by_stop'));
    assert.deepEqual(summary.launched, []);
    assert.equal(f.run(child).state, 'cancelled'); assert.equal(f.run(child).reason, 'scope_invalidated'); assert.equal(f.run(child).started_at, null);
    assert.equal(f.store(s => s.getRequest(requestId)).deliveryState, 'queued', 'accepted work still owes a result');
    assert.ok(!(await readControlTree(f.root)).working!.includes(y.id), 'invalidated child never becomes working');
    assert.ok(!(await f.get(y.id)).meta.log.some(l => l.kind === 'moved'), 'only the ancestor moved');
    await pass(f); await pass(f); settle(f);
    const rows = answers(f, requestId);
    assert.equal(rows.length, 1); assert.equal(rows[0].toTaskId, x.id);
    assert.equal(rows[0].outcome, 'stopped'); assert.equal(rows[0].boundaryRunId, child.runId);
    // The live router may have delivered before this manual pass; its durable delivery is the receipt.
    assert.equal(rows[0].deliveries.length, 1);
    assert.equal(f.store(s => s.getRequest(rows[0].deliveries[0].wakeRequestId)).taskId, x.id);
    assert.ok((await readControlTree(f.root)).working!.includes(x.id));
  } finally { await server.close(); unlockManager(); }
});

for (const stage of ['run', 'closing', 'delivery']) test(`ancestor invalidation ${stage} save failure rolls back and restart retries one result/wake`, async t => {
  const { f, b, x, child, requestId } = await branch(t);
  await move(f, x, b);
  const trigger = stage === 'run'
    ? `BEFORE UPDATE ON runs WHEN OLD.request_id='${requestId}' AND NEW.state='cancelled'`
    : stage === 'closing' ? `BEFORE INSERT ON returns WHEN NEW.request_id='${requestId}'`
    : `BEFORE INSERT ON return_deliveries WHEN NEW.return_id=(SELECT id FROM returns WHERE request_id='${requestId}')`;
  f.store(s => s.connection.exec(`CREATE TRIGGER invalidation_fault ${trigger} BEGIN SELECT RAISE(ABORT,'invalidation-fault'); END`));
  if (stage === 'run') assert.throws(() => settle(f), /invalidation-fault/);
  else { settle(f); await assert.rejects(pass(f), /invalidation-fault/); }
  assert.equal(f.run(child).state, stage === 'run' ? 'queued' : 'cancelled');
  assert.equal(f.store(s => s.getRequest(requestId)).deliveryState, 'queued');
  assert.equal(answers(f, requestId).length, stage === 'delivery' ? 1 : 0, 'closing and wake admission are separate existing atomic transactions');
  if (stage === 'delivery') assert.equal(answers(f, requestId)[0].deliveries.length, 0, 'failed wake admission commits no delivery');
  const history = (await f.get(x.id)).meta.log;
  f.store(s => s.connection.exec('DROP TRIGGER invalidation_fault'));
  settle(f); await pass(f); await pass(f); settle(f); // fresh store/Router connections on every retry
  const rows = answers(f, requestId);
  assert.equal(rows.length, 1); assert.equal(rows[0].boundaryRunId, child.runId);
  assert.equal(rows[0].deliveries.length, 1);
  assert.equal(f.store(s => Number(s.connection.prepare('SELECT count(*) AS n FROM requests WHERE id=?').get(requestId).n)), 1);
  const after = (await f.get(x.id)).meta.log;
  assert.equal(new Set(after.map(l => l.id)).size, after.length);
  assert.ok(history.every(l => after.some(a => a.id === l.id)));
  const stable = after; await pass(f); settle(f);
  assert.deepEqual((await f.get(x.id)).meta.log, stable);
});

for (const closeBefore of [true, false]) test(`target move normal closing ${closeBefore ? 'before' : 'after'} scheduler remains the single result`, async t => {
  const { f, b, x, y, child, requestId } = await branch(t);
  await move(f, y, b);
  if (closeBefore) await pass(f);
  settle(f); await pass(f); await pass(f);
  const rows = answers(f, requestId);
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'moved');
  assert.equal(rows[0].toTaskId, x.id); assert.equal(rows[0].boundaryRunId, null);
  assert.ok(rows[0].causeLogId); assert.equal(f.run(child).state, 'cancelled');
});

test('invalidated worker result keeps HTTP finish receipt guard and legal idempotent completion', { timeout: 120_000 }, async t => {
  const h = await handlingFixture(t), owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); h.end(owner.runId); h.reconcile();
  const commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const b = (await commands.create({ parentId: h.project, tasks: [{ title: 'B' }], userRequested: false })).tasks[0];
  await assignResponsible(h.root, b, 'fake');
  await commands.move({ id: h.task.id, parentId: b.id, expectedTaskHash: (await h.current()).hash });
  decideIn(h.store);
  assert.equal(h.store.get(worker.runId).state, 'cancelled');
  assert.deepEqual((await readControlTree(h.root)).working, []);
  const routed = await h.pass(), wake = routed.acceptedRequestIds.map(id => h.store.getRequest(id)).find(r => r.taskId === h.task.id);
  assert.ok(wake?.runId);
  const row = h.store.readReturns().find(r => r.requestId === worker.requestId);
  assert.equal(row.outcome, 'stopped'); assert.equal(row.boundaryRunId, worker.runId);
  h.store.write(tx => tx.update({ ...tx.get(wake.runId), state: 'running', started_at: new Date().toISOString() }));
  h.reconcile();
  const unlockManager = managerLock(h.root, wake.runId), server = await startServer(h.root, 0);
  try {
    const token = issueRunCredential(h.root, wake.runId);
    const input = { task: h.task.id, state: 'done', title: 'Received invalidation', description: 'The result is ready for review.', opId: randomUUID(), expectedTaskHash: (await h.current()).hash };
    const post = async data => {
      const response = await commandFetch(new URL('/api/task/report', server.url), { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Alpacawork-Run ${wake.runId}:${token}` }, body: JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    };
    const before = await h.current(), refused = await post(input);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await h.current()).hash, before.hash);
    h.store.write(tx => tx.update({ ...tx.get(wake.runId), pids: { manager: 1, agent: 2 } }));
    const completed = await post(input), again = await post(input);
    assert.equal(completed.status, 200, JSON.stringify(completed.body)); assert.equal(again.status, 200);
    assert.equal((await h.current()).meta.log.filter(l => l.id === input.opId).length, 1);
  } finally { await server.close(); unlockManager(); }
});

test('a stale continuation releases its undelivered result and routes a fresh valid wake once', async t => {
  const h = await handlingFixture(t), delivered = await h.deliver(false);
  const commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const b = (await commands.create({ parentId: h.project, tasks: [{ title: 'B' }], userRequested: false })).tasks[0];
  await assignResponsible(h.root, b, 'fake');
  await commands.move({ id: h.task.id, parentId: b.id, expectedTaskHash: (await h.current()).hash });
  h.store.connection.exec(`CREATE TRIGGER continuation_fault BEFORE UPDATE ON requests WHEN OLD.id='${delivered.request}' AND NEW.delivery_state='aborted' BEGIN SELECT RAISE(ABORT,'continuation-fault'); END`);
  assert.throws(() => decideIn(h.store), /continuation-fault/);
  assert.equal(h.store.get(delivered.run).state, 'queued', 'Run and continuation admission roll back together');
  assert.equal(h.store.getRequest(delivered.request).deliveryState, 'queued');
  h.store.connection.exec('DROP TRIGGER continuation_fault');
  decideIn(h.store);
  assert.equal(h.store.get(delivered.run).state, 'cancelled');
  assert.equal(h.store.getRequest(delivered.request).deliveryState, 'aborted');
  const routed = await h.pass(); await h.pass();
  const row = h.store.readReturns().find(r => r.id === delivered.answer.id);
  assert.equal(h.store.readReturns().filter(r => r.requestId === delivered.work.requestId).length, 1);
  assert.equal(h.store.readReturns().filter(r => r.requestId === delivered.request).length, 0, 'a seat continuation owes no closing return');
  assert.equal(row.deliveries.length, 2);
  assert.equal(row.deliveries[0].releaseReason, 'not_delivered');
  const fresh = h.store.getRequest(row.deliveries[1].wakeRequestId);
  assert.ok(routed.acceptedRequestIds.includes(fresh.id));
  decideIn(h.store); assert.equal(h.store.get(fresh.runId).state, 'queued', 'fresh scope is valid, awaiting folder preparation');
});

test('unknown admission and uncertain input remain excluded from scope invalidation', async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B');
  const child = await f.task('Unknown', { parentId: a.id }), unknown = await f.request(child);
  f.store(s => s.connection.prepare('DELETE FROM task_start_grants WHERE request_id=?').run(f.run(unknown).requestId));
  assert.ok(settle(f).skipped.some(e => e.reason === 'resume_scope_unknown')); assert.equal(f.run(unknown).state, 'queued');
  const other = await f.task('Uncertain', { parentId: a.id }), uncertain = await f.request(other);
  f.store(store => store.write(tx => {
    const settings = readAgentsSettings(f.root); assert.equal(settings.ok, true);
    const attempt = reserveAttempt(store, tx, tx.get(uncertain.runId), managerScript, settings.config.limits);
    store.connection.prepare("UPDATE run_inputs SET state='uncertain' WHERE attempt_id=?").run(attempt.attemptId);
  }));
  await move(f, other, b); settle(f);
  assert.equal(f.run(uncertain).state, 'queued');
  assert.deepEqual(f.store(s => s.connection.prepare('SELECT state FROM run_inputs').all()).map(s => s.state), ['uncertain']);
});

for (const routedFirst of [false, true]) test(`ancestor cancellation then child move ${routedFirst ? 'after' : 'before'} routing keeps the first boundary`, async t => {
  const { f, b, x, y, child, requestId } = await branch(t);
  await move(f, x, b); settle(f);
  if (routedFirst) await pass(f);
  await move(f, y, b); await pass(f); await pass(f);
  const rows = answers(f, requestId);
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'stopped');
  assert.equal(rows[0].boundaryRunId, child.runId); assert.equal(rows[0].toTaskId, x.id);
});

test('ordinary child stop closes one accepted result and a fresh request keeps its own valid scope', async t => {
  const { f, x, y, child, requestId } = await branch(t);
  await f.person(y.id, 'stopped'); await pass(f); settle(f);
  const rows = answers(f, requestId);
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'stopped'); assert.equal(rows[0].toTaskId, x.id);
  assert.equal(f.run(child).state, 'cancelled');
  const fresh = await f.request(y); settle(f); await pass(f);
  assert.equal(f.run(fresh).state, 'queued');
  assert.equal(f.store(s => s.getRequest(f.run(fresh).requestId)).deliveryState, 'queued');
  assert.equal(answers(f, requestId).length, 1);
});
