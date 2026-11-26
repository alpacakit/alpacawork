import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analysisTasksViewSchema } from '@alpacawork/contract/analysis';
import { taskWriteResultSchema } from '@alpacawork/contract/control';
import { commandPath } from '@alpacawork/contract/command-path';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { patchTask } from '../e2e/fixture/task-state.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { cliRun } from './helpers/http-cli.ts';

test('CLI and REST record one analysis subject and show open work within the project', { timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'analysis-subject-'));
  const root = join(temp, 'workspace');
  let original: string | undefined, copied = false;
  try {
    original = createOriginal({ ...profiles.small, seed: 'analysis-subject' }, join(temp, 'cache')).root;
    copyWorkspace(original, root);
    copied = true;
    const actor = { kind: 'human' } as const;
    const commands = new ControlTaskCommands(root, actor);
    const cause = { kind: 'cause', key: 'long-wait' } as const;
    const period = { kind: 'period', from: '2026-11-01', to: '2026-11-07' } as const;
    const aboutTask = { kind: 'task', task: 'T2' } as const;
    const helpers = new ControlTaskStore(root);
    const asking = (await commands.create({ parentId: 'P1', userRequested: false,
      tasks: [{ title: 'Investigate the task', analysisSubject: aboutTask }] })).tasks[0]!;
    const placements = new PlacementStore(root);
    const { placement } = (() => {
      try { return placements.createAndPlace({ taskId: asking.id, profileKey: 'fixture', responsible: true }); }
      finally { placements.close(); }
    })();
    const time = new Date().toISOString();
    patchTask(root, asking.id, { state: 'doing', logs: [{ id: randomUUID(), kind: 'asked', at: time, askedTo: null,
      actor: { kind: 'placement', placementId: placement.id }, title: 'Which cause?', description: 'A synthetic question.',
      fromState: null, toState: null, decide: [{ decide_kind: 'choose', decide_question: 'Which cause?' }] }] });
    const review = (await commands.create({ parentId: 'P1', userRequested: true,
      tasks: [{ title: 'Review the period', analysisSubject: period }] })).tasks[0]!;
    patchTask(root, review.id, { state: 'waiting', logs: [{ id: randomUUID(), kind: 'reported', at: time,
      actor, title: 'Ready for review', description: null, fromState: 'done', toState: 'waiting' }] });
    const server = await startServer(root, 0);
    try {
      const url = (path: string) => new URL(commandPath(path), server.url);
      const save = async (path: string, body: Record<string, unknown>, status = 200) => {
        const response = await commandFetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result;
      };
      const read = async (project: string, dates = 'period=today') => {
        const request = url('analysis/tasks');
        request.search = `project=${project}&bucket=day&${dates}`;
        const response = await fetch(request);
        assert.equal(response.status, 200);
        return analysisTasksViewSchema.parse(await response.json()).activeWork;
      };
      const cli = async (...args: string[]) => {
        const result = await cliRun(server.url, args, { ALPACAWORK_WORKSPACE: root, XDG_CONFIG_HOME: join(temp, 'config'), XDG_STATE_HOME: join(temp, 'state') });
        assert.equal(result.code, 0, result.stderr);
        return JSON.parse(result.stdout);
      };

      const nested = taskWriteResultSchema.parse(await save('task/new', { kind: 'project', parent: 'P1', color: '#39659b', title: 'Nested project' })).task;
      const foreign = taskWriteResultSchema.parse(await save('task/new', { kind: 'project', parent: 'none', color: '#39659b', title: 'Other project' })).task;
      await save('task/new', { parent: foreign.id, title: 'Work in the other project', analysisSubject: cause });
      const first = taskWriteResultSchema.parse(await cli('task', 'new', '--parent', nested.id, '--title', 'Investigate the wait',
        '--no-from-user', '--analysis-subject', JSON.stringify(cause))).task;
      assert.deepEqual(first.analysisSubject, cause);
      const open = [{
        id: review.id, title: review.title, state: 'waiting', analysisSubject: period, userTurn: true,
      }, {
        id: asking.id, title: asking.title, state: 'doing', analysisSubject: aboutTask, userTurn: true,
      }, {
        id: first.id, title: first.title, state: 'todo', analysisSubject: cause, userTurn: false,
      }];
      assert.deepEqual(await read('P1', 'from=2020-01-01&to=2020-01-02'), open);
      assert.deepEqual(await read(nested.id), [open[2]]);
      assert.deepEqual((await cli('analysis', 'tasks', '--period', 'today', '--bucket', 'day', '--project', 'P1')).activeWork, open);

      const input = { task: first.id, expectedTaskHash: first.hash };
      await save('task/update', { ...input, analysisSubject: { ...cause, task: 'T2' } }, 400);
      await save('task/update', { ...input, analysisSubject: { kind: 'cause', key: 'lookfeel' } }, 400);
      await save('task/update', { ...input, analysisSubject: { kind: 'task', task: 'T99999' } }, 404);
      await save('task/update', { ...input, analysisSubject: { ...period, from: '2026-11-08' } }, 400);
      const linked = taskWriteResultSchema.parse(await save('task/update', { ...input, analysisSubject: aboutTask })).task;
      const changed = taskWriteResultSchema.parse(await save('task/update', {
        ...input, expectedTaskHash: linked.hash, analysisSubject: period,
      })).task;
      await save('task/update', { ...input, analysisSubject: null }, 409);
      const renamed = taskWriteResultSchema.parse(await save('task/update', {
        task: first.id, expectedTaskHash: changed.hash, title: 'Compare the period',
      })).task;
      assert.deepEqual((await cli('task', 'get', '--task', first.id)).task.analysisSubject, period);
      assert.deepEqual(await read(nested.id), [{ ...open[2], title: renamed.title, analysisSubject: period }]);

      await cli('task', 'update', '--task', first.id, '--expected-task-hash', renamed.hash, '--analysis-subject', 'null');
      assert.equal((await cli('task', 'get', '--task', first.id)).task.analysisSubject, undefined);
      assert.deepEqual(await read(nested.id), []);

      await save('task/report', { task: review.id, expectedTaskHash: (await helpers.get(review.id)).hash, state: 'done' });
      await save('task/report', { task: asking.id, expectedTaskHash: (await helpers.get(asking.id)).hash, state: 'stopped' });
      assert.deepEqual(await read('P1'), []);
    } finally { await server.close(); }
  } finally {
    if (copied) removeWorkspace(root);
    if (original) removeWorkspace(original);
    rmSync(temp, { recursive: true, force: true });
  }
});
