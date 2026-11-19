import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { withControlWrite } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { reconcileStateLinks } from '@alpacawork/backend/test-dist/control/task-reports.js';
import { cli, pass, asyncPass, requestAttempt, fixture, userBall } from './return-repro.fixture.ts';
test('done is refused while a worker is running or still needs review', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.C.id, h.OC.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.C.id, h.WC.id, h.WC.revision, owner.runId);
    h.start(worker.runId);
    const before = (await h.current(h.C.id)).meta.state;
    await assert.rejects(h.report(owner.runId, h.C.id, 'done'), { code: 'conflict' });
    assert.equal((await h.current(h.C.id)).meta.state, before);
    h.store.write(tx => tx.update({ ...tx.get(worker.runId)!, state: 'needs_review', reason: 'manager_lost' }));
    await assert.rejects(h.report(owner.runId, h.C.id, 'done'), { code: 'conflict' });
    assert.equal((await h.current(h.C.id)).meta.state, before);
    h.end(owner.runId);
    h.end(worker.runId);
    const wake = (await pass(h.root));
    assert.equal(wake.acceptedRequestIds.length, 1);
    const continuation = h.runOf(wake.acceptedRequestIds[0]!);
    h.start(continuation);
    await h.report(continuation, h.C.id, 'done');
    assert.equal((await h.current(h.C.id)).meta.state, 'done', 'done succeeds as the first action after waking, without another pass');
});
test('done rejects a worker return that has arrived but has not been received', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.C.id, h.OC.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.C.id, h.WC.id, h.WC.revision, owner.runId);
    h.start(worker.runId);
    h.end(worker.runId);
    // Materialize the closing return without also dispatching it to the input-open owner.
    withControlWrite(h.root, ({ store, runs }, db) => {
        const { tasks } = reconcileStateLinks({ store, runs }, h.project);
        new ReturnLifecycle(db, runs, tasks, h.project).reconcile();
    });
    const returned = () => h.store.readReturns().find(row => row.requestId === worker.requestId)!;
    assert.equal(returnDisposition(returned()), 'pending');
    await assert.rejects(h.report(owner.runId, h.C.id, 'done'), { code: 'conflict', message: /returns to .* are not taken yet/ });
    assert.notEqual((await h.current(h.C.id)).meta.state, 'done');
    // A real pass can reserve delivery while the owner is running; reservation is not receipt.
    await pass(h.root);
    assert.equal(returnDisposition(returned()), 'in_flight');
    assert.equal(returned().deliveries.length, 1);
    assert.equal(returned().deliveries[0]!.receivedAt, null);
    await assert.rejects(h.report(owner.runId, h.C.id, 'done'), { code: 'conflict', message: /returns to .* are not taken yet/ });
    assert.notEqual((await h.current(h.C.id)).meta.state, 'done');
});
test('done is refused while the child it asked waits on its question', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    await h.ask(child.runId, h.C.id);
    h.end(child.runId);
    const before = (await h.current(h.T.id)).meta.state;
    await assert.rejects(h.report(parent.runId, h.T.id, 'done'), { code: 'conflict' }, 'a question does not close the Request');
    assert.equal((await h.current(h.T.id)).meta.state, before);
});
test('a coordinator\'s instruction to a top Task ends in the user\'s review, never in a return to a seat', async (t) => {
    const h = await fixture(t);
    // The coordinator writes only within the turn the user's words open.

    const sent = (await requestAttempt(h.root, h.U.id, (await h.current(h.U.id)).hash, h.OU.revision, { main: true }));
    assert.equal(sent.status, 0, sent.stderr);
    const request = JSON.parse(sent.stdout).outcome.request;
    assert.equal(h.store.getRequest(request.requestId)?.purpose, 'instruction');
    h.start(request.runId);
    await h.reachReview(request.runId, h.U.id);
    (await pass(h.root));
    const ball = await userBall(h.root, h.U.id);
    assert.deepEqual([ball?.reason, ball?.aboutRunId], ['review', request.runId]);
    assert.equal(h.store.readReturns().some(row => row.requestId === request.requestId), false);
});
test('3#10: the user\'s send-back is answered by the next review, never by a return to a seat', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.U.id, h.OU.revision);
    h.start(first.runId);
    await h.reachReview(first.runId, h.U.id);
    (await pass(h.root));
    const instruction = join(h.root, 'send-back.md');
    writeFileSync(instruction, 'Please revise');
    const sent = (await cli(h.root, 'task', 'request', '--task', h.U.id, '--instruction-file', instruction,
        '--expected-task-hash', (await h.current(h.U.id)).hash, '--expected-placement-revision', String(h.OU.revision))).outcome.request;
    assert.equal(h.store.getRequest(sent.requestId)?.purpose, 'instruction');
    h.start(sent.runId);
    await h.reachReview(sent.runId, h.U.id);
    (await pass(h.root));
    const ball = await userBall(h.root, h.U.id);
    assert.deepEqual([ball?.reason, ball?.aboutRunId], ['review', sent.runId]);
    assert.equal(h.store.readReturns().some(row => row.requestId === first.requestId || row.requestId === sent.requestId), false);
});
test('a held review can be confirmed directly before any new ordinary instruction', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.U.id, h.OU.revision);
    h.start(first.runId);
    await h.reachReview(first.runId, h.U.id);
    (await pass(h.root));
    await h.personReport(h.U.id, 'held', 'Hold review');
    await h.confirm(h.U.id, first.runId);
    assert.equal((await h.current(h.U.id)).meta.state, 'done');
    assert.equal(await userBall(h.root, h.U.id), null);
});
test('ordinary instruction to a held review preserves the hold and cannot revive its old confirmation', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.U.id, h.OU.revision);
    h.start(first.runId);
    await h.reachReview(first.runId, h.U.id);
    (await pass(h.root));
    await h.personReport(h.U.id, 'held', 'Hold review');
    const instruction = join(h.root, 'held-instruction.md');
    writeFileSync(instruction, 'Please revise after the hold is released');
    const result = await cli(h.root, 'task', 'request', '--task', h.U.id, '--instruction-file', instruction,
        '--expected-task-hash', (await h.current(h.U.id)).hash, '--expected-placement-revision', String(h.OU.revision));
    assert.equal(result.outcome.kind, 'request_accepted');
    assert.equal(h.store.getRequest(result.outcome.request.requestId)?.purpose, 'instruction');
    assert.equal((await h.current(h.U.id)).meta.state, 'held');
    assert.equal(h.store.get(result.outcome.request.runId)?.state, 'queued');
    await assert.rejects(h.confirm(h.U.id, first.runId), { code: 'conflict' });
});
test('two concurrent HTTP passes send one continuation for the same returned seat', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, owner.runId);
    h.start(worker.runId);
    h.end(owner.runId);
    h.end(worker.runId);
    const outcomes = await Promise.all([asyncPass(h.root), asyncPass(h.root)]);
    assert.equal(outcomes.flatMap(item => item.acceptedRequestIds).length, 1);
    assert.equal(h.store.readRequests().filter(item => item.purpose === 'return_continuation').length, 1);
    assert.equal(h.store.readReturns().filter(item => item.requestId === worker.requestId && (item.deliveries.at(-1)?.wakeRequestId ?? null)).length, 1);
});
