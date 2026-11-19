/** A retained file is evidence, not a fresh execution failure every time it is seen. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock } from '@alpacawork/core';
import { RunReviewState } from '@alpacawork/backend/test-dist/runs/reviews.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { setup, until } from './runs-runtime.fixture.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { settle, settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { recoverExecution } from '@alpacawork/backend/test-dist/runs/recovery.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';

test('identical cleanup evidence does not change the projection revision; a skipped check retains it and repair clears it', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create(); h.finish(run);
  const file = join(h.store.folder(run.id), 'result.tmp');
  writeFileSync(file, 'different reply');
  const reviews = new RunReviewState();
  reviews.cleanup(h.store, h.store.get(run.id)!);
  const revision = reviews.revision;
  assert.equal(reviews.issues.length, 1);
  for (let i = 0; i < 3; i++) reviews.retryCleanup(h.store);
  assert.equal(reviews.revision, revision);
  const lock = openRunFile(h.store.folder(run.id), 'manager.lock', constants.O_RDWR);
  try { assert.equal(tryLock(lock), true); reviews.retryCleanup(h.store); }
  finally { closeSync(lock); }
  assert.equal(reviews.revision, revision); assert.equal(reviews.issues.length, 1);
  writeFileSync(file, h.store.getText(run.id)!.result!);
  reviews.retryCleanup(h.store);
  assert.equal(reviews.revision, revision + 1); assert.deepEqual(reviews.issues, []);
  reviews.retryCleanup(h.store); assert.equal(reviews.revision, revision + 1);
});

test('the last Run warning clears from the real screen after repair without a Task change', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create(); h.finish(run);
  const file = join(h.store.folder(run.id), 'result.tmp');
  writeFileSync(file, 'different reply');
  let fullPass = false;
  const original = console.error;
  t.mock.method(console, 'error', (value: unknown, ...rest: unknown[]) => {
    if (typeof value === 'string') try {
      const record = JSON.parse(value);
      if (record.timing) { if (record.step === 'pass' && record.reasons?.includes('fullCheck')) fullPass = true; return; }
    } catch { /* Preserve unrelated errors. */ }
    original(value, ...rest);
  });
  const app = await startServer(h.root, 0, { timing: true });
  try {
    const errors = () => JSON.parse(app.feed()!.index()).errors.filter((error: { path: string }) => error.path.endsWith('/result.tmp'));
    assert.equal(errors().length, 1);
    // Let startup's full pass finish; the repair must also clear on a cached-project pass.
    await until(() => fullPass, 'startup full reconciliation finished');
    writeFileSync(file, h.store.getText(run.id)!.result!);
    await until(() => !existsSync(file), 'matching evidence is cleaned on the periodic pass', 35000);
    await until(() => errors().length === 0, 'the last Run issue leaves the cached screen', 5000);
  } finally { await app.close(); }
});

for (const state of ['failed', 'needs_review'] as const) test(`an imported ${state} completion supersedes an earlier recovery failure`, async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, state: 'needs_review', reason: 'manager_lost' }));
  const folder = h.store.folder(run.id), held = folder + '-held';
  const reviews = new RunReviewState();
  renameSync(folder, held);
  try { await recoverExecution(h.store, reviews); } finally { renameSync(held, folder); }
  assert.equal(reviews.issues.length, 1);
  const journal = new EventJournal(executionFolder(h.root, run.id, launch.attemptId), identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'repaired-manager', bootId: 'fixture' });
  journal.append('completed', { outcome: { state, reason: state === 'failed' ? 'launch' : 'conversation_busy' }, session: null,
    measuredUsage: null, exit: { code: 1, signal: null }, result: { state: 'missing', digest: null, size: 0 } });
  await settle(h.store, undefined, undefined, reviews);
  assert.equal(h.store.get(run.id)!.state, state);
  assert.ok(h.store.connection.prepare('SELECT completed_digest FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.completed_digest);
  assert.deepEqual(reviews.issues, [], 'the completion supersedes the old recovery error even when the outcome still needs review');
});
