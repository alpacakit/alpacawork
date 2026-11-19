/** Replay writes keep terminal facts intact even when the supplied records predate the latest routing write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, holdControlWriter } from '@alpacawork/db';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { emptyWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../scripts/dev-fixtures/fixture.ts';
import { mutate, mutationState } from './helpers/projection/mutations.ts';
import type { OperationKind } from './helpers/projection/harness.ts';

test('replay transitions preserve released deliveries, settled inputs, ended executions and ended placements', t => {
  const area = mkdtempSync(join(tmpdir(), 'projection-mutations-'));
  const original = createOriginal({ ...profiles.small, seed: 'projection-mutations' }, join(area, 'cache'));
  const root = copyWorkspace(original.root, join(area, 'workspace')).root;
  const release = holdControlWriter(root), store = new ControlStore(root);
  t.after(() => { store.close(); release(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  const state = mutationState(), at = '2026-11-15T00:00:00.000Z';
  const read = () => store.read(db => emptyWorkspaceRecords(root).load(db, 1 as ProjectionVersion));
  const write = (kind: OperationKind, step: number, variant = 1, target = 2) => mutate(store, read(), { kind, step, target, variant }, state);
  store.write(db => {
    for (const [returned, received] of [['fixture-return-2', at], ['fixture-return-3', at], ['fixture-return-5', null]])
      db.prepare('INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at,received_at) VALUES(?,?,?,?)')
        .run(returned, 'fixture-request-1', at, received);
  });
  const stale = read();
  store.write(db => db.prepare("UPDATE return_deliveries SET released_at=?,release_reason='unsuccessful' WHERE return_id='fixture-return-2'").run(at));
  const delivery = (id: string) => store.read(db => db.prepare('SELECT * FROM return_deliveries WHERE return_id=?').get(id)!);
  const released = delivery('fixture-return-2');
  mutate(store, stale, { kind: 'delivery', step: 1, target: 2, variant: 1 }, state);
  assert.deepEqual(delivery('fixture-return-2'), released, 'a stale read must not consume an already released delivery');
  const consumed = delivery('fixture-return-3');
  assert.ok(consumed.consumed_at);
  assert.equal(delivery('fixture-return-5').consumed_at, null, 'receipt must precede consumption');
  write('delivery', 2, 0);
  assert.ok(delivery('fixture-return-5').received_at);
  assert.equal(delivery('fixture-return-5').consumed_at, null);
  write('delivery', 3);
  assert.ok(delivery('fixture-return-5').consumed_at);
  assert.deepEqual(delivery('fixture-return-3'), consumed, 'a later receipt must not erase or retime an earlier consumption');
  assert.deepEqual(write('delivery', 4).keys, [], 'terminal deliveries leave no writable transition');

  write('input-uncertain', 10);
  store.write(db => db.prepare("UPDATE run_inputs SET state='taken' WHERE instruction_run_no=7010").run());
  write('input-uncertain', 11);
  const input = (run: number) => store.read(db => db.prepare('SELECT state FROM run_inputs WHERE instruction_run_no=?').get(run)!.state);
  assert.equal(input(7010), 'taken', 'new uncertainty belongs to a new execution');
  assert.equal(input(7011), 'uncertain');
  write('joined-delivery', 12);
  write('delivery-uncertain', 13);
  assert.equal(input(3012), 'taken');
  assert.deepEqual(write('delivery-uncertain', 14).keys, [], 'a proved receipt is never made uncertain again');

  const ended = store.read(db => db.prepare('SELECT record FROM runs WHERE id=1').get()!.record);
  write('run-state', 15, 0);
  assert.equal(store.read(db => db.prepare('SELECT record FROM runs WHERE id=1').get()!.record), ended);
  assert.equal(store.read(db => db.prepare("SELECT json_extract(record,'$.state') AS state FROM runs WHERE id=6015").get()!.state), 'running');

  write('placement', 16, 0, 8);
  const old = store.read(db => db.prepare("SELECT * FROM placements WHERE id='fixture-placement-8'").get()!);
  write('placement', 17, 1, 8);
  assert.deepEqual(store.read(db => db.prepare("SELECT * FROM placements WHERE id='fixture-placement-8'").get()), old);
  assert.equal(store.read(db => db.prepare("SELECT ended_at FROM placements WHERE id='synthetic-placement-17'").get()!.ended_at), null);

  write('question', 18, 1, 3);
  assert.deepEqual(write('question', 180, 1, 3).keys, [], 'a Task has only one open reply wait');
  assert.deepEqual(write('question', 181, 1, 4).keys, [], 'a review wait cannot also ask an open question');
  write('answer', 19, 1, 3);
  assert.deepEqual(write('answer', 20, 1, 3).keys, [], 'a closed question is not withdrawn twice');
  write('dependency', 21, 1, 2);
  assert.deepEqual(write('dependency', 22, 1, 3).keys, [], 'a dependency must not introduce a cycle');
});
