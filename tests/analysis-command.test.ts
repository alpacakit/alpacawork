import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ChangeLog, controlDatabasePath, keepControlChanges, keepControlTables, ControlStore, touch } from '@alpacawork/db';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { commandPath } from '@alpacawork/contract/command-path';
import { analysisTasksViewSchema, analysisUnitValuesSchema, analysisUsageViewSchema, analysisUsageSeriesViewSchema,
  type AnalysisTasksView, type AnalysisUnitList, type AnalysisUnitValues, type AnalysisUsageView } from '@alpacawork/contract/analysis';
import { AnalysisReader, analysisKept } from '@alpacawork/backend/test-dist/analysis/reads.js';
import { openTallyScope } from '@alpacawork/backend/test-dist/analysis/tally-scope.js';
import { setAnalysisSlice } from '@alpacawork/backend/test-dist/analysis/slices.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TALLY_VERSION } from '@alpacawork/backend/test-dist/agents/adapters/tally.js';
import { patchTask } from '../e2e/fixture/task-state.ts';
import { inertFixtureLaunch } from './helpers/agent-stub.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

const rowId = (n: number) => 'T' + n;
const project = 'P' + 1;
const actor = { kind: 'human' } as const;
const instant = (second: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString();
const tallySince = instant(0);
const link = 'https://github.com/fictional/app/pull/1';

function setup(root: string) {
  const db = new DatabaseSync(controlDatabasePath(root), { enableForeignKeyConstraints: true });
  try {
    db.exec('BEGIN');
    const insert = db.prepare("INSERT INTO task_log(id,task_id,ordinal,entry) SELECT ?,?,coalesce(max(ordinal),-1)+1,? FROM task_log WHERE task_id=?");
    for (const n of [2, 3]) {
      const external = rowId(n), row = db.prepare('SELECT id FROM tasks WHERE external_id=?').get(external)!;
      db.prepare("UPDATE tasks SET user_requested=1,base_state='done',lifecycle=? WHERE id=?").run(n === 3 ? 'archived' : 'active', row.id);
      if (n === 2) {
        db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at,ended_at)
          VALUES('analysis-released-member',?,'fixture-agent','fixture',0,2,?,?)`).run(external, instant(10), instant(20));
        const milestones = [
          { id: 'analysis-start', kind: 'linked', at: instant(10), actor, fromState: 'todo', toState: 'doing' },
          { id: 'analysis-question', kind: 'asked', at: instant(15), askedTo: null, decide: [{ title: 'Choose a synthetic option' }],
            actor: { kind: 'placement', placementId: 'fixture-placement-2' }, fromState: null, toState: null,
            title: 'Synthetic question', description: 'A fixture question' },
          { id: 'analysis-answer', kind: 'answered', at: instant(20), questionId: 'analysis-question',
            actor, fromState: null, toState: null },
          { id: 'analysis-submit', kind: 'reported', at: instant(25), actor, fromState: 'doing', toState: 'waiting' },
        ];
        for (const event of milestones) insert.run(event.id, row.id, JSON.stringify({ title: null, description: null, ...event }), row.id);
        db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)').run('analysis-answer', 'analysis-question');
        db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)').run('analysis-answer', 'A fixture answer');
      }
      const id = 'analysis-accept-' + n;
      const acceptedAt = instant(n === 2 ? 32 : 86_433);
      insert.run(id, row.id, JSON.stringify({ id, kind: 'review_approved', at: acceptedAt, title: null, description: null,
        actor, fromState: 'waiting', toState: 'done' }), row.id);
      db.prepare("UPDATE task_values SET value=? WHERE task_id=? AND field_id='notes'").run(JSON.stringify(link), row.id);
    }
    const deletedChild = db.prepare("UPDATE tasks SET lifecycle='deleted' WHERE external_id=? RETURNING id").get(rowId(5))!;
    const deletedQuestion = { id: 'deleted-question', kind: 'asked', at: instant(24), askedTo: null,
      decide: [{ title: 'Choose a synthetic option' }], actor: { kind: 'placement', placementId: 'fixture-placement-5' },
      fromState: null, toState: null, title: 'Question from a deleted child', description: 'A synthetic question on the deleted task.' };
    insert.run(deletedQuestion.id, deletedChild.id, JSON.stringify(deletedQuestion), deletedChild.id);
    for (const id of [1, 2, 3, 4]) {
      const record = JSON.parse(String(db.prepare('SELECT record FROM runs WHERE id=?').get(id)!.record));
      record.pids = { agent: 1000 + id, manager: 2000 + id };
      record.session = { provider: 'fixture', id: 'synthetic-session-' + id };
      if (id === 2) record.agent = 'unknown';
      const models = [{ model: 'example-v1', effort: 'high' }, { effort: 'high' },
        { model: 'example', effort: 'medium' }, { model: 'example' }];
      record.launch = inertFixtureLaunch('codex', models[id - 1]!);
      if (id === 1) record.started_at = instant(-86_400);
      if (id === 2) record.started_at = instant(-1);
      if (id === 4) record.started_at = instant(23);
      record.ended_at = instant(id === 1 ? 21 - 86_400 : id === 4 ? 25 : 20 + id);
      record.usage = { includesEarlier: id === 1, conversation: null, run: { input: 10, output: id, cacheRead: 2, cacheWrite: 3 } };
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), id);
    }
    db.prepare("UPDATE runs SET record=json_set(record,'$.ended_at',?) WHERE id=6").run(instant(120));
    db.exec('COMMIT');
  } finally { db.close(); }

  const folder = runFolder(root, 'R1');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, RUN_FILES.stdout), JSON.stringify({ type: 'item.started', item: { id: 'example', type: 'command_execution',
    command: 'cat /fictional/skills/example/SKILL.md' } }) + '\n');
  writeFileSync(join(folder, RUN_FILES.tally), JSON.stringify({
    v: TALLY_VERSION - 1, provider: 'fixture', model: null, tools: { command_execution: 1 }, mcp: {}, skills: {},
    subagentTools: 0, state: 'complete',
  }));
  const crossing = runFolder(root, 'R2');
  mkdirSync(crossing, { recursive: true });
  writeFileSync(join(crossing, RUN_FILES.tally), JSON.stringify({
    v: TALLY_VERSION, provider: 'fixture', model: null, tools: { crossing: 1 }, mcp: {}, skills: {},
    subagentTools: 0, state: 'complete',
  }));
  const recent = runFolder(root, 'R4');
  mkdirSync(recent, { recursive: true });
  writeFileSync(join(recent, RUN_FILES.stdout), [
    { type: 'item.completed', item: { id: 'config', type: 'agent_configuration', model: 'example-v2' } },
    { type: 'item.started', item: { id: 'recent', type: 'command_execution', command: 'cat /fictional/skills/recent/SKILL.md' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const cached = runFolder(root, 'R3');
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, RUN_FILES.tally), JSON.stringify({
    v: TALLY_VERSION, provider: 'fixture', model: 'example-v1', tools: { image_view: 2, read: 1 },
    mcp: { 'fixture:notes': 2, 'fixture:search': 1 }, skills: { one: { call: 1, read: 0 }, two: { call: 0, read: 1 } },
    subagentTools: 0, state: 'complete',
  }));
}

test('analysis commands share selection, contribution and tally rules over a small synthetic workspace', { timeout: 30_000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'analysis-command-'));
  const root = join(temp, 'workspace');
  let original: string | undefined, rootCreated = false;
  try {
    original = createOriginal({ ...profiles.small, seed: 'analysis-command' }, join(temp, 'cache')).root;
    copyWorkspace(original, root);
    rootCreated = true;
    setup(root);
    const clock = t.mock.method(Date, 'now', () => Date.parse(tallySince));
    try { assert.equal(openTallyScope(root), Date.parse(tallySince)); }
    finally { clock.mock.restore(); }
    const app = await startServer(root, 0);
    try {
      const { ALPACAWORK_RUN: _run, ALPACAWORK_RUN_TOKEN: _token, ...env } = process.env;
      const read = async <T>(verb: string, params: Record<string, string>): Promise<T> => {
        const url = new URL(commandPath('analysis/' + verb), app.url);
        url.search = new URLSearchParams(params).toString();
        const response = await fetch(url);
        const data = await response.json();
        assert.equal(response.status, 200, JSON.stringify(data));
        return data as T;
      };
      const base = { period: 'all', timeZone: 'UTC' }, trend = { ...base, bucket: 'week' };
      const tasks = await read<AnalysisTasksView>('tasks', { ...trend, by: 'project' });
      assert.deepEqual(tasks.counts.value, { passed: 2, reworked: 0, stopped: 0, doneUnaccepted: 0, accepted: 2, finished: 2, share: null });
      assert.equal(tasks.accepted.value.prs, 1);
      assert.equal(tasks.accepted.value.questions, 1);
      assert.equal(tasks.accepted.value.submits, 1);
      const { submits, questions, time } = tasks.accepted.value;
      for (const [value, expected] of Object.entries({ submits, questions, you: time.review + time.answer, ai: time.ai, other: time.other })) {
        const result = await read<AnalysisUnitList>('list', { ...base, set: 'accepted', value });
        assert.equal(result.rows.reduce((sum, row) => sum + (row.value ?? 0), 0), expected, value);
      }
      const acceptanceRange = { from: '2026-09-25', to: '2026-09-26', timeZone: 'UTC', bucket: 'day' };
      const daily = await read<AnalysisTasksView>('tasks', acceptanceRange);
      const points = daily.series.points.filter(point => point.from >= acceptanceRange.from && point.to <= acceptanceRange.to);
      assert.deepEqual(points.map(point => point.counts.accepted), [1, 1]);
      const accepted = points.map(point => point.accepted);
      for (const key of ['submits', 'questions'] as const)
        assert.equal(accepted.reduce((sum, point) => sum + point[key], 0), daily.accepted.value[key]);
      for (const key of ['review', 'answer', 'ai', 'other'] as const)
        assert.equal(accepted.reduce((sum, point) => sum + point.time[key], 0), daily.accepted.value.time[key]);
      await t.test('related PR lists add up to the period total and each trend bucket', async () => {
        assert.deepEqual(accepted.map(point => point.prs), [1, 0]);
        const prList = ({ from, to }: { from: string; to: string }) => read<AnalysisUnitList>('list', {
          from, to, timeZone: acceptanceRange.timeZone, set: 'accepted', value: 'prs',
        });
        const total = (list: AnalysisUnitList) => list.rows.reduce((sum, row) => sum + row.value!, 0);
        assert.equal(total(await prList(acceptanceRange)), daily.accepted.value.prs);
        for (const [index, point] of points.entries()) {
          const list = await prList(point);
          assert.equal(total(list), point.accepted.prs, point.from);
          assert.deepEqual(list.rows.map(row => [row.id, row.value]), index === 0 ? [[rowId(2), 1]] : []);
        }
        const laterRange = { ...acceptanceRange, from: acceptanceRange.to };
        const later = await read<AnalysisTasksView>('tasks', laterRange);
        assert.equal(later.accepted.value.prs, 0);
        assert.equal(later.accepted.previous?.prs, 1);
        assert.equal(later.ever?.accepted.prs, 1);
        const detail = await read<AnalysisUnitValues>('task', { task: rowId(3), timeZone: 'UTC' });
        assert.deepEqual(detail.prs, [link]);
      });
      const lead = await read<AnalysisUnitList>('list', { from: acceptanceRange.from, to: acceptanceRange.to,
        timeZone: 'UTC', set: 'accepted', value: 'lead' });
      const medians = accepted.map(point => point.leadMedianMs);
      assert.deepEqual(medians, [rowId(2), rowId(3)].map(id => lead.rows.find(row => row.id === id)!.value));
      assert.equal(daily.accepted.value.leadMedianMs, (medians[0]! + medians[1]!) / 2);
      assert.deepEqual(daily.series.points.find(point => point.from === '2026-09-24')?.accepted,
        { leadMedianMs: null, submits: 0, questions: 0, prs: 0, time: { review: 0, answer: 0, ai: 0, other: 0 },
          waits: { away: 0, otherTasks: 0, thisTask: 0 }, answerItems: { total: 0, choice: 0, recommended: 0, recommendable: 0, other: 0, stop: 0, unmatched: 0 }, answersWithoutParts: 0, instructions: { total: 0, unlabeled: 0, kinds: [], fixes: [] }, questionsReplaced: 0, noQuestions: 0, passedNoQuestions: 0, submitsEstimated: 0 });
      assert.equal(tasks.grass.finished.reduce((a, b) => a + b, 0), 2);
      for (const set of ['passed', 'reworked', 'stopped', 'doneUnaccepted', 'accepted', 'finished'] as const)
        assert.equal((await read<AnalysisUnitList>('list', { ...base, set })).total, tasks.counts.value[set]);
      assert.equal((await read<AnalysisUnitList>('list', { ...base, set: 'unfinished' })).total, tasks.unfinished.tasks);
      const projectRows = await read<AnalysisUnitList>('list', { ...base, set: 'passed', by: 'project', key: project, limit: '1' });
      assert.equal(projectRows.total, 2);
      assert.ok(projectRows.cursor);
      const projectPage = await read<AnalysisUnitList>('list', { ...base, set: 'passed', by: 'project', key: project, cursor: projectRows.cursor!, limit: '1' });
      assert.notEqual(projectPage.rows[0]!.id, projectRows.rows[0]!.id);
      const links = await read<AnalysisUnitList>('list', { ...base, set: 'accepted', value: 'prs' });
      assert.deepEqual(links.rows.map(r => [r.id, r.value]), [[rowId(2), 1]]);
      const detail = await read<AnalysisUnitValues>('task', { task: rowId(4), timeZone: 'UTC' });
      assert.equal(detail.unit.id, rowId(2));
      assert.equal(detail.unit.asked, rowId(4));
      assert.deepEqual(detail.prs, [link]);
      assert.equal(detail.questions, 1);
      assert.equal(detail.answers, 1);
      assert.equal(detail.time.ai, 10_000);
      assert.equal(detail.workers, 1);
      assert.ok(detail.children > 0);
      await t.test('the finished row and analysis detail include a deleted child’s elapsed time and tokens', async () => {
        const projection = await readWorkspaceProjection(root);
        const row = projection.finished(null, project).rows.find(candidate => candidate.id === detail.unit.id);
        assert.ok(row?.usage?.tokens && row.usageBelow);
        const { usage: own, usageBelow: below } = row;
        assert.equal(detail.usage.launches, 3);
        assert.equal(detail.usage.runMs, 46_000);
        assert.equal(detail.usage.tokens.output, 8);
        assert.deepEqual({
          launches: own.runs + below.runs,
          runMs: own.runMs + below.runMs,
          output: own.tokens!.output + (below.tokens?.output ?? 0),
          input: own.tokens!.input + (below.tokens?.input ?? 0),
          cache: own.tokens!.cacheRead + own.tokens!.cacheWrite + (below.tokens?.cacheRead ?? 0) + (below.tokens?.cacheWrite ?? 0),
          tokensUnknown: own.tokensUnknown + below.tokensUnknown,
        }, { launches: detail.usage.launches, runMs: detail.usage.runMs, ...detail.usage.tokens,
          tokensUnknown: detail.usage.tokensUnknown });
      });

      const custom = { from: '2026-08-25', to: '2026-09-24', timeZone: 'UTC', bucket: 'month' };
      const [customTasks, customUsage] = await Promise.all([
        read<AnalysisTasksView>('tasks', custom), read<AnalysisUsageView>('usage', { ...custom, view: 'history' }),
      ]);
      assert.deepEqual(customTasks.head.period, { from: custom.from, to: custom.to });
      assert.deepEqual(customUsage.head, customTasks.head);
      assert.equal(customTasks.counts.value.finished, 0);
      assert.equal(customUsage.counts.value.launches, 2);

      const usage = await read<AnalysisUsageView>('usage', { ...trend, by: 'agent' });
      const counts = usage.counts.value;
      assert.equal(counts.launches, 4);
      assert.equal(counts.tasks, 2);
      assert.equal(counts.runMs, 69_000);
      assert.deepEqual(counts.tokens, { input: 40, output: 10, cache: 20 });
      assert.deepEqual(customTasks.ever, { counts: tasks.counts.value, accepted: tasks.accepted.value });
      assert.deepEqual(customUsage.ever, counts);
      assert.deepEqual(usage.breakdown && { since: usage.breakdown.since, counted: usage.breakdown.counted, series: usage.breakdown.series },
        { since: null, counted: null, series: null });
      assert.equal((await read<AnalysisUnitList>('list', { ...base, set: 'used' })).total, counts.tasks);
      for (const [value, expected] of Object.entries({ launches: counts.launches, runMs: counts.runMs,
        newConversations: counts.newConversations, ...counts.tokens, tokens: counts.tokens.output + counts.tokens.input + counts.tokens.cache })) {
        const result = await read<AnalysisUnitList>('list', { ...base, set: 'used', value });
        assert.equal(result.rows.reduce((sum, row) => sum + (row.value ?? 0), 0), expected, value);
      }

      // Wait for the worker to recover tallies, including the Run that started exactly at the collection cutoff.
      let localTools: AnalysisUsageView | undefined;
      for (let tries = 0; tries < 80; tries++) {
        localTools = await read<AnalysisUsageView>('usage', { ...trend, by: 'tool', timeZone: 'America/Los_Angeles' });
        if (localTools.breakdown?.rows.some(row => row.key === JSON.stringify(['fixture', 'command_execution']))) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(localTools?.breakdown?.since, '2026-09-24');
      assert.deepEqual(localTools?.breakdown?.counted?.value, { calls: 4, launches: 2 });
      await t.test('model series, period rows and drill-down agree across efforts and channels', async () => {
        const by = 'model';
        const [usageView, taskView, detailView] = await Promise.all([
          read('usage', { ...trend, by }),
          read('tasks', { ...trend, by }),
          read('task', { task: rowId(2), timeZone: 'UTC' }),
        ]);
        const usageRows = analysisUsageViewSchema.parse(usageView).breakdown!.rows;
        const taskRows = analysisTasksViewSchema.parse(taskView).breakdown!.rows;
        const models = analysisUnitValuesSchema.parse(detailView).models;
        const example = { name: 'example-v1', effort: 'high' };
        const fallback = { name: 'unknown', effort: null };
        const version1 = { name: 'example-v1', effort: 'medium' };
        const version2 = { name: 'example-v2', effort: null };
        assert.deepEqual(usageRows.map(row => [row.model, row.counts.launches]), [
          [{ name: 'example-v1' }, 2], [{ name: version2.name }, 1], [{ name: fallback.name }, 1],
        ]);
        assert.deepEqual(new Set(taskRows.map(row => row.model)), new Set([example, fallback]));
        assert.deepEqual(new Set(models.map(row => [row.model, row.label, row.launches])), new Set([
          [example, 'example-v1(high)', 1], [version1, 'example-v1(medium)', 1], [version2, 'example-v2', 1],
        ]));

        const range = { from: '2026-09-24', to: '2026-09-27', timeZone: 'UTC', bucket: 'day' };
        const readSeries = async (params: Record<string, string>) => analysisUsageSeriesViewSchema.parse(await read('usage-series', params));
        const series = await readSeries({ ...range, by });
        assert.deepEqual(series.metric, { id: 'launches', unit: 'runs', aggregation: 'sum' });
        assert.equal(series.total, 4);
        assert.deepEqual(series.groups.map(group => [group.key, group.total]), usageRows.map(row => [row.key, row.counts.launches]));
        assert.equal(series.points.at(-1)?.total, 0);
        assert.deepEqual(series.points.at(-1)?.counts, []);
        assert.equal(series.points.reduce((sum, point) => sum + point.total, 0), series.total);
        const card = await read<AnalysisUsageView>('usage', { ...range, by, view: 'summary' });
        assert.deepEqual(card.breakdown?.rows[0], usageRows[0]);
        assert.deepEqual(card.counts.value, (await read<AnalysisUsageView>('usage', { ...range, by })).counts.value);
        const cardScope = { ...range, project, by };
        const firstCard = await read<AnalysisUsageView>('usage', { ...cardScope, view: 'summary' });
        const cardHistory = await read<AnalysisUsageView>('usage', { ...cardScope, view: 'history' });
        assert.deepEqual(firstCard.counts, cardHistory.counts);
        assert.deepEqual(firstCard.breakdown, cardHistory.breakdown);
        for (const point of series.points) {
          assert.equal(point.counts.reduce((sum, [, count]) => sum + count, 0), point.total);
          for (const [index, count] of point.counts) {
            const list = await read<AnalysisUnitList>('list', { from: point.from, to: point.to, timeZone: 'UTC',
              set: 'used', value: 'launches', by, key: series.groups[index]!.key });
            assert.equal(list.rows.reduce((sum, row) => sum + row.value!, 0), count);
          }
        }
        const cross = { ...range, by: 'effort', model: 'example-v1', effort: 'medium', bucket: 'week' };
        const filtered = await readSeries(cross);
        assert.deepEqual(filtered.groups.map(group => [group.value, group.total]), [['medium', 1]]);
        assert.deepEqual(filtered.points.map(({ from, to, complete }) => [from, to, complete]), [['2026-09-24', '2026-09-27', false]]);
        const usage = await read<AnalysisUsageView>('usage', { ...cross, view: 'summary' });
        assert.equal(usage.counts.value.launches, filtered.total);
        assert.equal(usage.breakdown?.rows[0]?.effort, 'medium');
        assert.deepEqual(usage.series.points, []);
        assert.equal(usage.ever, null);
        const measured = await read<AnalysisUsageView>('usage', cross);
        assert.deepEqual(measured.counts, usage.counts);
        assert.deepEqual(measured.series.points.map(point => [point.from, point.to, point.counts.launches]),
          filtered.points.map(point => [point.from, point.to, point.total]));
        const history = await read<AnalysisUsageView>('usage', { ...cross, view: 'history' });
        assert.deepEqual(history.counts, measured.counts);
        assert.ok(history.series.points.length > measured.series.points.length);
        assert.ok(history.ever);
        const filteredList = await read<AnalysisUnitList>('list', { from: cross.from, to: cross.to, timeZone: cross.timeZone,
          set: 'used', value: 'launches', by: cross.by, key: filtered.groups[0]!.key, model: cross.model, effort: cross.effort });
        assert.equal(filteredList.rows.reduce((sum, row) => sum + row.value!, 0), filtered.total);
        const monthly = await readSeries({ ...range, by: 'effort', bucket: 'month' });
        assert.equal(monthly.total, series.total);
        assert.equal(monthly.points[0]?.complete, false);
        assert.deepEqual(monthly.groups.map(group => [group.value, group.total]), [['high', 2], ['medium', 1], [null, 1]]);
        const missing = await readSeries({ ...range, by: 'effort', effortMissing: 'true' });
        assert.deepEqual(missing.groups.map(group => [group.value, group.total]), [[null, 1]]);
        const unknown = await readSeries({ ...range, by: 'effort', model: 'unknown' });
        assert.deepEqual(unknown.groups.map(group => [group.value, group.total]), [['high', 1]]);
        const invalid = new URL(commandPath('analysis/usage-series'), app.url);
        invalid.search = new URLSearchParams({ ...cross, effortMissing: 'true' }).toString();
        assert.equal((await fetch(invalid)).status, 400);
        invalid.search = new URLSearchParams({ ...cross, to: '9999-12-31' }).toString();
        assert.equal((await fetch(invalid)).status, 400);
        const { stdout } = await promisify(execFile)(process.execPath,
          ['apps/cli/dist/cli.js', '--server', app.url,
            'analysis', 'usage-series', '--from', cross.from, '--to', cross.to, '--time-zone', cross.timeZone,
            '--bucket', cross.bucket, '--by', cross.by, '--model', cross.model, '--effort', cross.effort], { env });
        assert.deepEqual(JSON.parse(stdout), filtered);
        const help = await promisify(execFile)(process.execPath, ['apps/cli/dist/cli.js', 'analysis', 'usage-series', '--help'], { env });
        assert.match(help.stdout, /--effort-missing/);
        assert.match(help.stdout, /Access/);
        for (const { key, counts: { launches, runMs, newConversations, tokens } } of usageRows) {
          for (const [value, expected] of Object.entries({ launches, runMs, newConversations, ...tokens,
            tokens: tokens.output + tokens.input + tokens.cache })) {
            const list = await read<AnalysisUnitList>('list', { ...base, set: 'used', by, key, value });
            assert.equal(list.rows.reduce((sum, row) => sum + row.value!, 0), expected, value);
          }
        }
        for (const taskRow of taskRows) {
          for (const set of ['finished', 'accepted', 'passed'] as const) {
            const list = await read<AnalysisUnitList>('list', { ...base, set, by, key: taskRow.key });
            assert.equal(list.total, taskRow[set], set);
          }
        }
      });
      const tools = await read<AnalysisUsageView>('usage', { ...trend, by: 'tool' });
      const tool = tools?.breakdown?.rows.find(row => row.key === JSON.stringify(['fixture', 'command_execution']));
      assert.equal(tool?.calls, 1);
      assert.equal(tools?.breakdown?.rows.find(row => row.key === JSON.stringify(['fixture', 'image_view']))?.calls, 2);
      const toolTotals = { calls: 4, launches: 2 };
      assert.equal(tools?.breakdown?.since, '2026-09-25');
      assert.deepEqual(tools?.breakdown?.counted, { value: toolTotals, previous: null });
      assert.deepEqual(tools?.breakdown?.series?.[0], toolTotals);
      const crossingKey = JSON.stringify(['fixture', 'crossing']);
      assert.ok(!tools?.breakdown?.rows.some(row => row.key === crossingKey));
      const split = await read<AnalysisUsageView>('usage', { ...acceptanceRange, from: '2026-09-26', to: '2026-09-27', by: 'tool', view: 'history' });
      assert.ok(split.head.previous);
      assert.deepEqual(split.breakdown?.counted, { value: { calls: 0, launches: 0 }, previous: null });
      assert.deepEqual(split.breakdown?.series?.slice(0, 3), [null, toolTotals, { calls: 0, launches: 0 }]);
      for (const [view, points] of [['period', 2], ['summary', 0]] as const) {
        const projected = await read<{ breakdown: NonNullable<AnalysisUsageView['breakdown']> }>('breakdown', {
          ...acceptanceRange, from: '2026-09-26', to: '2026-09-27', look: 'usage', by: 'tool', view,
        });
        assert.equal(projected.breakdown.series?.length, points);
        assert.deepEqual(projected.breakdown.rows, split.breakdown?.rows);
      }
      const after = await read<AnalysisUsageView>('usage', { ...acceptanceRange, from: '2026-09-27', to: '2026-09-28', by: 'tool' });
      assert.deepEqual(after.breakdown?.counted?.previous, toolTotals);
      const [skill, mcp] = await Promise.all([read<AnalysisUsageView>('usage', { ...trend, by: 'skill' }),
        read<AnalysisUsageView>('usage', { ...trend, by: 'mcp' })]);
      assert.deepEqual(skill.breakdown?.counted?.value, { calls: 0, launches: 2 });
      assert.deepEqual(mcp.breakdown?.counted?.value, { calls: 3, launches: 1 });
      await t.test('lists without a key add up to each collected usage total', async () => {
        for (const [by, view, values] of [
          ['skill', skill, ['launches']],
          ['tool', tools, ['calls', 'launches']],
          ['mcp', mcp, ['calls', 'launches']],
        ] as const) {
          const total = view.breakdown?.counted?.value;
          assert.ok(total);
          for (const value of values) {
            const list = await read<AnalysisUnitList>('list', { ...base, set: 'used', by, value });
            assert.deepEqual(list.rows.map(row => [row.id, row.value]), [[rowId(2), total[value]]], `${by} ${value}`);
          }
        }
      });
      const counted = await read<AnalysisUnitList>('list', { ...base, set: 'used', by: 'tool', key: tool!.key, value: 'calls' });
      assert.equal(counted.rows[0]?.value, 1);
      const early = await read<AnalysisUnitList>('list', { from: '2026-09-24', to: '2026-09-24', timeZone: 'UTC',
        set: 'used', by: 'tool', key: crossingKey, value: 'calls' });
      assert.equal(early.total, 0);
      await t.test('a Run started before collection is excluded from tool totals, lists and task detail', async () => {
        for (const timeZone of ['UTC', 'America/Los_Angeles']) {
          const [aggregate, list, unit] = await Promise.all([
            read<AnalysisUsageView>('usage', { ...trend, by: 'tool', timeZone }),
            read<AnalysisUnitList>('list', { ...base, set: 'used', by: 'tool', key: crossingKey, value: 'calls', timeZone }),
            read<AnalysisUnitValues>('task', { task: rowId(3), timeZone }),
          ]);
          assert.ok(!aggregate.breakdown?.rows.some(row => row.key === crossingKey), timeZone);
          assert.equal(list.total, 0, timeZone);
          assert.deepEqual(unit.tools, [], timeZone);
          assert.deepEqual(unit.tallied, { runs: 0, of: 0, since: aggregate.breakdown?.since }, timeZone);
        }
      });
      const older = JSON.parse(readFileSync(join(runFolder(root, 'R1'), RUN_FILES.tally), 'utf8'));
      assert.equal(older.v, TALLY_VERSION - 1);
      const saved = JSON.parse(readFileSync(join(runFolder(root, 'R4'), RUN_FILES.tally), 'utf8'));
      assert.equal(saved.v, TALLY_VERSION);
      assert.deepEqual(saved.skills, { recent: { call: 0, read: 1 } });
      assert.equal(saved.tools.command_execution, 1);

      const { stdout } = await promisify(execFile)(process.execPath,
        ['apps/cli/dist/cli.js', 'analysis', 'tasks', '--period', 'all', '--bucket', 'week', '--by', 'project', '--time-zone', 'UTC'],
        { env: { ...env, ALPACAWORK_SERVER: app.url } });
      assert.deepEqual(JSON.parse(stdout), tasks);
    } finally { await app.close(); }

    const { tasks: [task] } = await new ControlTaskCommands(root, actor).create({
      parentId: project, userRequested: true, tasks: [{ title: 'Awaiting a synthetic acceptance' }],
    });
    const id = task!.id;
    patchTask(root, id, { state: 'waiting', logs: [{ id: randomUUID(), kind: 'reported', at: new Date().toISOString(),
      actor, fromState: 'doing', toState: 'waiting', title: 'Ready for review', description: null }] });
    const shown = await new ControlTaskStore(root).get(id);

    const journal = new ChangeLog(), changes = keepControlChanges(root, journal), tables = keepControlTables(root);
    const reader = new AnalysisReader(root, Date.parse(tallySince), journal);
    const store = new ControlStore(root, { busyTimeoutMs: 1000 });
    try {
      const params = { period: 'all', bucket: 'week' } as const;
      assert.equal((await reader.tasks(params, actor)).counts.value.accepted, 2);
      assert.deepEqual((await reader.usage({ ...params, by: 'tool' }, actor)).breakdown,
        { by: 'tool', since: null, counted: null, series: null, rows: [] });
      await t.test('a late tally updates the first owner model without a change to cached Run facts', async t => {
        store.write(() => {
          store.connection.prepare("UPDATE runs SET record=json_set(record,'$.started_at',?) WHERE id=2").run(tallySince);
          touch(store.connection, { kind: 'run', id: 'R2' });
        });
        const by = 'model';
        const before = (await reader.tasks({ ...params, by }, actor)).breakdown!.rows.find(row => row.model?.name === 'unknown')!;
        assert.equal(before.finished, 1);
        t.after(() => { reader.updateTallies([['R2', null]]); });
        const tally = { v: TALLY_VERSION, provider: 'fixture', model: 'example-default', tools: {}, mcp: {}, skills: {},
          subagentTools: 0, state: 'complete' } as const;
        reader.updateTallies([['R2', tally]]);
        const rows = (await reader.tasks({ ...params, by }, actor)).breakdown!.rows;
        assert.ok(rows.every(row => row.key !== before.key));
        const reported = rows.find(row => row.model?.name === 'example-default')!;
        assert.equal(reported.model?.effort, 'high');
        const usage = (await reader.usage({ ...params, by }, actor)).breakdown!.rows.find(row => row.model?.name === 'example-default');
        assert.equal(usage?.counts.launches, 1);
        const series = () => reader.usageSeries({ ...params, by }, actor);
        assert.equal((await series()).groups.find(group => group.value === 'example-default')?.total, 1);
        reader.updateTallies([['R2', { ...tally, model: 'example-updated' }]]);
        const changed = await series();
        assert.equal(changed.groups.find(group => group.value === 'example-updated')?.total, 1);
        assert.ok(!changed.groups.some(group => group.value === 'example-default'));
        const changedTask = (await reader.tasks({ ...params, by }, actor)).breakdown!.rows.find(row => row.model?.name === 'example-updated')!;
        const list = (await reader.list({ period: 'all', set: 'finished', by, key: changedTask.key }, actor));
        assert.deepEqual(list.rows.map(row => row.id), [rowId(3)]);
      });
      const caller = { kind: 'run', taskId: rowId(2), runId: 'R1', placementId: 'fixture-placement-2',
        role: 'owner', responsible: true } as const;
      assert.equal((await reader.tasks(params, caller)).head.project, project);
      await assert.rejects(reader.tasks({ ...params, project: 'P' + 9 }, caller), /own project/);
      store.write(() => {
        store.connection.prepare('UPDATE tasks SET user_requested=0 WHERE external_id=?').run(rowId(2));
        touch(store.connection, { kind: 'task', id: rowId(2) });
      });
      assert.equal((await reader.tasks(params, actor)).counts.value.accepted, 1);
      assert.equal((await reader.usage(params, actor)).counts.value.launches, 4);
      await t.test('the next analysis read sees a committed acceptance without an owner Run in its own row', async () => {
        assert.equal((await reader.tasks(params, actor)).counts.value.accepted, 1);
        const committed = await new TaskReportService(root).report({ task: id, state: 'done', opId: randomUUID(),
          expectedTaskHash: shown.hash, title: 'Accepted', description: 'Accepted synthetic work.' }, actor, actor);
        assert.equal(committed.task.state, 'done');
        assert.equal((await reader.tasks(params, actor)).counts.value.accepted, 2);
        for (const by of ['model', 'agent'] as const) {
          const rows = analysisTasksViewSchema.parse((await reader.tasks({ ...params, by }, actor))).breakdown!.rows;
          assert.equal(rows.length, 2);
          const withoutOwner = rows.find(row => row.noOwnerRun === true);
          const named = rows.find(row => row.label === 'unknown');
          assert.ok(withoutOwner && named, by);
          assert.equal(withoutOwner.model, undefined, by);
          assert.equal(named.noOwnerRun, undefined, by);
          assert.notEqual(withoutOwner.key, named.key, by);
          for (const [dimension, taskId] of [[withoutOwner, id], [named, rowId(3)]] as const) {
            const list = (await reader.list({ period: 'all', set: 'finished', by, key: dimension.key }, actor));
            assert.equal(list.total, dimension.finished, by);
            assert.deepEqual(list.rows.map(row => row.id), [taskId], by);
          }
        }
      });
      store.write(() => {
        store.connection.prepare("UPDATE tasks SET lifecycle='deleted' WHERE external_id=?").run(rowId(3));
        touch(store.connection, { kind: 'task', id: rowId(3) });
      });
      assert.equal((await reader.tasks(params, actor)).counts.value.accepted, 1);
      assert.equal((await reader.usage(params, actor)).counts.value.launches, 3);

      // Reading only what changed counts as reading everything again: a Run that starts a conversation earlier than
      // the one that began it, and a Task moved under another unit.
      store.write(() => {
        const record = JSON.parse(String(store.connection.prepare('SELECT record FROM runs WHERE id=5').get()!.record));
        Object.assign(record, { pids: { agent: 1005, manager: 2005 }, session: { provider: 'fixture', id: 'synthetic-session-2' },
          started_at: instant(-5), ended_at: instant(30), usage: { includesEarlier: false, conversation: null, run: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } });
        store.connection.prepare('UPDATE runs SET record=? WHERE id=5').run(JSON.stringify(record));
        touch(store.connection, { kind: 'run', id: 'R5' });
        store.connection.prepare('UPDATE tasks SET parent_id=(SELECT id FROM tasks WHERE external_id=?) WHERE external_id=?').run(rowId(2), rowId(6));
        touch(store.connection, { kind: 'task', id: rowId(6) });
      });
      const whole = new AnalysisReader(root, Date.parse(tallySince));
      try {
        for (const read of [(view: AnalysisReader) => view.tasks({ ...params, by: 'model' }, actor),
          (view: AnalysisReader) => view.usage({ ...params, by: 'model' }, actor),
          (view: AnalysisReader) => view.list({ period: 'all', set: 'used', value: 'newConversations' }, actor),
          (view: AnalysisReader) => view.task({ task: rowId(2) }, actor)])
          assert.deepEqual(await read(reader), await read(whole));
      } finally { whole.close(); }

      // A breakdown alone is the breakdown its look gives.
      for (const [look, by] of [['tasks', 'model'], ['usage', 'model'], ['usage', 'agent'], ['usage', 'tool']] as const) {
        const alone = await reader.breakdown({ ...params, look, by }, actor);
        const full = look === 'tasks' ? await reader.tasks({ ...params, by }, actor) : await reader.usage({ ...params, by }, actor);
        assert.deepEqual(alone, { head: full.head, breakdown: { look, ...full.breakdown } }, `${look} ${by}`);
      }
      // Read in many zones, the analysis keeps only a few of their days.
      for (const timeZone of Intl.supportedValuesOf('timeZone').slice(0, 20))
        await reader.usage({ ...params, by: 'model', timeZone }, actor);
      assert.deepEqual(analysisKept(), { zones: 3, scopes: 3 });
      // Reads taken at once (counts, lists, a task's values, in several zones) answer as they do one by one.
      const reads = ['UTC', 'Asia/Tokyo', 'America/New_York'].flatMap(timeZone => [
        () => reader.usage({ ...params, by: 'model', timeZone }, actor), () => reader.tasks({ ...params, timeZone }, actor),
        () => reader.list({ period: 'all', set: 'used', value: 'tokens', timeZone }, actor), () => reader.task({ task: rowId(2), timeZone }, actor)]);
      const together = await Promise.all(reads.map(read => read()));
      const alone = [];
      for (const read of reads) alone.push(await read());
      assert.deepEqual(together, alone);

      // Writes while reads are under way: each answer is the whole answer of one moment, and the reads after them are
      // what reading everything again gives. Every point a read may give the loop back does (a slice of 0), and the
      // writes come after more and more of those points.
      const reRun = (run: number, session: string, output: number) => {
        const record = JSON.parse(String(store.connection.prepare('SELECT record FROM runs WHERE id=?').get(run)!.record));
        record.session = { provider: 'fixture', id: session };
        record.usage = { ...record.usage, run: { ...record.usage.run, output } };
        store.connection.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), run);
        touch(store.connection, { kind: 'run', id: 'R' + run });
      };
      // A Run's session and its output tokens changed at once, and two Runs changed by two writes.
      const states = [
        [() => store.write(() => reRun(4, 'synthetic-session-1', 4 + 12_345))],
        [() => store.write(() => reRun(4, 'synthetic-session-4', 4))],
        [() => store.write(() => reRun(3, 'synthetic-session-1', 3 + 12_345)), () => store.write(() => reRun(4, 'synthetic-session-1', 4 + 12_345))],
        [() => store.write(() => reRun(3, 'synthetic-session-3', 3)), () => store.write(() => reRun(4, 'synthetic-session-4', 4))],
      ];
      const counted = (view: AnalysisReader) => view.usage({ ...params, by: 'model' }, actor);
      const listed = (view: AnalysisReader) => view.list({ period: 'all', set: 'used', value: 'tokens' }, actor);
      const wholly = async <T>(read: (view: AnalysisReader) => Promise<T>) => {
        const fresh = new AnalysisReader(root, Date.parse(tallySince));
        try { return await read(fresh); } finally { fresh.close(); }
      };
      const turns = (count: number) => (async () => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); })();
      const seen = { counted: new Set<number>(), listed: new Set<number>() };
      let during = 0;
      setAnalysisSlice(0);
      try {
        for (let round = 0; round < 24; round++) {
          const writes = states[round % states.length]!, after = 1 + (round >> 2) * 6;
          const moments = [{ counted: await wholly(counted), listed: await wholly(listed) }];
          // A long count whose facts have a change to read, and a list that waits behind it for the facts.
          store.write(() => touch(store.connection, { kind: 'run', id: 'R1' }));
          let settled = false;
          const counting = counted(reader).finally(() => { settled = true; }), listing = listed(reader);
          for (const write of writes) {
            await turns(after);
            if (!settled) during++;
            write();
            moments.push({ counted: await wholly(counted), listed: await wholly(listed) });
          }
          const [count, list] = await Promise.all([counting, listing]);
          const at = (answer: unknown, kind: 'counted' | 'listed') => {
            const moment = moments.findIndex(each => JSON.stringify(each[kind]) === JSON.stringify(answer));
            assert.notEqual(moment, -1, `round ${round}: the ${kind} answer is no one moment's`);
            seen[kind].add(moment);
          };
          at(count, 'counted'); at(list, 'listed');
          const last = moments.at(-1)!;
          assert.deepEqual(await counted(reader), last.counted, `round ${round}`);
          assert.deepEqual(await listed(reader), last.listed, `round ${round}`);
        }
      } finally { setAnalysisSlice(); }
      // Writes came while reads were under way, and a read waiting its turn answered as of a later moment.
      assert.ok(during > 0 && seen.listed.size > 1, JSON.stringify({ during, counted: [...seen.counted], listed: [...seen.listed] }));
    } finally { store.close(); reader.close(); tables(); changes.close(); }
  } finally {
    if (original) {
      if (rootCreated) removeWorkspace(root);
      removeWorkspace(original);
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
