/**
 * The structure commands (task-commands): a Task's creation with its mark of the user's request, its title, body and
 * mark, its move, its archive, deletion and restore. Who may make each is authorize's (control-actor.test.ts); the
 * states they leave and the ancestors they send back are state-link's and instruction-state's.
 */
import { taskFlow } from './task-flow.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { questionsOf, type TaskActor } from '@alpacawork/raw';
import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { readValuesChange } from '@alpacawork/backend/test-dist/control/task-values-store.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';

const human = { kind: 'human' } as const;

test('projects and tasks share one numbering; a task belongs to its nearest project and has a project or a task as its parent', async t => {
  const f = await taskFlow(t);
  // P1 is the root project a workspace starts with; the fixture's project is below it.
  assert.deepEqual([(await f.get('P1')).meta.kind, (await f.get('P1')).meta.parentId, f.project], ['project', null, 'P2']);
  const nested = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: f.project, userRequested: null,
    tasks: [{ title: 'Nested' }] })).tasks[0];
  const top = await f.task('Top', { parentId: nested.id });
  const marked = await f.plan('Marked', { userRequested: true });
  const child = await f.plan('Child', { parentId: top.id });
  assert.deepEqual([nested.id, top.id, marked, child], ['P3', 'T4', 'T5', 'T6']);
  assert.deepEqual([nested.kind, nested.userRequested, nested.path], ['project', false, 'tasks/P3']);
  const db = new DatabaseSync(controlDatabasePath(f.root), { readOnly: true });
  try {
    assert.deepEqual(db.prepare(`SELECT t.external_id AS id, t.kind, p.external_id AS project, t.user_requested AS marked
      FROM tasks t LEFT JOIN tasks p ON p.id = t.project_task_id ORDER BY t.number`).all().map(row => ({ ...row })), [
      { id: 'P1', kind: 'project', project: null, marked: 0 }, { id: 'P2', kind: 'project', project: null, marked: 0 },
      { id: 'P3', kind: 'project', project: null, marked: 0 }, { id: 'T4', kind: 'task', project: 'P3', marked: 0 },
      { id: 'T5', kind: 'task', project: 'P2', marked: 1 }, { id: 'T6', kind: 'task', project: 'P3', marked: 0 },
    ], 'a project belongs to none; a task to its nearest project, through its parent task too');
  } finally { db.close(); }
  await assert.rejects(async () => f.commands.create({ parentId: null, userRequested: null, tasks: [{ title: 'Loose' }] }),
    (error: { code: string; issues?: { path: string }[] }) => error.code === 'invalid_input' &&
      error.issues?.[0]?.path === 'parent');
  await assert.rejects(f.commands.create({ kind: 'project', color: '#39659b', parentId: top.id, userRequested: null,
    tasks: [{ title: 'Inside' }] }), { code: 'invalid_input' }, 'no project below a task');
  assert.equal(await f.plan('Next'), 'T7', 'a refused creation takes no number');
});

test('the user request mark belongs to project-level Tasks, including every sibling of a plan', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const create = async (actor: TaskActor, userRequested: boolean | null, titles: string[], parentId = f.project) =>
    (await new ControlTaskCommands(f.root, actor).create({ parentId, userRequested,
      tasks: titles.map(title => ({ title })) })).tasks;
  const coordinator = { kind: 'main', provider: 'codex', conversationId: 'C1' } as const;
  const marks = async (actor: TaskActor, userRequested: boolean | null) =>
    (await create(actor, userRequested, ['One']))[0]!.userRequested;
  assert.deepEqual([await marks(human, null), await marks(human, false), await marks(coordinator, true),
    await marks(coordinator, false), await marks({ kind: 'placement', placementId: parent.placementId }, null)],
  [true, false, true, false, false]);
  const plan = await create(coordinator, true, ['A', 'B', 'C']);
  assert.ok(plan.every(task => task.userRequested && task.parentId === f.project));
  assert.deepEqual(plan.map(task => Number(task.id.slice(1))),
    [0, 1, 2].map(offset => Number(plan[0]!.id.slice(1)) + offset));
  const before = (await new ControlTaskStore(f.root).snapshot()).tasks.length;
  for (const titles of [['Child'], ['A', 'B']])
    await assert.rejects(create(coordinator, true, titles, parent.id),
      { code: 'invalid_input', reason: { kind: 'user_request_belongs_to_top' } });
  await assert.rejects(f.commands.create({ parentId: parent.id, userRequested: false,
    expectedParentHash: 'a'.repeat(64), tasks: [{ title: 'D' }, { title: 'E' }] }), { code: 'conflict' });
  assert.equal((await new ControlTaskStore(f.root).snapshot()).tasks.length, before);
  assert.deepEqual(f.store(runs => runs.readReturns()), [], 'creation never emits child_added');
});

