/** Synthetic Task/Run fixture, isolated root; no real provider or production data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFlow, type Seat } from './task-flow.fixture.ts';
import { dependencyStatus } from '@alpacawork/backend/test-dist/control/dependencies.js';
import { startDecision } from '@alpacawork/backend/test-dist/control/task-start-facts.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

type Flow = Awaited<ReturnType<typeof taskFlow>>;
const replace = async (f: Flow, task: string, after: string[]) => f.commands.dependencies({ task, after,
  expectedTaskHash: (await f.get(task)).hash });
const status = (f: Flow, task: string) => f.store(runs => dependencyStatus(runs.connection, task));
const decision = (f: Flow, seat: Seat) => f.store(runs => startDecision(runs.connection, f.run(seat).requestId, seat.id));
async function tick(f: Flow) {
  const store = new RunStore(f.root, { busyTimeoutMs: 1000 });
  try {
    const result = await settleTransaction(store, readAgentsSettings(f.root));
    const selected = result.launches.map(item => item.id);
    closeLaunches(result.launches);
    return { ...result.summary, launched: selected };
  }
  finally { store.close(); }
}
// finished reads only the base state and a live Run (dependencies.ts): not started, reported but unconfirmed, finished.
for (const state of ['todo', 'review', 'done'] as const) test(`register B after A while A is ${state}`, async t => {
  const f = await taskFlow(t), a = await f.task('A', { userRequested: state === 'review' }), b = await f.task('B');
  if (state !== 'todo') {
    const seat = await f.work(a);
    await f.report(seat, 'done'); f.end(seat);
  }
  await replace(f, b.id, [a.id]);
  assert.equal(status(f, b.id).after[0]!.task, a.id);
  assert.equal(status(f, b.id).waiting, state !== 'done');
});

test('an admitted ordinary Request stays queued until both dependencies finish and their Runs end', async t => {
  const f = await taskFlow(t), a = await f.task('A'), c = await f.task('C'), b = await f.task('B');
  const queued = await f.request(b); // Registration may follow admission, before the first start.
  await replace(f, b.id, [a.id, c.id]);
  const requestId = f.run(queued).requestId;
  assert.equal(decision(f, queued).kind, 'wait');
  assert.deepEqual((await tick(f)).launched, []);
  assert.equal(f.run(queued).state, 'queued');
  const ra = await f.work(a); await f.report(ra, 'done'); f.end(ra);
  assert.equal(decision(f, queued).kind, 'wait');
  const rc = await f.work(c); await f.report(rc, 'done');
  assert.equal(decision(f, queued).kind, 'wait', 'done report does not end the Run');
  f.end(rc);
  const view = await readTaskView(f.root, b.id, {}, null);
  assert.equal(view.dependencies.waiting, false);
  assert.equal(view.dependencies.after.every(item => item.finished), true);
  assert.deepEqual((await tick(f)).launched, [queued.runId]);
  assert.equal(f.run(queued).requestId, requestId, 'same admitted Request, no generated wake');
  assert.equal(f.run(queued).state, 'running');
});

test('user review blocks B until confirmation, then the admitted Run starts', async t => {
  const f = await taskFlow(t), a = await f.task('A', { userRequested: true }), b = await f.task('B');
  await replace(f, b.id, [a.id]); const queued = await f.request(b);
  const ra = await f.work(a); await f.report(ra, 'done'); f.end(ra);
  assert.equal(await f.state(a.id), 'waiting');
  assert.deepEqual((await tick(f)).launched, []);
  await f.confirm(a.id, ra.runId);
  assert.deepEqual((await tick(f)).launched, [queued.runId]);
});
for (const action of ['stopped', 'archive', 'delete'] as const) test(`${action} dependency releases B`, async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B');
  await replace(f, b.id, [a.id]); const queued = await f.request(b);
  assert.deepEqual((await tick(f)).launched, []);
  if (action === 'stopped') await f.person(a.id, 'stopped');
  else await f.commands.lifecycle({ id: a.id, action, expectedTaskHash: (await f.get(a.id)).hash });
  assert.deepEqual((await tick(f)).launched, [queued.runId]);
});

test('set replaces, clear removes, History retains both; first owner start permanently freezes them', async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B'), c = await f.task('C');
  await replace(f, b.id, [a.id]); await replace(f, b.id, [c.id]); await replace(f, b.id, []);
  assert.deepEqual(status(f, b.id).after, []);
  assert.deepEqual((await f.get(b.id)).meta.log.filter(log => log.kind === 'dependencies_changed').map(log => log.dependencies),
    [{ after: [a.id], previous: [] }, { after: [c.id], previous: [a.id] }, { after: [], previous: [c.id] }]);
  const rb = await f.work(b); await f.report(rb, 'done'); f.end(rb);
  for (const after of [[a.id], []]) await assert.rejects(replace(f, b.id, after), { reason: { kind: 'dependency_task_started' } });
  assert.equal(status(f, b.id).started, true);
});

test('no dependencies preserves admission, start and continuation after a prerequisite is reopened', async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B');
  await replace(f, b.id, [a.id]); const ra = await f.work(a); await f.report(ra, 'done'); f.end(ra);
  const rb = await f.work(b); f.end(rb);
  await f.request(a);
  const next = await f.request(b);
  assert.notEqual(decision(f, next).kind, 'wait');
});

test('cycle table: independent fan-in, siblings and a waiting parent with children pass; family and cross-branch loops fail', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), a = await f.task('A', { parentId: parent.id }),
    b = await f.task('B', { parentId: parent.id }), c = await f.task('C');
  await replace(f, b.id, [a.id, c.id]); // fan-in and siblings
  const child = await f.task('Child', { parentId: b.id }); // waiting Task may already have children
  await replace(f, b.id, [a.id]);
  for (const [target, after] of [[b.id, child.id], [child.id, b.id], [a.id, a.id], [a.id, b.id]])
    await assert.rejects(replace(f, target!, [after!]), { reason: { kind: 'dependency_cycle' } });
  const x = await f.task('X'), q = await f.task('Q'), y = await f.task('Y', { parentId: q.id }), z = await f.task('Z', { parentId: x.id });
  await replace(f, x.id, [y.id]);
  await assert.rejects(replace(f, q.id, [z.id]), { reason: { kind: 'dependency_cycle' } });
  assert.deepEqual(status(f, q.id).after, [], 'failed replacement is atomic');
  await f.person(child.id, 'stopped');
  await assert.rejects(replace(f, b.id, [child.id]), { reason: { kind: 'dependency_cycle' } }, 'terminal descendants retain end events');
});

test('move calls the same cycle check and rolls back the parent and History', async t => {
  const f = await taskFlow(t), x = await f.task('X'), y = await f.task('Y');
  await replace(f, x.id, [y.id]); const before = await f.get(y.id);
  await assert.rejects(f.commands.move({ id: y.id, parentId: x.id, expectedTaskHash: before.hash }),
    { reason: { kind: 'dependency_cycle' } });
  assert.equal((await f.get(y.id)).hash, before.hash);
  assert.equal((await f.get(y.id)).meta.parentId, f.project);
});

test('public HTTP uses ordinary task.request authority; CLI set/clear and task get expose the result', async t => {
  let server: Awaited<ReturnType<typeof startServer>>;
  t.after(() => server?.close());
  const f = await taskFlow(t), parent = await f.task('Parent'), rp = await f.work(parent),
    child = await f.task('Child', { parentId: parent.id }), a = await f.task('A'), outsider = await f.task('Outsider'), ro = await f.work(outsider);
  const interval = globalThis.setInterval;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) =>
    interval(callback, ms === POLL_INTERVAL_MS ? 3_600_000 : ms, ...args)) as typeof setInterval;
  try { server = await startServer(f.root, 0); } finally { globalThis.setInterval = interval; }
  const post = async (verb: 'set' | 'clear', target: string, seat?: typeof rp, fields = {}) => {
    const opId = randomUUID();
    const response = await fetch(new URL(`/api/commands/dependency/${verb}`, server.url), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alpacawork-op-id': opId,
        ...(seat ? { authorization: `Alpacawork-Run ${seat.runId}:${issueRunCredential(f.root, seat.runId)}` } : {}) },
      body: JSON.stringify({ task: target, expectedTaskHash: (await f.get(target)).hash,
        ...(verb === 'set' ? { after: [a.id] } : {}), ...fields }) });
    return { status: response.status, body: await response.json() };
  };
  const denied = await post('set', child.id, ro);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal((await post('clear', child.id, ro)).status, 403);
  assert.equal((await post('set', child.id, rp, { answers: 'question' })).status, 400, 'answer options grant no authority');
  assert.equal((await post('set', child.id, rp)).status, 200, 'parent may register');
  const own = await f.work(a);
  assert.equal((await post('set', a.id, own)).status, 403, 'own responsible cannot issue itself ordinary instructions');
  assert.equal((await post('clear', child.id)).status, 200, 'human may clear');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['apps/cli/dist/cli.js', '--server', server.url, ...args], { env: cleanCliEnv() })).stdout);
  const set = await cli('dependency', 'set', '--task', child.id, '--after', `${a.id},${outsider.id}`, '--expected-task-hash', (await f.get(child.id)).hash);
  assert.equal(set.dependencies.waiting, true);
  assert.equal(set.dependencies.after.length, 2);
  const view = await cli('task', 'get', '--task', child.id);
  assert.equal(view.dependencies.after[0].state, 'doing');
  assert.equal(view.dependencies.waiting, true);
  await cli('dependency', 'clear', '--task', child.id, '--expected-task-hash', (await f.get(child.id)).hash);
  assert.deepEqual(status(f, child.id).after, []);
});

test('a completed dependency with a new queued Request still blocks the first start', async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B');
  const ra = await f.work(a); await f.report(ra, 'done'); f.end(ra);
  await replace(f, b.id, [a.id]);
  assert.equal(status(f, b.id).waiting, false);
  await f.request(a);
  assert.equal(await f.state(a.id), 'done', 'admission alone preserves the completed state');
  const rb = await f.request(b);
  assert.equal(decision(f, rb).kind, 'wait');
  assert.equal(status(f, b.id).waiting, true);
});

test('registration rejects projects, other projects and stale hashes without changing the edges', async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B');
  await replace(f, b.id, [a.id]);
  await assert.rejects(replace(f, b.id, [f.project]), { reason: { kind: 'dependency_requires_same_project_tasks' } });
  await assert.rejects(replace(f, f.project, [a.id]), { reason: { kind: 'dependency_requires_same_project_tasks' } });
  const other = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null,
    tasks: [{ title: 'Other project' }] })).tasks[0]!.id;
  const outside = await f.task('Outside', { parentId: other });
  await assert.rejects(replace(f, b.id, [outside.id]), { reason: { kind: 'dependency_requires_same_project_tasks' } });
  await assert.rejects(f.commands.dependencies({ task: b.id, after: [], expectedTaskHash: '0'.repeat(64) }),
    { reason: { kind: 'task_changed' } });
  assert.deepEqual(status(f, b.id).after.map(item => item.task), [a.id]);
});

for (const base of ['done', 'stopped'] as const) for (const unfinished of [false, true])
  test(`held ${base} dependency waits until unheld${unfinished ? ' and its Run ends' : ''}`, async t => {
    const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B'), ra = await f.work(a);
    await f.report(ra, base);
    if (!unfinished) f.end(ra);
    await f.person(a.id, 'held');
    assert.deepEqual([(await f.get(a.id)).meta.state, (await f.get(a.id)).meta.baseState], ['held', base]);
    await replace(f, b.id, [a.id]);
    const rb = await f.request(b), held = status(f, b.id);
    assert.equal(held.after[0]!.finished, false);
    assert.equal(held.waiting, true);
    assert.equal(decision(f, rb).kind, 'wait');
    assert.deepEqual((await tick(f)).launched, []);
    assert.equal(f.run(rb).state, 'queued');
    await f.person(a.id, base);
    assert.equal(status(f, b.id).waiting, unfinished);
    if (unfinished) {
      assert.equal(decision(f, rb).kind, 'wait');
      assert.deepEqual((await tick(f)).launched, []);
      f.end(ra);
    }
    assert.equal(status(f, b.id).after[0]!.finished, true);
    assert.deepEqual((await tick(f)).launched, [rb.runId]);
  });

for (const action of ['archive', 'delete'] as const)
  test(`${action} still releases a held dependency once its Run has ended`, async t => {
    const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B'), ra = await f.work(a);
    await f.report(ra, 'done'); f.end(ra); await f.person(a.id, 'held');
    await f.commands.lifecycle({ id: a.id, action, expectedTaskHash: (await f.get(a.id)).hash });
    assert.equal((await f.get(a.id)).meta.hold, true);
    await replace(f, b.id, [a.id]); const rb = await f.request(b);
    assert.equal(status(f, b.id).after[0]!.finished, true);
    assert.equal(status(f, b.id).waiting, false);
    assert.deepEqual((await tick(f)).launched, [rb.runId]);
  });
