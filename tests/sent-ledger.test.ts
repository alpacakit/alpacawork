import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore, keepControlTables } from '@alpacawork/db';
import { RunStore, unclosedSent, requesterTaskIds } from '@alpacawork/runs';
import { handlingFixture } from './return-handling.fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields } from './runs-fixtures.ts';

test('sent candidates include their own admission without retaining a rolled-back Run', async t => {
  const h = await handlingFixture(t), release = keepControlTables(h.root);
  const reader = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true), writer = new ControlStore(h.root);
  t.after(() => { writer.close(); reader.close(); release(); });
  const owner = await h.human(); await h.start(owner.runId);
  const candidates = (db: ControlStore['connection']) => unclosedSent(db, h.root, [h.task.id]).get(h.task.id)!;
  const before = reader.read(candidates);
  const requestId = 'own-admission';
  assert.throws(() => writer.write(db => {
    const store = new RunStore(h.root, { busyTimeoutMs: 1000 }, false, db);
    try {
      store.write(tx => createFixtureRun(store, tx, fields({ task: h.task.id, placementId: h.worker.id,
        requestId, role: 'worker', caller: { run: owner.runId } }), 'own admission'));
      assert(candidates(db).includes(requestId));
      assert(requesterTaskIds(db, h.root, [h.task.id]).has(h.task.id));
      throw new Error('rollback admission');
    } finally { store.close(); }
  }), /rollback admission/);
  assert.deepEqual(reader.read(candidates), before);
});

test('sent candidates follow permanent closes without leaking rolled-back closes or newer snapshots', async t => {
  const h = await handlingFixture(t), release = keepControlTables(h.root);
  const reader = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true);
  const older = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true);
  const writer = new ControlStore(h.root);
  t.after(() => { writer.close(); older.close(); reader.close(); release(); });
  const owner = await h.human(); await h.start(owner.runId);
  const work = await h.delegate(owner.runId); await h.start(work.runId);
  const candidates = (db: ControlStore['connection']) => unclosedSent(db, h.root, [h.task.id]).get(h.task.id)!;
  assert(reader.read(candidates).includes(work.requestId));
  older.connection.exec('BEGIN');
  try {
    assert(candidates(older.connection).includes(work.requestId));
    h.end(work.runId);
    assert.throws(() => writer.write(db => {
      db.prepare(`INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at)
        VALUES ('rolled-back-close',?,?,'succeeded',?,?)`).run(work.requestId, h.task.id, work.runId, new Date().toISOString());
      assert(!candidates(db).includes(work.requestId));
      throw new Error('rollback close');
    }), /rollback close/);
    assert(reader.read(candidates).includes(work.requestId));
    await h.pass();
    assert(!reader.read(candidates).includes(work.requestId));
    assert(candidates(older.connection).includes(work.requestId), 'an old read still sees the unclosed Request');
  } finally { older.connection.exec('ROLLBACK'); }
});
