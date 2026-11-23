/** What a Run and field get read of projects: the Tasks' fields at a project, and the projects above a Run's own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { authorize } from '@alpacawork/backend/test-dist/control/authorize.js';
import { readSchema } from '@alpacawork/backend/test-dist/control/field-commands.js';
import { readControl } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { taskFlow } from './task-flow.fixture.ts';

test('field get at a project answers with the fields its Tasks write', async t => {
  const f = await taskFlow(t);
  assert.deepEqual([readSchema(f.root, f.project).fields, readSchema(f.root, f.project).from], [[...DEFAULT_SCHEMA], null]);
  const reordered = [...DEFAULT_SCHEMA].reverse();
  await f.commands.setSchema({ task: f.project, fields: reordered, expectedTaskHash: (await f.get(f.project)).hash });
  const read = readSchema(f.root, f.project);
  assert.deepEqual([read.fields, read.from], [reordered, f.project]);
  assert.deepEqual(Object.keys((read.schema as { properties: object }).properties), reordered);
});

test('a Run reads the projects above its own, whose policies its launches carry, and no other project', async t => {
  const f = await taskFlow(t);
  const create = async (parentId: string, title: string) => (await f.commands.create({ kind: 'project', color: '#39659b',
    parentId, userRequested: null, tasks: [{ title }] })).tasks[0]!.id as string;
  const child = await create(f.project, 'Child project'), beside = await create('P1', 'Unrelated project');
  const work = await f.task('Work', { parentId: child });
  const caller = { kind: 'run' as const, runId: 'R1', placementId: work.placementId, taskId: work.id, role: 'owner' as const, responsible: true };
  const read = (task: string) => readControl(f.root, db => {
    try { authorize(db, caller, { name: 'task.read' }, { task, quote: null }); return true; }
    catch (error) { if ((error as { code?: string }).code === 'forbidden') return false; throw error; }
  });
  assert.deepEqual([child, f.project, 'P1', beside].map(read), [true, true, true, false]);
  // The read itself, in the Run's scope (its own project): the project above comes back with its policy.
  await f.commands.update({ id: f.project, values: { project_policy: 'Ask before pushing' }, expectedTaskHash: (await f.get(f.project)).hash });
  const view = await readTaskView(f.root, f.project, {}, child);
  assert.deepEqual([view.task.id, view.task.values], [f.project, { project_policy: 'Ask before pushing' }]);
});
