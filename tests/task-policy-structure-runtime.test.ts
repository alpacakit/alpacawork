import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFlow } from './task-flow.fixture.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { readControlTree } from './helpers/control-tree.ts';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { decide, closeLaunches, type RunLaunch } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { startDecision } from '@alpacawork/backend/test-dist/control/task-start-facts.js';
import { laneAhead } from '@alpacawork/runs';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';

test('a manager_lost worker remains unfinished execution until reconciliation closes it', async t => {
  const h = await handlingFixture(t), owner = await h.human(); await h.start(owner.runId);
  const worker = await h.delegate(owner.runId); await h.start(worker.runId); h.end(owner.runId); h.reconcile();
  const summary = h.store.write(tx => decide(tx, { store: h.store, settings: readAgentsSettings(h.root), launches: [],
    prepared: new Set(), folderFailures: new Map(), unmanaged: new Map([[worker.runId, -1]]) }));
  assert.deepEqual(summary.lost, [worker.runId]);
  const tree = await readControlTree(h.root);
  assert.ok(tree.working!.includes(h.task.id));
  assert.equal(tree.balls[h.task.id]?.holder, 'child');
  h.store.write(tx => tx.update({ ...tx.get(worker.runId)!, state: 'needs_review', reason: 'conversation_busy' }));
  assert.ok((await readControlTree(h.root)).working!.includes(h.task.id));
});

test('a queued instruction must not permanently block a fresh user request after an ordinary move', async t => {
  const f = await taskFlow(t), a = await f.task('A'), b = await f.task('B'), child = await f.task('Child', { parentId: a.id });
  const old = await f.request(child);
  await f.commands.move({ id: child.id, parentId: b.id, expectedTaskHash: (await f.get(child.id)).hash });
  const retry = await f.request(child);
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  const oldRequest = f.run(old).requestId;
  f.store(s => s.connection.exec(`CREATE TRIGGER reject_abort BEFORE UPDATE ON runs WHEN OLD.request_id='${oldRequest}' AND NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'abort-fault'); END`));
  assert.throws(() => f.store(store => store.write(tx => decide(tx, { store, settings: readAgentsSettings(f.root), launches: [], prepared: new Set(), folderFailures: new Map(), unmanaged: new Map() }))), /abort-fault/);
  assert.equal(f.run(old).state, 'queued');
  assert.equal(f.store(s => s.getRequest(oldRequest)).deliveryState, 'queued');
  f.store(s => s.connection.exec('DROP TRIGGER reject_abort'));
  const details = f.store(store => store.write(tx => {
    const oldDecision = startDecision(store.connection, f.run(old).requestId, child.id);
    const newDecision = startDecision(store.connection, f.run(retry).requestId, child.id);
    const summary = decide(tx, { store, settings: readAgentsSettings(f.root), launches: [],
      prepared: new Set(), folderFailures: new Map(), unmanaged: new Map() });
    return { oldDecision, newDecision, summary, old: tx.get(old.runId), retry: tx.get(retry.runId),
      laneAhead: laneAhead(tx.forSettle(), tx.get(retry.runId)!, new Set(), new Set()) };
  }));
  assert.equal(details.newDecision.kind, 'keep');
  assert.equal(details.old.state, 'cancelled');
  assert.equal(f.store(s => s.getRequest(f.run(old).requestId)).deliveryState, 'queued');
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  const before = (await f.get(child.id)).meta.log;
  await new ReturnRouter(f.root).pass(undefined, { project: f.project });
  f.store(store => store.write(tx => decide(tx, { store, settings: readAgentsSettings(f.root), launches: [], prepared: new Set(), folderFailures: new Map(), unmanaged: new Map() })));
  assert.deepEqual((await f.get(child.id)).meta.log, before, 'recovery cannot duplicate a Task history entry');
  assert.equal(details.laneAhead, null, 'a permanently rejected old fence cannot hold all new instructions behind it');
  const launches: RunLaunch[] = [];
  try {
    f.store(store => {
      store.prepareFolder(retry.runId);
      return store.write(tx => decide(tx, { store, settings: readAgentsSettings(f.root), launches,
        prepared: new Set([retry.runId]), folderFailures: new Map(), unmanaged: new Map() }));
    });
    assert.equal(f.run(retry).state, 'running');
    assert.deepEqual(launches.map(item => item.id), [retry.runId]);
  } finally { closeLaunches(launches); }
});

test('error plus open question preserves original askedTo, what it asked and hold', async t => {
  const f = await taskFlow(t), task = await f.task('Failure question', { userRequested: true }), run = await f.work(task);
  const question = await f.ask(run, 'user'); await f.person(task.id, 'held'); f.end(run, 'failed');
  const tree = await readControlTree(f.root);
  const asked = tree.tasks.find(row => row.id === task.id)!.log.find(entry => entry.id === question)!;
  assert.equal(tree.tasks.find(row => row.id === task.id)!.hold, true);
  assert.equal(tree.balls[task.id]?.holder, 'user');
  assert.deepEqual([asked.askedTo, asked.decide], [null, [{ decide_kind: 'choose', decide_question: 'Which way?' }]]);
  await f.answer(task.id, question);
  assert.deepEqual([(await f.get(task.id)).meta.baseState, (await f.get(task.id)).meta.hold], ['error', true]);
});
