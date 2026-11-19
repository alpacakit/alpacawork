/** Return routing commits join current reads without replacing an older response's captured frame. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userTurn } from '@alpacawork/contract';
import { projectedIndexSchema, taskProjectedViewSchema } from '@alpacawork/contract/control';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import type { ProjectionOwner } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { handlingFixture } from './return-handling.fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';

const read = async (url: string, path: string) => {
  const response = await fetch(new URL('/api/' + path, url), { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
};
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

test('Return hold commits enter the current GET floor while an older response holds its captured frame', async t => {
  const clock = receiverClock(t), h = await handlingFixture(t);
  const owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId);
  await h.ask(owner.runId); h.end(owner.runId); h.end(worker.runId);
  const tasks = (await new ControlTaskStore(h.root).snapshot()).tasks;
  h.store.write(tx => new ReturnLifecycle(h.store.connection, tx, tasks).reconcile());
  const reason = PROBLEM_CODE.unavailable;
  const request = RequestService.prototype.request;
  t.mock.method(RequestService.prototype, 'request', function(this: RequestService, input, actor) {
    if (this.root === h.root && actor.purpose === 'return_continuation') throw new Problem(reason, 'deliberate Return admission fault');
    return request.call(this, input, actor);
  });
  const app = await startServer(h.root, 0);
  const expiry = setTimeout(() => void app.close(), 60_000);
  const entered = deferred(), gate = deferred();
  t.after(async () => { gate.release(); clearTimeout(expiry); await app.close(); });
  const initial = projectedIndexSchema.parse((await read(app.url, 'workspace/live')).body);
  assert.notEqual(userTurn(initial.tasks.find(row => row.id === h.task.id)?.ball ?? null)?.code, reason);
  const projection = app.feed()!, readFrame = projection.read;
  let paused = false;
  t.mock.method(projection, 'read', async function(this: ProjectionOwner, ...args: Parameters<ProjectionOwner['read']>) {
    const frame = await readFrame.apply(this, args);
    if (!paused) { paused = true; entered.release(); await gate.promise; }
    return frame;
  });
  const old = read(app.url, `task/view?task=${h.task.id}`);
  await entered.promise;
  let held = false;
  const route = ReturnRouter.prototype.route;
  t.mock.method(ReturnRouter.prototype, 'route', async function(this: ReturnRouter, ...args: Parameters<ReturnRouter['route']>) {
    const result = await route.apply(this, args);
    if (this.root === h.root) held ||= result.held.some(row => row.reason === reason);
    return result;
  });
  try {
    await clock.until(() => held, 'the natural Return pass commits its hold');
    const current = await read(app.url, 'workspace/live');
    const targeted = await read(app.url, `task/view?task=${h.task.id}`);
    assert.equal(current.status, 200);
    assert.equal(targeted.status, 200);
    const index = projectedIndexSchema.parse(current.body), view = taskProjectedViewSchema.parse(targeted.body);
    assert.equal(userTurn(index.tasks.find(row => row.id === h.task.id)?.ball ?? null)?.code, reason,
      'the current GET publishes the hold committed after the older read began');
    assert.equal(userTurn(view.row.ball)?.code, reason, 'the targeted GET reaches the same Return commit floor');
    gate.release();
    const previous = await old;
    assert.equal(previous.status, 200);
    const captured = taskProjectedViewSchema.parse(previous.body);
    assert.notEqual(userTurn(captured.row.ball)?.code, reason, 'the older response retains its captured frame');
    assert.ok(view.sourcePv > captured.sourcePv);
  } finally { gate.release(); await old; }
});
