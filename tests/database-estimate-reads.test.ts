import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '@alpacawork/db';
import { databaseEstimateExamples } from '@alpacawork/backend/test-dist/control/estimate-examples.js';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

test('estimate reads batch each candidate’s Runs, exhaust time ties and leave older broken history unread', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-estimate-reads-')));
  const original = createOriginal({ tasks: 8, logs: 8, runs: 28, seed: 'estimate-reads' }, join(directory, 'cache'));
  const root = join(directory, 'workspace');
  copyWorkspace(original.root, root);
  const control = new ControlStore(root, { busyTimeoutMs: 1000 });
  t.after(() => {
    control.close();
    removeWorkspace(root);
    removeWorkspace(original.root);
    rmSync(directory, { recursive: true, force: true });
  });
  const selected = control.write(db => {
    const tasks = db.prepare(`SELECT t.id,t.external_id FROM tasks t WHERE t.kind='task'
      AND (SELECT count(*) FROM runs r WHERE r.task_id=t.external_id)>=3 ORDER BY t.number LIMIT 5`).all();
    assert.equal(tasks.length, 5);
    const insert = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)');
    for (const [index, task] of tasks.entries()) {
      let ordinal = Number(db.prepare('SELECT max(ordinal) n FROM task_log WHERE task_id=?').get(String(task.id))!.n) + 1;
      if (index === 4) {
        const id = 'broken-old-estimate';
        insert.run(id, String(task.id), ordinal, JSON.stringify({ id, kind: 'invalid-history-kind',
          at: '2026-11-01T00:00:00.000Z', toState: 'done' }));
        continue;
      }
      const runs = db.prepare('SELECT record FROM runs WHERE task_id=? ORDER BY id LIMIT 3')
        .all(String(task.external_id)).map(row => JSON.parse(String(row.record)));
      for (const [position, run] of runs.entries()) {
        const id = `estimate-${index}-${position}`;
        insert.run(id, String(task.id), ordinal++, JSON.stringify({ id, kind: 'reported',
          at: `2026-11-01T00:0${position}:00.000Z`, title: 'Synthetic estimate', description: null,
          actor: { kind: 'placement', placementId: run.placementId }, fromState: 'doing', toState: 'doing',
          estimateMinutes: 20, runId: run.id }));
      }
      const id = `estimate-handoff-${index}`;
      insert.run(id, String(task.id), ordinal, JSON.stringify({ id, kind: 'reported',
        at: '2026-11-01T00:10:00.000Z', title: 'Synthetic handoff', description: null,
        actor: { kind: 'human' }, fromState: 'doing', toState: 'done' }));
    }
    return tasks.map(task => String(task.external_id));
  });
  const prepare = DatabaseSync.prototype.prepare;
  let batchReads = 0, singleReads = 0;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (/SELECT id, record FROM runs\s+WHERE id IN/.test(sql)) batchReads++;
    if (/SELECT id, record FROM runs WHERE id = \?/.test(sql)) singleReads++;
    return prepare.call(this, sql);
  });
  let result;
  try { result = control.read(db => databaseEstimateExamples(root, db, { agent: 'fixture', values: {} })); }
  finally { hook.mock.restore(); }
  assert.deepEqual(result.examples.map(example => example.taskId), selected.slice(0, 3));
  assert.equal(batchReads, 4, 'all four candidates in the cutoff time bucket are scored');
  assert.equal(singleReads, 0, 'three estimate Runs per candidate share one read');
  assert.throws(() => control.read(db => databaseEstimateExamples(root, db, { agent: 'missing-agent', values: {} })),
    /invalid|decode|stored|kind/i, 'without three matches the older broken candidate is still observed');
});
