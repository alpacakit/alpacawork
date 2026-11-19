/** Shared routing facts must remain current at every transaction that can decide business work. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ControlStore, keepControlChanges } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { ControlReadContext, controlReadContext } from '@alpacawork/backend/test-dist/control/read-context.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { ReturnRouter, type RoutingWrite } from '@alpacawork/backend/test-dist/control/return-router.js';
import { handlingFixture } from './return-handling.fixture.ts';
import { taskFlow } from './task-flow.fixture.ts';
import type { ChangeSeq } from '@alpacawork/db';

async function fixture(t: TestContext) {
  const owned: { context?: ControlReadContext } = {};
  t.after(() => owned.context?.close());
  const h = await handlingFixture(t), request = await h.human();
  const journal = keepControlChanges(h.root);
  t.after(() => journal.close());
  const context = owned.context = new ControlReadContext(new ControlStore(h.root, { busyTimeoutMs: 1_000 }));
  const read = () => {
    const runs = new RunStore(h.root, { busyTimeoutMs: 1_000 }, true, context.connection);
    try {
      return { taskHash: new TaskRepository(h.root, context.connection).get(h.task.id).hash,
        run: runs.get(request.runId)! };
    } finally { runs.close(); }
  };
  const facts = () => context.get('seat', read);
  const start = (store = h.store) => store.write(tx => tx.update({ ...tx.get(request.runId)!, state: 'running',
    started_at: new Date().toISOString() }));
  const startHere = () => {
    const runs = new RunStore(h.root, { busyTimeoutMs: 1_000 }, false, context.connection);
    try { start(runs); } finally { runs.close(); }
  };
  return { ...h, context, journal, request, facts, startHere, startElsewhere: () => start() };
}

test('one context shares immutable preparation facts and observes another connection changing a Run without changing its Task', async t => {
  const h = await fixture(t);
  const prepared = await h.context.prepare(async () => {
    assert.equal(controlReadContext(h.context.connection), h.context);
    return h.facts();
  });
  assert.equal(prepared.run.state, 'queued');
  assert(Object.isFrozen(prepared.run));
  h.context.write(db => {
    assert.equal(controlReadContext(db), h.context);
    assert.equal(h.facts(), prepared, 'the unchanged facts are shared across the preparation and write');
  });
  h.startElsewhere();
  const current = h.context.write(() => h.facts());
  assert.equal(current.taskHash, prepared.taskHash, 'execution state changes independently of the Task revision');
  assert.equal(current.run.state, 'running');
  assert.equal(prepared.run.state, 'queued', 'a previously returned fact remains immutable');
  assert.equal(controlReadContext(h.context.connection), undefined);
});

test('a commit while preparation yields cannot publish its older snapshot as the next write facts', async t => {
  const h = await fixture(t);
  let prepared!: () => void, resume!: () => void;
  const selected = new Promise<void>(resolve => { prepared = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const preparing = h.context.prepare(async () => {
    const before = h.facts();
    prepared();
    await paused;
    const sameSnapshot = h.facts();
    assert.equal(sameSnapshot.run.state, before.run.state);
    return sameSnapshot;
  });
  await selected;
  try { h.startElsewhere(); } finally { resume(); }
  const previous = await preparing;
  assert.equal(previous.run.state, 'queued', 'the active SQLite read snapshot remains coherent');
  const current = h.context.write(() => h.facts());
  assert.equal(current.taskHash, previous.taskHash);
  assert.equal(current.run.state, 'running', 'the next business transaction reads the committed execution state');
});

test('writes observe their own execution changes after sharing prepared facts', async t => {
  const h = await fixture(t);
  const previous = await h.context.prepare(async () => h.facts());
  h.context.write(() => {
    assert.equal(h.facts().run.state, 'queued');
    h.startHere();
    assert.equal(h.facts().run.state, 'running', 'the first mutation ends memo reuse inside this write');
  });
  assert.equal(h.context.write(() => h.facts()).run.state, 'running');
  assert.equal(previous.run.state, 'queued');
});

test('rolling back a nested savepoint cannot leave an uncommitted Run in the shared facts', async t => {
  const h = await fixture(t);
  await h.context.prepare(async () => h.facts());
  h.context.write(db => {
    db.exec('SAVEPOINT fixture_run');
    h.startHere();
    assert.equal(h.facts().run.state, 'running');
    db.exec('ROLLBACK TO fixture_run');
    db.exec('RELEASE fixture_run');
    assert.equal(h.facts().run.state, 'queued', 'rollback restores the current fact after the transaction has touched it');
  });
  assert.equal(h.context.write(() => h.facts()).run.state, 'queued');
});

test('a failed write cannot carry rolled-back execution facts into a retry', async t => {
  const h = await fixture(t);
  await h.context.prepare(async () => h.facts());
  const change = () => {
    h.startHere();
    assert.equal(h.facts().run.state, 'running');
    throw new Error('Synthetic business write failure');
  };
  assert.throws(() => h.context.write(change), /Synthetic business write failure/);
  assert.equal(h.store.get(h.request.runId)!.state, 'queued');
  assert.equal(h.context.write(() => h.facts()).run.state, 'queued', 'retry reads the rolled-back database state');
});

test('failed asynchronous preparation releases its read transaction before a later business write', async t => {
  const h = await fixture(t);
  await assert.rejects(h.context.prepare(async () => {
    assert.equal(h.facts().run.state, 'queued');
    await nextTurn();
    throw new Error('Synthetic preparation failure');
  }), /Synthetic preparation failure/);
  h.startElsewhere();
  assert.equal(h.context.write(() => h.facts()).run.state, 'running');
  assert.equal(controlReadContext(h.context.connection), undefined);
});

test('routing clears a question withdrawn after preparation even when the receiving Task did not change', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Receiving seat'), child = await f.task('Question origin', { parentId: parent.id });
  const owner = await f.work(parent), working = await f.work(child, owner);
  const question = await f.ask(working, parent.id), before = await f.get(parent.id);
  const journal = keepControlChanges(f.root);
  t.after(() => journal.close());
  let withdraw = true;
  const ordered: RoutingWrite = async execute => {
    if (withdraw) {
      withdraw = false;
      await f.withdraw(working, question);
      assert.equal((await f.get(parent.id)).hash, before.hash, 'the changed origin is independent of the receiving Task revision');
    }
    return execute();
  };
  const result = await new ReturnRouter(f.root).route({ tasks: new Set([parent.id]),
    after: 0 as ChangeSeq, through: 1 as ChangeSeq, mode: 'changed' }, undefined, ordered);
  assert.equal(result.completed, true);
  assert.deepEqual(result.acceptedRequestIds, [], 'an obsolete question must not wake the receiving seat');
  const notice = f.store(store => store.readReturns().find(row => row.causeLogId === question));
  assert(notice);
  assert.equal(notice.resolution?.reason, 'question_closed', 'the new closing fact is reconciled in this pass');
  assert.deepEqual(notice.deliveries, []);
});


test('repeated changes to the same Run inside a parent transaction invalidate shared facts', async t => {
  const h = await fixture(t);
  const writer = new ControlStore(h.root);
  t.after(() => writer.close());
  writer.write(() => {
    const runs = new RunStore(h.root, { busyTimeoutMs: 1_000 }, false, writer.connection);
    try {
      runs.write(tx => tx.update({ ...tx.get(h.request.runId)!, state: 'running', started_at: new Date().toISOString() }));
      const nested = new ControlReadContext(new ControlStore(h.root));
      try {
        const read = () => nested.get('execution', () => runs.get(h.request.runId)!);
        nested.write(() => {
          assert.equal(read().state, 'running');
          const revisedStart = '2026-11-16T14:00:00.000Z';
          runs.write(tx => tx.update({ ...tx.get(h.request.runId)!, started_at: revisedStart }));
          assert.equal(read().started_at, revisedStart, 'deduplicating a touched key must not hide a later mutation');
        });
      } finally { nested.close(); }
    } finally { runs.close(); }
  });
});

test('facts read inside a rolled-back parent transaction cannot escape to the next transaction', async t => {
  const h = await fixture(t);
  const parent = new ControlStore(h.root);
  t.after(() => parent.close());
  let nested: ControlReadContext | undefined;
  try {
    assert.throws(() => parent.write(() => {
      const runs = new RunStore(h.root, { busyTimeoutMs: 1_000 }, false, parent.connection);
      try {
        runs.write(tx => tx.update({ ...tx.get(h.request.runId)!, state: 'running', started_at: new Date().toISOString() }));
        nested = new ControlReadContext(new ControlStore(h.root));
        const read = () => nested!.get('execution', () => runs.get(h.request.runId)!);
        assert.equal(nested.write(() => read()).state, 'running');
      } finally { runs.close(); }
      throw new Error('Rollback parent');
    }), /Rollback parent/);
    assert(nested);
    assert.equal(nested.write(() => nested!.get('execution', () => h.store.get(h.request.runId)!)).state, 'queued');
  } finally { nested?.close(); }
});

test('facts are not shared without an active workspace change journal', async t => {
  const h = await fixture(t);
  h.journal.close();
  const before = await h.context.prepare(async () => h.facts());
  h.startElsewhere();
  const after = h.context.write(() => h.facts());
  assert.equal(before.run.state, 'queued');
  assert.equal(after.run.state, 'running');
});


test('an enclosing old read snapshot cannot label cached facts with a later journal position', async t => {
  const h = await fixture(t), db = h.context.connection;
  db.exec('BEGIN');
  try {
    assert.equal(db.prepare('SELECT state FROM runs WHERE id=?').get(Number(h.request.runId.slice(1)))!.state, 'queued');
    h.startElsewhere();
    assert.equal((await h.context.prepare(async () => h.facts())).run.state, 'queued', 'the enclosing snapshot remains coherent');
  } finally { db.exec('COMMIT'); }
  assert.equal(h.context.write(() => h.facts()).run.state, 'running', 'the next transaction reads the later commit');
});
