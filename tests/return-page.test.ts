import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RESOLUTION_REASONS } from '@alpacawork/contract';
import { PROBLEM_CODE } from '@alpacawork/core';
import { readTaskReturns } from '@alpacawork/backend/test-dist/control/return-views.js';
import { handlingFixture } from './return-handling.fixture.ts';

test('return pages fetch only the requested rows and their delivery history, preserving tied ordering and cursors', async t => {
  const h = await handlingFixture(t), request = await h.human();
  h.uncertain(request.runId);
  const db = h.store.connection, at = '2026-10-01T00:00:00.000Z';
  const task = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(h.task.id)!.id);
  const ordinal = Number(db.prepare('SELECT max(ordinal) n FROM task_log WHERE task_id=?').get(task)!.n) + 1;
  db.exec('BEGIN');
  try {
    const log = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)');
    const row = db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES (?,?,'urgent',?,?)");
    const delivery = db.prepare('INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at) VALUES (?,?,?)');
    const resolution = db.prepare('INSERT INTO return_resolutions(return_id,reason,at) VALUES (?,?,?)');
    for (let i = 1199; i >= 0; i--) {
      const id = `page-${String(i).padStart(4, '0')}`, cause = `cause-${id}`;
      log.run(cause, task, ordinal + i, JSON.stringify({ id: cause, kind: 'asked', askedTo: h.task.id, at, title: 'Seed',
        description: null, urgentReason: 'Seed reason', actor: { kind: 'human' }, fromState: null, toState: null }));
      row.run(id, h.task.id, cause, at);
      if (i % 2 === 0) delivery.run(id, request.requestId, at);
      if (i % 3 === 0) resolution.run(id, RESOLUTION_REASONS[0], at);
    }
    db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES (?,?,'question',?,?)")
      .run('page-0000-question', h.task.id, 'cause-page-0000', at);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const expected = h.store.readReturnsForTask(h.task.id);
  assert.equal(expected.length, 1201);
  const reads: { sql: string; rows: number }[] = [], prepare = DatabaseSync.prototype.prepare;
  let queryCount = 0;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql), all = statement.all;
    statement.all = function(...args: Parameters<typeof all>) {
      const rows = all.apply(this, args);
      if (/^\s*SELECT/.test(sql)) queryCount++;
      if (/\b(?:returns|return_deliveries|return_resolutions)\b/.test(sql)) reads.push({ sql, rows: rows.length });
      return rows;
    };
    return statement;
  });
  let first: Awaited<ReturnType<typeof readTaskReturns>>;
  try { first = await readTaskReturns(h.root, { task: h.task.id, limit: 7 }, h.project); }
  finally { hook.mock.restore(); }
  assert.deepEqual(first.returns.map(({ disposition, urgentReason, receiptUnknown, ...row }) => row), expected.slice(0, 7));
  assert.ok(reads.length > 0);
  assert.ok(reads.every(read => read.rows <= 8), JSON.stringify(reads));
  assert.ok(queryCount <= 8, `page facts must be batched: ${queryCount} queries`);
  for (const row of first.returns) {
    assert.equal(row.urgentReason, row.outcome === 'urgent' ? 'Seed reason' : null);
    assert.equal(row.receiptUnknown, row.outcome === 'urgent' && Number(row.id.slice(-4)) % 2 === 0);
  }
  const seen = [...first.returns.map(row => row.id)];
  let after = first.nextAfter;
  while (after !== null) {
    const page = await readTaskReturns(h.root, { task: h.task.id, limit: 199, after }, h.project);
    seen.push(...page.returns.map(row => row.id)); after = page.nextAfter;
  }
  assert.deepEqual(seen, expected.map(row => row.id));
  assert.deepEqual(await readTaskReturns(h.root, { task: h.task.id, after: seen.at(-1)!, limit: 1 }, h.project),
    { returns: [], nextAfter: null });
  for (const [taskId, project, after] of [[h.task.id, h.project, 'missing'], [h.task.id, 'P1', seen[0]], ['P1', h.project, seen[0]]])
    await assert.rejects(readTaskReturns(h.root, { task: taskId!, after: after!, limit: 1 }, project),
      (error: { code?: string }) => error.code === PROBLEM_CODE.invalidInput);
  assert.deepEqual(h.store.readReturnsForTask(h.task.id), expected, 'page reads write no durable facts');
});
