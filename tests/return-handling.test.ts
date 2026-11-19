/**
 * What becomes of a delivered return: its receipt by the agent, its consumption by a turn that succeeds, its release
 * when that turn fails or stops (carried to the next Request to the seat), and a receipt nobody knows, which only a
 * Request on the user's behalf sends again. Which seat wakes when is return-router's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { readTaskReturns } from '@alpacawork/backend/test-dist/control/return-views.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { readControlTree } from './helpers/control-tree.ts';
import { userTurn } from '@alpacawork/contract';
import { runNumber } from '@alpacawork/contract/run';
import { handlingFixture } from './return-handling.fixture.ts';

type Handling = Awaited<ReturnType<typeof handlingFixture>>;
/** The return `id` as the store holds it now. */
const rowOf = (h: Handling, id: string) => h.store.readReturns().find(row => row.id === id)!;
/** The states of the inputs that carried Run `run`'s instruction. */
const inputs = (h: Handling, run: string) => h.store.connection
  .prepare('SELECT state FROM run_inputs WHERE instruction_run_no=?').all(runNumber(run)).map(row => String(row.state));
const person = { kind: 'human' } as const;

test('a delivery is received once the wake Run\'s agent starts, and consumed when its turn succeeds', async t => {
  const h = await handlingFixture(t);
  const { run, request, answer } = await h.deliver(false);
  assert.deepEqual(rowOf(h, answer.id).deliveries.map(delivery => [delivery.wakeRequestId, delivery.receivedAt]), [[request, null]]);
  assert.equal(returnDisposition(rowOf(h, answer.id)), 'in_flight');
  await h.start(run); await h.pass();
  const received = rowOf(h, answer.id).deliveries[0]!;
  assert.ok(received.receivedAt);
  assert.equal(received.consumedAt, null);
  await h.consume(run);
  const row = rowOf(h, answer.id);
  assert.deepEqual([returnDisposition(row), row.deliveries.length, row.deliveries[0]!.releasedAt], ['disposed', 1, null]);
  assert.ok(row.deliveries[0]!.consumedAt);
});

for (const state of ['failed', 'cancelled'] as const) test(`a wake turn that ${state === 'failed' ? 'fails' : 'is stopped'} after taking its return releases it as carried, and only the next Request to the seat takes it`, async t => {
  const h = await handlingFixture(t);
  const { run, request, answer } = await h.deliver();
  h.end(run, state); await h.pass();
  const released = rowOf(h, answer.id);
  assert.ok(released.deliveries[0]!.receivedAt);
  assert.deepEqual(released.deliveries.map(delivery => [delivery.wakeRequestId, delivery.consumedAt, delivery.releaseReason]),
    [[request, null, 'unsuccessful']]);
  assert.equal(returnDisposition(released), 'carried');
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'nothing sends it again by itself (U2)');
  const retry = await h.human();
  assert.deepEqual(rowOf(h, answer.id).deliveries.map(delivery => [delivery.wakeRequestId, delivery.releasedAt === null]),
    [[request, false], [retry.requestId, true]]);
  await h.start(retry.runId); await h.consume(retry.runId);
  assert.equal(returnDisposition(rowOf(h, answer.id)), 'disposed');
});

test('a joined wake is received only when its own input is taken; an unknown receipt keeps the delivery out; the Run it joined consumes it once', async t => {
  const h = await handlingFixture(t);
  const { run, answer } = await h.deliver(false);
  // The scheduler joined the wake into a working Run of the seat, as planInputs feeds it.
  const actual = await h.human(); await h.start(actual.runId);
  h.store.write(tx => tx.update({ ...tx.get(run)!, state: 'joined', into: actual.runId, ended_at: new Date().toISOString() }));
  h.uncertain(run, actual.runId);
  await h.pass();
  assert.equal(rowOf(h, answer.id).deliveries[0]!.receivedAt, null, 'the Run it joined proves nothing about this input');
  h.end(actual.runId); await h.pass();
  assert.equal(rowOf(h, answer.id).deliveries[0]!.releasedAt, null, 'an unknown receipt keeps its delivery out after the work ended');
  h.store.connection.prepare("UPDATE run_inputs SET state='taken' WHERE instruction_run_no=?").run(runNumber(run));
  await h.pass();
  const row = rowOf(h, answer.id);
  assert.ok(row.deliveries[0]!.receivedAt); assert.ok(row.deliveries[0]!.consumedAt);
  assert.equal(row.deliveries.length, 1);
});

