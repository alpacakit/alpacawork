/** Independent counterexamples for the new transaction placement read boundary. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Problem } from '@alpacawork/core';
import { RunStore, type RunTransaction } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'return-independent-')));
  const project = initializeControlFixture(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project };
}

for (const stage of ['prepare', 'step'] as const) for (const busy of [true, false]) {
  test(`placement set ${stage} preserves ${busy ? 'busy' : 'storage fault'} classification and cause`, t => {
    const { root } = fixture(t), store = new RunStore(root, { busyTimeoutMs: 1000 });
    const cause = Object.assign(new Error('independent placement read failure'), busy ? { errcode: 5 } : {});
    // Only the placement read inside the transaction fails: one Task's (`get`), or the whole workspace's set (`all`).
    let armed = false;
    const prepare = store.connection.prepare.bind(store.connection);
    const hook = t.mock.method(store.connection, 'prepare', function(sql: string) {
      if (!armed) return prepare(sql);
      if (stage === 'prepare') throw cause;
      const statement = prepare(sql);
      for (const step of ['get', 'all']) Object.defineProperty(statement, step, { value: () => { throw cause; } });
      return statement;
    });
    const failing = <T>(read: () => T) => { armed = true; try { return read(); } finally { armed = false; } };
    try {
      for (const read of [() => store.write(tx => failing(() => tx.responsiblePlacement('P1'))),
        () => store.write(tx => failing(() => tx.responsiblePlacements()))]) {
        assert.throws(read, error => error instanceof Problem &&
          error.code === (busy ? 'busy' : 'runs_unavailable') && error.cause === cause);
      }
    } finally { hook.mock.restore(); store.close(); }
  });
}

test('placement reads return detached values, reread each project on the same handle, and expire after success', async t => {
  const { root, project: local } = fixture(t);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const task = (await commands.create({ parentId: local, userRequested: false, tasks: [{ title: 'Local' }] })).tasks[0];
  const people = new PlacementStore(root);
  let placed;
  try { placed = people.createAndPlace({ taskId: task.id, responsible: true, profileKey: 'fake' }).placement; }
  finally { people.close(); }
  // Beside the fixture's project, below the root project P1.
  const other = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Other' }] })).tasks[0].id;
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  let expired: () => unknown;
  try {
    store.write(tx => {
      expired = () => tx.responsiblePlacements(local);
      const first = tx.responsiblePlacements(local);
      assert.deepEqual(first, [placed]);
      first[0]!.revision = -1;
      first.length = 0;
      assert.deepEqual(tx.responsiblePlacements(local), [placed]);
      assert.deepEqual(tx.responsiblePlacements(other), []);
      assert.deepEqual(tx.responsiblePlacements(local), [placed]);
    });
    assert.throws(() => expired!(), error => error instanceof Problem && error.code === 'conflict');
  } finally { store.close(); }
});

test('empty Task reconciliations skip placement reads even with project placements outside the supplied tasks', async t => {
  const { root, project } = fixture(t), write = RunStore.prototype.write;
  // Every placement read of a Run transaction, one SQL read each.
  let reads = 0;
  const hook = t.mock.method(RunStore.prototype, 'write', function<T>(this: RunStore, callback: (tx: RunTransaction) => T): T {
    return write.call(this, (tx: RunTransaction) => {
      const set = tx.responsiblePlacements, point = tx.responsiblePlacement;
      tx.responsiblePlacements = project => { reads++; return set(project); };
      tx.responsiblePlacement = taskId => { reads++; return point(taskId); };
      return callback(tx);
    });
  });
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  // Only the project Tasks: no Task to work on yet.
  assert.equal(reconcileLinks(root, project).tasks.filter(task => task.meta.kind !== 'project').length, 0);
  const task = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'Outside supplied snapshot' }] })).tasks[0];
  const people = new PlacementStore(root);
  try { people.createAndPlace({ taskId: task.id, responsible: true, profileKey: 'fake' }); }
  finally { people.close(); }
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    store.write(tx => assert.deepEqual(new ReturnLifecycle(store.connection, tx, []).reconcile(),
      { runs: [], requests: [], returns: [] }));
  } finally { store.close(); hook.mock.restore(); }
  assert.equal(reads, 0);
});