test('a task has children only once it has its responsible; an internal child tells its parent nothing', async t => {
  const f = await taskFlow(t);
  const lone = await f.plan('Lone');
  await assert.rejects(f.plan('Child', { parentId: lone }), { code: 'responsible_missing', detail: { tasks: [lone] } });
  const next = await f.plan('Next');
  assert.equal(Number(next.slice(1)), Number(lone.slice(1)) + 1, 'the refused child took no number');
  const parent = await f.task('Parent');
  await f.plan('Internal', { parentId: parent.id });
  assert.deepEqual(f.store(runs => runs.readReturns()), []);
});

test('update writes a title, values and the mark, one record each; the mark goes false only once a review is decided', async t => {
  const f = await taskFlow(t);
  const task = await f.task('Task', { userRequested: true });
  const before = await f.get(task.id);
  await f.commands.update({ id: task.id, title: 'Renamed', values: { notes: 'New notes' }, expectedTaskHash: before.hash });
  const renamed = await f.get(task.id);
  assert.deepEqual([renamed.meta.title, renamed.values.notes, renamed.meta.version], ['Renamed', 'New notes', before.meta.version + 1n]);
  assert.deepEqual(renamed.meta.log.slice(-2).map(entry => [entry.kind, entry.actor]), [['retitled', human], ['body_updated', human]]);
  await f.commands.update({ id: task.id, userRequested: true, expectedTaskHash: renamed.hash });
  assert.equal((await f.get(task.id)).hash, renamed.hash, 'a mark that changes nothing writes nothing');
  await assert.rejects(f.commands.update({ id: f.project, userRequested: true, expectedTaskHash: (await f.get(f.project)).hash }),
    { code: 'invalid_input' }, 'only a task is the user\'s request');
  // While its review waits, held or not, the mark stays: the review is confirmed or sent back first.
  const turn = await f.work(task);
  await f.report(turn, 'done');
  f.end(turn);
  await assert.rejects(f.commands.update({ id: task.id, userRequested: false, expectedTaskHash: (await f.get(task.id)).hash }),
    { code: 'conflict', detail: { task: task.id } });
  await f.person(task.id, 'held');
  await assert.rejects(f.commands.update({ id: task.id, userRequested: false, expectedTaskHash: (await f.get(task.id)).hash }),
    { code: 'conflict' });
  await f.confirm(task.id, turn.runId);
  await f.commands.update({ id: task.id, userRequested: false, expectedTaskHash: (await f.get(task.id)).hash });
  const unmarked = await f.get(task.id);
  assert.deepEqual([unmarked.meta.state, unmarked.meta.userRequested, unmarked.meta.log.at(-1)?.kind,
    unmarked.meta.log.at(-1)?.userRequested], ['done', false, 'user_request_changed', false]);
  // A mark corrected while a question is open keeps the state and whom the question asked.
  const asking = await f.task('Asking', { userRequested: true });
  const question = await f.ask(await f.work(asking));
  await f.commands.update({ id: asking.id, userRequested: false, expectedTaskHash: (await f.get(asking.id)).hash });
  const corrected = await f.get(asking.id);
  assert.deepEqual([corrected.meta.state, corrected.meta.userRequested,
    questionsOf(corrected.meta.log).find(item => item.asked.id === question)?.asked.askedTo], ['doing', false, null]);
});

