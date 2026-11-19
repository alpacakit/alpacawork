/** Current placement admission at scale; no manager or agent is launched here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { type RequestContext } from '@alpacawork/backend/test-dist/control/requests.js';
import { setup } from './harness.ts';

test('A: 100 member Requests use current placements and reserve distinct Runs', async t => {
  const h = await setup(t);
  assert.ok(h.task && h.placement);
  const parent = h.seed({}, 'running', { token: 'held-parent' });
  const people = new PlacementStore(h.root);
  const members = Array.from({ length: 100 }, (_, i) => people.createAndPlace({
    taskId: h.task!.id, profileKey: 'plain', responsible: false,
  }).placement);
  people.close();
  const context: RequestContext = { purpose: 'instruction', actor: { kind: 'placement', placementId: h.placement.id },
    actorRunId: parent.id };
  const receipts = [];
  for (const [i, member] of members.entries()) {
    // Admission advances the Task history even when the destination is another member.
    const task = await h.currentTask(), current = h.getStore().getPlacement(member.id)!;
    assert.equal(current.active, true);
    assert.equal(current.taskId, task.id);
    receipts.push(await h.request({
      taskId: task.id, mode: 'new', body: `Member work ${i}`, requestId: randomUUID(),
      targetPlacementId: current.id, expectedTaskHash: task.hash,
      expectedPlacementRevision: current.revision,
    }, context));
  }
  assert.equal(new Set(receipts.map(receipt => receipt.runId)).size, 100);
  assert.equal(new Set(receipts.map(receipt => receipt.requestId)).size, 100);
  assert.deepEqual(receipts.map(receipt => receipt.placementId), members.map(member => member.id));
  assert.equal(h.records().length, 101);
  for (const receipt of receipts) {
    const run = h.getStore().get(receipt.runId)!;
    assert.deepEqual(run.caller, { run: parent.id });
    assert.equal(run.state, 'queued');
  }
  assert.equal(h.getStore().readRequests().length, 101, 'one owner Request and 100 member Requests');
  h.integrity();
});
