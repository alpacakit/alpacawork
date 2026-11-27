/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { readControlTree } from './helpers/control-tree.ts';
import { deriveEvents } from '@alpacawork/backend/test-dist/receiver/push.js';
import { defaultSettings, personalSettings } from '@alpacawork/contract';
import { config, cli, pass, fixture, userBall } from './return-repro.fixture.ts';
test('a depth refusal holds one returned seat while a different seat still wakes', async (t) => {
    const h = await fixture(t);
    const WU = (await new PlacementCommands(h.root).placeMember({ taskId: h.U.id, profileKey: 'fake',
        expectedTaskHash: (await h.current(h.U.id)).hash, expectedResponsibleRevision: h.OU.revision }, { kind: 'human' })).placement;
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const childWorker = await h.agent(h.C.id, h.WC.id, h.WC.revision, child.runId);
    h.start(childWorker.runId);
    h.end(child.runId);
    h.end(childWorker.runId);
    const other = await h.human(h.U.id, h.OU.revision);
    h.start(other.runId);
    const otherWorker = await h.agent(h.U.id, WU.id, WU.revision, other.runId);
    h.start(otherWorker.runId);
    h.end(other.runId);
    h.end(otherWorker.runId);
    writeFileSync(join(h.root, 'config.yaml'), config().replace('  parallel: 1\n', '  parallel: 1\n  depth: 1\n'));
    const result = (await pass(h.root));
    assert.equal(result.held.some(item => item.taskId === h.C.id && item.reason === 'too_deep'), true);
    assert.equal(result.acceptedRequestIds.length, 1, 'a refusal must not stop a later seat');
    assert.equal(h.store.readRequests().find(item => item.id === result.acceptedRequestIds[0])?.taskId, h.U.id);
    assert.equal(h.store.readReturns().find(row => row.requestId === childWorker.requestId)?.holdReason, 'too_deep');
    assert.equal((await userBall(h.root, h.C.id))?.code, 'too_deep');
});
test('a responsible ending without a report fails the Task the user asked for, notifies the user, and waits for the user\'s retry', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    h.end(first.runId);
    (await pass(h.root));
    assert.equal((await h.current(h.T.id)).meta.state, 'error');
    const turn = await userBall(h.root, h.T.id);
    assert.equal(turn?.reason, 'failed');
    const tree = await readControlTree(h.root);
    const notifications = deriveEvents(new Set(), tree.tasks, tree.balls, { ...defaultSettings(personalSettings), 'push.followup': true });
    assert.deepEqual(notifications.map(item => [item.key.split(':')[0], item.payload.title, item.payload.body, item.payload.url]),
        [[h.T.id, `${h.T.id} ${h.T.title}`, 'Stopped by an error. Decide whether to retry', `/?task=${h.T.id}`]]);
    assert.equal(h.store.readReturns().some(row => row.requestId === first.requestId), false, 'the user\'s Request closes into no seat');
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'nothing retries it by itself');
    const retry = await h.human(h.T.id, h.OT.revision, 'Continue with a report');
    h.start(retry.runId);
    (await pass(h.root));
    assert.equal(await userBall(h.root, h.T.id), null, 'the retry ends the user\'s turn');
});
test('a replaced responsible\'s successor is woken by the handover notice, then by the old worker\'s return', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    h.start(work.runId);
    h.end(first.runId);
    const replacement = (await cli(h.root, 'agent', 'assign', '--task', h.T.id, '--role', 'responsible', '--profile', 'fake',
        '--replace', h.OT.id, '--expected-placement-revision', String(h.OT.revision),
        '--expected-task-hash', (await h.current(h.T.id)).hash)).agent.placement;
    const handover = h.store.readReturns().find(row => row.outcome === 'handover' && row.toTaskId === h.T.id);
    assert.ok(handover, 'design 3: the replacement tells the new responsible');
    const wake = (await pass(h.root));
    assert.equal(wake.acceptedRequestIds.length, 1, 'the notice wakes it while the worker Request is open');
    const told = h.store.getRequest(wake.acceptedRequestIds[0]!)!;
    assert.deepEqual([told.taskId, told.placementId], [h.T.id, replacement.id]);
    assert.equal(h.store.readReturns().find(row => row.id === handover.id)?.deliveries.at(-1)?.wakeRequestId, told.id);
    const prompt = h.store.getText(told.runId!)!.prompt;
    assert.equal(prompt.split('## Open work\n').length - 1, 1, 'the complete wake supplies open work once');
    assert.equal(prompt.split('you are now its owner').length - 1, 1, 'the handover notice is still supplied once');
    const openWork = prompt.split('## Open work\n')[1]!.split('\n## ')[0]!;
    assert.ok(openWork.includes(`Member ${h.WT.id} (request ${work.requestId} "`),
        'the common section names the original worker and its open Request together');
    h.end(work.runId);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'the successor\'s queued Run takes nothing more yet');
    h.start(told.runId!);
    h.end(told.runId!);
    const next = (await pass(h.root));
    assert.deepEqual(next.acceptedRequestIds.map(id => h.store.getRequest(id)?.placementId), [replacement.id]);
    assert.equal(h.store.readReturns().find(row => row.requestId === work.requestId)?.deliveries.at(-1)?.wakeRequestId,
        next.acceptedRequestIds[0]);
});
test('a Request to a Task outlives a handover of its responsible and closes at the Task\'s done', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const old = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(old.runId);
    const worker = await h.agent(h.C.id, h.WC.id, h.WC.revision, old.runId);
    h.start(worker.runId);
    h.end(old.runId);
    // T's responsible replaces its child's, as authorize lets only the parent's responsible.
    const replacement = (await new PlacementCommands(h.root).placeNewResponsible({ placedAs: 'default', taskId: h.C.id, profileKey: 'fake',
        expectedTaskHash: (await h.current(h.C.id)).hash, replacePlacementId: h.OC.id,
        expectedPlacementRevision: h.OC.revision }, { kind: 'placement', placementId: h.OT.id })).placement;
    h.end(worker.runId);
    const wake = (await pass(h.root));
    assert.equal(h.store.readReturns().some(row => row.requestId === old.requestId), false, 'replacing the responsible does not close the Request');
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.placementId), [replacement.id],
        'the new responsible takes the handover and the old worker answer');
    const continuation = h.runOf(wake.acceptedRequestIds[0]!);
    h.start(continuation);
    await h.report(continuation, h.C.id, 'done');
    h.end(continuation);
    (await pass(h.root));
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === old.requestId).map(row => [row.outcome, row.toTaskId]),
        [['succeeded', h.T.id]]);
});
test('a failed worker promoted to child responsible does not answer the parent request, and the handover wakes it', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const worker = await h.agent(h.C.id, h.WC.id, h.WC.revision, child.runId);
    h.start(worker.runId);
    h.end(child.runId);
    h.end(worker.runId, 'failed', 'output');
    (await new PlacementCommands(h.root).setResponsible({ placedAs: 'policy', taskId: h.C.id, placementId: h.WC.id,
        expectedTaskHash: (await h.current(h.C.id)).hash, expectedPlacementRevision: h.WC.revision },
    { kind: 'placement', placementId: h.OT.id }));
    const wake = (await pass(h.root));
    assert.equal(h.store.readReturns().some(row => row.requestId === child.requestId), false);
    assert.equal(h.store.readReturns().some(row => row.requestId === worker.requestId &&
        row.outcome === 'failed' && row.toTaskId === h.C.id), true, 'the earlier worker request still answers the child seat after promotion');
    // Its failed Run was a worker's turn, not the seat's: the seat is not failed (wake.seatFailed).
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.placementId), [h.WC.id]);
});
test('a child whose responsible ends without a report fails, and its parent wakes with the failure', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    await h.report(child.runId, h.C.id, 'doing');
    h.end(parent.runId);
    h.end(child.runId);
    const result = (await pass(h.root));
    assert.equal((await h.current(h.C.id)).meta.state, 'error');
    assert.equal(h.store.readReturns().find(row => row.requestId === child.requestId)?.outcome, 'failed');
    assert.equal(result.acceptedRequestIds.length, 1, 'design 7: a failed child closes its Request (W1)');
    const next = h.store.getRequest(result.acceptedRequestIds[0]!)!;
    assert.equal(next.taskId, h.T.id);
    assert.ok(next.body.includes(h.C.id));
    assert.equal(await userBall(h.root, h.C.id), null, 'its parent decides on it');
});
for (const state of ['failed', 'cancelled', 'succeeded'] as const) {
    test(`a Task the user asked directly fails into the user's turn when its responsible's Run ends ${state} without a report`, async (t) => {
        const h = await fixture(t);
        const owner = await h.human(h.C.id, h.OC.revision);
        h.start(owner.runId);
        h.end(owner.runId, state);
        (await pass(h.root));
        (await pass(h.root));
        const task = await h.current(h.C.id);
        assert.equal(task.meta.state, 'error');
        assert.equal(task.meta.log.filter(row => row.id === `LEND${owner.runId}`).length, 1);
        assert.equal(h.store.readReturns().some(row => row.requestId === owner.requestId), false);
        assert.equal((await userBall(h.root, h.C.id))?.reason, 'failed', 'design 6: the user asked it, so the user retries or stops it');
    });
}
