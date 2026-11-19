import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, pass, fixture, userBall } from './return-repro.fixture.ts';
test('moving a working child closes its parent\'s Request once, as moved, and keeps the child\'s Run', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    (await cli(h.root, 'task', 'move', '--task', h.C.id, '--parent', h.U.id, '--expected-task-hash', (await h.current(h.C.id)).hash));
    assert.equal(h.store.get(child.runId)?.state, 'running', 'move must preserve the working child Run');
    const move = (await h.current(h.C.id)).meta.log.find(row => row.kind === 'moved')!;
    (await pass(h.root));
    await h.report(child.runId, h.C.id, 'done');
    h.end(child.runId);
    (await pass(h.root));
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === child.requestId)
        .map(row => [row.outcome, row.toTaskId, row.causeLogId]), [['moved', h.T.id, move.id]], 'the old parent gets only the close for its old request');
});
test('7.1 #27: a Task does not move below a parent without a responsible, and its Request stays open', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const nobody = (await h.commands.create({ parentId: h.project, userRequested: true, tasks: [{ title: 'Nobody' }] })).tasks[0];
    await assert.rejects(cli(h.root, 'task', 'move', '--task', h.C.id, '--parent', nobody.id,
        '--expected-task-hash', (await h.current(h.C.id)).hash), { code: 'responsible_missing' });
    (await pass(h.root));
    assert.equal((await h.current(h.C.id)).meta.parentId, h.T.id);
    assert.equal(h.store.readReturns().some(row => row.requestId === child.requestId), false);
});
test('a question expires with its Task\'s stop: its Request closes once as stopped, the undelivered question is withdrawn and its answer refused', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    const question = await h.ask(child.runId, h.C.id);
    h.end(child.runId);
    const notice = h.store.readReturns().find(row => row.outcome === 'question' && row.causeLogId === question)!;
    assert.equal(returnDisposition(notice), 'pending', 'stop before a pass can dispatch the question');
    assert.equal(notice.deliveries.length, 0);
    await h.personReport(h.C.id, 'stopped', 'Not needed any more');
    (await pass(h.root));
    (await pass(h.root));
    const rows = h.store.readReturns();
    assert.deepEqual(rows.filter(row => row.requestId === child.requestId).map(row => [row.outcome, row.toTaskId]), [['stopped', h.T.id]]);
    assert.equal(rows.find(row => row.outcome === 'question' && row.causeLogId === question)?.resolution?.reason, 'origin_stopped');
    await assert.rejects(h.answer(h.C.id, question, parent.runId), { code: 'question_expired' });
});
test('cancelling a queued human request leaves no user\'s turn', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    (await cli(h.root, 'run', 'stop', '--run', owner.runId));
    (await pass(h.root));
    assert.equal(h.store.get(owner.runId)?.state, 'cancelled');
    assert.equal((await h.current(h.T.id)).meta.state, 'todo', 'a Run stopped before it started leaves its Task as it was');
    assert.equal(await userBall(h.root, h.T.id), null);
    assert.equal(h.store.readReturns().some(row => row.requestId === owner.requestId), false);
});
