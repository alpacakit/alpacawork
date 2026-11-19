import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { settle } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { openQuestions } from '@alpacawork/raw';
import { config, cli, pass, fixture, userBall } from './return-repro.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';
test('case 31: a directly requested child selects a human question, and its done closes into no seat', async (t) => {
    const h = await fixture(t);
    // T has a responsible and nothing open, so a return or a notice to it would wake it.
    const asked = await h.human(h.C.id, h.OC.revision, 'Person asks C');
    h.start(asked.runId);
    const work = await h.agent(h.C.id, h.WC.id, h.WC.revision, asked.runId);
    h.start(work.runId);
    const question = await h.ask(asked.runId, h.C.id, 'user');
    h.end(asked.runId);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'design 6: the owned parent T is not asked');
    const ball = await userBall(h.root, h.C.id);
    assert.deepEqual([ball?.reason, ball?.questionId], ['question', question]);
    await h.answer(h.C.id, question);
    h.end(work.runId);
    const wake = (await pass(h.root));
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.taskId), [h.C.id], 'C wakes on its worker result and the answer');
    const continuation = h.runOf(wake.acceptedRequestIds[0]!);
    h.start(continuation);
    await h.report(continuation, h.C.id, 'done');
    h.end(continuation);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'the owned parent T must not wake');
    assert.equal(h.store.readReturns().some(row => row.requestId === asked.requestId), false, 'design §2.3/7.1 #31: the user reads the Task');
    assert.deepEqual(h.store.readReturns().filter(row => row.toTaskId === h.T.id), []);
});
test('§7.2: a continuation stopped before launch is not woken again; the next instruction carries its returns', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    h.start(work.runId);
    h.end(first.runId);
    h.end(work.runId);
    const one = (await pass(h.root));
    assert.equal(one.acceptedRequestIds.length, 1);
    const k1 = h.runOf(one.acceptedRequestIds[0]!);
    (await cli(h.root, 'run', 'stop', '--run', k1));
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'stopped seat does not wake');
    const workerReturn = () => h.store.readReturns().find(row => row.requestId === work.requestId)!;
    assert.equal(returnDisposition(workerReturn()), 'carried');
    assert.equal(await userBall(h.root, h.T.id), null, 'a Run stopped before it started leaves its Task as it was');
    const next = await h.human(h.T.id, h.OT.revision, 'Continue please');
    assert.equal(workerReturn().deliveries.at(-1)?.wakeRequestId, next.requestId);
    assert.match(h.store.getText(next.runId)?.prompt ?? '', new RegExp(`--run ${work.runId}\\b`), 'design 5.3: the start text carries it');
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'no continuation of its own');
    h.start(next.runId);
    h.end(next.runId);
    (await pass(h.root));
    assert.equal(returnDisposition(workerReturn()), 'disposed');
});
test('§2.4/#35 U2: a continuation that failed to launch is not relaunched; the user\'s retry carries its returns', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    h.start(work.runId);
    h.end(first.runId);
    h.end(work.runId);
    const one = (await pass(h.root));
    const k1 = h.runOf(one.acceptedRequestIds[0]!);
    h.store.write(tx => tx.update({ ...tx.get(k1)!, state: 'running', started_at: new Date().toISOString() }));
    h.end(k1, 'failed', 'launch');
    for (let i = 0; i < 2; i++)
        assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'a failed seat is not woken by itself');
    assert.equal((await h.current(h.T.id)).meta.state, 'error');
    assert.equal((await userBall(h.root, h.T.id))?.reason, 'failed', 'the user asked for T, so the user retries or stops it');
    const workerReturn = () => h.store.readReturns().find(row => row.requestId === work.requestId)!;
    assert.equal(returnDisposition(workerReturn()), 'carried');
    const retry = await h.human(h.T.id, h.OT.revision, 'Retry');
    assert.equal(workerReturn().deliveries.at(-1)?.wakeRequestId, retry.requestId);
    assert.match(h.store.getText(retry.runId)?.prompt ?? '', new RegExp(`--run ${work.runId}\\b`));
    h.start(retry.runId);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
    assert.equal(await userBall(h.root, h.T.id), null);
});
test('a continuation stopped after its agent took its returns fails its Task; the user\'s next request carries them', async (t) => {
    const h = await fixture(t, 20, true);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    h.start(work.runId);
    h.end(first.runId);
    h.end(work.runId);
    const wake = (await pass(h.root));
    assert.equal(wake.acceptedRequestIds.length, 1);
    const continuation = h.runOf(wake.acceptedRequestIds[0]!);
    await settle(h.store);
    for (let i = 0; i < 250 && !h.store.get(continuation)?.pids.agent; i++)
        await delay(20);
    assert.ok(h.store.get(continuation)?.pids.agent, 'the agent received its continuation');
    (await pass(h.root));
    const workerReturn = () => h.store.readReturns().find(row => row.requestId === work.requestId)!;
    assert.equal(returnDisposition(workerReturn()), 'in_flight');
    (await cli(h.root, 'run', 'stop', '--run', continuation));
    for (let i = 0; i < 250 && h.store.get(continuation)?.state === 'running'; i++)
        await delay(20);
    assert.equal(h.store.get(continuation)?.state, 'cancelled');
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'U2: an unsuccessful turn is not retried by itself');
    assert.equal(returnDisposition(workerReturn()), 'carried');
    assert.equal((await h.current(h.T.id)).meta.state, 'error', 'ruling 34: a person stopped the responsible at work');
    assert.equal((await userBall(h.root, h.T.id))?.reason, 'failed');
    const next = await h.human(h.T.id, h.OT.revision, 'Next instruction');
    assert.equal(workerReturn().deliveries.at(-1)?.wakeRequestId, next.requestId, 'the user\'s request carries the same worker answer');
    assert.equal(returnDisposition(workerReturn()), 'in_flight');
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
});
test('a return to a Task the user stopped is resolved, never delivered nor the user\'s turn', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    h.start(work.runId);
    h.end(first.runId);
    await h.personReport(h.T.id, 'stopped', 'person stops T');
    h.end(work.runId, 'cancelled');
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
    const row = h.store.readReturns().find(item => item.requestId === work.requestId);
    assert.deepEqual([row?.outcome, row?.resolution?.reason], ['stopped', 'seat_finished']);
    assert.equal(await userBall(h.root, h.T.id), null);
});
test('F6: a missing profile exposes an undeliverable worker return to the person', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, owner.runId);
    h.start(worker.runId);
    h.end(owner.runId);
    writeFileSync(join(h.root, 'config.yaml'), 'limits:\n  parallel: 1\n  automatic_per_placement: 20\nagents: {}\n');
    h.end(worker.runId);
    const result = (await pass(h.root));
    assert.deepEqual(result.acceptedRequestIds, []);
    assert.deepEqual(result.held, [{ taskId: h.T.id, reason: 'no_profile' }]);
    assert.equal(returnDisposition(h.store.readReturns().find(row => row.requestId === worker.requestId)!), 'pending');
    assert.equal((await userBall(h.root, h.T.id))?.code, 'no_profile');
});
test('F7: a worker return to a responsible whose manager was lost waits for that Run, not as the user\'s turn', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const worker = await h.agent(h.C.id, h.WC.id, h.WC.revision, child.runId);
    h.start(worker.runId);
    h.store.write(tx => tx.update({ ...tx.get(child.runId)!, state: 'needs_review', reason: 'manager_lost' }));
    h.end(worker.runId);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
    assert.equal(returnDisposition(h.store.readReturns().find(row => row.requestId === worker.requestId)!), 'pending');
    assert.equal(await userBall(h.root, h.C.id), null, 'a manager loss is provisional: nobody is asked yet');
    h.end(child.runId);
    const wake = (await pass(h.root));
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.taskId), [h.C.id], 'the seat wakes once its Run ended');
});
test('F4: a responsible is not released alone while its Task works; its worker\'s return still wakes it', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, owner.runId);
    h.start(worker.runId);
    h.end(owner.runId);
    const release = async (task: string, placement: { id: string; revision: number }) => cli(h.root, 'agent', 'release',
        '--task', task, '--agent', placement.id, '--expected-task-hash', (await h.current(task)).hash,
        '--expected-placement-revision', String(placement.revision));
    await assert.rejects(release(h.T.id, h.OT), { code: 'handover_required' }, 'design 3: hand it over instead');
    const released = await release(h.C.id, h.OC);
    assert.equal(released.agent.placement.active, false, 'the user proxy may manage a child placement');
    h.end(worker.runId);
    const wake = (await pass(h.root));
    assert.deepEqual(wake.acceptedRequestIds.map(id => h.store.getRequest(id)?.placementId), [h.OT.id]);
});
test('§2.3 coordinator move: the old request closes to its parent and the new parent waits for the child to run', async (t) => {
    const h = await fixture(t);
    const tFirst = await h.human(h.T.id, h.OT.revision);
    h.start(tFirst.runId);
    const toChild = await h.agent(h.C.id, h.OC.id, h.OC.revision, tFirst.runId);
    h.end(tFirst.runId);
    h.start(toChild.runId);
    await h.ask(toChild.runId, h.C.id);
    h.end(toChild.runId);
    (await pass(h.root));
    const words = `Move ${h.C.id} to ${h.U.id}`;

    const moved = await cliRun(h.app.url, ['task', 'move', '--task', h.C.id, '--parent', h.U.id,
        '--quote', words, '--expected-task-hash', (await h.current(h.C.id)).hash],
      { CODEX_THREAD_ID: 'return-repro-coordinator' });
    assert.equal(moved.code, 0, moved.stderr);
    (await pass(h.root));
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === toChild.requestId).map(row => [row.outcome, row.toTaskId]),
        [['moved', h.T.id]], 'the old parent\'s Request closes as moved');
    const uFirst = await h.human(h.U.id, h.OU.revision);
    h.start(uFirst.runId);
    const fromU = await h.agent(h.C.id, h.OC.id, h.OC.revision, uFirst.runId);
    (await pass(h.root));
    const early = h.store.readReturns().filter(row => row.requestId === fromU.requestId);
    h.start(fromU.runId);
    const worker = await h.agent(h.C.id, h.WC.id, h.WC.revision, fromU.runId);
    (await pass(h.root));
    const workerRows = h.store.readReturns().filter(row => row.requestId === worker.requestId);
    h.end(uFirst.runId);
    const wake = (await pass(h.root));
    assert.deepEqual(early, [], 'no return before C reaches a boundary');
    assert.deepEqual(workerRows, [], 'no return for a worker request before the worker ends');
    assert.deepEqual(wake.acceptedRequestIds, [], 'U waits for C');
});
test('a question closes only by its answer, its withdrawal or its expiry; an answer to a failed Task goes with its retry', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const notice = (question: string) => h.store.readReturns().find(row => row.outcome === 'question' && row.causeLogId === question);
    const withdrawn = await h.ask(child.runId, h.C.id);
    await h.withdraw(child.runId, h.C.id, withdrawn);
    (await pass(h.root));
    assert.equal(notice(withdrawn)?.resolution?.reason, 'question_closed', 'what was not delivered of it is withdrawn');
    // A late answer is admitted as ordinary work; check it after this failure/retry scenario so its queued Run does not replace the head under test.
    const asked = await h.ask(child.runId, h.C.id);
    h.end(child.runId, 'failed');
    (await pass(h.root));
    const failed = await h.current(h.C.id);
    assert.equal(failed.meta.state, 'error');
    assert.deepEqual(openQuestions(failed.meta.log).map(question => question.id), [asked], 'design 4.2: a failure does not close it');
    await h.answer(h.C.id, asked, parent.runId);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, [], 'U2b: the answer does not wake a failed Task');
    const answer = () => h.store.readReturns().find(row => row.outcome === 'answer' && row.toTaskId === h.C.id)!;
    assert.equal(returnDisposition(answer()), 'pending');
    const retry = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    assert.equal(answer().deliveries.at(-1)?.wakeRequestId, retry.requestId);
    assert.ok(h.store.getText(retry.runId)?.prompt?.includes(asked), 'the retry\'s start text carries the answer');
    const late = await h.answer(h.C.id, withdrawn, parent.runId);
    assert.equal(late.outcome.kind, 'request_accepted');
    assert.equal(h.store.getRequest(late.outcome.request.requestId)!.answersQuestion, withdrawn);
});
test('the automatic limit stops an urgent note as the user\'s turn, and the user\'s request delivers it as urgent', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    h.end(parent.runId);
    await h.urgent(child.runId, h.C.id);
    writeFileSync(join(h.root, 'config.yaml'), config(0));
    const result = (await pass(h.root));
    assert.deepEqual(result.acceptedRequestIds, [], 'design 5.3: the limit stops an urgent note too');
    assert.deepEqual(result.held, [{ taskId: h.T.id, reason: 'automatic_limit' }]);
    const urgent = () => h.store.readReturns().find(row => row.outcome === 'urgent' && row.toTaskId === h.T.id)!;
    assert.equal(returnDisposition(urgent()), 'pending', 'nothing is dropped');
    const ball = await userBall(h.root, h.T.id);
    assert.deepEqual([ball?.reason, ball?.count], ['limit', 1]);
    const next = await h.human(h.T.id, h.OT.revision, 'Go on');
    assert.equal(urgent().deliveries.at(-1)?.wakeRequestId, next.requestId);
    assert.ok(h.store.getText(next.runId)?.prompt?.includes('It changes the plan'), 'the urgent note goes as it was');
    assert.equal(await userBall(h.root, h.T.id), null);
});
test('serve leaves a held return alone while nothing changes and routes it on the change that frees it', async (t) => {
    const h = await fixture(t);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    writeFileSync(join(h.root, 'config.yaml'), config(0));
    h.start(work.runId);
    h.end(first.runId);
    h.end(work.runId);
    assert.deepEqual((await pass(h.root)).held, [{ taskId: h.T.id, reason: 'automatic_limit' }]);
    const route = ReturnRouter.prototype.route;
    let routes = 0;
    t.mock.method(ReturnRouter.prototype, 'route', function (this: ReturnRouter, ...args: Parameters<ReturnRouter['route']>) {
        routes++;
        return Reflect.apply(route, this, args);
    });
    await h.app.close();
    h.enableAutomaticRouting();
    // The serve interval and its clock move only when the test advances them.
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const advance = async (seconds: number) => {
        for (let look = 0; look < seconds * 1000 / POLL_INTERVAL_MS; look++) {
            t.mock.timers.tick(POLL_INTERVAL_MS);
            await delay(30);
        }
    };
    const app = await h.restart();
    try {
        await advance(3);
        const quiet = routes;
        assert.ok(quiet > 0, 'the first pass routed');
        await advance(25);
        assert.equal(routes, quiet, 'a held return is not routed again without a change');
        writeFileSync(join(h.root, 'config.yaml'), config(20));
        const freed = () => h.store.readRequests().some(item => item.taskId === h.T.id && item.purpose === 'return_continuation');
        for (let second = 0; second < 20 && !freed(); second++)
            await advance(1);
        assert.equal(freed(), true, 'raising the limit routes the held return');
    }
    finally {
        t.mock.timers.reset();
        await app.close();
    }
});
