/**
 * Routing reads only the selected seats and their related facts. Unrelated Tasks in the same project do not
 * increase its read volume, and facts are not retained across write transactions.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { ControlStore, type ChangeSeq } from '@alpacawork/db';
import { RunStore, type RunTransaction } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';

async function fixture(t: TestContext, count: number, stride = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'return-read-cost-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new FileWriter(root);
  let project: string;
  try { files.save('config.yaml', null, Buffer.from('agents: {}\n')); project = initializeControlFixture(root); }
  finally { files.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const tasks = [];
  for (let i = 0; i < count; i++) tasks.push((await commands.create({ parentId: project, userRequested: false, tasks: [{ title: `Task ${i}` }] })).tasks[0]);
  const placements = new PlacementStore(root);
  try {
    for (let i = 0; i < count; i += stride) placements.createAndPlace({ taskId: tasks[i]!.id, profileKey: 'fake', responsible: true });
    // Active members must never be considered responsible.
    placements.createAndPlace({ taskId: tasks[0]!.id, profileKey: 'fake', responsible: false });
  } finally { placements.close(); }
  return { root, project, tasks };
}

/**
 * Instrument SQL execution, not just prepare, and transaction controls separately; and the placement reads of the Run
 * transactions (each one SQL read, never memoized), with the Task IDs each set read was narrowed to.
 */
function measure(t: TestContext) {
  const stats = { prepares: 0, statements: 0, readRows: 0, execCalls: 0, sqlMs: 0, prepareMs: 0,
    placementSelects: 0, placementRows: 0, placementMs: 0, lifecycleMs: 0, passMs: 0,
    placementScopes: [] as (readonly string[] | undefined)[] };
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const at = performance.now(), stmt = prepare.call(this, sql);
    stats.prepares++; stats.prepareMs += performance.now() - at;
    for (const method of ['get', 'all', 'run'] as const) {
      const original = stmt[method].bind(stmt);
      Object.defineProperty(stmt, method, { value: (...args: SQLInputValue[]) => {
        const started = performance.now();
        try {
          const result = original(...args);
          stats.statements++;
          if (method === 'all') stats.readRows += (result as unknown[]).length;
          else if (method === 'get' && result !== undefined) stats.readRows++;
          return result;
        } finally { stats.sqlMs += performance.now() - started; }
      } });
    }
    return stmt;
  });
  const placementRead = <T>(read: () => T, rows: (result: T) => number): T => {
    const started = performance.now();
    try {
      const result = read();
      stats.placementSelects++; stats.placementRows += rows(result);
      return result;
    } finally { stats.placementMs += performance.now() - started; }
  };
  const write = RunStore.prototype.write;
  const writeHook = t.mock.method(RunStore.prototype, 'write', function<T>(this: RunStore, callback: (tx: RunTransaction) => T): T {
    return write.call(this, (tx: RunTransaction) => {
      const set = tx.responsiblePlacements, point = tx.responsiblePlacement;
      tx.responsiblePlacements = (project, taskIds) => {
        stats.placementScopes.push(taskIds);
        return placementRead(() => set(project, taskIds), placements => placements.length);
      };
      tx.responsiblePlacement = taskId => placementRead(() => point(taskId), placement => placement ? 1 : 0);
      return callback(tx);
    });
  });
  const execHook = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    stats.execCalls++;
    return exec.call(this, sql);
  });
  const reconcile = ReturnLifecycle.prototype.reconcile;
  const lifeHook = t.mock.method(ReturnLifecycle.prototype, 'reconcile', function(this: ReturnLifecycle,
    ...args: Parameters<ReturnLifecycle['reconcile']>) {
    const at = performance.now(); try { return reconcile.apply(this, args); }
    finally { stats.lifecycleMs += performance.now() - at; }
  });
  return { stats, stop: () => { hook.mock.restore(); execHook.mock.restore(); lifeHook.mock.restore(); writeHook.mock.restore(); } };
}

const work = (tasks: Iterable<string>) => ({ tasks: new Set(tasks), after: 0 as ChangeSeq,
  through: 1 as ChangeSeq, mode: 'changed' as const });

