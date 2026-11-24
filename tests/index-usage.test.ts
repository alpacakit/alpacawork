/** Completed subtree usage is projected before the live index omits finished Tasks. */
import { controlRunFixture } from './helpers/control-run-fixture.ts';
import type { RunRecord } from '@alpacawork/contract/run';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ControlRunDTO, type ControlTreeDTO } from '@alpacawork/contract/control';
import { readControlTree } from './helpers/control-tree.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { setupIndexFixture as setup } from './helpers/index-fixture.ts';

const minute = 60_000;
const iso = (minutes: number) => new Date(Date.UTC(2026, 9, 26, 5, minutes)).toISOString();
type Task = ControlTreeDTO['tasks'][number];
const like = (example: Task, id: string, changes: Partial<Task> = {}): Task => ({
  ...example, id, path: `tasks/${id}`, ...changes,
  baseState: changes.baseState ?? (changes.state === 'held' ? 'doing' : changes.state ?? example.baseState),
});
const tokens = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0, output: 0 });
const run = (id: string, taskId: string, end: number | null, changes: Partial<RunRecord> = {}): ControlRunDTO =>
  controlRunFixture(id, { task: taskId, placementId: `P-${id}`, agent: 'codex',
    requestId: `Q-${id}`, cwd: '/fixture/run', state: end === null ? 'running' : 'succeeded',
    created_at: iso(0), started_at: iso(0), ended_at: end === null ? null : iso(end),
    usage: end === null ? null : { conversation: null, run: tokens(end), includesEarlier: false }, ...changes });

test('usageBelow includes every logical descendant, including archived and deleted children and their grandchildren', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const example = tree.tasks.find(task => task.id === h.child.id)!;
  const parent = h.parent.id;
  const child = like(example, example.id, { state: 'done', userRequested: false });
  const tasks = [...tree.tasks.filter(task => task.id !== child.id), child,
    like(example, 'T100', { parentId: child.id, state: 'done' }),
    like(example, 'T101', { parentId: parent, lifecycle: 'archived' }),
    like(example, 'T102', { parentId: 'T101', state: 'done' }),
    like(example, 'T103', { parentId: parent, lifecycle: 'deleted' }),
    like(example, 'T104', { parentId: 'T103', state: 'done' }),
    like(example, 'T105', { parentId: parent, state: 'doing' }),
    like(example, 'T106', { parentId: h.projectId, state: 'done' }),
    like(example, 'T107', { parentId: parent, state: 'stopped' })];
  const runs = [run('R1', parent, 2), run('R2', child.id, 3), run('R3', 'T100', 5),
    run('R4', 'T101', 100), run('R5', 'T102', 100), run('R6', 'T103', 100), run('R7', 'T104', 100),
    run('R8', 'T105', 7), run('R9', 'T105', null), run('R10', 'T106', 100),
    run('R11', 'T107', 4, { state: 'cancelled', reason: 'stopped', usage: null }),
    run('R12', child.id, 8, { state: 'joined', into: 'R2', started_at: null }),
    run('R13', 'T105', null, { state: 'queued', started_at: null }),
    run('R14', 'T102', null), run('R15', 'T104', null), run('R16', child.id, null, { started_at: null })];
  await h.project({ ...tree, tasks, runs });
  const projection = await readWorkspaceProjection(h.root), index = projection.index;
  const row = index.tasks.find(task => task.id === parent)!;
  assert.deepEqual(row.usage, { runs: 1, runMs: 2 * minute, tokens: tokens(2), tokensUnknown: 0 });
  assert.deepEqual(row.usageBelow, { runs: 11, runMs: 419 * minute, tokens: tokens(415), tokensUnknown: 4 });
  assert.deepEqual(row.runsBelow.map(([, from]) => from), [Date.parse(iso(0)), Date.parse(iso(0)), Date.parse(iso(0))]);
  assert.ok(!index.tasks.some(task => [child.id, 'T100', 'T101', 'T103', 'T107'].includes(task.id)),
    'finished and inactive descendants are absent from the live rows');
  assert.deepEqual(index.tasks.find(task => task.id === 'T105')!.usageBelow,
    { runs: 0, runMs: 0, tokens: null, tokensUnknown: 0 });
  const finishedChild = projection.finished(parent).rows.find(task => task.id === child.id)!;
  assert.deepEqual(finishedChild.usageBelow, { runs: 1, runMs: 5 * minute, tokens: tokens(5), tokensUnknown: 0 });
});

