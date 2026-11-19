import { test } from 'node:test';
import { changeFixture } from './helpers/change-fixture.ts';
import assert from 'node:assert/strict';
import { ChangeLog, ControlStore, keepControlChanges, touch, type ChangeSeq } from '@alpacawork/db';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';

test('prepared reads keep caller configuration and active iterators private', t => {
  const { root, after } = changeFixture(t), store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  after(() => store.close());
  const db = store.connection, sql = 'SELECT CAST(? AS INTEGER) AS number';
  const earlier = db.prepare(sql), configured = db.prepare(sql); configured.setReadBigInts(true);
  assert.equal(earlier.get(7)!.number, 7, 'a previously prepared holder keeps its number mode');
  assert.equal(configured.get(7)!.number, 7n);
  assert.equal(db.prepare(sql).get(7)!.number, 7);
  const rows = 'SELECT external_id FROM tasks ORDER BY external_id';
  const all = db.prepare(rows).all();
  const held = db.prepare(rows), cursor = db.prepare(rows);
  for (const row of cursor.iterate()) {
    assert.deepEqual(held.all(), all, 'a previously prepared holder cannot invalidate this cursor');
    assert.deepEqual(db.prepare(rows).all(), all);
    assert(all.some(item => item.external_id === row.external_id));
  }
});


test('commits publish once, savepoints merge only released keys, and asynchronous writes use the same scope', async t => {
  const { root, after } = changeFixture(t), journal = keepControlChanges(root), log = journal.log;
  after(journal.close);
  const stop = log.register('projection', 0 as ChangeSeq); after(stop);
  const store = new ControlStore(root); after(() => store.close());
  const notices: number[] = [], unsubscribe = log.subscribe(seq => notices.push(seq)); after(unsubscribe);
  await store.writeOperationAsync({ opId: 'scope-test', operation: 'test', fingerprint: 'one' }, async () => {
    touch(store.connection, { kind: 'task', id: 'P1' });
    const nested = new ControlStore(root);
    try {
      nested.write(db => {
        db.prepare("UPDATE tasks SET title='Committed title' WHERE external_id='P1'").run();
        touch(db, { kind: 'task', id: 'P1' });
      });
      assert.throws(() => nested.write(db => {
        db.prepare("UPDATE tasks SET title='Rolled back title' WHERE external_id='P1'").run();
        touch(db, { kind: 'task', id: 'discarded' });
        throw new Error('rollback child');
      }), /rollback child/);
    } finally { nested.close(); }
    await Promise.resolve();
    const observed = { kind: 'config' as const, id: root };
    touch(store.connection, observed);
    observed.id = 'changed after touch';
    assert.equal(log.latest, 0, 'no notice escapes before the outer commit');
    return { status: 200, body: 'committed' };
  });
  assert.deepEqual(notices, [1], 'the notice is synchronous with successful outer commit');
  assert.deepEqual(log.read('projection'), { kind: 'changes', through: 1, batches: [{ seq: 1, keys: [
    { kind: 'task', id: 'P1' }, { kind: 'config', id: root },
  ] }] });
  assert.equal(store.connection.prepare("SELECT title FROM tasks WHERE external_id='P1'").get()!.title, 'Committed title');
  assert.throws(() => store.write(db => {
    db.prepare("UPDATE tasks SET title='Lost outer' WHERE external_id='P1'").run();
    touch(db, { kind: 'task', id: 'P1' });
    throw new Error('rollback outer');
  }), /rollback outer/);
  assert.equal(log.latest, 1);
  await assert.rejects(store.writeOperationAsync({ opId: 'scope-failure', operation: 'test', fingerprint: 'two' }, async () => {
    touch(store.connection, { kind: 'task', id: 'lost async' });
    throw new Error('rollback async');
  }), /rollback async/);
  assert.equal(log.latest, 1);
  const exec = store.connection.exec;
  const fault = t.mock.method(store.connection, 'exec', sql => {
    if (sql === 'COMMIT') throw new Error('commit failed');
    return exec(sql);
  });
  try {
    assert.throws(() => store.write(db => {
      db.prepare("UPDATE tasks SET title='Uncommitted' WHERE external_id='P1'").run();
      touch(db, { kind: 'task', id: 'P1' });
    }), /commit failed/);
    assert.equal(log.latest, 1, 'a failed COMMIT publishes no keys');
  } finally { fault.mock.restore(); }
  assert.equal(store.connection.prepare("SELECT title FROM tasks WHERE external_id='P1'").get()!.title, 'Committed title');
});