test('routing a fixed seat set reads the same number of rows as unrelated project Tasks grow', async t => {
  const measurements = [];
  for (const count of [32, 128]) {
    const stride = 2, { root, project, tasks } = await fixture(t, count, stride);
    const selected = tasks.slice(0, 4).map(task => task.id);
    // Both the same project's unrelated placements and another project's placement are outside this work set.
    const commands = new ControlTaskCommands(root, { kind: 'human' });
    const other = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Other' }] })).tasks[0].id;
    const outside = (await commands.create({ parentId: other, userRequested: false, tasks: [{ title: 'Outside' }] })).tasks[0];
    const people = new PlacementStore(root);
    try { people.createAndPlace({ taskId: outside.id, profileKey: 'fake', responsible: true }); } finally { people.close(); }
    const samples = process.env.RETURN_READ_COST_MEASURE ? 9 : 1;
    for (let i = 0; i < samples; i++) {
      const m = measure(t), at = performance.now();
      const result = await new ReturnRouter(root).route(work(selected));
      m.stats.passMs = performance.now() - at; m.stop();
      assert.deepEqual(result, { acceptedRequestIds: [], held: [], completed: true, completedThrough: 1 });
      // Per-seat transactions keep their facts bounded by the selected seats.
      assert.equal(m.stats.placementRows, 2, 'only selected responsible placements are read');
      assert.ok(m.stats.placementScopes.every(scope => scope !== undefined &&
        scope.every(id => selected.includes(id) || id === project || id === 'P1')),
      'each placement set is bounded by selected seats and their ancestors');
      measurements.push({ count, stride, iteration: i, ...m.stats });
    }
  }
  assert.equal(measurements.at(-1)!.readRows, measurements[0]!.readRows,
    'unrelated Tasks must not increase the rows read through the routing work-set entry');
  if (process.env.RETURN_READ_COST_MEASURE) writeFileSync(process.env.RETURN_READ_COST_MEASURE, JSON.stringify(measurements, null, 2));
});

test('placement set reads observe inserts, revision, release, reassignment and rollback in the same control transaction', async t => {
  const { root, tasks } = await fixture(t, 2, 2);
  const control = new ControlStore(root);
  try {
    let expired: (() => unknown) | undefined;
    const before = control.read(db => db.prepare('SELECT * FROM placements ORDER BY id').all());
    assert.throws(() => control.write(db => {
      const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
      const people = new PlacementStore(root, false, db);
      try { store.write(tx => {
        expired = () => tx.responsiblePlacements();
        const oracle = () => {
          const actual = new Map(tx.responsiblePlacements().map(p => [p.taskId, p]));
          assert.deepEqual(tasks.map(task => actual.get(task.id) ?? null), tasks.map(task => tx.responsiblePlacement(task.id)));
          return actual;
        };
        const first = oracle().get(tasks[0]!.id)!;
        const inserted = people.createAndPlace({ taskId: tasks[1]!.id, responsible: true, profileKey: 'fake' }).placement;
        assert.equal(oracle().get(tasks[1]!.id)?.id, inserted.id);
        const member = people.createAndPlace({ taskId: tasks[1]!.id, responsible: false, profileKey: 'fake' }).placement;
        const reassigned = people.setResponsible(member.id, member.revision).placement;
        assert.equal(oracle().get(tasks[1]!.id)?.revision, reassigned.revision);
        assert.equal(oracle().get(tasks[1]!.id)?.id, member.id);
        people.release(first.id, first.revision);
        assert.equal(oracle().has(tasks[0]!.id), false);
        assert.throws(() => { const p = people.createAndPlace({ taskId: tasks[1]!.id, responsible: true, profileKey: 'fake' }); return p; }, /already has a responsible/);
        throw new Error('rollback after placement writes');
      }); } finally { people.close(); store.close(); }
    }), /rollback after placement writes/);
    assert.throws(() => expired!(), /transaction has ended/);
    assert.deepEqual(control.read(db => db.prepare('SELECT * FROM placements ORDER BY id').all()), before);
  } finally { control.close(); }
});

test('placement set reads keep separate projects apart, including one with no responsible owner', async t => {
  const { root, project: first } = await fixture(t, 1);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  // Beside the fixture's project, below the root project P1.
  const second = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Other' }] })).tasks[0].id;
  const otherTask = await commands.create({ parentId: second, userRequested: false, tasks: [{ title: 'Other' }] });
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const original = store.write(tx => tx.responsiblePlacements(first));
    assert.equal(original.length, 1);
    assert.deepEqual(store.write(tx => tx.responsiblePlacements(second)), []);
    const placed = (() => {
      const people = new PlacementStore(root);
      try { return people.createAndPlace({ taskId: otherTask.tasks[0].id, responsible: true, profileKey: 'other' }).placement; }
      finally { people.close(); }
    })();
    assert.deepEqual(store.write(tx => tx.responsiblePlacements(second)), [placed]);
    assert.deepEqual(store.write(tx => tx.responsiblePlacements(first)), original);
  } finally { store.close(); }
});

test('empty work sets and pre-write yield perform no placement reads', async t => {
  const { root, tasks } = await fixture(t, 4);
  const router = new ReturnRouter(root);
  const skip = measure(t);
  try { assert.deepEqual(await router.route(work([])), { acceptedRequestIds: [], held: [], completed: true, completedThrough: 1 }); }
  finally { skip.stop(); }
  assert.equal(skip.stats.placementSelects, 0);
  const yielded = measure(t);
  try { await assert.rejects(router.route(work([tasks[0]!.id]), () => true), /yielded to a Task write/); }
  finally { yielded.stop(); }
  assert.equal(yielded.stats.placementSelects, 0);
});
