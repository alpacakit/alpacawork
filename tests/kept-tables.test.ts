/**
 * What a server keeps of its append-only rows (KeptTable) reads the same as reading them all, at every read point: after
 * new rows, inside a write, after a write rolled back, at an older read point, and over a database put back.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ControlStore, keepControlTables, controlDatabasePath } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import type { TaskLog } from '@alpacawork/raw';
import { comment } from '@alpacawork/backend/test-dist/control/task-questions.js';
import { withControlWrite } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { initializeControlFixture, seedFixtureTask } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields as runFields } from './runs-fixtures.ts';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kept-tables-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new FileWriter(root);
  let project: string;
  try { files.save('config.yaml', null, Buffer.from('agents: {}\n')); project = initializeControlFixture(root); }
  finally { files.close(); }
  const task = seedFixtureTask(root, project, 'One');
  const placements = new PlacementStore(root);
  const placement = (() => { try { return placements.createAndPlace({ taskId: task.id, profileKey: 'fake', responsible: true }).placement; } finally { placements.close(); } })();
  return { root, project, task, placement };
}
const reader = <T>(root: string, read: (db: ControlStore['connection']) => T): T => {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return store.read(read); } finally { store.close(); }
};
const tasks = (root: string, db: ControlStore['connection'], project: string) => new TaskRepository(root, db).snapshot(project).tasks;
const requests = (root: string, project: string) => {
  const store = new RunStore(root, { busyTimeoutMs: 1000 }, true);
  try { return store.readRequests(project); } finally { store.close(); }
};
/** One record on the Task, and one Request to it, through the writers the server uses. */
function write(root: string, task: string, placement: { id: string; revision: number }, fail = false) {
  const control = new ControlStore(root);
  try {
    control.write(db => {
      const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
      store.write(runs => {
        const id = `L${randomUUID()}`, current = new TaskRepository(root, db).get(task);
        new TaskTransition().appendRecord({ store, runs }, task, { id, kind: 'reported', at: new Date().toISOString(),
          actor: { kind: 'human' }, title: 'a note', description: null, fromState: null, toState: null });
        runs.insertRequest({ id: `Q${randomUUID()}`, taskId: task, placementId: placement.id, placementRevision: placement.revision,
          taskHash: current.hash, waitCycleId: null, headRunId: null, mode: 'new', body: 'body', purpose: 'return_continuation',
          author: { kind: 'placement', placementId: placement.id }, submittedAt: new Date().toISOString(), deliveryState: 'queued' });
        if (fail) throw new Error('rolled back');
      });
    });
  } finally { control.close(); }
}
/** The same reads without what is kept. */
const plainly = <T>(root: string, read: () => T, release: () => void): { value: T; keepAgain: () => () => void } => {
  release();
  return { value: read(), keepAgain: () => keepControlTables(root) };
};

test('writes continue after history ordinals cross a decimal digit boundary', t => {
  const { root, task, placement } = fixture(t);
  const release = keepControlTables(root); t.after(release);
  const before = reader(root, db => new TaskRepository(root, db).get(task.id)).meta.log.length;
  for (let index = 0; index < 12; index++) write(root, task.id, placement);
  assert.equal(reader(root, db => new TaskRepository(root, db).get(task.id)).meta.log.length, before + 12);
});

