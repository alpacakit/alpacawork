/** Demand is derived from the committed cursor; notifications are not execution evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { RunStore } from '@alpacawork/runs';
import { setup, until } from './runs-runtime.fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

const finish = { outcome: { state: 'failed' as const, reason: 'launch' as const }, session: null, measuredUsage: null,
  exit: { code: 1, signal: null }, result: { state: 'missing' as const, digest: null, size: 0 } };

test('cursor demand is read-only, acknowledges completed attempts and replays without another result', async t => {
  const h = await setup(t); h.pauseProjection();
  const runs = [h.create(), h.createIndependent()];
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const importer = new RunEventImporter(h.store), db = h.store.connection;
  assert.equal(importer.hasPublishedTail(), false);
  const before = db.prepare('SELECT total_changes() AS n').get()!.n;
  for (let n = 0; n < 4; n++) assert.equal(importer.hasPublishedTail(), false);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before);
  for (const run of runs) {
    const launch = attemptOf(h.store, run.id)!;
    assert.ok(launch, 'both independent Runs have attempts');
    const journal = new EventJournal(executionFolder(h.root, run.id, launch.attemptId), identityOf(launch));
    journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
    journal.append('completed', finish);
  }
  assert.equal(importer.hasPublishedTail(), true);
  assert.deepEqual(importer.pass(), runs.map(run => run.id));
  assert.equal(importer.hasPublishedTail(), false);
  const completed = db.prepare('SELECT * FROM run_attempts ORDER BY run_no').all();
  h.store.write(() => db.prepare('UPDATE run_attempts SET acked_seq=0').run());
  assert.equal(importer.hasPublishedTail(), true, 'completion still owes its commit-following ack');
  importer.pass();
  assert.deepEqual(db.prepare('SELECT * FROM run_attempts ORDER BY run_no').all(), completed);
  assert.equal(importer.hasPublishedTail(), false);
  const settled = db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual(importer.pass(), []);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, settled);
});

test('demand defers diagnosed faults to repair and leaves sequence and result validation to pass', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create(), decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!, folder = executionFolder(h.root, run.id, launch.attemptId);
  const journal = new EventJournal(folder, identityOf(launch)), importer = new RunEventImporter(h.store), db = h.store.connection;
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  importer.pass();
  journal.append('completed', finish);
  renameSync(join(folder, 'events', '000000000002.json'), join(folder, 'events', '000000000003.json'));
  assert.equal(importer.hasPublishedTail(), false, 'a gap is found by the existing repair pass, not by a second directory scan');
  importer.pass();
  assert.match(String(db.prepare('SELECT diagnostic FROM run_attempts').get()!.diagnostic), /sequence gap/);
  renameSync(join(folder, 'events', '000000000003.json'), join(folder, 'events', '000000000002.json'));
  assert.equal(importer.hasPublishedTail(), false, 'diagnosed faults do not retry each tick, even with an ack deficit');
  importer.pass();
  assert.equal(importer.hasPublishedTail(), false);
  assert.equal(db.prepare('SELECT diagnostic FROM run_attempts').get()!.diagnostic, null);
});

test('resource, permission and SQL faults request the owning pass instead of escaping the interval or hiding absence', async t => {
  const h = await setup(t); h.pauseProjection(); h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const importer = new RunEventImporter(h.store);
  for (const code of ['EACCES', 'EMFILE', 'EIO', 'ENOENT']) {
    const stat = t.mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error(code), { code }); });
    syncBuiltinESMExports();
    try { assert.equal(importer.hasPublishedTail(), code !== 'ENOENT', code); }
    finally { stat.mock.restore(); syncBuiltinESMExports(); }
  }
  const prepare = h.store.connection.prepare;
  const mock = t.mock.method(h.store.connection, 'prepare', () => { throw new Error('SQLfault'); });
  assert.equal(importer.hasPublishedTail(), true);
  mock.mock.restore();
  assert.equal(h.store.connection.prepare, prepare);
});

for (const mode of ['child', 'silent'] as const) test(`serve imports two real managers with ${mode} watch loss, then stays quiet`, { timeout: 45_000 }, async t => {
  const h = await setup(t); h.pauseProjection();
  const gates = [h.gate('one'), h.gate('two')];
  const runs = [h.create('plain', { gate: gates[0], result: 'one' }), h.createIndependent('plain', { gate: gates[1], result: 'two' })];
  const originalWatch = fs.watch;
  // Fail the directory-only Owner's first child, independent of enumeration order; discard every native hint.
  const watchPaths: string[] = [];
  const active = new Set<Pick<fs.FSWatcher, 'on' | 'close'>>();
  let injected = 0, callbacks = 0, registered = 0;
  const native = (path: fs.PathLike, options?: fs.WatchOptions | string | ((...args: unknown[]) => void), listener?: (...args: unknown[]) => void) => {
    assert.equal(typeof options === 'object' && options?.recursive, false, 'the real Owner requests directory-only native subscriptions');
    watchPaths.push(String(path));
    if (injected === 0 && (mode === 'child' && String(path).startsWith(h.root + '/'))) {
      injected++;
      throw Object.assign(new Error(`injected ${mode} EMFILE`), { code: 'EMFILE' });
    }
    // Failure/recovery is controlled at the native boundary; only silent mode needs real OS hints.
    const watcher: Pick<fs.FSWatcher, 'on' | 'close'> = mode === 'silent'
      ? Reflect.apply(originalWatch, fs, [path, options, () => { callbacks++; /* deliberately lose every hint */ }])
      : Object.assign(new EventEmitter(), { close() {} });
    registered++; active.add(watcher);
    const close = watcher.close.bind(watcher);
    watcher.close = () => { active.delete(watcher); close(); };
    return watcher;
  };
  fs.watch = native as typeof fs.watch; syncBuiltinESMExports();
  // Keep losing hints, but inject only during the initial registration, never later child discovery.
  t.after(() => { fs.watch = originalWatch; syncBuiltinESMExports(); });
  let recovered = mode === 'silent';
  const originalError = console.error;
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string') {
      try { if (JSON.parse(args[0]).workspaceWatch?.state === 'recovered') recovered = true; } catch {}
    }
    Reflect.apply(originalError, console, args);
  });
  let passes = 0;
  const originalPass = RunEventImporter.prototype.pass;
  t.mock.method(RunEventImporter.prototype, 'pass', function(this: RunEventImporter, ...args: Parameters<RunEventImporter['pass']>) {
    passes++; return Reflect.apply(originalPass, this, args);
  });
  const app = await startServer(h.root, 0);
  try {
    t.diagnostic(JSON.stringify({ phase: 'started', mode, root: h.root, url: app.url, pid: process.pid, deadline: new Date(Date.now() + 45_000).toISOString() }));
    t.diagnostic(JSON.stringify({ mode, injected, registered, watchPaths }));
    assert.equal(watchPaths[0], h.root, 'the initial root registration actually ran');
    assert.equal(injected, mode === 'silent' ? 0 : 1, 'the intended registration failure was injected');
    assert.equal(active.size, mode === 'silent' ? registered : 0, 'partial failure closes every registered directory');
    if (mode === 'child') assert.ok(registered > 0, 'some watches registered before child failure');
    await until(() => runs.every(run => fs.existsSync(join(h.root, 'processes')) && h.store.runtimeGet(run.id)?.pids.agent), 'both real managers start');
    // Release only after startup's passes are quiet (one tick and a margin). No DB write or HTTP read can announce these completions.
    await delay(POLL_INTERVAL_MS + 200);
    for (const gate of gates) writeFileSync(gate, 'release');
    await until(() => runs.every(run => {
      const row = h.store.connection.prepare('SELECT completed_digest,next_seq,acked_seq FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)));
      return row?.completed_digest && Number(row.acked_seq) === Number(row.next_seq) - 1;
    }), 'raw completion reaches cursor and post-commit ack without notification', 12_000);
    for (const run of runs) {
      assert.equal(h.store.runtimeGet(run.id)?.state, 'succeeded');
      const row = h.store.connection.prepare('SELECT * FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!;
      const folder = executionFolder(h.root, run.id, String(row.attempt_id));
      assert.ok(readFileSync(join(folder, 'acks', `${row.acked_seq}-${row.last_digest}.json`)));
    }
    await until(() => recovered, 'the injected registration fault has recovered');
    await delay(2200);
    const quietPasses = passes, quietChanges = h.store.connection.prepare('SELECT total_changes() AS n').get()!.n;
    const observer = new RunStore(h.root, { busyTimeoutMs: 0 });
    try {
      const version = observer.connection.prepare('PRAGMA data_version').get()!.data_version;
      await delay(1200);
      assert.equal(passes, quietPasses, 'no new event causes no additional pass');
      assert.equal(observer.connection.prepare('PRAGMA data_version').get()!.data_version, version, 'no extra DB commit');
      assert.equal(h.store.connection.prepare('SELECT total_changes() AS n').get()!.n, quietChanges);
    } finally { observer.close(); }
    // The Runs' events reach serve by its probe alone: no hint was there to lose, and no watch on their folders.
    assert.ok(registered > 0, 'the watch was registered');
    assert.ok(!watchPaths.some(path => path.includes('/.alpacawork/runs')), 'a Run folder spends no watch');
    t.diagnostic(JSON.stringify({ mode, injected, registered, callbacks, passes, root: h.root, url: app.url, pid: process.pid }));
  } catch (error) {
    await preserveTestFailure(t, h.root, { failure: { error }, origin: app.url,
      diagnostics: () => ({ mode, injected, registered, callbacks, passes, watchPaths, runs, gates,
        snapshot: h.store.snapshot() }) });
    throw error;
  } finally { await app.close(); }
});

