import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openControlDatabase, type ChangeKey } from '@alpacawork/db';
import type { RunId } from '@alpacawork/contract';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { emptyWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { runRecordsAvailable } from '@alpacawork/backend/test-dist/receiver/run-record-health.js';
import { coordinatorFileRunChanges } from '@alpacawork/backend/test-dist/receiver/coordinator-file-runs.js';
import { coordinatorRecord } from './runs-fixtures.ts';

function fixture(t: TestContext) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'run-record-health-')));
  const original = createOriginal({ tasks: 14, logs: 28, runs: 7, seed: 'run-record-health' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
  t.after(() => { db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  return { root, db };
}

test('invalid Run records degrade execution while fresh Task facts and previous publications remain readable', t => {
  const { root, db } = fixture(t);
  const version = (n: number) => n as ProjectionVersion;
  const healthy = emptyWorkspaceRecords(root).load(db, version(1));
  const row = db.prepare('SELECT id,task_id,record FROM runs WHERE task_id IS NOT NULL ORDER BY id LIMIT 1').get()!;
  const run = `R${row.id}` as RunId, task = String(row.task_id), previousTitle = healthy.bundle(task)!.task.meta.title;
  const keys: ChangeKey[] = [{ kind: 'run', id: run }, { kind: 'task', id: task }];
  db.prepare("UPDATE runs SET record=json_set(record,'$.agent','Not An Agent') WHERE id=?").run(row.id);
  db.prepare('UPDATE tasks SET title=? WHERE external_id=?').run('Fresh independent Task facts', task);

  const initialDegraded = emptyWorkspaceRecords(root).load(db, version(2));
  const degraded = healthy.advance(db, keys, version(2)).next;
  for (const records of [initialDegraded, degraded]) {
    assert.equal(runRecordsAvailable(records), false);
    assert.equal(records.environment().writable, false);
    assert(records.environment().errors.some(error => error.code === 'runs_unavailable'));
    assert.equal(records.bundle(task)!.task.meta.title, 'Fresh independent Task facts');
    const derived = deriveTask(records, task);
    assert(derived.placements.length > 0);
    assert(derived.placements.every(placement => placement.runtime.displayState === 'unknown'));
    assert.deepEqual(derived.runs, []);
    assert.equal(derived.ball, null);
    assert.equal(records.run(run), undefined);
  }
  assert.equal(healthy.bundle(task)!.task.meta.title, previousTitle);
  assert.equal(runRecordsAvailable(healthy), true);
  assert(healthy.run(run));

  db.prepare('UPDATE runs SET record=? WHERE id=?').run(row.record, row.id);
  const recovered = degraded.advance(db, [{ kind: 'run', id: run }], version(3)).next;
  assert.equal(runRecordsAvailable(recovered), true);
  assert.equal(recovered.environment().writable, true);
  assert.deepEqual(recovered.environment().errors, []);
  assert(deriveTask(recovered, task).placements.every(placement => placement.runtime.displayState !== 'unknown'));
  assert(recovered.run(run));
  assert.equal(runRecordsAvailable(degraded), false);
  assert.equal(degraded.run(run), undefined);
});

test('coordinator file observations follow changed Run identity and state without metadata-time inventory scans', t => {
  const { root, db } = fixture(t), version = (n: number) => n as ProjectionVersion;
  const before = emptyWorkspaceRecords(root).load(db, version(1));
  const conversation = globalThis.crypto.randomUUID(), request = globalThis.crypto.randomUUID();
  const at = '2026-11-16T00:00:00.000Z';
  db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES (?,?)').run(conversation, at);
  db.prepare(`INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state)
    VALUES (?,?,'new','Synthetic turn','instruction','{"kind":"human"}',?,'queued')`).run(request, conversation, at);
  const run = coordinatorRecord('R8', { requestId: request, conversationId: conversation, state: 'running', started_at: at });
  db.prepare("INSERT INTO runs(id,record,prompt) VALUES (8,?,'Synthetic prompt')").run(JSON.stringify(run));
  const keys: ChangeKey[] = [{ kind: 'request', id: request }, { kind: 'run', id: 'R8' }];
  const running = before.advance(db, keys, version(2)).next;
  const watched = { id: 'R8', task: null, state: 'running' };
  assert.deepEqual(coordinatorFileRunChanges(before, running, keys, false), { upsert: [watched], remove: [] });
  assert.deepEqual(coordinatorFileRunChanges(undefined, running, [], true), { upsert: [watched], remove: [] });
  assert.deepEqual([...running.coordinatorFileRuns()], [watched]);
  assert.deepEqual([...before.coordinatorFileRuns()], []);
  assert.equal(running.runtimeRun('R8')!.task, null);
  assert.equal(running.run('R8'), undefined, 'a coordinator is not invented as a Task Run');

  const scan = t.mock.method(running, 'coordinatorFileRuns', () => { throw new Error('Metadata must not enumerate Coordinator Runs'); });
  assert.deepEqual(coordinatorFileRunChanges(before, running, [{ kind: 'person', id: 'notices' }], false), { upsert: [], remove: [] });
  scan.mock.restore();
  assert.deepEqual(coordinatorFileRunChanges(before, running, [{ kind: 'request', id: request }], false).upsert, [watched]);
  assert.deepEqual(coordinatorFileRunChanges(running, running, [{ kind: 'activity', id: 'R8' }], false), { upsert: [], remove: [] });

  const failedRecord = coordinatorRecord('R8', { ...run, state: 'failed', reason: 'exit', ended_at: at, exit: { code: 1, signal: null } });
  db.prepare("UPDATE runs SET record=?,result=NULL,result_state='missing' WHERE id=8").run(JSON.stringify(failedRecord));
  const failed = running.advance(db, [{ kind: 'run', id: 'R8' }], version(3)).next;
  assert.deepEqual(coordinatorFileRunChanges(running, failed, [{ kind: 'run', id: 'R8' }], false),
    { upsert: [{ ...watched, state: 'failed' }], remove: [] });
  const endedRecord = coordinatorRecord('R8', { ...run, state: 'succeeded', ended_at: at, exit: { code: 0, signal: null } });
  db.prepare("UPDATE runs SET record=?,result='Synthetic reply',result_state='present' WHERE id=8").run(JSON.stringify(endedRecord));
  const ended = failed.advance(db, [{ kind: 'run', id: 'R8' }], version(4)).next;
  assert.deepEqual(coordinatorFileRunChanges(failed, ended, [{ kind: 'run', id: 'R8' }], false), { upsert: [], remove: ['R8'] });
  assert.deepEqual(coordinatorFileRunChanges(failed, ended, [], true), { upsert: [], remove: ['R8'] });
  assert.deepEqual([...ended.coordinatorFileRuns()], []);
  assert.deepEqual([...running.coordinatorFileRuns()], [watched], 'older publications retain their independent file watch facts');
});