test('business statements refuse unmanaged transactions, cached statements and expired async contexts', async t => {
  const { root, after } = changeFixture(t), store = new ControlStore(root), journal = keepControlChanges(root);
  after(() => { journal.close(); store.close(); });
  const db = store.connection, sql = "UPDATE tasks SET title='Unmanaged' WHERE external_id='P1'";
  const cached = db.prepare(sql);
  assert.throws(() => cached.run(), /managed ChangeScope/);
  db.exec('BEGIN');
  try { assert.throws(() => db.exec(sql), /managed ChangeScope/); } finally { db.exec('ROLLBACK'); }
  store.read(() => assert.throws(() => db.prepare(sql + ' RETURNING external_id').get(), /managed ChangeScope/));
  let escaped!: () => void;
  store.write(() => {
    escaped = () => cached.run();
    cached.run();
    touch(db, { kind: 'task', id: 'P1' });
  });
  assert.throws(escaped, /managed ChangeScope/);
  let later!: Promise<unknown>;
  store.write(() => { later = Promise.resolve().then(() => assert.throws(() => cached.run(), /managed ChangeScope/)); });
  await later;
  let iterator!: IterableIterator<unknown>;
  store.write(() => { iterator = db.prepare(sql + ' RETURNING external_id').iterate(); });
  assert.throws(() => iterator.next(), /managed ChangeScope/);
  assert.throws(() => db.prepare("WITH marker AS (SELECT 1) UPDATE tasks SET title='No scope' WHERE external_id='P1' RETURNING external_id").all(),
    /managed ChangeScope/);
});

test('standalone placement writes publish and caught borrowed placement failures roll back their savepoint', t => {
  const { root, after } = changeFixture(t), journal = keepControlChanges(root);
  after(journal.close);
  const log = journal.log, stop = log.register('projection'); after(stop);
  const placements = new PlacementStore(root); after(() => placements.close());
  const { placement } = placements.createAndPlace({ taskId: 'T2', profileKey: 'codex', responsible: false });
  const read = log.read('projection');
  assert.equal(read.kind, 'changes');
  if (read.kind === 'changes') assert.deepEqual(read.batches.flatMap(batch => batch.keys), [{ kind: 'placement', id: placement.id }]);
  const store = new ControlStore(root); after(() => store.close());
  store.write(db => {
    const borrowed = new PlacementStore(root, false, db);
    try {
      assert.throws(() => borrowed.createAndPlace({ taskId: 'T2', profileKey: 'codex', responsible: false }, () => {
        throw new Error('failed placement');
      }), /failed placement/);
    } finally { borrowed.close(); }
  });
  assert.equal(log.latest, 1, 'rolled-back placement and its agent publish no change');
  assert.equal(placements.placements('T2').filter(p => p.profileKey === 'codex' && !p.responsible).length, 1);
});

test('a commit no key names sends every reader that has not passed it to read everything again', () => {
  const log = new ChangeLog(), projection = log.register('projection'), routing = log.register('routing');
  const named = log.append([{ kind: 'task', id: 'T1' }]);
  log.acknowledge('routing', named);
  let heard: ChangeSeq | undefined;
  const stop = log.subscribe(seq => { heard = seq; });
  const unknown = log.appendUnknown();
  assert.equal(heard, unknown, 'readers are woken as for a named commit');
  assert.deepEqual(log.read('projection'), { kind: 'overflow', through: unknown });
  assert.deepEqual(log.read('routing'), { kind: 'overflow', through: unknown });
  log.acknowledge('projection', unknown);
  const later = log.append([{ kind: 'task', id: 'T2' }]);
  assert.deepEqual(log.read('projection'), { kind: 'changes', through: later, batches: [{ seq: later, keys: [{ kind: 'task', id: 'T2' }] }] },
    'a reader that read everything again goes on with named changes');
  assert.equal(log.read('routing').kind, 'overflow', 'until it passes the unknown commit');
  stop(); projection(); routing();
});

test('journal waits for both readers and reports retention loss until that reader resynchronizes', () => {
  const log = new ChangeLog(2), projection = log.register('projection'), routing = log.register('routing');
  const one = log.append([{ kind: 'task', id: 'T1' }]);
  log.acknowledge('projection', one);
  assert.equal(log.read('routing').kind, 'changes');
  const two = log.append([{ kind: 'task', id: 'T2' }]);
  log.acknowledge('projection', two);
  const three = log.append([{ kind: 'task', id: 'T3' }]);
  assert.deepEqual(log.read('routing'), { kind: 'overflow', through: three });
  assert.deepEqual(log.read('projection'), { kind: 'changes', through: three,
    batches: [{ seq: three, keys: [{ kind: 'task', id: 'T3' }] }] });
  log.acknowledge('routing', two);
  log.acknowledge('projection', three);
  assert.equal(log.read('routing').kind, 'changes');
  assert.throws(() => log.acknowledge('projection', one), /backwards/);
  log.acknowledge('routing', three);
  assert.deepEqual(log.read('routing'), { kind: 'changes', through: three, batches: [] });
  projection(); routing();
});
