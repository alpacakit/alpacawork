import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
/** Counterexamples driven through the public `workspace returns` entry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pass, fixture } from './return-repro.fixture.ts';
test('700 worker returns wake their seat once within 160 KiB, naming the rest by the command that reads them', async (t) => {
    const h = await fixture(t, 20);
    const first = await h.human(h.T.id, h.OT.revision);
    h.start(first.runId);
    // A real Request opens the seat's wait cycle, which the recorded ones join.
    const seed = await h.agent(h.T.id, h.WT.id, h.WT.revision, first.runId);
    const waitCycleId = h.store.getRequest(seed.requestId)!.waitCycleId;
    const headline = '🙂'.repeat(40);
    const now = Date.now();
    const { launch } = h.store.get(first.runId)!;
    const taskHash = (await h.current(h.T.id)).hash;
    const recorded: string[] = [];
    h.store.write(tx => {
        for (let index = 0; index < 700; index++) {
            const requestId = randomUUID();
            const at = new Date(now + index).toISOString();
            tx.insertRequest({ id: requestId, taskId: h.T.id, placementId: h.WT.id,
                placementRevision: h.WT.revision, taskHash, waitCycleId, headRunId: null,
                mode: 'new', body: headline, purpose: 'instruction',
                author: { kind: 'placement', placementId: h.OT.id }, submittedAt: at,
                deliveryState: 'queued' });
            const run = tx.create({ task: h.T.id, placementId: h.WT.id, requestId,
                agent: 'fake', role: 'worker', resumes: null, continues: false,
                session: { provider: 'fake', id: randomUUID() }, caller: { run: first.runId },
                cwd: h.root, launch }, headline);
            tx.update({ ...run, state: 'running', started_at: at });
            tx.finish({ ...run, state: 'succeeded', started_at: at, ended_at: at }, { state: 'present', text: 'done' });
            recorded.push(requestId);
        }
    });
    h.start(seed.runId);
    h.end(seed.runId);
    h.end(first.runId);
    const wake = (await pass(h.root));
    assert.equal(wake.acceptedRequestIds.length, 1, 'one W1 delivery for the whole cycle');
    const request = h.store.getRequest(wake.acceptedRequestIds[0]!)!;
    assert.equal(request.purpose, 'return_continuation');
    const bytes = Buffer.byteLength(request.body);
    assert.ok(bytes <= 160 * 1024, `${bytes} bytes`);
    assert.ok(bytes > 150 * 1024, `the body must approach the 160 KiB limit: ${bytes}`);
    assert.ok(request.body.includes('alpacawork task returns --task'), 'what does not fit is named by the command that reads it');
    const rows = () => h.store.readReturns().filter(row => recorded.includes(row.requestId ?? ''));
    assert.equal(rows().length, 700);
    assert.equal(rows().filter(row => row.deliveries.at(-1)?.wakeRequestId === request.id).length, 700);
    h.start(request.runId!);
    h.end(request.runId!);
    assert.deepEqual((await pass(h.root)).acceptedRequestIds, []);
    assert.equal(rows().filter(row => returnDisposition(row) === 'disposed').length, 700);
});
// A done report closes the Request as succeeded; an end without one fails the Task.
for (const [final, outcome] of [['done', 'succeeded'], ['no report', 'failed']] as const)
    test(`manager loss stays provisional and ${final} returns once at its final boundary`, async (t) => {
        const h = await fixture(t);
        const parent = await h.human(h.T.id, h.OT.revision);
        h.start(parent.runId);
        const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId);
        h.start(child.runId);
        if (final === 'done')
            await h.report(child.runId, h.C.id, 'done');
        h.store.write(tx => tx.update({ ...tx.get(child.runId)!, state: 'needs_review', reason: 'manager_lost' }));
        (await pass(h.root));
        assert.equal(h.store.readReturns().filter(row => row.requestId === child.requestId &&
            row.outcome === 'needs_review').length, 0, 'manager loss must not wake its requester before a final result');
        h.end(child.runId);
        (await pass(h.root));
        (await pass(h.root));
        assert.equal(h.store.readReturns().filter(row => row.requestId === child.requestId &&
            row.outcome === outcome).length, 1);
    });
