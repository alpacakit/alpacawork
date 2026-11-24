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
import type { AnalysisTasksView, AnalysisUnitList, AnalysisUnitValues, AnalysisUsageView } from '@alpacawork/contract/analysis';
import { AnalysisReader } from '@alpacawork/backend/test-dist/analysis/reads.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TALLY_VERSION } from '@alpacawork/backend/test-dist/agents/adapters/tally.js';
import { patchTask } from '../e2e/fixture/task-state.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

const rowId = (n: number) => 'T' + n;
const project = 'P' + 1;
const actor = { kind: 'human' } as const;
const instant = (second: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString();
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
      insert.run(id, row.id, JSON.stringify({ id, kind: 'review_approved', at: instant(30 + n), title: null, description: null,
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
      if (id === 4) record.started_at = instant(23);
      record.ended_at = instant(id === 4 ? 25 : 20 + id);
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
  const cached = runFolder(root, 'R3');
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, RUN_FILES.tally), JSON.stringify({
    v: TALLY_VERSION, provider: 'fixture', model: null, tools: { image_view: 2 }, mcp: {}, skills: {},
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
    const app = await startServer(root, 0);
    try {
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
      assert.deepEqual(tasks.counts.value, { passed: 2, reworked: 0, stopped: 0, accepted: 2, finished: 2, share: null });
      assert.equal(tasks.accepted.value.prs, 1);
      assert.equal(tasks.accepted.value.questions, 1);
      assert.equal(tasks.accepted.value.submits, 1);
      const { submits, questions, time } = tasks.accepted.value;
      for (const [value, expected] of Object.entries({ submits, questions, you: time.review + time.answer, ai: time.ai, other: time.other })) {
        const result = await read<AnalysisUnitList>('list', { ...base, set: 'accepted', value });
        assert.equal(result.rows.reduce((sum, row) => sum + (row.value ?? 0), 0), expected, value);
      }
      assert.equal(tasks.grass.finished.reduce((a, b) => a + b, 0), 2);
      for (const set of ['passed', 'reworked', 'stopped', 'accepted', 'finished'] as const)
        assert.equal((await read<AnalysisUnitList>('list', { ...base, set })).total, tasks.counts.value[set]);
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
      assert.equal(detail.time.ai, 8_000);
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
        read<AnalysisTasksView>('tasks', custom), read<AnalysisUsageView>('usage', custom),
      ]);
      assert.deepEqual(customTasks.head.period, { from: custom.from, to: custom.to });
      assert.deepEqual(customUsage.head, customTasks.head);
      assert.equal(customTasks.counts.value.finished, 0);
      assert.equal(customUsage.counts.value.launches, 0);

      const usage = await read<AnalysisUsageView>('usage', { ...trend, by: 'agent' });
      const counts = usage.counts.value;
      assert.equal(counts.launches, 4);
      assert.equal(counts.tasks, 2);
      assert.equal(counts.runMs, 68_000);
      assert.deepEqual(counts.tokens, { input: 40, output: 10, cache: 20 });
      assert.equal((await read<AnalysisUnitList>('list', { ...base, set: 'used' })).total, counts.tasks);
      for (const [value, expected] of Object.entries({ launches: counts.launches, runMs: counts.runMs,
        newConversations: counts.newConversations, ...counts.tokens })) {
        const result = await read<AnalysisUnitList>('list', { ...base, set: 'used', value });
        assert.equal(result.rows.reduce((sum, row) => sum + (row.value ?? 0), 0), expected, value);
      }

      // A startup scan publishes both existing tallies and newly backfilled counts.
      let tools: AnalysisUsageView | undefined;
      for (let tries = 0; tries < 80; tries++) {
        tools = await read<AnalysisUsageView>('usage', { ...trend, by: 'tool' });
        if (tools.breakdown?.tallied?.runs === 2) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const tool = tools?.breakdown?.rows.find(row => row.key === JSON.stringify(['fixture', 'command_execution']));
      assert.equal(tool?.calls, 1);
      assert.equal(tools?.breakdown?.rows.find(row => row.key === JSON.stringify(['fixture', 'image_view']))?.calls, 2);
      assert.deepEqual(tools?.breakdown?.tallied, { runs: 2, of: 4 });
      const counted = await read<AnalysisUnitList>('list', { ...base, set: 'used', by: 'tool', key: tool!.key, value: 'calls' });
      assert.equal(counted.rows[0]?.value, 1);
      const saved = JSON.parse(readFileSync(join(runFolder(root, 'R1'), RUN_FILES.tally), 'utf8'));
      assert.deepEqual(saved.skills, { example: { call: 0, read: 1 } });
      assert.equal(saved.tools.command_execution, 1);

      const { ALPACAWORK_RUN: _run, ALPACAWORK_RUN_TOKEN: _token, ...env } = process.env;
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
    const reader = new AnalysisReader(root, journal);
    const store = new ControlStore(root, { busyTimeoutMs: 1000 });
    try {
      const params = { period: 'all', bucket: 'week' } as const;
      assert.equal(reader.tasks(params, actor).counts.value.accepted, 2);
      const caller = { kind: 'run', taskId: rowId(2), runId: 'R1', placementId: 'fixture-placement-2',
        role: 'owner', responsible: true } as const;
      assert.equal(reader.tasks(params, caller).head.project, project);
      assert.throws(() => reader.tasks({ ...params, project: 'P' + 9 }, caller), /own project/);
      store.write(() => {
        store.connection.prepare('UPDATE tasks SET user_requested=0 WHERE external_id=?').run(rowId(2));
        touch(store.connection, { kind: 'task', id: rowId(2) });
      });
      assert.equal(reader.tasks(params, actor).counts.value.accepted, 1);
      assert.equal(reader.usage(params, actor).counts.value.launches, 4);
      await t.test('the next analysis read sees a committed acceptance', async () => {
        assert.equal(reader.tasks(params, actor).counts.value.accepted, 1);
        const committed = await new TaskReportService(root).report({ task: id, state: 'done', opId: randomUUID(),
          expectedTaskHash: shown.hash, title: 'Accepted', description: 'Accepted synthetic work.' }, actor, actor);
        assert.equal(committed.task.state, 'done');
        assert.equal(reader.tasks(params, actor).counts.value.accepted, 2);
      });
      store.write(() => {
        store.connection.prepare("UPDATE tasks SET lifecycle='deleted' WHERE external_id=?").run(rowId(3));
        touch(store.connection, { kind: 'task', id: rowId(3) });
      });
      assert.equal(reader.tasks(params, actor).counts.value.accepted, 1);
      assert.equal(reader.usage(params, actor).counts.value.launches, 3);
    } finally { store.close(); reader.close(); tables(); changes.close(); }
  } finally {
    if (original) {
      if (rootCreated) removeWorkspace(root);
      removeWorkspace(original);
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
