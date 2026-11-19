/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { config, cli, pass, requestAttempt, fixture, userBall } from './return-repro.fixture.ts';
test('an owner with an accepted worker request stays doing until its continuation', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    await h.report(owner.runId, h.T.id, 'doing');
    const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, owner.runId);
    h.start(worker.runId);
    h.end(owner.runId);
    (await pass(h.root));
    assert.equal((await h.current(h.T.id)).meta.state, 'doing');
    h.end(worker.runId);
    const wake = (await pass(h.root));
    assert.equal(wake.acceptedRequestIds.length, 1);
    assert.equal((await h.current(h.T.id)).meta.state, 'doing');
});
test('a responsible Run\'s end is judged by the facts at its end: an instruction sent after it does not keep the Task working', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    await h.report(first.runId, h.T.id, 'doing');
    h.end(first.runId);
    await delay(5);
    // Sent before any pass applies the end, as the person saw the Task.
    const sent = await requestAttempt(h.root, h.T.id, (await new ControlTaskStore(h.root).get(h.T.id)).hash, h.OT.revision);
    assert.equal(sent.status, 0, sent.stderr);
    const next = JSON.parse(sent.stdout).outcome.request;
    (await pass(h.root));
    assert.equal(h.store.get(next.runId)?.state, 'queued');
    const ended = await h.current(h.T.id);
    assert.equal(ended.meta.state, 'error', 'design 4.1: it ended with no report, question or open Request');
    assert.equal(ended.meta.log.filter(row => row.id === `LEND${first.runId}`).length, 1);
    h.start(next.runId);
    (await pass(h.root));
    assert.equal((await h.current(h.T.id)).meta.state, 'doing', 'the instruction\'s start brings it back to work');
});
test('a person\'s stop after the responsible Run ended is not overwritten by that Run\'s end', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    await h.report(owner.runId, h.T.id, 'doing');
    h.end(owner.runId);
    await delay(5);
    const seen = await new ControlTaskStore(h.root).get(h.T.id);
    (await cli(h.root, 'task', 'report', '--task', h.T.id, '--state', 'stopped', '--title', 'Person stops T',
        '--expected-task-hash', seen.hash));
    (await pass(h.root));
    const stopped = await h.current(h.T.id);
    assert.equal(stopped.meta.state, 'stopped');
    assert.equal(stopped.meta.log.some(row => row.id === `LEND${owner.runId}`), false);
});
test('a child handles each arrived batch while another worker is open, then its done wakes the parent', async (t) => {
    const h = await fixture(t);
    const second = (await new PlacementCommands(h.root).placeMember({ taskId: h.C.id, profileKey: 'fake',
        expectedTaskHash: (await h.current(h.C.id)).hash, expectedResponsibleRevision: h.OC.revision }, { kind: 'human' })).placement;
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const workers = [await h.agent(h.C.id, h.WC.id, h.WC.revision, child.runId),
        await h.agent(h.C.id, second.id, second.revision, child.runId)];
    for (const worker of workers)
        h.start(worker.runId);
    h.end(child.runId);
    h.end(parent.runId);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
    assert.equal(h.store.readReturns().some(row => row.requestId === child.requestId), false);
    h.end(workers[0]!.runId);
    const early = await pass(h.root);
    assert.equal(early.acceptedRequestIds.length, 1, 'the first worker result arrives while the other is open');
    const earlyRun = h.runOf(early.acceptedRequestIds[0]!); h.start(earlyRun);
    await assert.rejects(h.report(earlyRun, h.C.id, 'done'), { code: 'conflict' });
    h.end(earlyRun);
    assert.equal(h.store.readReturns().some(row => row.requestId === child.requestId), false, 'partial handling does not close the child Request');
    h.end(workers[1]!.runId);
    const wake = (await pass(h.root));
    assert.equal(wake.acceptedRequestIds.length, 1);
    assert.equal(h.store.readRequests().find(row => row.id === wake.acceptedRequestIds[0])?.taskId, h.C.id);
    assert.equal(h.store.readReturns().some(row => row.requestId === child.requestId), false);
    const continued = h.runOf(wake.acceptedRequestIds[0]!);
    h.start(continued);
    await h.report(continued, h.C.id, 'done');
    h.end(continued);
    const parentWake = (await pass(h.root));
    assert.equal(parentWake.acceptedRequestIds.length, 1);
    assert.equal(h.store.readRequests().find(row => row.id === parentWake.acceptedRequestIds[0])?.taskId, h.T.id);
    assert.equal(h.store.readReturns().find(row => row.requestId === child.requestId)?.outcome, 'succeeded');
    assert.equal(await userBall(h.root, h.C.id), null, 'a Task the user did not ask for is done without a review');
});
test('run stop on a child\'s queued Run stops the Run alone; stopping the child closes its parent\'s Request', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.end(parent.runId);
    const stopped = (await cli(h.root, 'run', 'stop', '--run', child.runId));
    assert.deepEqual(stopped.cancelled, [child.runId]);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
    assert.equal((await h.current(h.C.id)).meta.state, 'todo', 'a Run stopped before it started leaves its Task as it was');
    assert.equal(h.store.readReturns().some(row => row.requestId === child.requestId), false, 'the Request waits for the child Task');
    await h.personReport(h.C.id, 'stopped', 'Not needed');
    const wake = (await pass(h.root));
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === child.requestId).map(row => [row.outcome, row.toTaskId]),
        [['stopped', h.T.id]]);
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.taskId), [h.T.id]);
    assert.equal(h.store.readRequests().some(item => item.purpose === 'return_continuation' && item.taskId === h.C.id), false);
    assert.equal(await userBall(h.root, h.C.id), null);
});
test('moving a child under a parent awaiting review sends that parent back to work and closes the old parent\'s Request as moved', async (t) => {
    const h = await fixture(t);
    const oldParent = await h.human(h.T.id, h.OT.revision);
    h.start(oldParent.runId);
    const newParent = await h.human(h.U.id, h.OU.revision);
    h.start(newParent.runId);
    await h.reachReview(newParent.runId, h.U.id);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, oldParent.runId);
    h.start(child.runId);
    h.end(oldParent.runId);
    await h.commands.move({ id: h.C.id, parentId: h.U.id, expectedTaskHash: (await h.current(h.C.id)).hash });
    assert.equal((await h.current(h.U.id)).meta.state, 'doing', 'design 7: the review was of work that has changed');
    assert.equal(await userBall(h.root, h.U.id), null);
    const wake = (await pass(h.root));
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === child.requestId).map(row => [row.outcome, row.toTaskId]),
        [['moved', h.T.id]]);
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.taskId), [h.T.id, h.U.id], 'the old parent learns of the move and the invalidated review reserves ordinary work');
    assert.equal(h.store.get(child.runId)?.state, 'running', 'the move keeps the working child Run');
});
test('return continuations before session discovery each start a new conversation without increasing depth', async (t) => {
    const h = await fixture(t);
    // A worker stands at depth two; a continuation that added depth would have its next worker refused.
    writeFileSync(join(h.root, 'config.yaml'), config(20, 'codex').replace('  parallel: 1\n', '  parallel: 1\n  depth: 2\n'));
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    let ownerRun = first.runId;
    for (let index = 0; index < 3; index++) {
        // Until the bridge discovers a session, each instruction begins a new conversation.
        const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, ownerRun, true);
        h.start(worker.runId);
        h.end(ownerRun);
        h.end(worker.runId);
        const wake = (await pass(h.root));
        assert.equal(wake.acceptedRequestIds.length, 1, `continuation ${index + 1} must be accepted`);
        const request = h.store.readRequests().find(row => row.id === wake.acceptedRequestIds[0])!;
        const run = h.store.get(request.runId!)!;
        assert.deepEqual([request.mode, run.resumes, run.caller], ['new', null, { run: ownerRun }]);
        ownerRun = run.id;
        h.start(ownerRun);
    }
    assert.equal(h.store.get(ownerRun)?.role, 'owner');
});
test('answering a held question closes its turn and defers the wake until explicit release', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.U.id, h.OU.revision);
    h.start(first.runId);
    const question = await h.ask(first.runId, h.U.id);
    h.end(first.runId);
    (await pass(h.root));
    const asked = await userBall(h.root, h.U.id);
    assert.deepEqual([asked?.reason, asked?.questionId], ['question', question]);
    await h.personReport(h.U.id, 'held', 'Hold question');
    (await pass(h.root));
    assert.deepEqual(await userBall(h.root, h.U.id), asked, 'a hold sets the turn aside unchanged');
    await h.answer(h.U.id, question);
    assert.equal((await h.current(h.U.id)).meta.state, 'held', 'an answer preserves the explicit hold');
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'W3 waits behind the hold');
    await h.personReport(h.U.id, 'doing', 'Release answered work');
    const wake = (await pass(h.root));
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.taskId), [h.U.id], 'W3: the answer wakes the Task that asked');
    assert.equal(await userBall(h.root, h.U.id), null, 'the answer closes the held turn');
});
test('a review held and returned from the hold keeps the turn its report began', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.U.id, h.OU.revision);
    h.start(first.runId);
    await h.reachReview(first.runId, h.U.id);
    (await pass(h.root));
    const asked = await userBall(h.root, h.U.id);
    assert.deepEqual([asked?.reason, asked?.aboutRunId], ['review', first.runId]);
    assert.equal(asked?.at, (await h.current(h.U.id)).meta.log.find(log => log.toState === 'waiting')?.at, 'the turn dates from the report that asked');
    for (const state of ['held', 'waiting', 'held'] as const) {
        await h.personReport(h.U.id, state, state);
        (await pass(h.root));
        assert.deepEqual(await userBall(h.root, h.U.id), asked, `${state}: the same review`);
    }
});
test('a held review refuses reparenting and keeps its review identity', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.U.id, h.OU.revision);
    h.start(first.runId);
    await h.reachReview(first.runId, h.U.id);
    (await pass(h.root));
    const asked = await userBall(h.root, h.U.id);
    await h.personReport(h.U.id, 'held', 'Hold');
    (await pass(h.root));
    // A parent with a child keeps a responsible, so the new parent has one before U moves below it.
    const other = (await h.commands.create({ parentId: h.project, userRequested: true, tasks: [{ title: 'Other parent' }] })).tasks[0];
    await assignResponsible(h.root, await h.current(other.id), 'fake');
    const before = await h.current(h.U.id);
    await assert.rejects(h.commands.move({ id: h.U.id, parentId: other.id, expectedTaskHash: before.hash }),
      { code: 'conflict' });
    assert.equal((await h.current(h.U.id)).hash, before.hash);
    (await pass(h.root));
    assert.equal((await h.current(h.U.id)).meta.state, 'held');
    // It still points at the report that asked for the review, not at the hold or the move.
    assert.deepEqual(await userBall(h.root, h.U.id), asked);
});
