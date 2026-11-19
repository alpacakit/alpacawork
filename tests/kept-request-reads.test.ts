import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepControlTables } from '@alpacawork/db';
import { RunStore, latestUserRequests, type NewRequest, type RunTransaction } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { initializeControlFixture, seedFixtureTask } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields } from './runs-fixtures.ts';

test('named and complete Request reads retain their read point through Run attachment and rolled-back writes', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kept-request-reads-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new FileWriter(root);
  let project: string;
  try { files.save('config.yaml', null, Buffer.from('agents: {}\n')); project = initializeControlFixture(root); }
  finally { files.close(); }
  const task = seedFixtureTask(root, project, 'One'), placements = new PlacementStore(root);
  const placement = (() => {
    try { return placements.createAndPlace({ taskId: task.id, profileKey: 'fake', responsible: true }).placement; }
    finally { placements.close(); }
  })();
  const writer = new RunStore(root, { busyTimeoutMs: 1000 });
  const reader = new RunStore(root, { busyTimeoutMs: 1000 }, true);
  const older = new RunStore(root, { busyTimeoutMs: 1000 }, true);
  const release = keepControlTables(root);
  t.after(() => { older.close(); reader.close(); writer.close(); release(); });
  const request = (id: string, body = 'original'): NewRequest => ({ id, taskId: task.id, placementId: placement.id,
    placementRevision: placement.revision, taskHash: task.hash, waitCycleId: null, headRunId: null,
    mode: 'new', body, purpose: 'instruction', author: { kind: 'human' },
    submittedAt: new Date().toISOString(), deliveryState: 'queued' });
  writer.write(tx => tx.insertRequest(request('kept')));
  reader.readRequests(project);
  const latest = (store = reader) => latestUserRequests(store.connection, root, [task.id]).get(task.id)?.id;
  assert.equal(reader.readDecisions(() => latest()), 'kept');
  const readIn = (tx: Pick<RunTransaction, 'getRequest' | 'getRequests' | 'requests'>) => {
    const single = tx.getRequest('kept'), named = tx.getRequests(['kept', 'kept', 'missing']);
    assert.deepEqual(named.get('kept'), single);
    assert.equal(named.has('missing'), false);
    assert.equal(named.size, 1);
    assert.deepEqual(tx.requests(project).find(item => item.id === 'kept'), single);
    return single!;
  };
  const read = (store = reader) => store.readDecisions(readIn);
  const before = read();
  assert.equal(before.deliveryState, 'queued');
  assert.equal(before.runId, null);
  before.body = 'local edit';
  assert.equal(read().body, 'original', 'each caller owns its Request object');
  older.readDecisions(snapshot => {
    const old = readIn(snapshot);
    assert.equal(latest(older), 'kept');
    const run = writer.write(tx => {
      const created = createFixtureRun(writer, tx, fields({ task: task.id, placementId: placement.id,
        requestId: 'kept', role: 'owner' }), 'prompt');
      tx.updateRequest('kept', 'waiting_for_run');
      tx.insertRequest(request('later'));
      return created;
    });
    assert.equal(reader.readDecisions(() => latest()), 'later');
    assert.equal(latest(older), 'kept', 'an older snapshot cannot use a later user head');
    assert.equal(read().deliveryState, 'waiting_for_run');
    assert.equal(read().runId, run.id, 'an existing Request acquires its newly committed Run');
    assert.deepEqual(readIn(snapshot), old, 'an older snapshot keeps its delivery state and lack of a Run');
  });
  assert.throws(() => writer.write(tx => {
    tx.updateRequest('kept', 'aborted');
    tx.updateRequest('later', 'recorded_unconfirmed');
    assert.equal(latest(writer), undefined, 'ineligible user heads do not reset accounting');
    tx.insertRequest(request('retry', 'rolled back'));
    const named = tx.getRequests(['kept', 'retry']);
    assert.equal(named.get('kept')!.deliveryState, 'aborted');
    assert.equal(named.get('retry')!.body, 'rolled back');
    assert.deepEqual(tx.getRequest('retry'), named.get('retry'));
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(read().deliveryState, 'waiting_for_run');
  assert.equal(reader.readDecisions(() => latest()), 'later', 'rolled-back eligibility cannot leak');
  assert.equal(reader.readDecisions(tx => tx.getRequests(['retry'])).size, 0,
    'a named read cannot invent a rolled-back Request');
  writer.write(tx => tx.insertRequest(request('retry', 'committed replacement')));
  assert.equal(reader.readDecisions(tx => tx.getRequests(['retry'])).get('retry')!.body, 'committed replacement');
  writer.connection.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,
    author,submitted_at,delivery_state,wait_cycle_id)
    SELECT 'unsafe-revision',task_id,placement_id,9007199254740992,task_hash,mode,body,purpose,
      author,submitted_at,delivery_state,wait_cycle_id FROM requests WHERE id='kept'`).run();
  reader.readDecisions(tx => {
    assert.equal(tx.getRequest('kept')!.body, 'original', 'an unrelated malformed row cannot poison a named read');
    assert.equal(tx.getRequests(['kept']).get('kept')!.body, 'original');
  });
  assert.throws(() => reader.readDecisions(tx => tx.getRequest('unsafe-revision')),
    'the malformed selected Request still fails its reader');
  assert.throws(() => reader.readDecisions(tx => tx.getRequests(['unsafe-revision'])));

});
