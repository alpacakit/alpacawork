import { managerScript } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { runNumber } from '@alpacawork/contract/run';
import { executionReferences, inspectExecution, reserveAttempt } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { readRunFiles } from '@alpacawork/backend/test-dist/runs/view.js';
import { handlingFixture } from './return-handling.fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';

type Fixture = Awaited<ReturnType<typeof handlingFixture>>;
function run(h: Fixture, prompt: string) {
  return h.store.write(tx => createFixtureRun(h.store, tx, { task: h.task.id, placementId: h.worker.id,
    requestId: randomUUID(), agent: 'fake', role: 'worker', resumes: null, continues: false, session: null,
    caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused'],
      path: '/bin', values: {} } }, prompt));
}
function attempt(h: Fixture, record: ReturnType<typeof run>, ended = false) {
  const launch = h.store.write(tx => reserveAttempt(h.store, tx, record, managerScript, { run_minutes: 0, coordinator_run_minutes: 30, coordinator_command_seconds: 10 }));
  // No manager was launched: explicitly model its quiet, unlocked exchange.
  // A missing lock is uncertain evidence under the shared obligation contract.
  writeFileSync(join(h.store.prepareFolder(record.id), 'manager.lock'), '', { mode: 0o600 });
  if (ended) {
    h.store.write(tx => tx.finish({ ...record, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() }, { state: 'missing', text: null }));
    h.store.connection.prepare('UPDATE run_attempts SET completed_digest=? WHERE run_no=?').run('d'.repeat(64), runNumber(record.id));
    h.store.connection.prepare("UPDATE run_inputs SET state='taken' WHERE attempt_id=?").run(launch.attemptId);
  }
  return launch;
}
/** Observe values crossing the SQLite boundary, including streamed rows; no SQL-text assertion substitutes for it. */
function measured<T>(t: TestContext, work: () => T) {
  let rows = 0, bytes = 0, calls = 0;
  const prepare = DatabaseSync.prototype.prepare;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (!/^\s*(SELECT|WITH)/i.test(sql)) return statement;
    const add = (value: unknown) => { if (value !== undefined) { rows++; bytes += Buffer.byteLength(JSON.stringify(value)); } };
    const get = statement.get, all = statement.all, iterate = statement.iterate;
    statement.get = function(...args: Parameters<typeof get>) { calls++; const row = get.apply(this, args); add(row); return row; };
    statement.all = function(...args: Parameters<typeof all>) { calls++; const result = all.apply(this, args); result.forEach(add); return result; };
    statement.iterate = function*(...args: Parameters<typeof iterate>) { calls++; for (const row of iterate.apply(this, args)) { add(row); yield row; } };
    return statement;
  });
  try { return { value: work(), stats: () => ({ rows, bytes, calls }) }; }
  finally { hook.mock.restore(); }
}

test('execution inspection reads launch text only for contract users while retaining every diagnostic check', async t => {
  const h = await handlingFixture(t), db = h.store.connection;
  for (let i = 0; i < 24; i++) {
    const record = run(h, 'past'.repeat(32 * 1024)); attempt(h, record, true);
    // Excluded launch snapshots are never decoded; keep that boundary.
    db.prepare("UPDATE run_attempts SET launch_json='{}' WHERE run_no=?").run(runNumber(record.id));
  }
  const live = run(h, 'live'), launch = attempt(h, live);
  const read = measured(t, () => inspectExecution(h.store));
  assert.deepEqual(read.value.contractUsers, [{ runId: live.id, attemptId: launch.attemptId, format: launch.format }]);
  assert.ok(read.stats().bytes < 32 * 1024, `excluded history must not cross SQLite: ${JSON.stringify(read.stats())}`);
  assert.equal(read.value.unpublishedStops, 0);
  const historical = Number(db.prepare('SELECT min(run_no) n FROM run_attempts').get()!.n);
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare("UPDATE run_attempts SET diagnostic='{' WHERE run_no=?").run(historical);
  assert.throws(() => inspectExecution(h.store), /malformed JSON/, 'an excluded historical diagnostic is still rejected by the SQL predicate');
  db.prepare('UPDATE run_attempts SET diagnostic=NULL WHERE run_no=?').run(historical);
  db.exec('PRAGMA ignore_check_constraints=OFF');
  db.prepare("UPDATE run_attempts SET launch_json='{}' WHERE run_no=?").run(runNumber(live.id));
  assert.throws(() => inspectExecution(h.store), 'a selected invalid launch is still rejected');
});

