import { ControlStore } from '@alpacawork/db';
import { initialControlDocument } from '@alpacawork/raw';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, mkdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { TASK_BASE_STATES, type TaskState } from '@alpacawork/raw';
import { tryLock, unlock } from '@alpacawork/core';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { taskFlow } from './task-flow.fixture.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';

function lock(root: string, run: string) {
  mkdirSync(runFolder(root, run), { recursive: true });
  const fd = openSync(join(runFolder(root, run), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(fd), true);
  return () => { unlock(fd); closeSync(fd); };
}

// The restore rule (task-policy I01, HR01) reads no particular base; only the parent's own path branches here. Every base as
// the person over HTTP: migration-b-hold-http.test.ts.
const restores = [...TASK_BASE_STATES.map(base => ['parent', base] as const), ['human', 'waiting'], ['coordinator', 'todo'], ['coordinator', 'waiting']] as const;
for (const [manager, base] of restores) test(`${manager} CLI explicitly restores held ${base}, preserving its base and review`, async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), own = await f.work(parent);
  const release = lock(f.root, own.runId);
  // A historical child review remains releasable. New children never acquire this mark.
  let child: { id: string; placementId: string };
  if (base === 'waiting') {
    const control = new ControlStore(f.root);
    let id: string;
    try { id = control.write(db => new TaskRepository(f.root, db).create('task', id => ({ values: {},
      meta: initialControlDocument(id, parent.id, 'Historical review child',
        { kind: 'task', userRequested: true, actor: { kind: 'human' } }) }))); }
    finally { control.close(); }
    child = { id, placementId: (await assignResponsible(f.root, await f.get(id), 'fake')).id };
  } else child = await f.task('Child', { parentId: parent.id });
  if (base !== 'todo') {
    const run = await f.work(child, own);
    if (base === 'waiting' || base === 'done') { await f.report(run, 'done'); f.end(run); }
    else if (base === 'error') f.end(run, 'failed');
    else if (base === 'stopped') { await f.person(child.id, 'stopped'); f.end(run, 'cancelled'); }
    else { await f.ask(run, 'user'); f.end(run); }
  }
  await f.person(child.id, 'held');
  assert.equal((await f.get(child.id)).meta.baseState, base);
  const server = await startServer(f.root, 0);
  try {
    const env = manager === 'parent' ? { ALPACAWORK_RUN: own.runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(f.root, own.runId) }
      : manager === 'coordinator' ? { CODEX_THREAD_ID: 'restore-decision' } : {};
    const before = await f.get(child.id), opId = randomUUID();
    if (base === 'waiting' && manager === 'parent') {
      const wrong = await cliRun(server.url, ['task', 'report', '--task', child.id, '--state', base,
        '--ask-to', 'user', '--expected-task-hash', before.hash], env);
      assert.notEqual(wrong.code, 0); assert.equal((await f.get(child.id)).hash, before.hash);
    }
    const args = ['task', 'report', '--task', child.id, '--state', base, '--expected-task-hash', before.hash, '--op-id', opId];
    const first = await cliRun(server.url, args, env), again = await cliRun(server.url, args, env);
    assert.equal(first.code, 0, first.stderr); assert.equal(again.code, 0, again.stderr);
    const after = await f.get(child.id);
    assert.deepEqual([after.meta.baseState, after.meta.hold], [base, false]);
    assert.equal(after.meta.log.filter(row => row.id === opId).length, 1);
    assert.deepEqual(after.meta.log.at(-1)?.actor, manager === 'parent' ? { kind: 'placement', placementId: own.placementId }
      : manager === 'human' ? { kind: 'human' } : { kind: 'main', provider: 'codex', conversationId: 'restore-decision' });
    assert.equal(after.meta.log.at(-1)?.stage?.action, 'unhold');
    if (base === 'error' && manager === 'parent') {
      const retry = await cliRun(server.url, ['task', 'request', '--task', child.id, '--instruction-file', '-',
        '--expected-task-hash', after.hash, '--expected-placement-revision', '1'], env, 'Retry');
      assert.equal(retry.code, 0, retry.stderr);
    }
  } finally { await server.close(); release(); }
});