test('sparse history ordinals allow appending and replaying the same comment', t => {
  const { root, task } = fixture(t);
  const db = new ControlStore(root);
  try {
    // Keep existing immutable rows intact and append a valid row after an ordinal gap.
    const event = { id: `L${randomUUID()}`, kind: 'reported', at: new Date().toISOString(),
      actor: { kind: 'human' }, title: 'sparse', description: null, fromState: null, toState: null };
    db.connection.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry)
      SELECT ?,id,100,? FROM tasks WHERE external_id=?`).run(event.id, JSON.stringify(event), task.id);
  } finally { db.close(); }
  const before = reader(root, db => new TaskRepository(root, db).get(task.id));
  const opId = randomUUID(), input = { taskId: task.id, title: 'after gap', actor: { kind: 'human' } as const, runId: null,
    expectedTaskHash: before.hash, opId };
  withControlWrite(root, tx => comment(tx, input));
  const after = reader(root, db => new TaskRepository(root, db).get(task.id));
  withControlWrite(root, tx => comment(tx, input));
  assert.equal(reader(root, db => new TaskRepository(root, db).get(task.id)).hash, after.hash);
  assert.equal(after.meta.log.filter(event => event.id === opId).length, 1);
});

test('kept rows read the same as all of them after each commit, and a read owns its log array', t => {
  const { root, project, task, placement } = fixture(t);
  let release = keepControlTables(root);
  t.after(() => release());
  for (let i = 0; i < 4; i++) {
    const kept = reader(root, db => tasks(root, db, project)), keptRequests = requests(root, project);
    const { value, keepAgain } = plainly(root, () => [reader(root, db => tasks(root, db, project)), requests(root, project)] as const, release);
    release = keepAgain();
    assert.deepEqual(kept, value[0]);
    assert.deepEqual(keptRequests, value[1]);
    const text = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item);
    assert.equal(text(kept), text(value[0]), 'the same key order: a screen compares rows as text');
    write(root, task.id, placement);
  }
  const [first, second] = [reader(root, db => tasks(root, db, project)), reader(root, db => tasks(root, db, project))];
  const log = first.find(item => item.id === task.id)!.meta.log;
  assert.ok(log.length > 2);
  assert.throws(() => { (log[0] as { title: string | null }).title = 'changed'; }, TypeError, 'a shared entry is frozen');
  assert.throws(() => log.pop(), TypeError, 'shared history cannot be changed by a reader');
  assert.ok(Object.isFrozen(second.find(item => item.id === task.id)!.meta.log));
});

test('targeted Task history shares frozen ordinary events only while kept, and follows rollback and changed text', t => {
  const { root, task } = fixture(t);
  const get = () => reader(root, db => new TaskRepository(root, db).get(task.id));
  const plain = get(), another = get();
  assert.notEqual(plain.meta.log[0], another.meta.log[0]);
  plain.meta.log[0]!.title = 'local edit';
  assert.notEqual(get().meta.log[0]!.title, 'local edit', 'one-shot readers own mutable events');
  const release = keepControlTables(root);
  try {
    const first = get(), second = get(), event = first.meta.log[0]!;
    assert.equal(second.meta.log[0], event);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.actor), 'nested values are frozen too');
    assert.throws(() => { event.title = 'outside'; }, TypeError);
    assert.throws(() => first.meta.log.pop(), TypeError, 'targeted readers share immutable history');
    assert.ok(Object.isFrozen(get().meta.log));

    const id = `L${randomUUID()}`;
    let pending: TaskLog | undefined;
    const append = (title: string, rollback: boolean): TaskLog => {
      const control = new ControlStore(root);
      try {
        return control.write(db => {
          const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
          try {
            return store.write(runs => {
              new TaskTransition().appendRecord({ store, runs }, task.id, { id, kind: 'reported',
                at: new Date().toISOString(), actor: { kind: 'human' }, title, description: null,
                fromState: null, toState: null });
              const current = new TaskRepository(root, db).get(task.id).meta.log.find(entry => entry.id === id)!;
              if (rollback) { pending = current; throw new Error('rolled back'); }
              return current;
            });
          } finally { store.close(); }
        });
      } finally { control.close(); }
    };
    assert.throws(() => append('First', true), /rolled back/);
    assert.ok(pending && Object.isFrozen(pending));
    assert.equal(get().meta.log.some(entry => entry.id === id), false, 'memo does not invent a rolled-back row');
    const committed = append('Other', false);
    assert.notEqual(committed, pending, 'same ID with different same-length text must decode again');
    assert.equal(committed.title, 'Other');
    assert.deepEqual(get().meta.log.find(entry => entry.id === id), committed);
    assert.equal(pending.title, 'First', 'an older retained event stays immutable');
  } finally { release(); }
  assert.equal(Object.isFrozen(get().meta.log[0]), false, 'releasing the server cache restores mutable decoding');
});

test('a write sees its own rows, and rows it rolled back are in no later read', t => {
  const { root, project, task, placement } = fixture(t);
  const release = keepControlTables(root);
  t.after(release);
  reader(root, db => tasks(root, db, project));
  requests(root, project);
  const before = reader(root, db => tasks(root, db, project)).find(item => item.id === task.id)!.meta.log.length;
  const beforeRequests = requests(root, project).length;
  const control = new ControlStore(root);
  try {
    assert.throws(() => control.write(db => {
      const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
      store.write(runs => {
        const entry = { id: `L${randomUUID()}`, kind: 'reported' as const, at: new Date().toISOString(),
          actor: { kind: 'human' as const }, title: 'gone', description: null, fromState: null, toState: null };
        new TaskTransition().appendRecord({ store, runs }, task.id, entry);
        const seen = tasks(root, db, project).find(item => item.id === task.id)!.meta.log;
        assert.equal(seen.length, before + 1);
        assert.equal(seen.at(-1)!.id, entry.id);
        runs.insertRequest({ id: 'Q-gone', taskId: task.id, placementId: placement.id, placementRevision: placement.revision,
          taskHash: new TaskRepository(root, db).get(task.id).hash, waitCycleId: null, headRunId: null, mode: 'new', body: 'gone',
          purpose: 'return_continuation', author: { kind: 'placement', placementId: placement.id }, submittedAt: new Date().toISOString(), deliveryState: 'queued' });
        assert.equal(runs.requests(project).filter(request => request.id === 'Q-gone').length, 1);
        runs.updateRequest('Q-gone', 'aborted');
        assert.equal(runs.getRequest('Q-gone')!.deliveryState, 'aborted');
        assert.equal(runs.requests(project).find(request => request.id === 'Q-gone')!.deliveryState, 'aborted');
        throw new Error('rolled back');
      });
    }), /rolled back/);
  } finally { control.close(); }
  assert.equal(reader(root, db => tasks(root, db, project)).find(item => item.id === task.id)!.meta.log.length, before);
  assert.equal(requests(root, project).length, beforeRequests);
  // The rowid the rolled-back rows had goes to other rows.
  write(root, task.id, placement);
  const after = reader(root, db => tasks(root, db, project)).find(item => item.id === task.id)!.meta.log;
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1)!.title, 'a note');
  assert.equal(requests(root, project).length, beforeRequests + 1);
});

test('a kept Request follows its delivery state; an older read point reads as it was', t => {
  const { root, project, task, placement } = fixture(t);
  const release = keepControlTables(root);
  t.after(release);
  write(root, task.id, placement);
  const [request] = requests(root, project);
  assert.equal(request!.deliveryState, 'queued');
  const older = new ControlStore(root, { busyTimeoutMs: 1000 }, true), db = older.connection;
  try {
    // This read point is fixed before the next writes, which a newer read then keeps.
    db.exec('BEGIN');
    const logs = tasks(root, db, project).find(item => item.id === task.id)!.meta.log.length;
    const store = new RunStore(root, { busyTimeoutMs: 1000 });
    try { store.write(runs => runs.updateRequest(request!.id, 'aborted')); } finally { store.close(); }
    write(root, task.id, placement);
    assert.equal(requests(root, project).find(item => item.id === request!.id)!.deliveryState, 'aborted');
    assert.equal(reader(root, other => tasks(root, other, project)).find(item => item.id === task.id)!.meta.log.length, logs + 1);
    assert.equal(tasks(root, db, project).find(item => item.id === task.id)!.meta.log.length, logs, 'kept rows newer than this read are not in it');
    db.exec('COMMIT');
  } finally { older.close(); }
});

test('a database put back is read as it now is', t => {
  const { root, project, task, placement } = fixture(t);
  const release = keepControlTables(root);
  t.after(release);
  reader(root, db => tasks(root, db, project));
  const saved = join(root, 'saved.sqlite'), live = controlDatabasePath(root);
  const checkpoint = new ControlStore(root);
  try { checkpoint.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { checkpoint.close(); }
  copyFileSync(live, saved);
  write(root, task.id, placement);
  const count = reader(root, db => tasks(root, db, project)).find(item => item.id === task.id)!.meta.log.length;
  const again = new ControlStore(root);
  try { again.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { again.close(); }
  copyFileSync(saved, live);
  assert.equal(reader(root, db => tasks(root, db, project)).find(item => item.id === task.id)!.meta.log.length, count - 1);
  write(root, task.id, placement);
  const log = reader(root, db => tasks(root, db, project)).find(item => item.id === task.id)!.meta.log;
  assert.equal(log.length, count);
  assert.equal(new Set(log.map(entry => entry.id)).size, log.length);
});

test('a decision shares a Run record only while its row reads the same', t => {
  const { root, project, task, placement } = fixture(t);
  const release = keepControlTables(root);
  t.after(release);
  write(root, task.id, placement);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const created = store.write(tx => createFixtureRun(store, tx, runFields({ task: task.id, placementId: placement.id, role: 'owner' }), 'prompt'));
    const started = new Date().toISOString();
    const [first, second] = store.write(tx => [tx.returnRuns(project)[0]!, tx.returnRuns(project)[0]!]);
    assert.equal(first, second, 'the same text is the same record');
    assert.ok(Object.isFrozen(first));
    const projected = store.runtimeDecidingGet(created.id)!;
    assert.ok(Object.isFrozen(projected));
    const mutable = store.runtimeGet(created.id)!;
    mutable.state = 'failed';
    assert.equal(projected.state, 'queued', 'an execution caller cannot change a shared projection record');
    assert.equal(store.get(created.id)!.state, 'queued', 'execution getters remain detached from storage too');
    assert.deepEqual(store.write(tx => tx.get(created.id)), first);
    assert.throws(() => store.write(tx => {
      tx.update({ ...tx.get(created.id)!, state: 'running', started_at: started });
      assert.equal(tx.returnRuns(project)[0]!.state, 'running', 'a write reads its own change');
      assert.equal(tx.ownerRunsWithoutLogs(project, ['LSTART'])[0]!.state, 'running');
      throw new Error('rolled back');
    }), /rolled back/);
    assert.equal(store.write(tx => tx.returnRuns(project)[0]!.state), 'queued', 'and not what it rolled back');
  } finally { store.close(); }
});
