/** Execution journals must progress when an otherwise live filesystem watch misses a notification. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { digestBytes, publishImmutable } from '@alpacawork/core';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { setup } from './runs-runtime.fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { ServeLifecycle } from '@alpacawork/backend/test-dist/receiver/lifecycle.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';

for (const { coordinator, resting } of [
  { coordinator: false, resting: false }, { coordinator: true, resting: false }, { coordinator: false, resting: true },
]) test(`serve imports a completed ${coordinator ? 'coordinator' : 'task'} journal${resting ? ' during the tree rest' : ''} without a watch notification`, async t => {
  const clock = receiverClock(t);
  const h = await setup(t); h.pauseProjection();
  const run = coordinator ? h.createCoordinator() : h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
  t.after(() => closeLaunches(decision.launches));
  const launch = attemptOf(h.store, run.id)!;
  const folder = executionFolder(h.root, run.id, launch.attemptId);
  const journal = new EventJournal(folder, identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  journal.append('spawn_intent', { initialInputId: launch.initialInputId });
  journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: run.id, contentDigest: digestBytes(launch.prompt) });
  journal.append('input_taken', { inputId: launch.initialInputId, receipt: { evidence: 'invocation_completed' } });

  // A watch which remains open but delivers no event models a missed notification. Do not mock the Importer,
  // execution bytes, database, or its data_version observer, and do not fall back by throwing from watch().
  const watch = t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close() {} }));
  syncBuiltinESMExports();
  // Observe completion of the real server work instead of racing a projection still awaiting filesystem I/O.
  const pending = new Set<Promise<unknown>>();
  const originalRun = ServeLifecycle.prototype.run;
  t.mock.method(ServeLifecycle.prototype, 'run', function<T>(this: ServeLifecycle, work: () => T | Promise<T>): Promise<T> {
    const result = Reflect.apply(originalRun, this, [work]) as Promise<T>;
    if (this.workspace === h.root) {
      pending.add(result);
      void result.finally(() => pending.delete(result)).catch(() => undefined);
    }
    return result;
  });
  const imports = t.mock.method(RunEventImporter.prototype, 'pass');
  if (resting) {
    // One costly routing pass leaves a real pacing gap, without making the test wait for it.
    const now = performance.now.bind(performance);
    let elapsed = 0;
    t.mock.method(performance, 'now', () => now() + elapsed);
    const route = ReturnRouter.prototype.pass;
    t.mock.method(ReturnRouter.prototype, 'pass', async function(this: ReturnRouter, ...args: Parameters<typeof route>) {
      const result = await route.apply(this, args);
      if (this.root === h.root && elapsed === 0) elapsed = 2_000;
      return result;
    });
  }
  const server = await startServer(h.root, 0);
  try {
    const turn = async () => {
      await clock.advance(1_000);
      while (pending.size) await Promise.all([...pending]);
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    // Drain startup and the database changes made by its own import before publishing a filesystem-only tail.
    for (let n = 0; n < (resting ? 1 : 4); n++) await turn();
    assert.equal(h.store.runtimeGet(run.id)!.state, 'running');
    assert.equal(h.store.connection.prepare('SELECT next_seq FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.next_seq, 5);
    const before = imports.mock.callCount();
    await turn();
    assert.equal(imports.mock.callCount(), before, 'an empty live journal does not demand a full pass');
    const text = Buffer.from('a completed invocation whose notification was lost');
    const digest = digestBytes(text);
    publishImmutable(join(folder, 'results'), `${digest}.bin`, text);
    journal.append('completed', { outcome: { state: 'succeeded', reason: null }, session: launch.invocation.session?.id ?? null,
      measuredUsage: null, exit: { code: 0, signal: null }, result: { state: 'present', digest, size: text.length } });
    closeLaunches(decision.launches);
    await turn();
    assert.equal(h.store.runtimeGet(run.id)!.state, 'succeeded');
    assert.equal(h.store.getText(run.id)!.result, text.toString());
    const cursor = h.store.connection.prepare('SELECT next_seq,acked_seq FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
    assert.equal(cursor.next_seq, 6);
    assert.equal(cursor.acked_seq, 5);
    if (!coordinator) assert.equal(h.store.connection.prepare('SELECT dirty FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.dirty, 0,
      'accepted completion is routed before the pass ends, including during the tree rest');
    assert.equal(new RunEventImporter(h.store).hasPublishedTail(), false, 'completed and acknowledged history has no demand');
  } finally { await server.close(); watch.mock.restore(); syncBuiltinESMExports(); }
});

// Presence is only a scheduling hint; protocol validation and fault diagnosis remain with the real import pass.
test('the journal probe detects ack recovery and unsafe input but does not fast-poll a diagnosed fault', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
  t.after(() => closeLaunches(decision.launches));
  const launch = attemptOf(h.store, run.id)!;
  const folder = executionFolder(h.root, run.id, launch.attemptId);
  const journal = new EventJournal(folder, identityOf(launch));
  const importer = new RunEventImporter(h.store);
  assert.equal(importer.hasPublishedTail(), false);
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  assert.equal(importer.hasPublishedTail(), true);
  importer.pass();
  assert.equal(importer.hasPublishedTail(), false);
  h.store.write(() => h.store.connection.prepare('UPDATE run_attempts SET acked_seq=0 WHERE attempt_id=?').run(launch.attemptId));
  assert.equal(importer.hasPublishedTail(), true);
  importer.pass();
  assert.equal(importer.hasPublishedTail(), false);
  publishImmutable(join(folder, 'events'), '000000000002.json', '{invalid');
  assert.equal(importer.hasPublishedTail(), true);
  importer.pass();
  assert.match(String(h.store.connection.prepare('SELECT diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.diagnostic), /execution_fault/);
  assert.notEqual(h.store.runtimeGet(run.id)!.state, 'succeeded');
  assert.equal(importer.hasPublishedTail(), false);
});
