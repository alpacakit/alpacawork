/** Review reproduction: an ancestor's later user request must not hide the user's still-open request to a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handlingFixture } from './return-handling.fixture.ts';
import { assignResponsible } from './helpers/control-fixture.ts';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { withControlWrite, returnsAt, tasksIn } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { ballFactsOf } from '@alpacawork/backend/test-dist/control/ball.js';
import { seatSourceIn } from '@alpacawork/backend/test-dist/control/wake.js';
import { ballSourceOf } from './helpers/ball-source.ts';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { keepControlTables } from '@alpacawork/db';
import { liveRequestIds } from '@alpacawork/backend/test-dist/control/live-endpoints.js';

test('the urgent target of a child the user asked directly stays the user after the user asks its parent', async t => {
  const h = await handlingFixture(t), release = keepControlTables(h.root), store = () => new ControlTaskStore(h.root);
  t.after(release);
  const parent = (await h.commands.create({ parentId: h.project, userRequested: false, tasks: [{ title: 'Parent' }] })).tasks[0]!;
  const parentOwner = await assignResponsible(h.root, parent, 'fake');
  const child = (await h.commands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0]!;
  const childOwner = await assignResponsible(h.root, await store().get(child.id), 'fake');
  const requests = new TaskRequestService(h.root), person = { kind: 'human' } as const;
  const ask = async (task: string, revision: number) => {
    const result = await requests.request({ task, body: 'Work', opId: randomUUID(), expectedTaskHash: (await store().get(task)).hash,
      expectedPlacementRevision: revision }, person, person);
    assert.equal(result.outcome.kind, 'request_accepted');
    const request = (result.outcome as { request: { id?: string; requestId?: string; runId: string } }).request; return { ...request, id: request.requestId ?? request.id! };
  };
  const direct = await ask(child.id, childOwner.revision);
  await h.start(direct.runId);
  // The Run ends; its boundary is not applied yet, so the child is still at work and the user's Request stays open.
  h.end(direct.runId);
  const observe = () => {
    let target = '', live = false;
    assert.throws(() => withControlWrite(h.root, (tx, db) => {
      live = liveRequestIds(db, h.root, [child.id]).includes(direct.id);
      try { target = returnsAt(tx, child.id).urgentTarget(child.id); } catch (error) {
        if (!(error instanceof Problem) || error.code !== PROBLEM_CODE.urgentToUser) throw error;
        target = 'user';
      }
      throw new Error('rollback');
    }), /rollback/);
    return { live, target };
  };
  const before = observe();
  await ask(parent.id, parentOwner.revision);
  const after = observe();
  assert.equal(before.live, true);
  assert.equal(before.target, 'user');
  assert.deepEqual(after, before, 'a user request to the parent must not change where the child\'s urgent note goes');
  // Settle the direct Run's failure through the real boundary path; its failure still belongs to the user.
  h.reconcile();
  withControlWrite(h.root, tx => {
    const lifecycle = returnsAt(tx, child.id), tasks = tasksIn(tx).related(child.id).tasks;
    assert.equal(tasks.find(task => task.id === child.id)!.meta.baseState, 'error');
    const seats = seatSourceIn(tx.runs, h.project, tasks, { profiles: new Set(['fake']), automaticLimit: 2000 }, lifecycle.current);
    assert.equal(ballFactsOf(ballSourceOf(seats, tasks), child.id).requester, 'user');
  });
});
