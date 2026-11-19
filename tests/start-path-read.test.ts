import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initialControlDocument } from '@alpacawork/raw';
import { PROBLEM_CODE } from '@alpacawork/core';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { startPath } from '@alpacawork/backend/test-dist/control/task-start-facts.js';
import { taskFlow } from './task-flow.fixture.ts';

test('start facts read only the upward metadata path, retaining order, hold, stop epochs and the 32-level fence', async t => {
  const f = await taskFlow(t), parent = (await f.task('Parent')).id, leaf = await f.plan('Leaf', { parentId: parent });
  // Over 5000 bytes in all, each value within its field's limit: reading it would break the byte bound below.
  const sibling = await f.plan('Unrelated', { values: { notes: 'x'.repeat(700), user_instructions: Array(13).fill('x'.repeat(190)),
    artifact: Array(10).fill('x'.repeat(130)), conditions: Array(8).fill('x'.repeat(130)) } });
  const original = DatabaseSync.prototype.prepare, reads: { sql: string; rows: number; bytes: number }[] = [];
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql), all = statement.all;
    statement.all = function(...args: Parameters<typeof all>) {
      const rows = all.apply(this, args);
      if (/FROM tasks|FROM task_log|FROM task_stop_epochs/.test(sql)) reads.push({ sql, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
      return rows;
    }; return statement;
  });
  let path;
  try { path = f.store(store => startPath(store.connection, leaf)); }
  finally { hook.mock.restore(); }
  assert.deepEqual(path, [{ taskId: leaf, baseState: 'todo', hold: false, stopId: null },
    { taskId: parent, baseState: 'todo', hold: false, stopId: null }]);
  assert.ok(reads.every(row => row.rows <= 4 && row.bytes < 5000), JSON.stringify(reads));
  assert.ok(reads.every(row => !/FROM task_log|t\.\*|t\.body/.test(row.sql)), 'start eligibility does not consume text/history');
  await f.person(parent, 'held');
  assert.equal(f.store(store => startPath(store.connection, leaf))[1]!.hold, true);
  f.store(store => {
    const db = store.connection, repository = new TaskRepository(f.root, db);
    const cause = String(db.prepare('SELECT l.id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE t.external_id=? ORDER BY ordinal LIMIT 1').get(parent)!.id);
    db.prepare('INSERT INTO task_stop_epochs(task_id,stop_id) VALUES (?,?)').run(parent, cause);
    assert.equal(startPath(db, leaf)[1]!.stopId, cause);
    let previous = f.project;
    for (let i = 0; i < 30; i++) previous = repository.create('task', id => ({ values: {}, meta: initialControlDocument(id, previous, `Depth ${i}`,
      { kind: 'task', userRequested: false, actor: { kind: 'human' } }) }));
    assert.equal(startPath(db, previous).length, 30);
    const tooDeep = repository.create('task', id => ({ values: {}, meta: initialControlDocument(id, previous, 'Too deep',
      { kind: 'task', userRequested: false, actor: { kind: 'human' } }) }));
    assert.throws(() => startPath(db, tooDeep), (error: { code?: string }) => error.code === PROBLEM_CODE.tooDeep);
    assert.throws(() => startPath(db, 'T999999'), /Start Task does not exist/);
    db.exec('DROP TRIGGER tasks_parent_cycle');
    db.prepare('UPDATE tasks SET parent_id=(SELECT id FROM tasks WHERE external_id=?) WHERE external_id=?').run(leaf, parent);
    assert.throws(() => startPath(db, leaf), (error: { code?: string }) => error.code === PROBLEM_CODE.conflict);
    // A malformed, unrelated body remains outside this eligibility projection.
    assert.equal(startPath(db, sibling).length, 1);
    db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER tasks_shape_update');
    db.prepare('UPDATE tasks SET parent_id=? WHERE external_id=?').run('missing-parent', leaf);
    assert.throws(() => startPath(db, leaf), (error: { code?: string }) => error.code === PROBLEM_CODE.parentUnavailable);
  });
});
