/** Current Request boundary keeps a placement's conversation serial without launching it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { closeLaunches, settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { setup } from './harness.ts';

test('C: a reply Request waits for its current placement head', async t => {
  const h = await setup(t);
  assert.ok(h.task && h.placement);
  const common = { taskId: h.task.id, expectedPlacementRevision: h.placement.revision };
  const first = await h.request({ ...common, expectedTaskHash: (await h.currentTask()).hash,
    mode: 'new', body: 'First', requestId: randomUUID() });
  // Each admitted Request appends history and advances the Task revision.
  const second = await h.request({ ...common, expectedTaskHash: (await h.currentTask()).hash,
    mode: 'continue', body: 'Second',
    requestId: randomUUID(), expectedHeadRunId: first.runId });
  assert.equal(first.deliveryState, 'queued');
  assert.equal(second.deliveryState, 'waiting_for_run');
  const decision = await settleTransaction(h.getStore(), readAgentsSettings(h.root));
  try { assert.deepEqual(decision.launches.map(item => item.id), [first.runId]); }
  finally { closeLaunches(decision.launches); }
  assert.equal(h.getStore().get(second.runId)?.state, 'queued');
  h.integrity();
});

test('C: stale Request facts reject without reserving another Run', async t => {
  const h = await setup(t);
  assert.ok(h.task && h.placement);
  const observed = await h.currentTask();
  const common = { taskId: observed.id, expectedPlacementRevision: h.placement.revision };
  const first = await h.request({ ...common, expectedTaskHash: observed.hash,
    mode: 'new', body: 'First', requestId: randomUUID() });
  const current = await h.currentTask();
  assert.notEqual(current.hash, observed.hash);
  for (const [facts, reason] of [
    [{ expectedTaskHash: observed.hash, expectedHeadRunId: first.runId }, 'task_or_placement_changed'],
    [{ expectedTaskHash: current.hash, expectedHeadRunId: null }, 'conversation_head_changed'],
  ] as const) {
    await assert.rejects(h.request({ ...common, ...facts, mode: 'continue',
      body: 'Stale draft', requestId: randomUUID() }), {
      code: 'conflict', reason: { kind: reason },
      detail: { currentTaskHash: current.hash, currentPlacementRevision: h.placement.revision,
        currentHeadRunId: first.runId, preserveDraft: true },
    });
    assert.equal(h.records().length, 1);
    assert.equal(h.getStore().readRequests().length, 1);
    assert.equal((await h.currentTask()).hash, current.hash);
  }
  h.integrity();
});
