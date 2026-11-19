/** A dense synthetic Return history still exposes both newly closed and reopened Requests during one audit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControlDatabase, type ChangeSeq } from '@alpacawork/db';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { emptyWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { ProjectionAudit } from '@alpacawork/backend/test-dist/receiver/projection-audit.js';
import { deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { createScreenAggregate } from '@alpacawork/backend/test-dist/receiver/screen-aggregate.js';
import { aggregateFactsOf } from '@alpacawork/backend/test-dist/receiver/workspace-aggregate-facts.js';
import type { PublishedFrame } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';

test('many closure references to one destination retain detection of both new and missing Returns', t => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'projection-audit-batch-')));
  const original = createOriginal({ tasks: 4, logs: 8, runs: 48, seed: 'projection-audit-batch' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
  t.after(() => { db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  t.mock.method(console, 'error', () => {});
  const pv = 1 as ProjectionVersion, seq = 0 as ChangeSeq;
  const records = emptyWorkspaceRecords(root).load(db, pv), held = records.bundle('T2');
  const values = new Map([...records.taskIds()].map(id => [id, deriveTask(records, id)]));
  const facts = new Map([...values].map(([id, value]) => [id, aggregateFactsOf(records, id, value.row, null)]));
  const frame: PublishedFrame = { generation: 'synthetic-audit-batch', pv, applied: seq, records, derived: id => values.get(id),
    aggregate: createScreenAggregate([...values.values()].map(value => value.contribution), facts),
    requiredPv: { view: {}, history: {}, page: {}, timeline: {}, search: {} }, patch: null };

  db.prepare("DELETE FROM returns WHERE id='fixture-return-2'").run();
  db.prepare(`INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at)
    VALUES ('fixture-return-4','fixture-request-4','T2','succeeded','R4','2026-11-16T00:00:00.000Z')`).run();
  const result = new ProjectionAudit().tick(db, frame, () => seq, { limit: 8 });
  assert.equal(result.skipped, false);
  assert.deepEqual(new Set(result.tasks), new Set(records.taskIds()));
  assert.ok(result.repairs.some(repair => repair.task === 'T3' && repair.kinds.has('records')), 'the deleted closure is detected at its Request');
  assert.ok(result.repairs.some(repair => repair.task === 'T2' && repair.kinds.has('records')), 'the inserted closure is detected');
  assert.equal(records.closedRequest('fixture-request-2'), true);
  assert.equal(records.closedRequest('fixture-request-4'), false);
  assert.equal(records.bundle('T2'), held, 'the held publication remains immutable');
});
