/** A document-only write must not decode the unrelated documents in its branch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { comment } from '@alpacawork/backend/test-dist/control/task-questions.js';
import { withControlWrite } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { taskFlow } from './task-flow.fixture.ts';

test('a comment remains writable when a child has an unreadable history record', async t => {
  const f = await taskFlow(t), parent = (await f.task('Parent')).id, child = await f.plan('Child', { parentId: parent });
  const before = await f.get(parent), opId = randomUUID();
  withControlWrite(f.root, (_tx, db) => {
    db.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry)
      SELECT 'unreadable-child',id,(SELECT coalesce(max(ordinal),-1)+1 FROM task_log WHERE task_id=tasks.id),?
      FROM tasks WHERE external_id=?`).run(JSON.stringify({ id: 'unreadable-child', kind: 'unknown' }), child);
  });
  withControlWrite(f.root, tx => comment(tx, { actor: { kind: 'human' }, runId: null, taskId: parent, opId,
    expectedTaskHash: before.hash, title: 'Independent comment' }));
  const after = await f.get(parent);
  assert.equal(after.meta.log.at(-1)?.id, opId);
  assert.equal(after.meta.log.at(-1)?.title, 'Independent comment');
  assert.equal(after.meta.state, before.meta.state);
  assert.notEqual(after.hash, before.hash);
});