test('a move stays within its project, below a parent with a responsible, and records the ancestors it left', async t => {
  const f = await taskFlow(t);
  const first = await f.task('First'), second = await f.task('Second');
  const moving = await f.plan('Moving', { parentId: first.id });
  const before = await f.get(moving);
  const moved = (await f.commands.move({ id: moving, parentId: second.id, expectedTaskHash: before.hash })).task;
  assert.deepEqual([moved.id, moved.path, moved.parentId, moved.version], [moving, before.path, second.id,
    Number(before.meta.version) + 1]);
  const record = (await f.get(moving)).meta.log.at(-1);
  assert.deepEqual([record?.kind, record?.actor, record?.formerAncestors],
    ['moved', human, [first.id, f.project, 'P1']]);
  const move = async (id: string, parentId: string | null) =>
    f.commands.move({ id, parentId, expectedTaskHash: (await f.get(id)).hash });
  const other = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null,
    tasks: [{ title: 'Other' }] })).tasks[0];
  await assert.rejects(move(moving, other.id), { code: 'invalid_input' }, 'not out of its project');
  await assert.rejects(move(moving, null), { code: 'invalid_input' }, 'a task keeps a parent');
  await assert.rejects(move(f.project, 'P1'), { code: 'invalid_input' }, 'a project does not move');
  const lone = await f.plan('Lone');
  await assert.rejects(move(moving, lone), { code: 'responsible_missing', detail: { tasks: [lone] } });
  await assert.rejects(move(second.id, moving), /cycle/);
  await assert.rejects(f.commands.move({ id: moving, parentId: first.id, expectedTaskHash: before.hash }), /changed/);
  await f.commands.lifecycle({ id: lone, action: 'archive', expectedTaskHash: (await f.get(lone)).hash });
  await assert.rejects(move(moving, lone), /not active/);
});

test('new accepts logical depth 32 and rejects depth 33 before publishing a document', async t => {
  const f = await taskFlow(t);
  // The root project is depth 1 and the fixture's project depth 2; each parent has its responsible.
  const people = new PlacementStore(f.root);
  let parentId = f.project;
  try {
    for (let depth = 3; depth <= 32; depth++) {
      parentId = await f.plan(`Depth ${depth}`, { parentId });
      people.place({ taskId: parentId, agentId: people.createAgent().id, profileKey: 'fake', responsible: true });
    }
  } finally { people.close(); }
  await assert.rejects(f.plan('Too deep', { parentId }), { code: 'too_deep' });
  const snapshot = await new ControlTaskStore(f.root).snapshot();
  assert.equal(snapshot.tasks.length, 32);
  assert.equal(snapshot.tasks.some(task => task.id === 'T33'), false);
});

test('archive, delete and restore: no live child or unfinished Run, a project with nothing at work below it', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const child = await f.task('Child', { parentId: parent.id });
  await assert.rejects(f.commands.lifecycle({ id: parent.id, action: 'delete', expectedTaskHash: (await f.get(parent.id)).hash }),
    /children/);
  await f.request(child);
  await assert.rejects(f.commands.lifecycle({ id: child.id, action: 'archive', expectedTaskHash: (await f.get(child.id)).hash }),
    /unfinished runs/);
  const nested = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: f.project, userRequested: null,
    tasks: [{ title: 'Nested' }] })).tasks[0];
  const top = await f.task('Top', { parentId: nested.id });
  await f.work(top);
  await assert.rejects(f.commands.lifecycle({ id: nested.id, action: 'archive', expectedTaskHash: nested.hash }),
    { code: 'conflict', detail: { tasks: [top.id] } });
  const shelf = await f.plan('Shelf');
  await f.commands.lifecycle({ id: shelf, action: 'archive', expectedTaskHash: (await f.get(shelf)).hash });
  await f.commands.lifecycle({ id: shelf, action: 'restore', expectedTaskHash: (await f.get(shelf)).hash });
  const restored = await f.get(shelf);
  assert.deepEqual([restored.meta.lifecycle, restored.meta.state, restored.meta.log.slice(-2).map(entry => entry.kind)],
    ['active', 'todo', ['archived', 'restored']]);
});

test('a failed Task update rolls back its DB revision and can be retried', async t => {
  const f = await taskFlow(t);
  const task = await f.get(await f.plan('Stable'));
  const original = DatabaseSync.prototype.prepare;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('UPDATE tasks SET')) throw new Error('injected write failure');
    return original.call(this, sql);
  });
  try {
    await assert.rejects(f.commands.update({ id: task.id, values: { notes: 'Never committed' }, expectedTaskHash: task.hash }), /injected write failure/);
  } finally { hook.mock.restore(); }
  const current = await f.get(task.id);
  assert.deepEqual([current.hash, current.values], [task.hash, task.values]);
  assert.equal((await f.commands.update({ id: task.id, values: { notes: 'Retry' }, expectedTaskHash: task.hash })).task.values.notes, 'Retry');
});

