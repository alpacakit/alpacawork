import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectShelfSchema } from '@alpacawork/contract/control';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { callerWorkspace, run } from './coordinator-caller.fixture.ts';
import { assignResponsible } from './helpers/control-fixture.ts';

test('project catalog uses screen authorization over HTTP and CLI while project-scoped task reads remain allowed', { timeout: 60_000 }, async t => {
  const h = callerWorkspace(t), commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const own = (await commands.create({ parentId: h.project, userRequested: false,
    tasks: [{ title: 'Own Run task' }] })).tasks[0]!;
  const foreign = (await commands.create({ kind: 'project', color: '#aa2244', parentId: 'P1', userRequested: false,
    tasks: [{ title: 'Foreign confidential archived project' }] })).tasks[0]!;
  await commands.lifecycle({ id: foreign.id, action: 'archive', expectedTaskHash: foreign.hash });
  const placement = await assignResponsible(h.root, own, 'codex');
  const held = h.heldRun({ task: own.id, placementId: placement.id });
  const headers = { authorization: `Alpacawork-Run ${held.env.ALPACAWORK_RUN}:${held.env.ALPACAWORK_RUN_TOKEN}` };
  const url = await h.start();
  const read = async (path: string, credential?: typeof headers) => {
    const response = await fetch(new URL(path, url), { headers: credential });
    return { status: response.status, body: await response.json() };
  };

  await t.test('HTTP denies the whole screen catalog to a Run, as it denies other screen reads', async () => {
    for (const path of [`/api/task/get?task=${foreign.id}`, `/api/task/view?task=${foreign.id}`, '/api/workspace/live', '/api/project/shelf']) {
      const result = await read(path, headers);
      assert.equal(result.status, 403, path);
      assert.equal(result.body.error.code, 'forbidden', path);
      assert.equal(result.body.error.reason.kind, 'authorization_required', path);
      assert.equal(result.body.error.detail.action, path.startsWith('/api/task/get') ? 'task.read' : 'screen', path);
    }
  });
  await t.test('real CLI denies the same catalog to a Run', async () => {
    const result = await run(url, ['project', 'shelf'], held.env);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    const problem = JSON.parse(result.stderr).error;
    assert.equal(problem.code, 'forbidden');
    assert.equal(problem.reason.kind, 'authorization_required');
    assert.equal(problem.detail.action, 'screen');
    assert.equal(result.stdout, '');
  });
  await t.test('a person can read the complete archived catalog over HTTP and real CLI', async () => {
    const http = await read('/api/project/shelf');
    assert.equal(http.status, 200);
    const cli = await run(url, ['project', 'shelf']);
    assert.equal(cli.code, 0, cli.stderr);
    for (const body of [http.body, JSON.parse(cli.stdout)]) {
      const catalog = projectShelfSchema.parse(body);
      const archived = catalog.projects.find(project => project.id === foreign.id);
      assert.ok(archived);
      assert.equal(archived.title, foreign.title);
      assert.equal(archived.lifecycle, 'archived');
      assert.equal(archived.shelf.restoreTarget?.id, foreign.id);
    }
  });
  await t.test('the same Run credential still reads its own task over HTTP and real CLI', async () => {
    const http = await read(`/api/task/get?task=${own.id}`, headers);
    assert.equal(http.status, 200);
    assert.equal(http.body.task.id, own.id);
    const cli = await run(url, ['task', 'get', '--task', own.id], held.env);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).task.id, own.id);
  });
});
