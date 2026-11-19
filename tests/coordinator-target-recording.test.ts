import { currentTaskLog } from './helpers/control-fixture.ts';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
/** The original general PWA question carried a reference URL, not a selected recipient. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '@alpacawork/db';
import { dialoguesOf, resultsOf } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { call, callerWorkspace, claudeConversation } from './coordinator-caller.fixture.ts';

test('a general PWA question with a reference URL never gains recipients through the URL, an AI write or its answer', async t => {
  const w = callerWorkspace(t), head = w.screenRun({
    words: `PWA cache and read errors? Reference https://example.test/?task=${w.project}`, session: 'pwa-reference',
  });
  const url = await w.start(); await w.startScreenRun(url, head);
  const targets = () => {
    const control = new ControlStore(w.root, { busyTimeoutMs: 1000 });
    try { return control.read(db => db.prepare('SELECT task_uuid FROM task_dialogues WHERE request_id=?').all(head.requestId)); }
    finally { control.close(); }
  };
  assert.deepEqual(targets(), [], 'a reference URL does not explicitly select its Task');
  const created = await call(url, ['task', 'new', '--from-user', '--parent', w.project,
    '--title', 'AI operation remains an effect record', '--op-id', randomUUID()], claudeConversation('pwa-reference'));
  assert.equal(currentTaskLog(w.root, created.task.id).at(-1)!.actor.message, head.requestId, 'the actual operation still has its Request audit owner');
  assert.deepEqual(targets(), [], 'an AI operation does not expand the fixed recipient set');
  w.end(head, 'succeeded', `Please see ${w.project} and ${created.task.id}.`);
  const control = new ControlStore(w.root, { busyTimeoutMs: 1000 });
  try { control.read(db => {
    assert.deepEqual(dialoguesOf(db, [w.project, created.task.id].map(id => new TaskRepository(w.root, db).metadataWithHistory(id))), [], 'an answer reference creates no dialogue link');
    assert.deepEqual(resultsOf(db, [head.requestId]).get(head.requestId)!.writes.map(write => write.task), [created.task.id]);
  }); } finally { control.close(); }
});
