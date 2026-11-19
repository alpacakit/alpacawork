/** Database contention, launch rollback and scheduler recovery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { tryLock } from '@alpacawork/core';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { closeLaunches, launch, settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { readdirSync } from 'node:fs';
import { now, setup, settleAt, until } from './runs-runtime.fixture.ts';

test('settle busy propagates and transaction rollback closes every selected lock', async t => {
  const h = await setup(t), run = h.create(), db = new DatabaseSync(controlDatabasePath(h.root));
  try {
    db.exec('BEGIN IMMEDIATE');
    await assert.rejects(settleAt(h.root, 0), { code: 'busy' });
    db.exec('ROLLBACK');
    // A trigger forces a later queued update to fail after the first lock was selected.
    h.create('plain', {}, { role: 'worker', placementId: h.memberPlacementId });
    db.exec("CREATE TRIGGER fail_launch BEFORE UPDATE ON runs WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'forced write failure'); END");
    await assert.rejects(settleTransaction(h.store, readAgentsSettings(h.root)), /forced write failure/);
    assert.equal(h.store.get(run.id)!.state, 'queued');
    for (const id of ['R1', 'R2']) {
      const fd = openRunFile(h.store.folder(id), 'manager.lock', constants.O_RDWR);
      try { assert.equal(tryLock(fd), true); } finally { closeSync(fd); }
    }
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});

test('held queued lock is skipped and missing running folder is manager_lost', async t => {
  const h = await setup(t, { parallel: 2 }), held = h.create();
  const other = h.create('plain', {}, { role: 'worker', placementId: h.memberPlacementIds[0] });
  const missing = h.create('plain', {}, { role: 'worker', placementId: h.memberPlacementIds[1] });
  const fd = openRunFile(h.store.folder(held.id), 'manager.lock', constants.O_RDWR | constants.O_CREAT); assert.equal(tryLock(fd), true);
  try {
    h.store.write(tx => tx.update({ ...missing, state: 'running', started_at: now() }));
    rmSync(h.store.folder(missing.id), { recursive: true });
    const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
    try {
      assert.deepEqual(decision.summary.lost, [missing.id]); assert.deepEqual(decision.launches.map(r => r.id), [other.id]);
      assert.equal(h.store.get(held.id)!.state, 'queued');
    } finally { closeLaunches(decision.launches); }
  } finally { closeSync(fd); }
});

test('(B3 k) invalid settings keeps queued runs queued; repaired settings launches them and running agents finish', async t => {
  const h = await setup(t);
  const runs = Array.from({ length: 5 }, (_, index) => h.create('plain', { gate: h.gate('finish') },
    index === 0 ? {} : { role: 'worker', placementId: h.memberPlacementIds[index - 1] }));
  await h.tick(); await Promise.all(runs.slice(0, 4).map(h.ready));
  writeFileSync(join(h.root, 'config.yaml'), 'invalid: true');
  const summary = await h.tick(); assert.deepEqual(summary.launched, []);
  h.release('finish'); await Promise.all(runs.slice(0, 4).map(r => h.waitState(r, 'succeeded')));
  assert.deepEqual((await h.tick()).launched, []);
  assert.equal(h.store.get(runs[4].id)!.state, 'queued');
  writeFileSync(join(h.root, 'config.yaml'), stringify(h.config));
  assert.deepEqual((await h.tick()).launched, [runs[4].id]);
  await h.waitState(runs[4], 'succeeded');
});

test('(B3 k) invalid settings withholds ended member callers and detects lost managers', async t => {
  const h = await setup(t), { ownerPlacementId, memberPlacementId } = h;
  const parent = h.create('claude', {}, { placementId: ownerPlacementId }); h.finish(parent);
  const child = h.create('plain', {}, { caller: { run: parent.id }, placementId: memberPlacementId, role: 'worker' }); h.finish(child);
  const lost = h.create(); h.store.write(tx => tx.update({ ...lost, state: 'running' }));
  writeFileSync(join(h.root, 'config.yaml'), 'agents: [broken');
  const summary = await h.tick();
  assert.deepEqual(summary.launched, []); assert.deepEqual(summary.lost, [lost.id]);
  await h.pass();
  assert.equal(h.continuations(parent).length, 0);
});

test('(B3 l) stop after natural parent exit preserves succeeded; the child\'s end still wakes the seat once (W1)', async t => {
  const h = await setup(t), parent = h.create('claude', { gate: h.gate('parent') });
  const child = h.create('plain', { gate: h.gate('child') }, { caller: { run: parent.id } });
  await h.tick(); await Promise.all([h.ready(parent), h.ready(child)]);
  const db = new DatabaseSync(controlDatabasePath(h.root));
  try {
    db.exec('BEGIN IMMEDIATE'); h.release('parent');
    await until(() => completed(h.root,parent.id), 'natural completion is durable before DB import');
    db.prepare("UPDATE runs SET record = json_set(record, '$.stop_requested', json('true')) WHERE id = ?").run(Number(parent.id.slice(1)));
    db.exec('COMMIT');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  const ended = await h.waitState(parent, 'succeeded'); assert.equal(ended.stop_requested, true);
  h.release('child'); await h.waitState(child, 'succeeded'); await h.tick(); await h.pass(); await h.pass();
  assert.equal(h.store.get(parent.id)!.state, 'succeeded');
  assert.equal(h.store.get(parent.id)!.stop_requested, true);
  // `run stop` stops only the Run: its Task still waits on the child, so the cycle's end wakes the seat, once.
  const [wake, ...more] = h.continuations(parent);
  assert.deepEqual(more, []);
  assert.equal(h.store.getRequest(wake!.requestId)!.purpose, 'return_continuation');
  assert.deepEqual(h.store.readReturns().filter(row => row.deliveries.some(d => d.wakeRequestId === wake!.requestId))
    .map(row => row.requestId), [child.requestId]);
});

test('recovery reports a real manager-lock I/O failure and still launches other work', async t => {
  const h = await setup(t, { parallel: 1 }), blocked = h.create();
  mkdirSync(join(h.store.folder(blocked.id), 'manager.lock'));
  const available = h.create('plain', {}, { role: 'worker', placementId: h.memberPlacementId });
  const result = await h.tick();
  assert.deepEqual(result.skipped, [{ run: blocked.id, reason: 'EISDIR' }]);
  assert.equal(h.store.get(blocked.id)!.state, 'queued');
  await h.waitState(available, 'succeeded');
});

function completed(root:string,id:string){try{const base=join(root,".alpacawork/runs",id,"protocol");return readdirSync(base).some(a=>readdirSync(join(base,a,"events")).some(n=>JSON.parse(readFileSync(join(base,a,"events",n),"utf8")).type==="completed"))}catch{return false}}