test('a child Run ending updates unchanged ancestry, and finishing retains its completed cost', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!, parent = h.parent.id;
  const tasks = tree.tasks.map(task => task.id === child.id ? like(task, child.id, { state: 'doing' }) : task);
  const own = run('R1', parent, 2);
  const publish = async (runs: ControlRunDTO[], currentTasks = tasks) => {
    await h.project({ ...tree, tasks: currentTasks, runs });
    return (await readWorkspaceProjection(h.root)).index;
  };
  const before = (await publish([own, run('R2', child.id, null)])).tasks.find(row => row.id === parent)!;
  assert.equal(before.usageBelow?.runMs, 0);
  assert.deepEqual(before.runsBelow.map(([, from]) => from), [Date.parse(iso(0))]);
  const ended = run('R2', child.id, 3), after = await publish([own, ended]);
  const row = after.tasks.find(row => row.id === parent)!;
  assert.deepEqual(row.usage, before.usage);
  assert.deepEqual(row.usageBelow, { runs: 1, runMs: 3 * minute, tokens: tokens(3), tokensUnknown: 0 });
  assert.deepEqual(row.runsBelow, []);
  assert.equal(after.tasks.find(row => row.id === h.projectId)?.usageBelow?.runMs, 5 * minute);
  const finished = await publish([own, ended], tasks.map(task => task.id === child.id ? like(task, child.id, { state: 'done' }) : task));
  assert.ok(!finished.tasks.some(row => row.id === child.id));
  assert.deepEqual(finished.tasks.find(row => row.id === parent)!.usageBelow, row.usageBelow);
});

for (const state of ['done', 'stopped'] as const) test(`a ${state} child retains its running start until the Run ends`, async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!, parent = h.parent.id;
  const own = run('R1', parent, 2), moving = run('R2', child.id, null);
  const tasks = tree.tasks.map(task => task.id === child.id ? like(task, child.id, { state: 'doing', userRequested: false }) : task);
  await h.project({ ...tree, tasks, runs: [own, moving] });
  const started = (await readWorkspaceProjection(h.root)).index;
  for (const id of [parent, h.projectId])
    assert.deepEqual(started.tasks.find(task => task.id === id)?.runsBelow.map(([, from]) => from), [Date.parse(iso(0))]);
  const changedTasks = tasks.map(task => task.id === child.id ? like(task, child.id, { state,
    log: [...task.log, { id: 'Lreported', kind: 'reported', at: iso(3), actor: { kind: 'human' },
      title: null, description: null, fromState: 'doing', toState: state }] }) : task);
  await h.project({ ...tree, tasks: changedTasks, runs: [own, moving] });
  const during = (await readWorkspaceProjection(h.root)).index;
  assert.ok(!during.tasks.some(task => task.id === child.id));
  assert.ok(!during.runs.some(run => run.id === moving.id));
  for (const id of [parent, h.projectId])
    assert.deepEqual(during.tasks.find(task => task.id === id)?.runsBelow.map(([, from]) => from), [Date.parse(iso(0))]);
  assert.equal(during.tasks.find(task => task.id === parent)!.usageBelow?.runMs, 0);
  const ended = run('R2', child.id, 3, { state: state === 'done' ? 'succeeded' : 'cancelled', reason: state === 'done' ? null : 'stopped' });
  await h.project({ ...tree, tasks: changedTasks, runs: [own, ended] });
  const row = (await readWorkspaceProjection(h.root)).index.tasks.find(task => task.id === parent)!;
  assert.deepEqual(row.runsBelow, []);
  assert.equal(row.usageBelow?.runMs, 3 * minute);
});