test('unfinished inspection transfers only unfinished IDs and retains unknown and missing states', async t => {
  const h = await handlingFixture(t), db = h.store.connection;
  for (let i = 0; i < 32; i++) {
    const record = run(h, 'historical'.repeat(4096));
    h.store.write(tx => tx.finish({ ...record, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() },
      { state: 'missing', text: null }));
  }
  const queued = run(h, 'queued'), unknown = run(h, 'unknown'), absent = run(h, 'missing');
  db.prepare("UPDATE runs SET record=json_set(record,'$.state','future-state') WHERE id=?").run(runNumber(unknown.id));
  db.prepare("UPDATE runs SET record=json_remove(record,'$.state') WHERE id=?").run(runNumber(absent.id));
  const read = measured(t, () => inspectExecution(h.store));
  assert.deepEqual(read.value.unfinishedRuns, [queued.id, unknown.id, absent.id]);
  assert.ok(read.stats().rows < 20, `historical rows must stay in SQLite: ${JSON.stringify(read.stats())}`);
});

test('execution inspection retains ended pending or diagnosed users and excludes launch-aborted users', async t => {
  const h = await handlingFixture(t), db = h.store.connection;
  const cases = [
    { ended: false, completed: false, diagnostic: null, input: 'taken', selected: true },
    { ended: true, completed: false, diagnostic: null, input: 'taken', selected: false },
    { ended: true, completed: true, diagnostic: null, input: 'reserved', selected: true },
    { ended: true, completed: true, diagnostic: null, input: 'attempted', selected: true },
    { ended: true, completed: true, diagnostic: null, input: 'uncertain', selected: true },
    { ended: true, completed: true, diagnostic: '{}', input: 'resolved', selected: true },
    { ended: false, completed: false, diagnostic: '{"kind":"launch_aborted"}', input: 'reserved', selected: false },
    { ended: true, completed: true, diagnostic: null, input: 'not_sent', selected: false },
    { ended: true, completed: true, diagnostic: null, input: 'resolved', selected: false },
  ];
  const expected: string[] = [];
  for (const c of cases) {
    const record = run(h, 'case'), launch = attempt(h, record, c.ended);
    db.prepare('UPDATE run_attempts SET completed_digest=?,diagnostic=? WHERE run_no=?')
      .run(c.completed ? 'd'.repeat(64) : null, c.diagnostic, runNumber(record.id));
    db.prepare('UPDATE run_inputs SET state=? WHERE attempt_id=?').run(c.input, launch.attemptId);
    if (c.selected) expected.push(record.id);
  }
  assert.deepEqual(inspectExecution(h.store).contractUsers.map(user => user.runId).sort(), expected.sort());
});

test('execution inspection reads the selected launch at the same read point as its eligibility facts', async t => {
  const h = await handlingFixture(t), record = run(h, 'prompt'), launch = attempt(h, record);
  const writer = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'));
  const prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (this === h.store.connection && sql === 'SELECT launch_json FROM run_attempts WHERE attempt_id=?') {
      const get = statement.get;
      statement.get = function(...args: Parameters<typeof get>) {
        writer.prepare("UPDATE run_attempts SET launch_json=json_set(launch_json,'$.format',?) WHERE run_no=?")
          .run('f'.repeat(64), runNumber(record.id));
        changed = true;
        return get.apply(this, args);
      };
    }
    return statement;
  });
  try {
    assert.equal(inspectExecution(h.store).contractUsers[0]!.format, launch.format);
    assert.equal(changed, true);
  } finally { hook.mock.restore(); writer.close(); }
  assert.equal(inspectExecution(h.store).contractUsers[0]!.format, 'f'.repeat(64));
});

