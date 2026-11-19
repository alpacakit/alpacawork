/** Synthetic tasks and inert Runs only: exercise storage -> one read -> index and History. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { taskHistoryWindowSchema } from '@alpacawork/contract/control';
import { taskFlow } from './task-flow.fixture.ts';
import { readControlTree } from './helpers/control-tree.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { dependencyStatus } from '@alpacawork/backend/test-dist/control/dependencies.js';

const projection = (f: Awaited<ReturnType<typeof taskFlow>>) => readWorkspaceProjection(f.root);
const set = async (f: Awaited<ReturnType<typeof taskFlow>>, task: string, after: string[]) =>
  f.commands.dependencies({ task, after, expectedTaskHash: (await f.get(task)).hash });

test('index start orders track held completion, unfinished Runs and first start without changing the waiting Task', async t => {
  const f = await taskFlow(t), a = await f.task('Prerequisite'), b = await f.task('Waiting'), c = await f.task('Other');
  await set(f, b.id, [a.id, c.id]);
  const before = (await f.get(b.id)).hash;
  const row = async () => (await projection(f)).index.tasks.find(row => row.id === b.id)!;
  assert.equal((await row()).startOrder!.waiting, true);
  const ra = await f.work(a); await f.report(ra, 'done');
  assert.deepEqual((await row()).startOrder!.after[0], { task: a.id, title: 'Prerequisite', state: 'done', lifecycle: 'active', finished: false });
  f.end(ra);
  await f.person(a.id, 'held');
  assert.equal((await row()).startOrder!.after[0]!.finished, false);
  await f.person(a.id, (await f.get(a.id)).meta.baseState);
  assert.equal((await row()).startOrder!.after[0]!.finished, true);
  assert.equal((await row()).startOrder!.waiting, true);
  await f.person(c.id, 'stopped');
  assert.equal((await row()).startOrder!.waiting, false);
  assert.equal((await f.get(b.id)).hash, before, 'a dependency update changes the index without changing the opened Task');
  const rb = await f.work(b); f.end(rb);
  await f.request(a);
  assert.equal((await row()).startOrder!.started, true);
  assert.equal((await row()).startOrder!.waiting, false, 'reopening prerequisites never reinstates first-start waiting');
});

test('tree reads start orders in two statements inside its transaction, independent of the number of waiting Tasks', async t => {
  const f = await taskFlow(t), a = await f.task('Prerequisite');
  const waiting: string[] = [];
  for (let n = 0; n < 12; n++) {
    const b = await f.task(`Waiting ${n}`); await set(f, b.id, [a.id]); waiting.push(b.id);
  }
  const prepare = DatabaseSync.prototype.prepare;
  const observed: string[] = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.includes('FROM task_dependencies') || sql.includes('SELECT DISTINCT task_id FROM runs WHERE')) {
      assert.equal(this.isTransaction, true, 'dependency reads share the tree transaction');
      observed.push(sql);
    }
    return prepare.call(this, sql);
  });
  const tree = await readControlTree(f.root, { project: f.project });
  assert.equal(observed.length, 2);
  assert.equal(Object.keys(tree.startOrder!).length, waiting.length);
  t.mock.restoreAll();
  f.store(store => { for (const id of waiting) assert.deepEqual(tree.startOrder![id], dependencyStatus(store.connection, id)); });
});

test('new changes persist after/previous IDs, clear, and no-op without a report or an English text dependency', async t => {
  const f = await taskFlow(t), a = await f.task('First'), b = await f.task('Waiting'), c = await f.task('Second');
  await set(f, b.id, [a.id]); await set(f, b.id, [c.id]); await set(f, b.id, [c.id]); await set(f, b.id, []);
  const expected = [{ after: [a.id], previous: [] }, { after: [c.id], previous: [a.id] }, { after: [], previous: [c.id] }];
  const stored = (await f.get(b.id)).meta.log.filter(entry => entry.kind === 'dependencies_changed');
  assert.deepEqual(stored.map(entry => entry.dependencies), expected);
  assert.ok(stored.every(entry => entry.title === null && entry.description === null));
  const feed = await projection(f);
  const history = taskHistoryWindowSchema.parse(feed.history(b.id));
  assert.deepEqual(history.events.filter(event => event.dependencies).reverse().map(event => event.dependencies), expected);
  assert.ok(history.events.filter(event => event.dependencies).every(event => event.kind === 'changed' && event.state === null));
  assert.equal(history.tasks![a.id]!.title, 'First', 'cleared/finished references have names even off the live index');
});

test('structured records reject missing payloads, invalid IDs, duplicate IDs and state changes', () => {
  const valid = { id: 'Ldependency', kind: 'dependencies_changed', at: '2026-10-30T00:00:00.000Z',
    title: null, description: null, actor: { kind: 'human' }, fromState: null, toState: null,
    dependencies: { after: ['T2'], previous: [] } };
  assert.equal(taskLogSchema.safeParse(valid).success, true);
  for (const patch of [{ dependencies: undefined }, { dependencies: { after: ['banana'], previous: [] } },
    { dependencies: { after: ['T2', 'T2'], previous: [] } }, { toState: 'doing' }, { kind: 'reported' }])
    assert.equal(taskLogSchema.safeParse({ ...valid, ...patch }).success, false);
});