test('late completed after manager_lost is demand; result mismatch remains a pass diagnostic', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create(), other = h.createIndependent();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const importer = new RunEventImporter(h.store);
  for (const item of [run, other]) {
    const launch = attemptOf(h.store, item.id)!, folder = executionFolder(h.root, item.id, launch.attemptId);
    const journal = new EventJournal(folder, identityOf(launch));
    journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
    importer.pass();
    h.store.write(tx => tx.update({ ...tx.runtimeGet(item.id)!, state: 'needs_review', reason: 'manager_lost' }));
    if (item.id === run.id) journal.append('completed', finish);
    else {
      fs.mkdirSync(join(folder, 'results'), { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, 'results', `${'0'.repeat(64)}.bin`), 'mismatch', { mode: 0o600 });
      journal.append('completed', { ...finish, result: { state: 'present', digest: '0'.repeat(64), size: 10 } });
    }
  }
  assert.equal(importer.hasPublishedTail(), true);
  importer.pass();
  assert.equal(h.store.runtimeGet(run.id)?.state, 'failed', 'the observed late outcome resolves provisional manager_lost');
  assert.equal(h.store.runtimeGet(run.id)?.reason, 'launch');
  const bad = h.store.connection.prepare('SELECT next_seq,diagnostic FROM run_attempts WHERE run_no=?').get(Number(other.id.slice(1)))!;
  assert.equal(bad.next_seq, 2); assert.match(String(bad.diagnostic), /Result digest\/size mismatch/);
  assert.equal(importer.hasPublishedTail(), false, 'a missing result is retried by repair, not each tick');
});