test('a failed Task insert leaves no title-only row or consumed number', async t => {
  const f = await taskFlow(t);
  const original = DatabaseSync.prototype.prepare;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO tasks(')) throw new Error('injected insert failure');
    return original.call(this, sql);
  });
  try { await assert.rejects(f.plan('Unpublished'), /injected insert failure/); }
  finally { hook.mock.restore(); }
  assert.deepEqual((await new ControlTaskStore(f.root).snapshot()).tasks.map(task => task.id), ['P1', f.project]);
  const retried = await f.get(await f.plan('Retry'));
  assert.equal(retried.id, 'T3');
  assert.deepEqual(retried.meta.log.map(entry => entry.kind), ['created']);
});

test('project rows require settings.color on creation and decode, for every lifecycle', async t => {
  const f = await taskFlow(t);
  assert.throws(() => f.commands.create({ kind: 'project', parentId: null, userRequested: null, tasks: [{ title: 'No color' }] }), /#rrggbb/);
  const db = new DatabaseSync(controlDatabasePath(f.root));
  try {
    for (const lifecycle of ['active', 'archived', 'deleted']) {
      for (const settings of [null, '{}', '{"extracts":[]}', '{"color":"#ABCDEF"}']) {
        db.prepare('UPDATE tasks SET lifecycle=?,settings=? WHERE external_id=?').run(lifecycle, settings, f.project);
        await assert.rejects(f.get(f.project), /#rrggbb/);
      }
    }
  } finally { db.close(); }
});

test('a project\'s own values are independent of the fields its Tasks use', async t => {
  const f = await taskFlow(t);
  const long = 'Ask before pushing.\n'.repeat(2000);
  const values = { project_summary: 'Release planning', project_policy: long };
  await f.commands.update({ id: f.project, values, expectedTaskHash: (await f.get(f.project)).hash });
  await assert.rejects(f.commands.update({ id: f.project, values: { goal: 'g' }, expectedTaskHash: (await f.get(f.project)).hash }),
    (error: { reason?: { kind: string }; issues?: { path: string }[] }) => error.reason?.kind === 'values_invalid' && error.issues?.[0]?.path === 'goal');
  const owner = await f.task('Owner');
  await assert.rejects(f.commands.update({ id: owner.id, values, expectedTaskHash: (await f.get(owner.id)).hash }),
    (error: { reason?: { kind: string } }) => error.reason?.kind === 'values_invalid');
  const run = new ControlTaskCommands(f.root, { kind: 'placement', placementId: owner.placementId });
  await run.setSchema({ task: f.project, fields: DEFAULT_SCHEMA.filter(id => id !== 'policy'), expectedTaskHash: (await f.get(f.project)).hash });
  assert.deepEqual((await f.get(f.project)).values, { ...values, project_policy: long.trim() });
});

test('direction triggers apply to rewrites and the exact value versions remain readable', async t => {
  const f = await taskFlow(t);
  const task = await f.task('Task');
  const commands = new ControlTaskCommands(f.root, { kind: 'placement', placementId: task.placementId });
  const update = async (values: object, trigger?: 'found' | 'refine') =>
    commands.update({ id: task.id, values, trigger, expectedTaskHash: (await f.get(task.id)).hash });
  await update({ goal: 'Deliver a useful preview', conditions: ['The link opens — 未'] });
  await assert.rejects(update({ goal: 'Deliver a checked preview' }), { code: 'invalid_input' });
  const progress = await update({ conditions: ['The link opens — met（手動確認）'] }, 'found');
  assert.equal(progress.result, true);
  assert.equal((await f.get(task.id)).meta.log.at(-1)?.reason, undefined);
  await update({ goal: 'Deliver a checked preview', conditions: ['The link opens on mobile — unchecked'] }, 'found');
  const changed = (await f.get(task.id)).meta.log.at(-1)!;
  assert.deepEqual(changed.reason?.trigger, { code: 'found', fields: ['goal', 'conditions'] });
  await update({ goal: 'Deliver a verified preview' }, 'refine');
  const db = new DatabaseSync(controlDatabasePath(f.root), { readOnly: true });
  try {
    assert.deepEqual(readValuesChange(db, task.id, changed.id).fields, [
      { id: 'conditions', before: ['The link opens — met（手動確認）'], after: ['The link opens on mobile — unchecked'] },
      { id: 'goal', before: 'Deliver a useful preview', after: 'Deliver a checked preview' },
    ]);
  } finally { db.close(); }
});
