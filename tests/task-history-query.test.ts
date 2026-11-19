import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, controlDatabasePath, keepControlTables } from '@alpacawork/db';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { copyWorkspace, createOriginal, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

test('request history carries state through long admission sequences, cached appends and sparse event reads', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'alpacawork-history-query-'));
  const original = createOriginal({ tasks: 4, logs: 4, runs: 4, seed: 'request-history-query' }, join(temporary, 'cache'));
  const root = join(temporary, 'workspace');
  copyWorkspace(original.root, root);
  t.after(() => {
    removeWorkspace(root); removeWorkspace(original.root);
    rmSync(temporary, { recursive: true, force: true });
  });
  const db = new DatabaseSync(controlDatabasePath(root));
  t.after(() => db.close());
  const task = String(db.prepare("SELECT id FROM tasks WHERE external_id='T2'").get()!.id);
  const request = db.prepare("SELECT * FROM requests WHERE task_id='T2' LIMIT 1").get()!;
  const run = db.prepare('SELECT record,prompt,result,result_state FROM runs WHERE request_id=?').get(String(request.id))!;
  const columns = db.prepare('PRAGMA table_xinfo(requests)').all().filter(row => !row.hidden).map(row => String(row.name));
  const insertRequest = db.prepare(`INSERT INTO requests(${columns.join(',')}) VALUES(${columns.map(() => '?')})`);
  const insertRun = db.prepare('INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,?,?)');
  const insertLog = db.prepare('INSERT INTO task_log(id,task_id,ordinal,request_id) VALUES(?,?,?,?)');
  let ordinal = 1;
  const append = (from: number, count: number) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let n = from; n < from + count; n++) {
        const id = `history-request-${n}`, number = 100 + n;
        insertRequest.run(...columns.map(column => column === 'id' ? id : request[column]) as SQLInputValue[]);
        insertRun.run(number, JSON.stringify({ ...JSON.parse(String(run.record)), id: `R${number}`, requestId: id }),
          run.prompt as SQLInputValue, run.result as SQLInputValue, run.result_state as SQLInputValue);
        insertLog.run(id, task, ordinal++, id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  append(0, 256);
  const read = () => {
    const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
    try { return store.read(connection => new TaskRepository(root, connection).snapshot('P1', ['T2']).tasks[0]!); }
    finally { store.close(); }
  };
  const prepare = DatabaseSync.prototype.prepare, plans: string[] = [];
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes('SELECT l.task_id,') && sql.includes('FROM task_log l')) {
      const all = statement.all.bind(statement);
      statement.all = (...parameters) => {
        plans.push(...prepare.call(this, 'EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => String(row.detail)));
        return all(...parameters);
      };
    }
    return statement;
  });
  let plain: ReturnType<typeof read>;
  try { plain = read(); } finally { hook.mock.restore(); }
  assert.equal(plain.meta.log.length, 257);
  assert.ok(plain.meta.log.slice(1).every(event => event.fromState === 'todo'));
  assert.ok(plans.length > 0);
  assert.ok(!plans.some(detail => detail.includes('CORRELATED')), 'ordered histories must not rescan prior rows per Request');
  const release = keepControlTables(root);
  t.after(release);
  assert.deepEqual(read(), plain);
  const held = { id: 'history-held', kind: 'reported', at: '2027-01-01T00:00:00Z', title: null, description: null,
    actor: { kind: 'human' }, fromState: 'todo', toState: 'doing', stage: { version: 1, baseState: 'doing', hold: true,
      policyVersion: 'test', ruleId: 'test', action: 'hold' } };
  db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)').run(held.id, task, ordinal++, JSON.stringify(held));
  append(256, 2);
  const cached = read();
  assert.deepEqual(cached.meta.log.slice(-2).map(event => event.fromState), ['held', 'held']);
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { store.read(connection => {
    const repository = new TaskRepository(root, connection);
    assert.deepEqual(repository.metadataWithHistory('T2'), { ...cached, values: undefined });
    assert.deepEqual([...repository.events(['history-request-0', 'history-request-257']).values()].map(event => event.fromState), ['todo', 'held']);
  }); } finally { store.close(); }
});
