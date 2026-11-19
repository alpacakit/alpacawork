/** Permanent closure does not require decoding unrelated execution history again. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticIndex } from '@alpacawork/runs';
import { ReturnLifecycle, returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { returnLinesOf } from '@alpacawork/backend/test-dist/control/return-lines.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { handlingFixture } from './return-handling.fixture.ts';

test('unreadable closed worker history preserves pending result text, newer closures and automatic accounting', async t => {
  const h = await handlingFixture(t);
  const owner = await h.human(); await h.start(owner.runId);
  const old = await h.delegate(owner.runId); await h.start(old.runId); h.end(old.runId);
  const reconcile = () => h.store.write(tx => {
    const tasks = new TaskRepository(h.root, h.store.connection).snapshot().tasks;
    const lifecycle = new ReturnLifecycle(h.store.connection, tx, tasks);
    lifecycle.reconcile({ tasks: new Set([h.task.id]) });
    return lifecycle.current.returns.find(row => row.requestId === old.requestId)!;
  });
  const previous = reconcile();
  h.store.connection.prepare('INSERT INTO return_resolutions(return_id,reason,at) VALUES(?,?,?)')
    .run(previous.id, 'migrated_handled', new Date().toISOString());
  const pending = await h.delegate(owner.runId); await h.start(pending.runId); h.end(pending.runId);
  reconcile();
  const latest = await h.delegate(owner.runId); await h.start(latest.runId); h.end(latest.runId, 'failed');

  // The canonical Request and closing Return survive; only the unrelated Run record is unreadable.
  h.store.connection.prepare("UPDATE runs SET record=json_set(record,'$.state','unreadable-fixture') WHERE id=?")
    .run(Number(old.runId.slice(1)));
  h.store.write(tx => {
    const tasks = new TaskRepository(h.root, h.store.connection).snapshot().tasks;
    const lifecycle = new ReturnLifecycle(h.store.connection, tx, tasks);
    lifecycle.reconcile({ tasks: new Set([h.task.id]) });
    const current = lifecycle.current;
    assert(current.requests.some(request => request.id === old.requestId));
    assert(current.facts.closedRequests.has(old.requestId), 'the historical obligation stays permanently closed');
    assert.equal(automaticIndex(current.requests).count(h.worker.id, []), 3,
      'closed Requests still count toward the placement automatic limit');
    assert.deepEqual(lifecycle.openRequests(h.task.id), []);
    assert.equal(current.returns.find(row => row.requestId === latest.requestId)?.outcome, 'failed');
    const lines = returnLinesOf(lifecycle, current.returns.filter(row => returnDisposition(row) === 'pending'));
    const waiting = lines.find(line => line.id === current.returns.find(row => row.requestId === pending.requestId)?.id);
    assert(waiting && 'from' in waiting && waiting.from.by === 'worker');
    assert.equal(waiting.request.body, 'Investigate');
    assert.equal(waiting.from.runId, pending.runId);
    assert(lines.some(line => line.outcome === 'failed' && 'from' in line && line.from.by === 'worker'
      && line.from.runId === latest.runId));
  });
});

test('a continuation receipt still consumes its delivery after the worker Request permanently closed', async t => {
  const h = await handlingFixture(t);
  const delivered = await h.deliver();
  h.end(delivered.run);
  h.store.write(tx => {
    const tasks = new TaskRepository(h.root, h.store.connection).snapshot().tasks;
    const lifecycle = new ReturnLifecycle(h.store.connection, tx, tasks);
    lifecycle.reconcile({ tasks: new Set([h.task.id]) });
    const row = tx.getReturn(delivered.answer.id)!;
    const receipt = row.deliveries.find(delivery => delivery.wakeRequestId === delivered.request)!;
    assert(receipt.receivedAt);
    assert(receipt.consumedAt, 'the continuation Run remains receipt evidence even though it awaits no closing Return');
    assert.equal(returnDisposition(row), 'disposed');
  });
});
