/** Current dependency command history stays opt-in and searches each changed field separately. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFlow } from './task-flow.fixture.ts';
import { readTaskListView } from '@alpacawork/backend/test-dist/control/task-views.js';

test('History searches native dependency after/previous IDs only when opted in', async t => {
  const f = await taskFlow(t), a = await f.task('First prerequisite'), b = await f.task('Second prerequisite'),
    native = await f.task('Command history');
  const set = async (after: string[]) => f.commands.dependencies({ task: native.id, after, expectedTaskHash: (await f.get(native.id)).hash });
  await set([a.id]); await set([b.id]);
  const record = (await f.get(native.id)).meta.log.filter(log => log.kind === 'dependencies_changed').at(-1)!;
  for (const [id, task, excerpt, otherMatches] of [
    [a.id, native.id, a.id, 1], [b.id, native.id, b.id, 0],
  ] as const) {
    const plain = await readTaskListView(f.root, { text: id }, null);
    assert.deepEqual(plain.errors, []);
    assert.equal(plain.tasks.find(row => row.id === task), undefined, 'History stays opt-in');
    const found = await readTaskListView(f.root, { text: id.toLowerCase(), in: ['history'] }, null);
    assert.deepEqual(found.errors, []);
    assert.deepEqual(found.tasks.find(row => row.id === task)!.match, {
      kind: 'history', at: record.at,
      type: 'dependencies_changed', excerpt, otherMatches,
    });
  }
  const crossFields = await readTaskListView(f.root, { text: `${a.id} ${b.id}`, in: ['history'] }, null);
  assert.deepEqual(crossFields.errors, []);
  assert.deepEqual(crossFields.tasks, [], 'a query cannot span after and previous fields');
});
