/** Review reproduction: a seat-scoped query changes what a later unscoped ReturnLifecycle call sees. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handlingFixture } from './return-handling.fixture.ts';
import { assignResponsible } from './helpers/control-fixture.ts';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { withControlWrite, tasksIn } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';

test('workChanged notices the requester of X whatever seat was queried before', async t => {
  const h = await handlingFixture(t);
  const parent = (await h.commands.create({ parentId: h.project, userRequested: false, tasks: [{ title: 'Parent' }] })).tasks[0]!;
  const parentOwner = await assignResponsible(h.root, parent, 'fake');
  const child = (await h.commands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0]!;
  const childOwner = await assignResponsible(h.root, await new ControlTaskStore(h.root).get(child.id), 'fake');
  const requests = new TaskRequestService(h.root), person = { kind: 'human' } as const;
  const work = await requests.request({ task: parent.id, body: 'Work', opId: randomUUID(),
    expectedTaskHash: (await new ControlTaskStore(h.root).get(parent.id)).hash, expectedPlacementRevision: parentOwner.revision }, person, person);
  assert.equal(work.outcome.kind, 'request_accepted');
  const parentRun = (work.outcome as { request: { runId: string } }).request.runId;
  await h.start(parentRun);
  const sent = await requests.request({ task: child.id, body: 'Do it', opId: randomUUID(),
    expectedTaskHash: (await new ControlTaskStore(h.root).get(child.id)).hash, expectedPlacementRevision: childOwner.revision },
  { kind: 'placement', placementId: parentOwner.id },
  { kind: 'run', runId: parentRun, placementId: parentOwner.id, taskId: parent.id, role: 'owner', responsible: true });
  assert.equal(sent.outcome.kind, 'request_accepted');
  const cause = (await new ControlTaskStore(h.root).get(child.id)).meta.log[0]!.id;
  const notices = (selectFirst: string | null) => {
    let count = -1;
    assert.throws(() => withControlWrite(h.root, (tx, db) => {
      const lifecycle = new ReturnLifecycle(db, tx.runs, tasksIn(tx).related(child.id).tasks, h.project, undefined, h.root);
      if (selectFirst) lifecycle.openRequests(selectFirst);
      lifecycle.workChanged(child.id, cause);
      count = Number(db.prepare(`SELECT count(*) n FROM returns WHERE outcome='work_changed' AND to_task_id=?`).get(parent.id)!.n);
      throw new Error('rollback');
    }), /rollback/);
    return count;
  };
  const fresh = notices(null), afterOtherSeat = notices(h.task.id), afterParent = notices(parent.id);
  assert.equal(fresh, 1);
  assert.equal(afterParent, 1);
  assert.equal(afterOtherSeat, 1, 'the same workChanged must not depend on the seat queried before');
});
