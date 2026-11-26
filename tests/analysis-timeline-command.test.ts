import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runSummarySchema } from '@alpacawork/contract/run-summary';
import { controlDatabasePath } from '@alpacawork/db';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { commandPath } from '@alpacawork/contract/command-path';
import { analysisAtViewSchema, analysisUnitValuesSchema, analysisChangesViewSchema, analysisFindingsViewSchema, analysisTraceViewSchema } from '@alpacawork/contract/analysis';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { inertFixtureLaunch } from './helpers/agent-stub.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

const instant = (second: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString();

/** One Run of the task gets times, a step journal with its output, and its conditions; the others stay as they are. */
function prepare(root: string) {
  const db = new DatabaseSync(controlDatabasePath(root));
  let run: string, task: string, top: string;
  try {
    const row = db.prepare("SELECT id, json_extract(record,'$.task') AS task FROM runs WHERE json_extract(record,'$.task') IS NOT NULL ORDER BY id LIMIT 1").get()!;
    run = 'R' + String(row.id); task = String(row.task);
    const record = JSON.parse(String(db.prepare('SELECT record FROM runs WHERE id=?').get(row.id)!.record));
    Object.assign(record, { state: 'succeeded', reason: null, created_at: instant(0), started_at: instant(1), ended_at: instant(60),
      launch: inertFixtureLaunch('codex', { model: 'example', effort: 'high' }), pids: { agent: 1001, manager: 2001 } });
    db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), row.id);
    // The top-level Task above it, and a question to the user on each of the two, open while the Run works.
    top = task;
    for (;;) {
      const up = db.prepare("SELECT p.external_id AS id, p.kind FROM tasks t JOIN tasks p ON p.id=t.parent_id WHERE t.external_id=?").get(top)!;
      if (up.kind !== 'task') break;
      top = String(up.id);
    }
    const insert = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) SELECT ?,t.id,coalesce((SELECT max(ordinal) FROM task_log WHERE task_id=t.id),-1)+1,? FROM tasks t WHERE t.external_id=?');
    insert.run('timeline-doing', JSON.stringify({ id: 'timeline-doing', kind: 'linked', at: instant(2), title: null, description: null,
      actor: { kind: 'human' }, fromState: 'todo', toState: 'doing' }), top);
    for (const [n, owner] of [...new Set([top, task])].entries()) {
      const question = `timeline-question-${n}`, answer = `timeline-answer-${n}`;
      insert.run(question, JSON.stringify({ id: question, kind: 'asked', at: instant(5 + n), askedTo: null, title: 'Synthetic question',
        description: 'A fixture question', decide: [{ decide_question: 'Take the result?', decide_kind: n ? 'choose' : 'accept' }],
        actor: { kind: 'placement', placementId: 'fixture-placement' }, fromState: null, toState: null }), owner);
      insert.run(answer, JSON.stringify({ id: answer, kind: 'answered', at: instant(50 + n * 10), questionId: question, title: null,
        description: null, actor: { kind: 'human' }, fromState: null, toState: null }), owner);
      db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)').run(answer, question);
      db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)').run(answer, 'A fixture answer');
    }
  } finally { db.close(); }
  const folder = runFolder(root, run);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, RUN_FILES.stdout), [
    { type: 'item.started', item: { id: 'call', type: 'command_execution', command: 'pnpm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'call', type: 'command_execution', command: 'pnpm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(folder, RUN_FILES.steps), [
    { event: 'start', line: 0, id: 'call', at: instant(10), source: 'reported', fingerprint: { line: 'pnpm test', bodyDigest: null }, parentId: null },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(folder, RUN_FILES.conditions), JSON.stringify({ v: 1, observedAt: instant(1), version: '0.0.0', release: null, source: null,
    cwd: { path: '/fictional', commit: null }, skills: [], instructions: [] }));
  writeFileSync(join(root, '.alpacawork', 'analysis-tally-since'), instant(0));
  return { run, task, top: top! };
}

test('analysis trace, findings and at answer one task\'s timeline over HTTP in their contract shapes', { timeout: 30_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'analysis-timeline-'));
  const root = join(temp, 'workspace');
  let original: string | undefined, rootCreated = false;
  try {
    original = createOriginal({ ...profiles.small, seed: 'analysis-timeline' }, join(temp, 'cache')).root;
    copyWorkspace(original, root);
    rootCreated = true;
    const { run, task, top } = prepare(root);
    const app = await startServer(root, 0);
    try {
      const summaryUrl = new URL(commandPath('run/summary'), app.url);
      summaryUrl.searchParams.set('run', run);
      const getSummary = async () => {
        const response = await fetch(summaryUrl);
        assert.equal(response.status, 200);
        return runSummarySchema.parse(await response.json());
      };
      let summary = await getSummary();
      for (let i = 0; summary.state === 'pending' && i < 100; i++) {
        await delay(30);
        summary = await getSummary();
      }
      assert.equal(summary.state, 'complete');
      assert.deepEqual(summary.outputs, { chars: 2, largest: [{ step: 0, chars: 2 }] });
      assert.deepEqual(summary.tests.map(({ step, state, commit }) => [step, state, commit]), [[0, 'done', null]]);
      const read = async (verb: string, params: Record<string, string>, status = 200) => {
        const url = new URL(commandPath('analysis/' + verb), app.url);
        url.search = new URLSearchParams(params).toString();
        const response = await fetch(url), data = await response.json();
        assert.equal(response.status, status, JSON.stringify(data));
        return data;
      };
      // The output shows the step ended, but the journal has no end yet: its time is unknown, and it is not running.
      const before = analysisTraceViewSchema.parse(await read('trace', { task, timeZone: 'UTC', limit: '1' }));
      assert.ok(before.coverage.steps.unknown.find(item => item.reason === 'missing-step-times')?.runs.includes(run));
      assert.equal(before.breakdown.toolMs, null);
      assert.deepEqual(analysisAtViewSchema.parse(await read('at', { task, at: instant(20) })).runs.map(item => item.current), [[]]);
      // The end is written: the records' version changes and a cursor of the earlier version is refused.
      appendFileSync(join(runFolder(root, run), RUN_FILES.steps),
        JSON.stringify({ event: 'end', line: 0, id: 'call', at: instant(40), source: 'reported', state: 'done', output: null }) + '\n');
      const trace = analysisTraceViewSchema.parse(await read('trace', { task, timeZone: 'UTC' }));
      assert.notEqual(trace.head.version, before.head.version);
      await read('trace', { task, timeZone: 'UTC', limit: '1', cursor: before.cursor! }, 400);
      assert.ok(trace.coverage.steps.known.includes(run));
      assert.ok(trace.coverage.summaries.known.includes(run));
      assert.deepEqual(trace.marks.filter(mark => mark.kind === 'test').map(mark => [mark.run, mark.step, mark.atSource]),
        [[run, 0, 'step']]);
      const step = trace.spans.find(span => span.kind === 'step');
      assert.deepEqual(step && [step.run, step.step, step.from, step.to], [run, 0, instant(10), instant(40)]);
      assert.equal(trace.breakdown.categories.reduce((sum, part) => sum + part.ms, 0), trace.breakdown.wall);
      assert.equal(trace.url, `/?task=${task}&tab=analysis`);
      // Pages follow one another in time order and together hold every span and mark once.
      const ids: string[] = [];
      let cursor: string | null = null, pages = 0;
      do {
        const page = analysisTraceViewSchema.parse(await read('trace', { task, limit: '2', ...cursor ? { cursor } : {} }));
        ids.push(...page.spans.map(span => span.id), ...page.marks.map(mark => mark.id));
        cursor = page.cursor; pages++;
      } while (cursor && pages < 100);
      assert.equal(new Set(ids).size, trace.total);
      await read('trace', { task, cursor: 'xxxxxxxxxxxx.yyyyyyyyyyyy.2' }, 400);
      // A cursor holds to one version of the records, and a page past the end is refused.
      const first = analysisTraceViewSchema.parse(await read('trace', { task, limit: '1' }));
      const [selector, , offset] = first.cursor!.split('.');
      await read('trace', { task, limit: '1', cursor: `${selector}.zzzzzzzzzzzz.${offset}` }, 400);
      await read('trace', { task, limit: '1', cursor: `${selector}.${first.head.version}.${first.total + 1}` }, 400);
      // A period is resolved, then checked; a record at its start is kept.
      await read('trace', { task, from: '2100-01-01T00:00:00Z' }, 400);
      const mark = trace.marks[0]!;
      const atStart = analysisTraceViewSchema.parse(await read('trace', { task, from: mark.at, kinds: mark.kind }));
      assert.ok(atStart.marks.some(item => item.id === mark.id));

      const findings = analysisFindingsViewSchema.parse(await read('findings', { task, threshold: 'queue-wait=0.001' }));
      assert.equal(findings.rules.set, 'experimental');
      for (const finding of findings.findings) assert.ok(finding.url.includes(`finding=${encodeURIComponent(finding.id)}`));
      await read('findings', { task, threshold: 'rework=1' }, 400);

      const at = analysisAtViewSchema.parse(await read('at', { task, at: instant(20) }));
      assert.deepEqual(at.runs.map(item => [item.run, item.current.map(current => current.step)]), [[run, [0]]]);
      // The values then are the ones task values --at reads for the same instant.
      const valuesUrl = new URL(commandPath('task/values'), app.url);
      valuesUrl.search = new URLSearchParams({ task, at: instant(20) }).toString();
      const then = await (await fetch(valuesUrl)).json();
      assert.deepEqual([at.values, at.valuesReason], [then.values, then.reason ?? null]);
      await read('at', { task: 'T999999', at: instant(20) }, 404);

      // The trace's waits are the counts' waits: for a top-level task, the same numbers whatever the scope.
      const counted = analysisUnitValuesSchema.parse(await read('task', { task: top, timeZone: 'UTC' }));
      assert.ok(counted.time.review > 0 && counted.waits.away + counted.waits.otherTasks + counted.waits.thisTask > 0);
      for (const scope of ['self', 'subtree']) {
        const traced = analysisTraceViewSchema.parse(await read('trace', { task: top, scope, limit: '1' }));
        assert.deepEqual([traced.time, traced.waits], [{ review: counted.time.review, answer: counted.time.answer }, counted.waits], scope);
      }

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
