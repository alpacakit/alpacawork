import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { controlDatabasePath } from '@alpacawork/db';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { commandPath } from '@alpacawork/contract/command-path';
import { analysisAtViewSchema, analysisChangesViewSchema, analysisFindingsViewSchema, analysisTraceViewSchema } from '@alpacawork/contract/analysis';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { inertFixtureLaunch } from './helpers/agent-stub.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

const instant = (second: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString();

/** One Run of the task gets times, a step journal with its output, and its conditions; the others stay as they are. */
function prepare(root: string) {
  const db = new DatabaseSync(controlDatabasePath(root));
  let run: string, task: string;
  try {
    const row = db.prepare("SELECT id, json_extract(record,'$.task') AS task FROM runs WHERE json_extract(record,'$.task') IS NOT NULL ORDER BY id LIMIT 1").get()!;
    run = 'R' + String(row.id); task = String(row.task);
    const record = JSON.parse(String(db.prepare('SELECT record FROM runs WHERE id=?').get(row.id)!.record));
    Object.assign(record, { state: 'succeeded', reason: null, created_at: instant(0), started_at: instant(1), ended_at: instant(60),
      launch: inertFixtureLaunch('codex', { model: 'example', effort: 'high' }), pids: { agent: 1001, manager: 2001 } });
    db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), row.id);
  } finally { db.close(); }
  const folder = runFolder(root, run);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, RUN_FILES.stdout), [
    { type: 'item.started', item: { id: 'call', type: 'command_execution', command: 'pnpm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'call', type: 'command_execution', command: 'pnpm test', status: 'completed', exit_code: 0, aggregated_output: 'ok' } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(folder, RUN_FILES.steps), [
    { event: 'start', line: 0, id: 'call', at: instant(10), source: 'reported', fingerprint: { line: 'pnpm test', bodyDigest: null }, parentId: null },
    { event: 'end', line: 0, id: 'call', at: instant(40), source: 'reported', state: 'done', output: null },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(folder, RUN_FILES.conditions), JSON.stringify({ v: 1, observedAt: instant(1), version: '0.0.0', release: null, source: null,
    cwd: { path: '/fictional', commit: null }, skills: [], instructions: [] }));
  return { run, task };
}

test('analysis trace, findings and at answer one task\'s timeline over HTTP in their contract shapes', { timeout: 30_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'analysis-timeline-'));
  const root = join(temp, 'workspace');
  let original: string | undefined, rootCreated = false;
  try {
    original = createOriginal({ ...profiles.small, seed: 'analysis-timeline' }, join(temp, 'cache')).root;
    copyWorkspace(original, root);
    rootCreated = true;
    const { run, task } = prepare(root);
    const app = await startServer(root, 0);
    try {
      const read = async (verb: string, params: Record<string, string>, status = 200) => {
        const url = new URL(commandPath('analysis/' + verb), app.url);
        url.search = new URLSearchParams(params).toString();
        const response = await fetch(url), data = await response.json();
        assert.equal(response.status, status, JSON.stringify(data));
        return data;
      };
      const trace = analysisTraceViewSchema.parse(await read('trace', { task, timeZone: 'UTC' }));
      assert.ok(trace.coverage.steps.known.includes(run));
      const step = trace.spans.find(span => span.kind === 'step');
      assert.deepEqual(step && [step.run, step.step, step.from, step.to], [run, 0, instant(10), instant(40)]);
      assert.equal(trace.breakdown.categories.reduce((sum, part) => sum + part.ms, 0), trace.breakdown.wall);
      assert.equal(trace.url, `/?task=${task}&tab=timeline`);
      // Pages follow one another in time order and together hold every span and mark once.
      const ids: string[] = [];
      let cursor: string | null = null, pages = 0;
      do {
        const page = analysisTraceViewSchema.parse(await read('trace', { task, limit: '2', ...cursor ? { cursor } : {} }));
        ids.push(...page.spans.map(span => span.id), ...page.marks.map(mark => mark.id));
        cursor = page.nextCursor; pages++;
      } while (cursor && pages < 100);
      assert.equal(new Set(ids).size, trace.total);
      await read('trace', { task, cursor: 'xxxxxxxxxxxx.2' }, 400);

      const findings = analysisFindingsViewSchema.parse(await read('findings', { task, threshold: 'queue-wait=0.001' }));
      assert.equal(findings.rules.set, 'experimental');
      for (const finding of findings.findings) assert.ok(finding.url.includes(`finding=${encodeURIComponent(finding.id)}`));
      await read('findings', { task, threshold: 'rework=1' }, 400);

      const at = analysisAtViewSchema.parse(await read('at', { task, at: instant(20) }));
      assert.deepEqual(at.runs.map(item => [item.run, item.current.map(current => current.step)]), [[run, [0]]]);
      assert.equal(at.values, null);
      await read('at', { task: 'T999999', at: instant(20) }, 404);

      const changes = analysisChangesViewSchema.parse(await read('changes', { period: 'all', timeZone: 'UTC', limit: '1' }));
      assert.ok(changes.runs.recorded >= 1 && changes.runs.launched >= changes.runs.recorded);
      assert.equal(changes.cursor === null, changes.total <= 1);
    } finally { await app.close(); }
  } finally {
    if (original) {
      if (rootCreated) removeWorkspace(root);
      removeWorkspace(original);
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
