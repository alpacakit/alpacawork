import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runRecordSchema } from '@alpacawork/contract/run';
import { record, time } from '../runs-fixtures.ts';
import { setup } from './harness.ts';

test('D: current Request admission works with 10,000 ended Run records', async t => {
  const h = await setup(t); h.getStore();
  h.sql(db => {
    const insertRequest = db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,
      head_run_id,mode,body,purpose,author,submitted_at,delivery_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insert = db.prepare(`INSERT INTO runs(id,record,prompt) VALUES (?,?,?)`);
    const history = (run: ReturnType<typeof record>) => {
      const requestId = `request-${run.id}`;
      const current = { ...run, task: h.task!.id, placementId: h.placement!.id, requestId };
      insertRequest.run(requestId, h.task!.id, h.placement!.id, h.placement!.revision,
        h.task!.hash, null, 'new', 'Ended history', 'instruction', '{"kind":"human"}', time, 'queued');
      insert.run(Number(run.id.slice(1)), JSON.stringify(current), '');
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      // 833 twelve-record chains and four unrelated final owners = 10,000.
      // Ended history needs no prompt folders: no agent will ever launch for it.
      let n = 0;
      for (let chain = 0; chain < 833; chain++) {
        const parent = `R${n + 1}`, session = { provider: 'claude' as const, id: `history-${chain}` };
        const count = 12;
        for (let j = 0; j < count; j++) {
          const continuation = j === count - 1, worker = j > 0 && !continuation, failed = worker && j % 3 === 0;
          const run = runRecordSchema.parse(record(`R${++n}`, {
            state: failed ? 'failed' : 'succeeded', reason: failed ? 'exit' : null,
            exit: { code: failed ? 1 : 0, signal: null }, started_at: time, ended_at: time,
            role: worker ? 'worker' : 'owner', session: worker ? null : session,
            caller: worker || continuation ? { run: parent } : null,
            resumes: continuation ? parent : null,
          }));
          history(run);
        }
      }
      for (let extra = 0; extra < 4; extra++) {
        const run = runRecordSchema.parse(record(`R${++n}`, { state: 'succeeded', started_at: time, ended_at: time,
          exit: { code: 0, signal: null }, session: { provider: 'claude', id: `extra-${extra}` },
          caller: null }));
        history(run);
      }
      assert.equal(n, 10_000);
      db.prepare('UPDATE run_sequence SET next_number = ? WHERE singleton = 1').run(10_001);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  assert.equal(h.records().length, 10_000);
  assert.ok(h.task && h.placement);
  const receipt = await h.request({ taskId: h.task.id, mode: 'new', body: 'Current admission after history',
    requestId: randomUUID(), expectedTaskHash: h.task.hash,
    expectedPlacementRevision: h.placement.revision });
  assert.equal(receipt.runId, 'R10001');
  assert.equal(h.getStore().get(receipt.runId)?.state, 'queued');
  assert.equal(h.getStore().readRequests().length, 10_001);
  assert.equal(h.records().length, 10_001);
  h.integrity();
});
