import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workingOf } from '@alpacawork/backend/test-dist/control/working.js';
import { readControlTree } from './helpers/control-tree.ts';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { handlingFixture } from './return-handling.fixture.ts';

test('working is exactly queued, running and needs_review Runs of either role, deduplicated by Task', () => {
  for (const role of ['owner', 'worker']) {
    const records = ['queued', 'running', 'needs_review', 'succeeded', 'failed', 'cancelled', 'joined'].map((state, index) =>
      ({ role, task: `T${index + 1}`, state }));
    assert.deepEqual(workingOf([...records, records[0]!]), ['T1', 'T2', 'T3']);
  }
  assert.deepEqual(workingOf([]), []);
  assert.equal(workingOf(null), null);
});

test('an arriving worker result and pending delivery are not work until a Run is queued', async t => {
  const h = await handlingFixture(t), owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId); h.end(owner.runId); h.reconcile();
  assert.deepEqual((await readControlTree(h.root)).working, [h.task.id]);
  h.end(worker.runId); h.reconcile();
  assert.deepEqual((await readControlTree(h.root)).working, []);
  // Router creates the real next queued Run; no inferred activity is needed.
  await h.pass();
  assert.deepEqual((await readControlTree(h.root)).working, [h.task.id]);
});

test('pending notices and returns stopped by the automatic limit add no working Task', async t => {
  const h = await handlingFixture(t);
  const current = await h.current();
  h.store.write(tx => new ReturnLifecycle(h.store.connection, tx, [current], h.project).notice('work_changed', h.task.id, current.meta.log[0]!.id));
  assert.ok(h.store.readReturns().some(row => row.outcome === 'work_changed' && row.deliveries.length === 0));
  assert.deepEqual((await readControlTree(h.root)).working, [], 'an immediately deliverable notice is not a Run');
  const delivered = await h.deliver();
  const worker = await h.delegate(delivered.run); await h.start(worker.runId);
  h.end(delivered.run); h.end(worker.runId);
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const config = join(h.root, 'config.yaml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('automatic_per_placement: 2000', 'automatic_per_placement: 1'));
  await h.pass();
  const tree = await readControlTree(h.root);
  assert.equal(tree.balls[h.task.id]?.holder, 'user');
  const ball = tree.balls[h.task.id];
  assert.equal(ball?.holder === 'user' && ball.reason, 'limit');
  assert.deepEqual(tree.working, []);
});
