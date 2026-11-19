/** Batch reads preserve delivery evidence and draw only the facts of the selected returns. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { RunRecord } from '@alpacawork/contract/run';
import type { StoredReturn, RunTransaction } from '@alpacawork/runs';
import { handlingFixture } from './return-handling.fixture.ts';
import { fields } from './runs-fixtures.ts';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { returnLinesOf } from '@alpacawork/backend/test-dist/control/return-lines.js';
import { suppliedSnapshotForRequest, rotationForRequest } from '@alpacawork/backend/test-dist/control/conversation-context.js';
import type { ControlTx } from '@alpacawork/backend/test-dist/control/task-transition.js';

function executions(t: TestContext, db: DatabaseSync, selected: (sql: string) => boolean = () => true) {
  let calls = 0;
  const prepare = db.prepare.bind(db);
  const hook = t.mock.method(db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!selected(sql)) return statement;
    for (const key of ['get', 'all', 'run'] as const) {
      const execute = statement[key].bind(statement);
      Object.defineProperty(statement, key, { value: (...args: SQLInputValue[]) => { calls++; return execute(...args); } });
    }
    return statement;
  });
  return { count: () => calls, restore: () => hook.mock.restore() };
}

test('return facts stay bounded by the selected IDs and read a batch in constant query count', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const work = await h.delegate(first.runId);
  const questionId = await h.ask(first.runId);
  const task = await h.current(), db = h.store.connection;
  h.uncertain(work.runId);
  db.prepare('UPDATE run_attempts SET diagnostic=? WHERE run_no=?').run(
    JSON.stringify({ kind: 'launch_aborted', cause: { message: 'Start failed' } }), Number(work.runId.slice(1)));
  // A corrupt unrelated record must remain outside the selected return facts.
  db.prepare("UPDATE runs SET record=json_set(record,'$.agent',NULL) WHERE id=?").run(Number(first.runId.slice(1)));
  const closure: StoredReturn = { id: 'RET-worker', requestId: work.requestId, outcome: 'failed', toTaskId: task.id,
    boundaryRunId: work.runId, causeLogId: null, holdReason: null, holdProblemReason: null,
    createdAt: '2026-01-01T00:00:00Z', deliveries: [], resolution: null };
  const question: StoredReturn = { ...closure, id: 'RET-question', requestId: null, outcome: 'question',
    boundaryRunId: null, causeLogId: questionId };
  h.store.write(tx => {
    const life = new ReturnLifecycle(db, tx, [task], h.project);
    const one = returnLinesOf(life, [closure, question]);
    assert.deepEqual(one[0], { id: closure.id, outcome: 'failed', request: { id: work.requestId, body: 'Investigate' },
      from: { by: 'worker', placementId: h.worker.id, runId: work.runId, reason: 'Start failed' } });
    const notice = one[1]!;
    assert.equal(notice.outcome, 'question');
    assert.ok('text' in notice && notice.text.includes('Please decide'));
    for (const count of [1, 64]) {
      const selected = Array.from({ length: count }, () => [closure, question]).flat();
      const measured = executions(t, db);
      try {
        assert.deepEqual(returnLinesOf(life, selected), Array.from({ length: count }, () => one).flat());
        assert.ok(measured.count() <= 4, `${count} pairs made ${measured.count()} queries`);
      } finally { measured.restore(); }
    }
    assert.throws(() => returnLinesOf(life, [{ ...closure, requestId: 'missing' }]), /has no Request/);
    const withoutText = { ...task, meta: { ...task.meta, log: [...task.meta.log,
      { ...task.meta.log.find(log => log.id === questionId)!, id: 'missing-text', kind: 'answered' as const, questionId }] } };
    assert.throws(() => returnLinesOf(new ReturnLifecycle(db, tx, [withoutText], h.project),
      [{ ...question, outcome: 'answer', causeLogId: 'missing-text' }]), /has no fixed text/);
  });
});

test('conversation receipt batches preserve latest supply and unknown rotations with constant query count', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE run_inputs(instruction_run_no INTEGER,state TEXT,attempt_id TEXT,initial INTEGER);
    CREATE TABLE run_attempts(run_no INTEGER,attempt_id TEXT);`);
  const runs = Array.from({ length: 64 }, (_, index) => ({ id: `R${index + 1}`, state: 'succeeded', task: 'T1',
    placementId: 'P1', resumes: index ? `R${index}` : null, into: null, started_at: '2026-01-01T00:00:00Z', reason: null,
    context: { rotationFrom: 'checkpoint', ...(index ? {} : { suppliedSnapshot: 'complete' }) } } as RunRecord));
  for (const run of runs) {
    const n = Number(run.id.slice(1)), attempt = randomUUID();
    db.prepare('INSERT INTO run_attempts VALUES (?,?)').run(n, attempt);
    db.prepare('INSERT INTO run_inputs VALUES (?,?,?,1)').run(n, 'taken', attempt);
  }
  let selected = runs;
  const tx = { store: { connection: db }, runs: { runsOfTask: () => selected } } as unknown as ControlTx;
  for (const count of [1, 64]) {
    selected = runs.slice(0, count);
    const measured = executions(t, db);
    try {
      assert.equal(suppliedSnapshotForRequest(tx, selected.at(-1)!, selected), 'complete');
      assert.equal(rotationForRequest(tx, 'T1', 'P1')?.receipt, 'taken');
      assert.ok(measured.count() <= 2, `${count} Runs made ${measured.count()} queries`);
    } finally { measured.restore(); }
  }
  selected = runs;
  db.exec('BEGIN');
  db.prepare("UPDATE run_inputs SET state='uncertain' WHERE instruction_run_no=2").run();
  assert.equal(suppliedSnapshotForRequest(tx, runs.at(-1)!, runs), undefined);
  db.exec('ROLLBACK');
  assert.equal(suppliedSnapshotForRequest(tx, runs.at(-1)!, runs), 'complete', 'receipt reads never cache a rolled back state');
  db.prepare("UPDATE run_inputs SET state='uncertain' WHERE instruction_run_no=2").run();
  assert.equal(suppliedSnapshotForRequest(tx, runs.at(-1)!, runs), undefined);
  assert.deepEqual(rotationForRequest(tx, 'T1', 'P1'), { run: runs.at(-1), receipt: 'taken', unknown: true });
  db.prepare("UPDATE run_inputs SET state='resolved' WHERE instruction_run_no=2").run();
  assert.equal(rotationForRequest(tx, 'T1', 'P1')?.unknown, false);
  db.prepare('DELETE FROM run_inputs WHERE instruction_run_no=64').run();
  assert.equal(rotationForRequest(tx, 'T1', 'P1')?.receipt, 'unknown', 'an attempt without its initial receipt is unknown');
});


test('delivery reconciliation and resending batch receipt evidence and reread after rollback', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId); h.end(first.runId);
  const task = await h.current(), db = h.store.connection, attempt = randomUUID(), cycle = randomUUID();
  const states = ['taken', 'uncertain', 'not_sent', 'resolved', 'aborted'] as const;
  const cases: { returnId: string; requestId: string; state: typeof states[number] }[] = [];
  h.store.write(tx => {
    db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,?,?)').run(cycle, task.id, '2026-01-01T00:00:00Z');
    db.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES(?,?,?)')
      .run(Number(first.runId.slice(1)), attempt, '{}');
    for (let index = 0; index < 25; index++) {
      const state = states[index % states.length]!, requestId = randomUUID(), returnId = `RET-${index}`;
      tx.insertRequest({ id: requestId, taskId: task.id, placementId: h.worker.id, placementRevision: h.worker.revision,
        taskHash: task.hash, waitCycleId: cycle, headRunId: null, mode: 'new', body: 'Synthetic delivered work',
        purpose: 'instruction', author: { kind: 'placement', placementId: h.owner.id }, submittedAt: '2026-01-01T00:00:00Z',
        deliveryState: state === 'aborted' ? 'aborted' : 'queued' });
      const run = tx.create(fields({ task: task.id, placementId: h.worker.id, requestId, role: 'worker', cwd: h.root,
        caller: { run: first.runId } }), 'Synthetic delivered work');
      tx.update({ ...run, state: 'joined', into: first.runId,
        ended_at: '2026-01-01T00:00:01Z' });
      db.prepare('INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at) VALUES(?,?,?,?,?,?)')
        .run(returnId, requestId, task.id, 'succeeded', run.id, '2026-01-01T00:00:01Z');
      db.prepare('INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at) VALUES(?,?,?)')
        .run(returnId, requestId, '2026-01-01T00:00:02Z');
      db.prepare('INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES(?,?,?,?,?,0)')
        .run(randomUUID(), attempt, Number(run.id.slice(1)), 'a'.repeat(64),
          state === 'aborted' ? 'taken' : state);
      cases.push({ returnId, requestId, state });
    }
  });
  const check = (tx: RunTransaction, resend: boolean) => {
    const life = new ReturnLifecycle(db, tx, [task], h.project);
    db.exec('SAVEPOINT all_taken_probe');
    try {
      db.prepare("UPDATE run_inputs SET state='taken' WHERE attempt_id=?").run(attempt);
      const pending = executions(t, db, sql => sql.includes('SELECT r.request_id,i.state'));
      try {
        assert.deepEqual(life.undelivered(task.id, first.runId), []);
        assert.equal(pending.count(), 1, 'all current deliveries share one receipt read');
        assert.equal(life.awaiting(task.id, first.runId, '2100-01-01T00:00:00Z'), false);
        assert.equal(pending.count(), 2, 'all historical deliveries share one receipt read');
      } finally { pending.restore(); }
    } finally { db.exec('ROLLBACK TO all_taken_probe'); db.exec('RELEASE all_taken_probe'); }
    const measured = executions(t, db, sql => sql.includes('SELECT r.request_id,i.state'));
    try {
      life.reconcile();
      assert.equal(measured.count(), 1, 'all active deliveries share one input read');
      for (const each of cases) {
        const saved = db.prepare('SELECT received_at,consumed_at,release_reason FROM return_deliveries WHERE return_id=?')
          .get(each.returnId)!;
        assert.equal(saved.received_at !== null, ['taken', 'aborted'].includes(each.state), each.state);
        assert.equal(saved.consumed_at !== null, each.state === 'taken', each.state);
        assert.equal(saved.release_reason, each.state === 'aborted' ? 'not_delivered'
          : ['not_sent', 'resolved'].includes(each.state) ? 'unsuccessful' : null, each.state);
      }
      if (resend) {
        life.resendUnconfirmed(task.id, h.owner.id);
        assert.equal(measured.count(), 2, 'all uncertain deliveries share one resend read');
        for (const each of cases.filter(each => each.state === 'uncertain'))
          assert.equal(db.prepare('SELECT release_reason FROM return_deliveries WHERE return_id=?').get(each.returnId)!.release_reason,
            'resent_by_person');
      }
    } finally { measured.restore(); }
  };
  const rollback = new Error('Rollback delivery exercise');
  assert.throws(() => h.store.write(tx => { check(tx, true); throw rollback; }), error => error === rollback);
  assert.equal(db.prepare('SELECT count(*) AS n FROM return_deliveries WHERE received_at IS NOT NULL OR released_at IS NOT NULL').get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM run_inputs WHERE state='uncertain'").get()!.n, 5);
  h.store.write(tx => check(tx, false));
});