test('execution references preserve read-only snapshots, caller transactions and failed-read ownership', async t => {
  const h = await handlingFixture(t), record = run(h, 'prompt'), launch = attempt(h, record), db = h.store.connection;
  const original = String(db.prepare('SELECT launch_json FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.launch_json);
  for (const readOnly of [false, true]) {
    const reader = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'), { readOnly });
    const store = { root: h.root, connection: reader };
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT id FROM workspace_identity').get(); // Pin the caller's read point before another writer commits.
      db.prepare("UPDATE run_attempts SET launch_json=json_set(launch_json,'$.format',?) WHERE run_no=?")
        .run('f'.repeat(64), runNumber(record.id));
      assert.equal(executionReferences(store).contractUsers[0]!.format, launch.format);
      assert.equal(reader.isTransaction, true, 'a borrowed read must leave the caller transaction open');
      reader.exec('ROLLBACK');
      assert.equal(executionReferences(store).contractUsers[0]!.format, 'f'.repeat(64));
      assert.equal(reader.isTransaction, false, 'an owned read must release its snapshot');
      if (!readOnly) {
        reader.exec('BEGIN IMMEDIATE');
        assert.equal(executionReferences(store).contractUsers[0]!.format, 'f'.repeat(64));
        assert.equal(reader.isTransaction, true, 'a borrowed write must remain owned by its caller');
        reader.exec('ROLLBACK');
      }
      db.prepare("UPDATE run_attempts SET launch_json='{}' WHERE run_no=?").run(runNumber(record.id));
      assert.throws(() => executionReferences(store));
      assert.equal(reader.isTransaction, false, 'a rejected owned read must not leak its snapshot');
      reader.exec('BEGIN');
      assert.throws(() => executionReferences(store));
      assert.equal(reader.isTransaction, true, 'a rejected borrowed read must leave rollback to its caller');
      reader.exec('ROLLBACK');
      assert.equal(reader.prepare('SELECT total_changes() AS n').get()!.n, 0, 'inspection never writes');
    } finally {
      if (reader.isTransaction) reader.exec('ROLLBACK');
      reader.close();
      db.prepare('UPDATE run_attempts SET launch_json=? WHERE run_no=?').run(original, runNumber(record.id));
    }
  }
});

test('run file reads fetch only the selected body, preserving result consistency and both-body cleanup reads', async t => {
  const h = await handlingFixture(t), record = run(h, 'p'.repeat(384 * 1024)), db = h.store.connection;
  db.prepare("UPDATE runs SET result='ok',result_state='present' WHERE id=?").run(runNumber(record.id));
  const result = measured(t, () => readRunFiles(h.root, record.id, 'result'));
  assert.equal(result.value.files[0]!.text, 'ok');
  assert.ok(result.stats().bytes < 32 * 1024, `unselected prompt must not cross SQLite: ${JSON.stringify(result.stats())}`);
  db.prepare("UPDATE runs SET prompt='prompt',result=? WHERE id=?").run('r'.repeat(1024 * 1024), runNumber(record.id));
  const prompt = measured(t, () => readRunFiles(h.root, record.id, 'prompt'));
  assert.equal(prompt.value.files[0]!.text, 'prompt');
  assert.ok(prompt.stats().bytes < 32 * 1024, `unselected result must not cross SQLite: ${JSON.stringify(prompt.stats())}`);
  const both = h.store.getText(record.id)!;
  assert.equal(both.prompt, 'prompt'); assert.equal(both.result?.length, 1024 * 1024);
  for (const [state, text] of [['present', null], ['missing', 'unexpected'], ['invalid', null]] as const) {
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE runs SET result_state=?,result=? WHERE id=?').run(state, text, runNumber(record.id));
    for (const kind of ['prompt', 'result'] as const)
      assert.throws(() => readRunFiles(h.root, record.id, kind), /Invalid Run result storage/);
    assert.throws(() => h.store.getText(record.id), /Invalid Run result storage/);
  }
  db.prepare("UPDATE runs SET result_state='present',result='ok' WHERE id=?").run(runNumber(record.id));
  db.exec('PRAGMA ignore_check_constraints=OFF');
  for (const state of ['pending', 'missing', 'too_large', 'unreadable'] as const) {
    db.prepare('UPDATE runs SET result_state=?,result=NULL WHERE id=?').run(state, runNumber(record.id));
    assert.equal(readRunFiles(h.root, record.id, 'result').files[0]!.state, state);
    assert.equal(readRunFiles(h.root, record.id, 'prompt').files[0]!.state, 'present');
  }
});

test('one-body and cleanup reads agree about non-text result storage without transferring that body', async t => {
  const h = await handlingFixture(t), record = run(h, 'prompt'), db = new DatabaseSync(':memory:');
  // Strict production storage refuses this type; a borrowed damaged source exercises the same SQL decoder.
  db.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY,record TEXT,prompt,result,result_state TEXT)');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(runNumber(record.id), JSON.stringify(record), 'prompt', new Uint8Array([255]), 'present');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 }, true, db);
  try {
    assert.equal(store.getText(record.id)!.resultState, 'unreadable');
    assert.equal(store.getFileText(record.id, 'result')!.state, 'unreadable');
    assert.equal(store.getFileText(record.id, 'result')!.text, null);
    assert.equal(store.getFileText(record.id, 'prompt')!.state, 'present');
    assert.equal(store.getFileText(record.id, 'prompt')!.text, 'prompt');
  } finally { store.close(); db.close(); }
});