for (const lifecycle of ['archived', 'deleted'] as const) test(`${lifecycle} preserves the completed cost of the child and its grandchild`, async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!, parent = h.parent.id;
  const tasks = [...tree.tasks.map(task => task.id === child.id ? like(task, child.id, { state: 'done', userRequested: false }) : task),
    like(child, 'T100', { parentId: child.id, state: 'done', userRequested: false })];
  const runs = [run('R1', child.id, 3), run('R2', 'T100', 5)];
  const publish = async (current: Task[]) => {
    await h.project({ ...tree, tasks: current, runs });
    return new Map((await readWorkspaceProjection(h.root)).index.tasks.filter(task => task.id === parent || task.id === h.projectId)
      .map(task => [task.id, task.usageBelow]));
  };
  const before = await publish(tasks);
  assert.equal(before.get(parent)?.runMs, 8 * minute);
  assert.ok((before.get(h.projectId)?.runMs ?? 0) >= 8 * minute);
  const changedTasks = tasks.map(task => task.id === child.id ? like(task, child.id, { lifecycle,
    log: [...task.log, { id: 'Llifecycle', kind: lifecycle, at: iso(10), actor: { kind: 'human' },
      title: null, description: null, fromState: null, toState: null }] }) : task);
  assert.deepEqual(await publish(changedTasks), before);
});

test('running counts distinguish active nesting from logical ancestry and exclude queued or ended Runs', async t => {
  const h = await setup(t), tree = await readControlTree(h.root), parent = h.parent.id;
  const example = tree.tasks.find(task => task.id === h.child.id)!;
  const tasks = [...tree.tasks.filter(task => task.id !== example.id),
    like(example, 'T10', { parentId: parent, state: 'doing' }),
    like(example, 'T11', { parentId: 'T10', state: 'doing' }),
    like(example, 'T12', { parentId: parent, state: 'done' }),
    like(example, 'T13', { parentId: parent, lifecycle: 'archived' }),
    like(example, 'T14', { parentId: 'T13', state: 'doing' }),
    like(example, 'T20', { parentId: h.projectId, state: 'doing' })];
  const running = [run('R1', parent, null), run('R2', parent, null), run('R3', 'T10', null),
    run('R4', 'T11', null), run('R5', 'T12', null), run('R6', 'T14', null), run('R7', 'T20', null)];
  const queued = run('R8', 'T10', null, { state: 'queued', started_at: null });
  const publish = async (runs: ControlRunDTO[]) => {
    await h.project({ ...tree, tasks, runs });
    return (await readWorkspaceProjection(h.root)).index;
  };
  const before = await publish([...running, queued, run('R9', 'T11', 3)]);
  const row = (index: typeof before, id: string) => index.tasks.find(task => task.id === id)!;
  assert.deepEqual(['T10', 'T11', 'T20'].map(id => row(before, id).rowFacts.runningRuns), [2, 1, 1]);
  assert.equal(row(before, parent).rowFacts.runningRuns, 6);
  assert.equal(row(before, parent).runsBelow.length, 4);
  assert.equal(before.counts.children[parent]?.runningBelow, 3, 'the finished but still running child is an active descendant');
  assert.equal(before.counts.children.T13?.runningBelow, 1, 'active nesting stops at the archived parent');
  assert.ok(!before.tasks.some(task => task.id === 'T12'));
  const after = await publish([...running.filter(item => item.id !== 'R4'), run('R4', 'T11', 3), queued]);
  assert.deepEqual([parent, 'T10', 'T11', 'T20'].map(id => row(after, id).rowFacts.runningRuns), [5, 1, 0, 1]);
});

test('a Run start moves its home row ahead of newer Task records', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const tasks = [...tree.tasks, like(child, 'T10', { parentId: h.projectId, state: 'doing', log: child.log.map(entry => ({ ...entry, at: iso(1) })) }),
    like(child, 'T11', { parentId: h.projectId, state: 'doing', log: child.log.map(entry => ({ ...entry, at: iso(2) })) })];
  const older = run('R50', 'T10', null, { state: 'queued', started_at: null, created_at: iso(1) });
  const newer = run('R51', 'T11', null, { state: 'queued', started_at: null, created_at: iso(2) });
  const publish = async (runs: ControlRunDTO[]) => {
    await h.project({ ...tree, tasks, runs });
    return (await readWorkspaceProjection(h.root)).index;
  };
  const order = (index: Awaited<ReturnType<typeof publish>>) => index.home.filter(row => ['T10', 'T11'].includes(row.taskId)).map(row => row.taskId);
  assert.deepEqual(order(await publish([older, newer])), ['T11', 'T10']);
  const changed = await publish([{ ...older, state: 'running', startedAt: iso(3) }, newer]);
  assert.deepEqual(order(changed), ['T10', 'T11']);
  assert.equal(changed.tasks.find(row => row.id === 'T10')?.movedAt, Date.parse(iso(3)));
});