for (const fault of ['result', 'ack'] as const) test(`retained diagnostics wait for repair, fault=${fault}`, async t => {
  const clock = receiverClock(t);
  const h = await setup(t); h.pauseProjection(); const run = h.create();
  const decision = await settleTransaction(h.store,readAgentsSettings(h.root));closeLaunches(decision.launches);
  const launch = attemptOf(h.store,run.id)!, folder = executionFolder(h.root,run.id,launch.attemptId), journal = new EventJournal(folder,identityOf(launch));
  journal.append('claimed',{managerPid:process.pid,managerStarted:'test',bootId:'test'});
  if (fault === 'ack') writeFileSync(join(folder, 'acks'), 'publication unavailable', { mode: 0o600 });
  journal.append('completed',{outcome:{state:'failed',reason:'launch'},session:null,measuredUsage:null,exit:{code:1,signal:null},
    result: fault === 'ack' ? {state:'missing',digest:null,size:0} : {state:'present',digest:'0'.repeat(64),size:1}});
  const watch = fs.watch;
  fs.watch = function(path,options,callback) { return watch.call(this,path,options,()=>{}); } as typeof fs.watch;
  syncBuiltinESMExports();t.after(()=>{fs.watch=watch;syncBuiltinESMExports();});
  let count=0;const original=RunEventImporter.prototype.pass;
  t.mock.method(RunEventImporter.prototype,'pass',function(...args){count++;return original.apply(this,args);});
  const samples: { second: number; count: number; next: unknown }[]=[];
  const server=await startServer(h.root,0);
  try {
    for(let second=0;second<=40;second++){
      if(second)await clock.advance(1000);
      // Let each asynchronous ordered pass finish without changing the server's clock further.
      await new Promise(resolve=>setTimeout(resolve,15));
      samples.push({second,count,next:h.store.connection.prepare('SELECT next_seq,diagnostic FROM run_attempts').get()});
    }
    assert.equal(samples[10]!.count, samples[29]!.count, 'a retained diagnostic cannot wake another pass before repair');
    assert.ok(samples[40]!.count > samples[29]!.count, 'the existing 30-second repair still revisits the fault');
    t.diagnostic(JSON.stringify({fault,root:h.root,url:server.url,samples}));
  } finally { await server.close(); }
});
