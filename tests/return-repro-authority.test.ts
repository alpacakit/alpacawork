/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { assignResponsible } from './helpers/control-fixture.ts';
import { cli, pass, requestAttempt, fixture } from './return-repro.fixture.ts';
test('a worker alone cannot instruct a child through the public CLI', async (t) => {
    const h = await fixture(t);
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, owner.runId);
    h.start(worker.runId);
    const result = (await requestAttempt(h.root, h.C.id, (await h.current(h.C.id)).hash, h.OC.revision, { run: worker.runId }));
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /forbidden/);
    assert.equal(h.store.readRequests().filter(item => item.taskId === h.C.id).length, 0);
});
test('the real CLI refuses the removed handoff, wake and processing commands and flags before they reach the server', async (t) => {
    const h = await fixture(t);
    const hash = (await h.current(h.T.id)).hash;
    const report = (...flags: string[]) => ['task', 'report', '--task', h.T.id, ...flags, '--expected-task-hash', hash];
    for (const args of [['delivery', 'get'], ['workspace', 'redeliver'], ['run', 'wait', '--run', 'R1'],
        ['run', 'wait-state', '--run', 'R1'], ['run', 'stop', '--task', h.T.id],
        report('--state', 'doing', '--wake'), report('--instruction-file', '-'),
        report('--state', 'doing', '--processed-returns', '[]'), report('--state', 'waiting', '--restore-report-id', 'L1'),
        report('--state', 'waiting', '--waiting-intent', 'review')]) {
        await assert.rejects(cli(h.root, ...args), (error: Problem) => error.code === PROBLEM_CODE.invalidInput &&
            /unknown (option|command)/.test(error.message), `obsolete command was accepted: ${args.join(' ')}`);
    }
    assert.deepEqual(h.store.readRequests(), []);
    assert.equal((await h.current(h.T.id)).hash, hash);
});
test('a responsible Run cannot instruct itself, an unrelated Task, or a grandchild; a worker cannot instruct anyone', async (t) => {
    const h = await fixture(t);
    const grandchild = (await h.commands.create({ parentId: h.C.id, userRequested: false, tasks: [{ title: 'D' }] })).tasks[0];
    const OD = await assignResponsible(h.root, await h.current(grandchild.id), 'fake');
    const owner = await h.human(h.T.id, h.OT.revision);
    h.start(owner.runId);
    const worker = await h.agent(h.T.id, h.WT.id, h.WT.revision, owner.runId);
    h.start(worker.runId);
    for (const [target, revision] of [[h.T.id, h.OT.revision], [h.U.id, h.OU.revision],
        [grandchild.id, OD.revision]] as const) {
        const result = (await requestAttempt(h.root, target, (await h.current(target)).hash, revision, { run: owner.runId }));
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /forbidden/);
    }
    const result = (await requestAttempt(h.root, h.C.id, (await h.current(h.C.id)).hash, h.OC.revision, { run: worker.runId }));
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /forbidden/);
    assert.equal(h.store.readRequests().filter(item => item.taskId === h.C.id || item.taskId === grandchild.id).length, 0);
});
test('F12: a child a person stopped before its answer is routed closes the parent request as stopped', async (t) => {
    const h = await fixture(t);
    const parent = await h.human(h.T.id, h.OT.revision);
    h.start(parent.runId);
    const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
    h.start(child.runId);
    h.end(parent.runId);
    await h.personReport(h.C.id, 'stopped', 'human marked stopped');
    h.end(child.runId);
    (await pass(h.root));
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === child.requestId).map(row => [row.outcome, row.toTaskId]),
        [['stopped', h.T.id]]);
});
