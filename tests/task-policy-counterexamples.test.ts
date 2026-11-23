import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, mkdirSync, constants } from 'node:fs';
import { taskFlow } from './task-flow.fixture.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { cliCommand } from './helpers/cli-session.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { readControlTree } from './helpers/control-tree.ts';
import { decide } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { tryLock, unlock } from '@alpacawork/core';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { join } from 'node:path';

const managerLock = (root: string, run: string) => {
  mkdirSync(runFolder(root, run), { recursive: true });
  const fd = openSync(join(runFolder(root, run), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(fd), true);
  return () => { unlock(fd); closeSync(fd); };
};

test('a needs_review child remains working without inventing a user turn', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent', { userRequested: true }), owner = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id }), run = await f.work(child, owner);
  f.end(owner);
  const summary = f.store(store => store.write(tx => decide(tx, { store, settings: readAgentsSettings(f.root), launches: [],
    prepared: new Set(), folderFailures: new Map(), unmanaged: new Map([[run.runId, -1]]) })));
  assert.deepEqual(summary.lost, [run.runId]);
  const tree = await readControlTree(f.root);
  assert.ok(tree.working!.includes(child.id));
  const home = (await readWorkspaceProjection(f.root)).index.home;
  assert.equal(home.find((row: { taskId: string }) => row.taskId === parent.id).section, 'doing');
  assert.equal(home.some((row: { taskId: string }) => row.taskId === child.id), false, 'only a user ball exposes the child');
});

test('HTTP finish must reject a closed worker Request until its Return is received', async t => {
  const h = await handlingFixture(t), owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId); h.end(worker.runId);
  const before = await readControlTree(h.root);
  assert.equal(h.store.readReturns().filter(r => r.requestId === worker.requestId).length, 0);
  const unlockManager = managerLock(h.root, owner.runId);
  const server = await startServer(h.root, 0);
  try {
  const token = issueRunCredential(h.root, owner.runId), current = await h.current(), opId = randomUUID();
  const input = { task: h.task.id, state: 'done', title: 'Premature finish', description: 'The result is ready for review.', opId, expectedTaskHash: current.hash };
  const response = await commandFetch(new URL('/api/commands/task/report', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Alpacawork-Run ${owner.runId}:${token}` }, body: JSON.stringify(input) });
  const output = await response.json();
  assert.ok(before.working!.includes(h.task.id));
  assert.equal(response.status, 409, 'the result is not delivered merely because its Request has closed: ' + JSON.stringify(output));
  assert.equal((await h.current()).hash, current.hash);
  } finally { await server.close(); unlockManager(); }
});

test('CLI CAS, held Run authorization, and same-ID report retry use actual HTTP boundary', async t => {
  const f = await taskFlow(t), task = await f.task('Held owner', { userRequested: true }), owner = await f.work(task);
  await f.person(task.id, 'held');
  const unlockManager = managerLock(f.root, owner.runId);
  const server = await startServer(f.root, 0), token = issueRunCredential(f.root, owner.runId);
  try {
  const env = { ALPACAWORK_RUN: owner.runId, ALPACAWORK_RUN_TOKEN: token };
  const get = await cliCommand(server.url, ['task', 'get', '--task', task.id]);
  assert.equal(get.code, 0, get.stderr);
  const dto = JSON.parse(get.stdout).task; assert.deepEqual([dto.baseState, dto.hold], ['doing', true]);
  const before = await f.get(task.id);
  const rejected = await cliCommand(server.url, ['task', 'report', '--task', task.id, '--state', 'doing',
    '--expected-task-hash', '0'.repeat(64)], env);
  assert.notEqual(rejected.code, 0); assert.equal((await f.get(task.id)).hash, before.hash);
  const unauthorized = await cliCommand(server.url, ['task', 'new', '--parent', task.id, '--title', 'Forbidden held work'], env);
  assert.notEqual(unauthorized.code, 0); assert.equal((await f.get(task.id)).hash, before.hash);
  const opId = randomUUID(), args = ['task', 'report', '--task', task.id, '--state', 'doing', '--title', 'Held progress',
    '--op-id', opId, '--expected-task-hash', before.hash];
  const first = await cliCommand(server.url, args, env), again = await cliCommand(server.url, args, env);
  assert.equal(first.code, 0, first.stderr); assert.equal(again.code, 0, again.stderr);
  const after = await f.get(task.id);
  assert.equal(after.meta.hold, true); assert.equal(after.meta.log.filter(log => log.id === opId).length, 1);
  } finally { await server.close(); unlockManager(); }
});

for (const stage of ['batch', 'notice']) test(`review invalidation ${stage} failure rolls back both Tasks, cause and delivery; one retry`, async t => {
  const f = await taskFlow(t), parent = await f.task('Parent review', { userRequested: true });
  const child = await f.task('Child result', { parentId: parent.id }), ownChild = await f.work(child);
  await f.report(ownChild, 'done'); f.end(ownChild);
  const ownParent = await f.work(parent); await f.report(ownParent, 'done'); f.end(ownParent);
  const priorParent = await f.get(parent.id), priorChild = await f.get(child.id);
  f.store(s => s.connection.exec(stage === 'batch'
    ? `CREATE TRIGGER review_fault BEFORE UPDATE ON tasks WHEN OLD.external_id='${parent.id}' BEGIN SELECT RAISE(ABORT,'review-fault'); END`
    : `CREATE TRIGGER review_fault BEFORE INSERT ON returns WHEN NEW.outcome='work_changed' BEGIN SELECT RAISE(ABORT,'review-fault'); END`));
  const update = () => f.commands.update({ id: child.id, values: { notes: 'Changed result' }, expectedTaskHash: priorChild.hash });
  await assert.rejects(update(), /review-fault/);
  assert.equal((await f.get(parent.id)).hash, priorParent.hash); assert.equal((await f.get(child.id)).hash, priorChild.hash);
  assert.equal(f.store(s => s.readReturns().filter(r => r.outcome === 'work_changed').length), 0);
  f.store(s => s.connection.exec('DROP TRIGGER review_fault'));
  await update();
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  const returns = f.store(s => s.readReturns().filter(r => r.outcome === 'work_changed'));
  assert.equal(returns.length, 1); assert.equal((await f.get(parent.id)).meta.baseState, 'doing');
});

test('stop retains a descendant hold and late Run end never reopens stopped ancestry', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), child = await f.task('Child', { parentId: parent.id });
  const run = await f.work(child); await f.person(child.id, 'held'); await f.person(parent.id, 'stopped');
  f.end(run, 'failed');
  assert.deepEqual([(await f.get(child.id)).meta.baseState, (await f.get(child.id)).meta.hold, await f.state(parent.id)], ['stopped', true, 'stopped']);
});

test('HTTP completion succeeds after the actual worker result receipt', async t => {
  const h = await handlingFixture(t), delivered = await h.deliver();
  const unlockManager = managerLock(h.root, delivered.run), server = await startServer(h.root, 0);
  try {
    const token = issueRunCredential(h.root, delivered.run);
    const response = await commandFetch(new URL('/api/commands/task/report', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Alpacawork-Run ${delivered.run}:${token}` },
      body: JSON.stringify({ task: h.task.id, state: 'done', title: 'Result received', description: 'The result is ready for review.', opId: randomUUID(), expectedTaskHash: (await h.current()).hash }) });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal((await h.current()).meta.baseState, 'done');
  } finally { await server.close(); unlockManager(); }
});