test('an unknown receipt is the user\'s turn; a Request on the user\'s behalf sends it again, resolving the input and ending the Run it carried', async t => {
  const h = await handlingFixture(t);
  const { first, run, request, answer } = await h.deliver(false);
  // The wake was fed to the seat's working agent, and the manager was lost while handing it over.
  h.uncertain(run, first.runId);
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  assert.equal(rowOf(h, answer.id).deliveries[0]!.releasedAt, null, 'nothing sends it again by itself');
  assert.equal(userTurn((await readControlTree(h.root)).balls[h.task.id] ?? null)?.reason, 'unconfirmed');
  // Naming the Run the clean-up ends refuses the Request, and the clean-up goes back with it.
  await assert.rejects(new TaskRequestService(h.root).request({ task: h.task.id, body: 'Again', opId: randomUUID(),
    expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision, expectedHeadRun: run },
  person, person), (error: { code: string; detail: { currentHeadRunId: string } }) =>
    error.code === 'conflict' && error.detail.currentHeadRunId === first.runId);
  assert.deepEqual([h.store.get(run)?.state, inputs(h, run), rowOf(h, answer.id).deliveries.length], ['queued', ['uncertain'], 1]);
  const again = await h.human();
  assert.deepEqual([again.deliveryState, again.conversationRef.headRunId, h.store.get(again.runId)?.resumes],
    ['queued', first.runId, first.runId], 'it continues from the Run before the one it ended, and waits for none');
  assert.deepEqual([h.store.get(run)?.state, h.store.getRequest(request)?.deliveryState, inputs(h, run)],
    ['cancelled', 'aborted', ['resolved']]);
  assert.deepEqual(rowOf(h, answer.id).deliveries.map(delivery => [delivery.wakeRequestId, delivery.releaseReason]),
    [[request, 'resent_by_person'], [again.requestId, null]]);
});

test('a new conversation on the user\'s behalf is admitted past a Run whose input nobody knows was taken', async t => {
  const h = await handlingFixture(t);
  const { first, run, answer } = await h.deliver(false);
  h.uncertain(run, first.runId);
  const fresh = (await new TaskRequestService(h.root).request({ task: h.task.id, body: 'Start over', opId: randomUUID(),
    newConversation: true, expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
  person, person)).outcome.request;
  assert.deepEqual([fresh.deliveryState, h.store.get(fresh.runId)?.resumes, h.store.get(run)?.state], ['queued', null, 'cancelled']);
  assert.equal(rowOf(h, answer.id).deliveries.at(-1)?.wakeRequestId, fresh.requestId);
});

test('only a user-side Request resolves an unknown receipt; an outside coordinator needs no quote', async t => {
  for (const sender of ['placement', 'coordinator'] as const) {
    const h = await handlingFixture(t);
    const { first, work, run, request, answer } = await h.deliver(false);
    h.uncertain(run, first.runId);
    const input = { task: h.task.id, body: 'More work', opId: randomUUID(), expectedTaskHash: (await h.current()).hash,
      expectedPlacementRevision: h.owner.revision };
    if (sender === 'placement') await new TaskRequestService(h.root).request(input,
      { kind: 'placement', placementId: h.worker.id },
      { kind: 'run', runId: work.runId, placementId: h.worker.id, taskId: h.task.id, role: 'worker', responsible: false });
    else {
      const again = (await new TaskRequestService(h.root).request(input,
        { kind: 'main', provider: 'codex', conversationId: 'outside-conversation' },
        { kind: 'coordinator', conversation: 'outside-conversation', source: 'codex' })).outcome.request;
      assert.deepEqual([h.store.get(run)?.state, h.store.getRequest(request)?.deliveryState, inputs(h, run)],
        ['cancelled', 'aborted', ['resolved']]);
      assert.equal(again.conversationRef.headRunId, first.runId);
      assert.deepEqual(rowOf(h, answer.id).deliveries.map(delivery => [delivery.wakeRequestId, delivery.releaseReason]),
        [[request, 'resent_by_person'], [again.requestId, null]]);
      continue;
    }
    assert.deepEqual([h.store.get(run)?.state, h.store.getRequest(request)?.deliveryState, inputs(h, run)],
      ['queued', 'queued', ['uncertain']], sender);
    assert.deepEqual(rowOf(h, answer.id).deliveries.map(delivery => [delivery.wakeRequestId, delivery.releasedAt]),
      [[request, null]], sender);
  }
});

test('return pages show each return\'s disposition and unknown receipt, and reading them writes nothing', async t => {
  const h = await handlingFixture(t);
  const first = await h.human(); await h.start(first.runId);
  const one = await h.delegate(first.runId), two = await h.delegate(first.runId);
  for (const work of [one, two]) { await h.start(work.runId); h.end(work.runId); }
  h.end(first.runId);
  const routed = await h.pass();
  assert.equal(routed.acceptedRequestIds.length, 1);
  h.uncertain(h.runOf(routed.acceptedRequestIds[0]!));
  const before = h.store.readReturns();
  const page = await readTaskReturns(h.root, { task: h.task.id, limit: 1 });
  assert.equal(page.returns.length, 1); assert.ok(page.nextAfter);
  const second = await readTaskReturns(h.root, { task: h.task.id, limit: 1, after: page.nextAfter! });
  assert.equal(second.returns.length, 1); assert.equal(second.nextAfter, null);
  assert.notEqual(second.returns[0]!.id, page.returns[0]!.id);
  for (const row of [...page.returns, ...second.returns])
    assert.deepEqual([row.disposition, row.receiptUnknown, row.urgentReason], ['in_flight', true, null]);
  assert.deepEqual(h.store.readReturns(), before);
});
