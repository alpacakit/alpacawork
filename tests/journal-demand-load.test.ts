/** The idle tick reads one candidate index and one next path per healthy attempt, with no commit or fsync. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { setup } from './runs-runtime.fixture.ts';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';

test('idle journal demand scales with outstanding attempts, without reading prompts, writing or fsync', async t => {
  const h = await setup(t); h.pauseProjection();
  const db = h.store.connection, importer = new RunEventImporter(h.store);
  const stat = fs.lstatSync, fsync = fs.fsyncSync, prepare = db.prepare;
  let stats = 0, selects = 0, cursorReads = 0, syncs = 0, measuring = false;
  const statMock = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof stat>) => { stats++; return Reflect.apply(stat, fs, args); });
  const syncMock = t.mock.method(fs, 'fsyncSync', (fd: number) => { syncs++; return fsync(fd); });
  syncBuiltinESMExports();
  t.after(() => { statMock.mock.restore(); syncMock.mock.restore(); syncBuiltinESMExports(); });
  const query = t.mock.method(db, 'prepare', function(sql: string) {
    const statement = prepare.call(db, sql);
    if (sql.includes('FROM run_attempts a JOIN runs')) {
      if (measuring) assert.ok(!sql.includes('prompt'), 'no prompt bytes on an idle tick');
      // Count executed index scans separately from per-candidate cursor reads.
      // Preparing the cursor lookup does not execute it (there are none at size 0).
      const all = statement.all, get = statement.get;
      statement.all = function(...args: Parameters<typeof all>) { if (measuring) selects++; return all.apply(this, args); };
      statement.get = function(...args: Parameters<typeof get>) { if (measuring) cursorReads++; return get.apply(this, args); };
    }
    return statement;
  });
  let count = 0, template: Record<string, unknown> | undefined;
  for (const size of [0, 10, 100]) {
    while (count < size) {
      const run = h.createCoordinator();
      if (!template) {
        const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
        template = JSON.parse(String(db.prepare('SELECT launch_json FROM run_attempts').get()!.launch_json));
      } else {
        // Isolated cursor rows model pending journals, not running OS managers. Keep actual launch snapshot shape.
        const attemptId = randomUUID();
        h.store.write(() => db.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES(?,?,?)')
          .run(Number(run.id.slice(1)), attemptId, JSON.stringify({ ...template, runId: run.id, attemptId, initialInputId: randomUUID() })));
      }
      count++;
    }
    stats = 0; selects = 0; cursorReads = 0; syncs = 0;
    const before = db.prepare('SELECT total_changes() AS n').get()!.n;
    const times: number[] = [];
    measuring = true;
    for (let n = 0; n < 20; n++) {
      const start = performance.now(); assert.equal(importer.hasPublishedTail(), false); times.push(performance.now() - start);
    }
    measuring = false;
    times.sort((a, b) => a - b);
    assert.equal(selects, 20); assert.equal(cursorReads, 20 * size); assert.equal(stats, 20 * size); assert.equal(syncs, 0);
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before);
    t.diagnostic(JSON.stringify({ attempts: size, rounds: 20, selects, cursorReads, stats, fsync: syncs,
      p50Ms: times[10], p95Ms: times[19], totalMs: times.reduce((a, b) => a + b, 0) }));
  }
  query.mock.restore();
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT a.run_no FROM run_attempts a JOIN runs r ON r.id=a.run_no
    WHERE (a.completed_digest IS NULL OR a.diagnostic IS NOT NULL OR a.acked_seq<a.next_seq-1) ORDER BY a.run_no`).all();
  assert.ok(plan.some(row => String(row.detail).includes('run_attempts_open')));
  t.diagnostic(JSON.stringify({ plan }));
});
