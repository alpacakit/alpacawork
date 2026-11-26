/** The time a save's values hold from, through the real update command on a synthetic workspace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readValuesAt } from '@alpacawork/backend/test-dist/control/task-values-store.js';
import { taskFlow } from './task-flow.fixture.ts';

test('every record a values update appends reads the new values, even when the records are moments apart', async t => {
  const f = await taskFlow(t), task = await f.task('Versions');
  const before = await f.get(task.id);
  // Each clock read is a millisecond later, so the update's records (body_updated, user_request_changed) differ in time.
  let tick = 0;
  const original = Date.prototype.toISOString;
  t.mock.method(Date.prototype, 'toISOString', function(this: Date) { return original.call(new Date(this.getTime() + ++tick)); });
  await f.commands.update({ id: task.id, values: { goal: 'After' }, userRequested: true, expectedTaskHash: before.hash });
  t.mock.restoreAll();
  const added = (await f.get(task.id)).meta.log.slice(before.meta.log.length);
  assert.deepEqual(added.map(log => log.kind), ['body_updated', 'user_request_changed']);
  assert.notEqual(added[0]!.at, added[1]!.at);
  f.store(runs => {
    for (const record of added) assert.equal(readValuesAt(runs.connection, task.id, record.at).values?.goal, 'After', record.kind);
    assert.notEqual(readValuesAt(runs.connection, task.id, before.meta.log.at(-1)!.at).values?.goal, 'After');
  });
});
