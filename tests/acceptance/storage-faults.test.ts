/** Current Request persistence faults and Run stop/recovery boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { alive, http, receipts, setup, until, type Harness } from './harness.ts';
import { installFault } from './faults.ts';

const insertFault = (h: Harness) => h.sql(db => db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'B8 INSERT failure'); END"));
const dropInsert = (h: Harness) => h.sql(db => db.exec('DROP TRIGGER fail_insert'));

for (const mode of ['busy', 'insert', 'commit'])
  test(`F: Request ${mode} failure leaves no confirmed Run and allows a new ID`, async t => {
    const h = await setup(t); h.getStore();
    assert.ok(h.task && h.placement);
    const input = { taskId: h.task.id, mode: 'new' as const, body: 'Fault admission',
      requestId: randomUUID(), expectedTaskHash: h.task.hash,
      expectedPlacementRevision: h.placement.revision };
    if (mode === 'insert') insertFault(h);
    const fault = installFault(h.root, mode, t.mock);
    try { await assert.rejects(h.request(input)); }
    finally { fault.restore(); if (mode === 'insert') dropInsert(h); }
    if (mode !== 'insert') assert.ok(fault.hits > 0, 'fault actually reached');
    assert.deepEqual(h.records(), []);
    assert.deepEqual(h.getStore().readRequests(), []);
    assert.equal(receipts(h.root).length, 0);
    const recovered = await h.request({ ...input, requestId: randomUUID(), body: 'Recovered' });
    assert.equal(h.getStore().get(recovered.runId)?.state, 'queued');
    assert.equal(h.getStore().readRequests().length, 1);
    h.integrity();
  });

test('F: HTTP stop UPDATE failure returns 503 and leaves its target unchanged', async t => {
  const h = await setup(t), target = h.seed({}, 'running', { token: 'stop-target' }), app = await h.server();
  h.sql(db => db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'B8 UPDATE failure'); END"));
  let result: Awaited<ReturnType<typeof http>>;
  try { result = await http(app.url, 'commands/run/stop', { run: target.id }); }
  finally { h.sql(db => db.exec('DROP TRIGGER fail_update')); }
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'runs_unavailable'); assert.match(result.body.error.message, /B8 UPDATE failure/);
  assert.deepEqual(h.getStore().get(target.id), target); assert.equal(receipts(h.root).length, 0);
  assert.equal((await http(app.url, 'commands/run/stop', { run: target.id })).status, 200);
  assert.equal(h.getStore().get(target.id)!.stop_requested, true); h.integrity();
});

test('F: importer final UPDATE failure keeps completion/cursor pending and repairs without relaunch', async t => {
 const h=await setup(t),run=h.seed({},'queued',{gate:h.gate('final'),token:'final-fault'});await h.tick();const running=await h.ready(run.id);
 h.sql(db=>db.exec("CREATE TRIGGER fail_final BEFORE UPDATE ON runs WHEN json_extract(NEW.record, '$.state')='succeeded' BEGIN SELECT RAISE(ABORT, 'B8 final UPDATE failure'); END"));
 h.release('final');await until(()=>!alive(running.pids.manager!),'manager persists completion and ends');
 new RunEventImporter(h.getStore()).pass();const attempt=h.getStore().connection.prepare('SELECT next_seq,completed_digest,diagnostic FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!;
 assert.equal(attempt.completed_digest,null);assert.match(String(attempt.diagnostic),/B8 final UPDATE failure/);assert.equal(h.getStore().getText(run.id)!.resultState,'pending');assert.equal(h.getStore().get(run.id)!.state,'needs_review');assert.equal(h.getStore().get(run.id)!.reason,null,'an importer fault is not manager_lost');
 h.sql(db=>db.exec('DROP TRIGGER fail_final'));await h.tick();await h.waitState(run.id,'succeeded');assert.equal(h.getStore().getText(run.id)!.result,'fake result');assert.equal(receipts(h.root).length,1);h.oncePerRun();h.integrity();
});
