/** Exercise the built internal manager with isolated roots and fake agents only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { ServeLifecycle } from '@alpacawork/backend/test-dist/receiver/lifecycle.js';
import { closeSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { tryLock, unlock } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { controlDatabasePath } from '@alpacawork/db';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { launch, settle, settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { record } from './runs-fixtures.ts';

import { fake, now, setup, until } from './runs-runtime.fixture.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

test('a live Run is reconciled on a database change, not every second without change', async t => {
  const h = await setup(t), queued = h.create();
  h.store.write(tx => tx.update({ ...queued, state: 'running', started_at: now() }));
  const fd = openRunFile(h.store.folder(queued.id), 'manager.lock', constants.O_RDWR | constants.O_CREAT);
  assert.equal(tryLock(fd), true);
  const original = RunStore.prototype.write;
  let serverWrites = 0, completedPasses = 0;
  t.mock.method(RunStore.prototype, 'write', function(this: RunStore, ...args: Parameters<RunStore['write']>) {
    if (this !== h.store) serverWrites++;
    return Reflect.apply(original, this, args);
  });
  t.mock.method(console, 'error', (line: unknown) => {
    if (typeof line === 'string' && line.includes('"step":"pass"')) completedPasses++;
  });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const advance = async (seconds: number) => {
    for (let look = 0; look < seconds * 1000 / POLL_INTERVAL_MS; look++) { t.mock.timers.tick(POLL_INTERVAL_MS); await delay(5); }
  };
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(h.root, 0, { timing: true });
    await advance(5);
    await until(() => completedPasses > 0, 'first reconciliation pass');
    assert.ok(serverWrites > 0, 'the first pass reconciles the live Run');
    // Startup can commit its initial routing decisions; observe the steady state.
    await advance(3);
    const quiet = serverWrites;
    await advance(3);
    assert.equal(serverWrites, quiet, 'no periodic full reconciliation while the manager holds a live Run');
    h.store.write(tx => tx.update({ ...tx.get(queued.id)!, stop_requested: true }));
    await advance(3);
    await until(() => serverWrites > quiet, 'database commit wakes reconciliation', 4000);
  } finally {
    t.mock.timers.reset();
    await app?.close();
    unlock(fd); closeSync(fd);
  }
});

test('an idle serve settles Run liveness every 30 seconds and reads the tree only after a change or a five-minute repair pass', async t => {
  const h = await setup(t), run = h.create();
  h.store.write(tx => tx.update({ ...run, state: 'running', started_at: now() }));
  const fd = openRunFile(h.store.folder(run.id), 'manager.lock', constants.O_RDWR | constants.O_CREAT);
  assert.equal(tryLock(fd), true);
  let locked = true;
  const original = RunStore.prototype.write;
  let settles = 0, routes = 0, trees = 0;
  t.mock.method(RunStore.prototype, 'write', function(this: RunStore, ...args: Parameters<RunStore['write']>) {
    if (this !== h.store) settles++;
    return Reflect.apply(original, this, args);
  });
  const pass = ReturnRouter.prototype.pass;
  t.mock.method(ReturnRouter.prototype, 'pass', function(this: ReturnRouter, ...args: Parameters<ReturnRouter['pass']>) {
    routes++;
    return Reflect.apply(pass, this, args);
  });
  t.mock.method(console, 'error', (line: unknown) => {
    if (typeof line === 'string' && line.includes('"step":"tree"')) trees++;
  });
  // A fake second must not overtake work accepted by the previous tick. In an
  // all run, routing and projection can outlive any fixed real-time sleep.
  const work = ServeLifecycle.prototype.run;
  let active = 0;
  t.mock.method(ServeLifecycle.prototype, 'run', function<T>(this: ServeLifecycle, operation: () => T | Promise<T>) {
    active++;
    return (Reflect.apply(work, this, [operation]) as Promise<T>).finally(() => { active--; });
  });
  // The serve interval and its clock move only when the test advances them.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const advance = async (seconds: number) => {
    for (let look = 0; look < seconds * 1000 / POLL_INTERVAL_MS; look++) {
      t.mock.timers.tick(POLL_INTERVAL_MS);
      await yieldTurn();
      await until(() => active === 0, 'serve completes accepted work before the next fake look');
    }
  };
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(h.root, 0, { timing: true });
    // A first pass may record the already-running owner's Task transition;
    // let its notification settle before measuring an idle interval.
    await advance(70);
    const quiet = { settles, routes, trees };
    assert.ok(quiet.settles > 0 && quiet.trees > 0, 'the first pass settled and read the tree');
    await advance(65);
    assert.deepEqual({ routes, trees }, { routes: quiet.routes, trees: quiet.trees },
      'no notification, so no routing pass and no tree read');
    assert.ok(settles > quiet.settles, 'periodic Run liveness checks continue without routing or tree reads');
    unlock(fd); closeSync(fd); locked = false;
    await advance(31);
    assert.notEqual(h.store.get(run.id)?.state, 'running', 'the periodic settle finds the lost manager');
    assert.ok(trees > quiet.trees, 'the settled change reaches the tree');
    const settled = { routes, trees };
    await advance(210);
    assert.deepEqual({ routes: routes - settled.routes, trees: trees - settled.trees }, { routes: 1, trees: 1 },
      'one repair pass in five minutes bounds a lost notification');
  } finally {
    t.mock.timers.reset();
    await app?.close();
    if (locked) { unlock(fd); closeSync(fd); }
  }
});

test('quiesce waits for an accepted launch-failure write and releases its lock after commit', { timeout: 30_000 }, async t => {
  const h = await setup(t), run = h.create();
  // Serve launches and settles here; the fixture's own pass would block on the held lock for its busy timeout.
  h.pauseProjection();
  const holder = new DatabaseSync(controlDatabasePath(h.root));
  const app = await startServer(h.root, 0);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  let intercepted = false, closing: Promise<void> | undefined;
  Object.defineProperty(process, 'execPath', { configurable: true, get() {
    Object.defineProperty(process, 'execPath', descriptor);
    holder.exec('BEGIN IMMEDIATE'); intercepted = true; return join(h.root, 'missing-node');
  } });
  t.mock.method(console, 'log', () => {});
  try {
    await until(() => intercepted && readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8').includes('Manager launch failed'), 'failed launch awaits its save');
    let closed=false;closing=app.close().then(()=>{closed=true});await delay(100);
    assert.equal(closed,false,'accepted launch transaction must not be abandoned by quiesce');
    assert.equal(h.store.get(run.id)!.state,'running');holder.exec('ROLLBACK');await closing;
    assert.equal(h.store.get(run.id)!.state,'failed');assert.equal(h.store.get(run.id)!.reason,'launch');
    const fd=openRunFile(h.store.folder(run.id),'manager.lock',constants.O_RDWR);try{assert.equal(tryLock(fd),true)}finally{closeSync(fd)}
  } finally {
    Object.defineProperty(process,'execPath',descriptor);if(holder.isTransaction)holder.exec('ROLLBACK');holder.close();await(closing??app.close());
  }
});

test('a failed launch log write cannot prevent failed(launch)', async t => {
  const h = await setup(t);
  const run = h.create(), original = fs.writeSync;
  let faults = 0;
  const write = t.mock.method(fs, 'writeSync', (...args: Parameters<typeof fs.writeSync>) => {
    if (typeof args[1] === 'string' && args[1].startsWith('Manager launch failed:')) {
      faults++; throw Object.assign(new Error('injected log full'), { code: 'ENOSPC' });
    }
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const result = await launch(h.store, await settleTransaction(h.store, readAgentsSettings(h.root)), { script: join(h.root, 'missing-manager.js') });
    assert.equal(faults, 1); assert.deepEqual(result.failed, [run.id]);
    const failed = h.store.get(run.id)!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'launch');
    assert.deepEqual((await h.tick()).lost, []);
  } finally { write.mock.restore(); syncBuiltinESMExports(); }
});