test('CLI rejects held-parent, other branch, ancestor, bad base and stale hash; own progress and questions retain hold', async t => {
  const f = await taskFlow(t), grand = await f.task('Grandparent'), ancestor = await f.work(grand);
  const parent = await f.task('Parent', { parentId: grand.id }), own = await f.work(parent, ancestor);
  const child = await f.task('Child', { parentId: parent.id }), target = await f.work(child, own);
  const sibling = await f.task('Other branch'), other = await f.work(sibling);
  const releases = [ancestor, own, target, other].map(run => lock(f.root, run.runId));
  await f.person(child.id, 'held');
  const server = await startServer(f.root, 0);
  try {
    const report = async (run: typeof own, state: TaskState, extra: string[] = []) => cliRun(server.url,
      ['task', 'report', '--task', child.id, '--state', state, '--expected-task-hash', (await f.get(child.id)).hash, ...extra],
      { ALPACAWORK_RUN: run.runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(f.root, run.runId) }, 'A or B');
    for (const run of [ancestor, other]) assert.notEqual((await report(run, 'doing')).code, 0);
    const before = await f.get(child.id);
    assert.notEqual((await report(own, 'todo')).code, 0);
    assert.notEqual((await report(own, 'doing', ['--expected-task-hash', '0'.repeat(64)])).code, 0);
    assert.equal((await f.get(child.id)).hash, before.hash);
    assert.equal((await report(target, 'doing')).code, 0);
    assert.equal((await report(target, 'waiting', ['--ask-to', 'user', '--title', 'Question', '--description-file', '-'])).code, 0);
    assert.equal((await f.get(child.id)).meta.hold, true);
    await f.person(parent.id, 'held');
    assert.notEqual((await report(own, 'doing')).code, 0);
    assert.equal((await f.get(child.id)).meta.hold, true);
  } finally { await server.close(); releases.forEach(release => release()); }
});

test('notifications stay pending under hold and are dispatched after an explicit coordinator restore', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const work = await h.delegate(first.runId); await h.start(work.runId);
  const service = new TaskReportService(h.root), human = { kind: 'human' } as const;
  await service.report({ task: h.task.id, state: 'held', opId: randomUUID(), expectedTaskHash: (await h.current()).hash }, human, human);
  h.end(first.runId); h.end(work.runId);
  assert.equal((await h.pass()).acceptedRequestIds.length, 0);
  assert.equal((await h.current()).meta.hold, true);
  assert.equal(h.store.readReturns().filter(row => row.requestId === work.requestId).length, 1);
  const actor = { kind: 'main', provider: 'codex', conversationId: 'restore-decision' } as const;
  await service.report({ task: h.task.id, state: (await h.current()).meta.baseState, opId: randomUUID(),
    expectedTaskHash: (await h.current()).hash }, actor, { kind: 'coordinator', source: 'codex', conversation: actor.conversationId });
  assert.equal((await h.current()).meta.hold, false);
  assert.equal((await new ReturnRouter(h.root).pass()).acceptedRequestIds.length, 1);
});

for (const manager of ['parent', 'human'] as const) test(`${manager} CLI restoring a hold to another stage is told it changed nothing, once`, async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), own = await f.work(parent);
  const release = lock(f.root, own.runId), child = await f.task('Child', { parentId: parent.id });
  await f.person(child.id, 'held');
  const server = await startServer(f.root, 0);
  try {
    const env = manager === 'parent' ? { ALPACAWORK_RUN: own.runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(f.root, own.runId) } : {};
    const before = await f.get(child.id);
    const refused = await cliRun(server.url, ['task', 'report', '--task', child.id, '--state', 'error', '--expected-task-hash', before.hash], env);
    assert.equal(refused.code, 2, refused.stderr);
    const { error } = JSON.parse(refused.stderr);
    assert.deepEqual([error.code, error.retry, error.reason.kind], ['conflict', 'reread', 'hold_returns_only_current_base']);
    assert.equal(error.detail.operation.attempts, 1, 'a refusal is not sent again');
    assert.equal((await f.get(child.id)).hash, before.hash);
  } finally { await server.close(); release(); }
});
