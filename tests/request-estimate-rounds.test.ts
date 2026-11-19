/** Real admissions and authorized HTTP delegation must share the displayed and historical estimate round. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdirSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { commandFetch } from './helpers/command-fetch.ts';
// The override runs this exact regression against a separately built, fixed pre-change implementation.
const base = process.env.ALPACAWORK_TEST_IMPLEMENTATION_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const { handlingFixture } = await import(`${base}/tests/return-handling.fixture.ts`);
const { TaskReportService } = await import(`${base}/apps/backend/test-dist/control/report.js`);
const { issueRunCredential } = await import(`${base}/apps/backend/test-dist/control/credentials.js`);
const { startServer } = await import(`${base}/apps/backend/test-dist/receiver/server.js`);
const { readControlTree } = await import(`${base}/tests/helpers/control-tree.ts`);
const { estimateExamples } = await import(`${base}/apps/backend/test-dist/control/estimate-examples.js`);
const { readWorkspaceProjection } = await import(`${base}/tests/helpers/workspace-projection.ts`);
const { screenTree, readScreenEnvironment } = await import(`${base}/tests/helpers/screen-tree.ts`);
const { estimateOf } = await import(`${base}/apps/web/src/domain/estimate.ts`);
const { tryLock, unlock } = await import(`${base}/packages/core/dist/index.js`);
const { RUN_FILES, runFolder } = await import(`${base}/packages/contract/dist/run-contract.js`);
const person = { kind: 'human' } as const;

test('an ordinary owner instruction invalidates the estimate in its frozen launch text', async t => {
  const h = await handlingFixture(t), request = await h.human();
  assert.match(h.store.getText(request.runId)!.prompt, /is void with this request/);
});

test('authorized HTTP member delegation preserves the owner estimate through the return and completion', { timeout: 60000 }, async t => {
  const h = await handlingFixture(t), first = await h.human();
  await h.start(first.runId);
  const caller = (runId: string) => ({ kind: 'run', runId, placementId: h.owner.id, taskId: h.task.id,
    role: 'owner', responsible: true } as const);
  const actor = { kind: 'placement', placementId: h.owner.id } as const;
  const report = async (runId: string, state: 'doing' | 'done', estimateMinutes?: number) =>
    new TaskReportService(h.root).report({ task: h.task.id, state, title: state, description: `The work is ${state}.`, opId: randomUUID(),
      expectedTaskHash: (await h.current()).hash, ...(estimateMinutes === undefined ? {} : { estimateMinutes }) }, actor, caller(runId));
  await report(first.runId, 'doing', 30);
  const folder = runFolder(h.root, first.runId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const fd = openSync(join(folder, RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(fd), true);
  const server = await startServer(h.root, 0);
  console.log('LEASE', JSON.stringify({ pid: process.pid, root: h.root, url: server.url,
    deadline: new Date(Date.now() + 60000).toISOString() }));
  const timer = setTimeout(() => void server.close(), 60000);
  let workerRun: string;
  try {
    const input = { task: h.task.id, body: 'Planned delegation', opId: randomUUID(), agent: h.worker.id,
      expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.worker.revision };
    const post = (authorization?: string) => commandFetch(new URL('/api/task/request', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(input) });
    assert.equal((await post()).status, 403, 'a person cannot instruct the member');
    const token = issueRunCredential(h.root, first.runId);
    const response = await post(`Alpacawork-Run ${first.runId}:${token}`);
    const accepted = await response.json();
    assert.equal(response.status, 200, JSON.stringify(accepted));
    workerRun = accepted.outcome.request.runId;
    const replay = await post(`Alpacawork-Run ${first.runId}:${token}`);
    assert.deepEqual(await replay.json(), accepted, 'HTTP receipt is frozen on retry');
    const feed = await readWorkspaceProjection(h.root);
    const row = feed.index.tasks.find(item => item.id === h.task.id)!;
    assert.equal(estimateOf(row, Date.now())!.pending, false);
    assert.equal(row.stateLog.some((entry: { id: string }) => entry.id === input.opId), false);
    assert.deepEqual(feed.history(h.task.id).events.filter((entry: { id: string }) => entry.id === input.opId)
      .map((entry: { kind: string }) => entry.kind), ['request']);
  } finally { clearTimeout(timer); await server.close(); unlock(fd); closeSync(fd); }
  h.end(first.runId);
  if (!['succeeded','failed','cancelled'].includes(h.store.get(workerRun!)!.state)) { await h.start(workerRun!); h.end(workerRun!); }
  const dispatched = await h.pass();
  assert.equal(dispatched.acceptedRequestIds.length, 1);
  const wake = h.runOf(dispatched.acceptedRequestIds[0]);
  await h.start(wake); await h.pass();
  assert.doesNotMatch(h.store.getText(wake)!.prompt, /is void with this request/, 'automatic returns keep the round');
  await report(wake, 'done'); h.end(wake); await h.pass();
  const tree = await readControlTree(h.root), original = h.store.get(first.runId)!;
  const examples = estimateExamples({ tasks: tree.tasks, runRecords: h.store.read(), errors: tree.errors }, { agent: original.agent, values: original.launch.values }).examples;
  assert.equal(examples.filter((example: { taskId: string }) => example.taskId === h.task.id).length, 1,
    'the completed owner round remains a reference outcome after delegation');
  console.log('CLOSED', JSON.stringify({ pid: process.pid, root: h.root, url: server.url }));
});
