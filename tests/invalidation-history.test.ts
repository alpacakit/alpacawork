import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invalidationHistory } from './invalidation-history.fixture.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { until } from './runs-runtime.fixture.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { taskHistorySchema } from '@alpacawork/contract/control';
import { compareHistoryEvents, historyCursor } from '@alpacawork/contract';
import { isRunInTrouble } from '@alpacawork/contract/run';

test('real ancestor invalidation reaches history HTTP with stable Run/Request identity, parent visibility and paging', async t => {
  const h = await invalidationHistory(t), { f, x, y, child, requestId } = h;
  const app = await startServer(f.root, 0);
  const history = async (task: string, options = '') => {
    const response = await fetch(new URL(`/api/task/history?task=${task}&${options}`, app.url));
    assert.equal(response.status, 200); return taskHistorySchema.parse(await response.json());
  };
  try {
    const all = await history(y.id), end = all.events.find(e => e.id === child.runId);
    assert.deepEqual(end, { id: child.runId, kind: 'run_end', taskId: y.id, fromChild: false,
      at: f.run(child).ended_at, state: null, by: null, title: 'scope_invalidated', summary: '',
      // The Run that ended writes its row, by what it ran with (the fake agent records no model).
      author: { kind: 'owner', profileKey: 'fake', modelId: null, effort: null } });
    assert.equal(all.events.filter(e => e.id === child.runId).length, 1);
    assert.equal(all.events.find(e => e.id === requestId)!.kind, 'request');
    assert.equal(all.events.find(e => e.id === requestId)!.summary, 'Do the work');
    assert.equal(isRunInTrouble(f.run(child).state), false);
    assert.equal((await f.get(y.id)).meta.baseState, 'todo');
    const parent = await history(x.id, 'children=1');
    assert.deepEqual(parent.events.find(e => e.id === child.runId), { ...end, fromChild: true });
    assert.ok(!(await history(x.id, 'children=0')).events.some(e => e.id === child.runId));
    const paged = []; let before: string | null = null;
    do {
      const page = await history(y.id, `limit=1${before ? '&before=' + encodeURIComponent(before) : ''}`);
      paged.push(...page.events); before = page.nextBefore;
      assert.ok(paged.length < 20);
    } while (before);
    assert.deepEqual(paged, all.events); assert.equal(new Set(paged.map(historyCursor)).size, paged.length);
    assert.deepEqual([...all.events].sort(compareHistoryEvents), all.events);
    assert.deepEqual((await history(y.id, 'after=' + encodeURIComponent(end!.at))).events,
      all.events.filter(e => Date.parse(e.at) >= Date.parse(end!.at)));
    assert.deepEqual((await history(y.id)).events, all.events, 'same read and demand do not duplicate terminal facts');
    // A person's ordinary Run stop still leaves its child Task alone and produces no synthetic error/end row.
    const normal = await f.task('Ordinary stopped input'), run = await f.request(normal);
    const stop = await cliRun(app.url, ['run', 'stop', '--run', run.runId]); assert.equal(stop.code, 0, stop.stderr);
    await until(() => f.run(run).reason === 'stopped', 'the stopped Run records its reason');
    assert.ok(!(await history(normal.id)).events.some(e => e.id === run.runId));
  } finally { await app.close(); }
});

test('normal worker stays quiet while failed and needs_review retain their existing error history', async t => {
  const h = await handlingFixture(t), owner = await h.human(); await h.start(owner.runId);
  const success = await h.delegate(owner.runId); await h.start(success.runId); h.end(success.runId);
  const failed = await h.delegate(owner.runId); await h.start(failed.runId); h.end(failed.runId, 'failed');
  const pending = await h.delegate(owner.runId); await h.start(pending.runId);
  h.store.write(tx => tx.update({ ...tx.get(pending.runId)!, state: 'needs_review', reason: 'manager_lost' }));
  const app = await startServer(h.root, 0);
  try {
    const response = await fetch(new URL(`/api/task/history?task=${h.task.id}`, app.url));
    const events = taskHistorySchema.parse(await response.json()).events;
    assert.ok(!events.some(e => e.id === success.runId));
    assert.equal(events.find(e => e.id === failed.runId)!.kind, 'error');
    assert.equal(events.find(e => e.id === failed.runId)!.title, 'output');
    assert.equal(events.find(e => e.id === pending.runId)!.kind, 'error');
    assert.equal(events.find(e => e.id === pending.runId)!.title, 'manager_lost');
    assert.equal(events.filter(e => e.kind === 'run_end').length, 0);
  } finally { await app.close(); }
});
