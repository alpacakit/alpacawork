import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
/** Release startup and retention at actual scheduler/manager/CLI boundaries, with one owned fake CLI. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { setTimeout as delay } from 'node:timers/promises';
import { RunStore } from '@alpacawork/runs';
import { assignedSession, readAgentsSettings, launchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { attemptOf, inspectExecution, executionReferences } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { readRunFiles } from '@alpacawork/backend/test-dist/runs/view.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { point, holdReleases, tryHoldReleases } from '@alpacawork/backend/test-dist/release/layout.js';
import { prune } from '@alpacawork/backend/test-dist/release/switch.js';
import { saveJournal } from '@alpacawork/backend/test-dist/release/journal.js';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { grantFixtureRequest } from './helpers/control-fixture.ts';
import { startPackagedServer } from '../e2e/perf/packaged-server.ts';
import { releaseFixture } from './helpers/release-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { EventJournal, executionFolder, identityOf, names, publishLaunch } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { digestBytes, tryLock, trySharedLock } from '@alpacawork/core';

async function until(check: () => unknown, message: string) {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) { if (check()) return; await delay(20); }
  throw new Error(message);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
}
async function fixture(t: TestContext, withoutExclusion = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-release-runtime-')));
  const original = createOriginal({ tasks: 14, logs: 19, runs: 7, seed: 'release-runtime' }, join(root, 'cache')).root;
  const workspace = join(root, 'workspace'); copyWorkspace(original, workspace);
  const children: ChildProcess[] = [], stores: RunStore[] = [], servers: { close(): Promise<void> }[] = [];
  const gate = join(workspace, 'finish-agent'), receipt = join(workspace, 'agent.json');
  const fake = join(root, 'fake-cli.mjs');
  writeFileSync(fake, `import{writeFileSync,existsSync,fstatSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';import{createInterface}from'node:readline';
const args=process.argv.slice(2),bridge=args.includes('--fixture-bridge');
const session=bridge?'synthetic-release-session':args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
const input=createInterface({input:process.stdin});
const first=await new Promise(done=>input.once('line',line=>done(JSON.parse(line))));input.close();
const event=value=>console.log(JSON.stringify(value));
if(bridge){event({type:'thread.started',thread_id:session});event({type:'input.taken',id:first.id})}
else event({type:'command_lifecycle',state:'started',command_uuid:first.uuid,session_id:session});
const fd=n=>{try{return fstatSync(n).isFile()}catch{return false}};
const bytes=JSON.stringify({pid:process.pid,fd3:fd(3),fd4:fd(4),env:process.env,prompt:bridge?first.text:first.message.content});writeFileSync(${JSON.stringify(receipt)},bytes);writeFileSync(${JSON.stringify(receipt)}+'.'+(process.env.ALPACAWORK_RUN||'coordinator'),bytes);
for(const end=Date.now()+18000;!existsSync(${JSON.stringify(gate)})&&Date.now()<end;)await delay(20);
if(bridge){writeFileSync(args[args.indexOf('-o')+1],'synthetic release result');event({type:'turn.completed'})}
else event({type:'result',session_id:session,is_error:false,result:'synthetic release result'});`);
  const path = installAgentStub(root, 'claude', [process.execPath, fake]);
  const setting = fixtureAgentSetting('claude'); setting.env = [];
  writeFileSync(join(workspace, 'config.yaml'), stringify({ limits: { parallel: 4, run_minutes: 0.35 }, agents: { fake: setting } }));
  t.after(async () => {
    writeFileSync(gate, 'finish');
    for (const server of servers) await server.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), delay(3000)]);
      await stop(child); assert.ok(child.exitCode !== null || child.signalCode !== null);
    }
    for (const store of stores) store.close();
    removeWorkspace(workspace); removeWorkspace(original); rmSync(root, { recursive: true, force: true });
  });
  const store = new RunStore(workspace, { busyTimeoutMs: 3000 }); stores.push(store);
  const task = (await new ControlTaskCommands(workspace, { kind: 'human' }).create({ parentId: 'P1', userRequested: false,
    tasks: [{ title: 'Synthetic release startup' }] })).tasks[0]!;
  const people = new PlacementStore(workspace);
  const placement = people.createAndPlace({ taskId: task.id, profileKey: 'fake', responsible: true }).placement; people.close();
  function create(coordinator = false, resumes: string | null = null, sessionId: string | null = null) {
    const settings = readAgentsSettings(workspace); assert.equal(settings.ok, true); if (!settings.ok) throw settings.error;
    const previous = resumes ? store.get(resumes) : null;
    const selected = launchSnapshot(settings.config, 'fake', resumes ? 'resume' : 'start', path, {}, previous?.launch);
    assert.equal(selected.ok, true); if (!selected.ok) throw Error(selected.code);
    const assigned = assignedSession(selected.launch, 'fake');
    const session = previous?.session ?? (sessionId && assigned ? { ...assigned, id: sessionId } : assigned);
    const requestId = randomUUID(), submittedAt = new Date().toISOString();
    const conversationId = coordinator ? new CoordinatorConversation(workspace).read().id : '';
    const run = store.write(tx => {
      if (coordinator) {
        tx.insertConversationRequest({ id: requestId, conversationId, headRunId: null, mode: 'new', body: 'synthetic coordinator', submittedAt, deliveryState: 'queued' });
        return tx.createCoordinatorRun({ conversationId, requestId, agent: 'fake', resumes, session, restartArgv: null,
          cwd: workspace, launch: selected.launch, message: { context: null, attachments: [], intent: null } }, 'synthetic coordinator');
      }
      tx.insertRequest({ id: requestId, taskId: task.id, placementId: placement.id, placementRevision: 1, taskHash: task.hash,
        waitCycleId: null, headRunId: null, mode: 'new', body: 'synthetic work', purpose: 'instruction', author: { kind: 'human' }, submittedAt, deliveryState: 'queued' });
      grantFixtureRequest(store, tx, requestId);
      return tx.create({ task: task.id, agent: 'fake', role: 'owner', placementId: placement.id, requestId, resumes,
        continues: false, session,
        caller: null, cwd: workspace, launch: selected.launch }, 'synthetic work');
    });
    store.prepareFolder(run.id); return run;
  }
  const f = releaseFixture(root);
  if (withoutExclusion) {
    const entry = join(f.image, 'apps/backend/test-dist/runs/scheduler.js'), code = readFileSync(entry, 'utf8');
    const broken = code.replace('const close = tryHoldReleases(releases);', 'const close = () => {};');
    assert.notEqual(broken, code, 'substitute the actual built scheduler'); writeFileSync(entry, broken);
  }
  const scheduler = await import(pathToFileURL(join(f.image, 'apps/backend/test-dist/runs/scheduler.js')).href);
  const core = await import(pathToFileURL(join(f.image, 'node_modules/@alpacawork/core/dist/index.js')).href);
  // Capture only the managers this scheduler starts; this fake spawn never creates a service or scope.
  core.platform.run.spawnDetached = (command: string, args: string[], options: object) => {
    assert.equal(command, process.execPath); assert.equal((options as any).stdio.length, 4, 'manager only inherits fd3');
    const child = spawn(command, args, { ...options, detached: true }); children.push(child); return child;
  };
  const closeStore = () => { const index = stores.indexOf(store); if (index >= 0) { stores.splice(index, 1); store.close(); } };
  return { root, workspace, store, task, create, f, scheduler, children, gate, receipt, closeStore, servers };
}

// Reproduce the pre-version persisted shape only after its real manager/import lifecycle has finished.
function retainOldLaunch(store: RunStore, id: string) {
  const { version: _version, prompt: _prompt, ...saved } = attemptOf(store, id)!;
  store.connection.prepare('UPDATE run_attempts SET launch_json=? WHERE run_no=?')
    .run(JSON.stringify(saved), Number(id.slice(1)));
}

/** A historical shape which current writers no longer create: terminal without a completed event. */
async function quietOldExchange(t: TestContext) {
  const h = await fixture(t), run = h.create();
  const decision = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  publishLaunch(h.workspace, launch);
  const spool = executionFolder(h.workspace, run.id, launch.attemptId);
  const { version: _version, prompt: _prompt, ...old } = launch;
  old.format = 'f'.repeat(64);
  h.store.connection.prepare('UPDATE run_attempts SET launch_json=? WHERE attempt_id=?').run(JSON.stringify(old), launch.attemptId);
  writeFileSync(join(spool, 'launch.json'), JSON.stringify({ ...old, prompt: launch.prompt }));
  h.store.write(tx => tx.finish({ ...tx.runtimeGet(run.id)!, state:'cancelled',reason:'stopped',ended_at:new Date().toISOString() }, {state:'missing',text:null}));
  h.store.connection.prepare("UPDATE run_inputs SET state='taken',receipt_json='{}' WHERE attempt_id=?").run(launch.attemptId);
  for (const name of ['prompt.tmp', 'result.tmp']) rmSync(join(h.store.folder(run.id), name), { force: true });
  return { ...h, run, launch, old, spool };
}

test('quiet old terminal NULL-completion history survives the real import and packaged startup without launch repair', { timeout: 60_000 }, async t => {
  const h = await quietOldExchange(t);
  const before = h.store.connection.prepare('SELECT * FROM run_attempts WHERE attempt_id=?').get(h.launch.attemptId);
  const bytes = readFileSync(join(h.spool, 'launch.json'));
  assert.throws(() => attemptOf(h.store, h.run.id), /version/, 'runnable launch reader remains strict');
  assert.deepEqual(new RunEventImporter(h.store).pass(), []);
  assert.deepEqual(inspectExecution(h.store).contractUsers, []);
  assert.deepEqual(h.store.connection.prepare('SELECT * FROM run_attempts WHERE attempt_id=?').get(h.launch.attemptId), before);
  assert.deepEqual(readFileSync(join(h.spool, 'launch.json')), bytes);
  const config = join(h.workspace, 'config.yaml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('limits: {', 'limits: {automatic_per_placement: 0, '));
  h.closeStore();
  const server = await startPackagedServer(h.f.image, h.workspace); h.servers.push(server);
  const response = await fetch(new URL('/api/runtime/readiness', server.url));
  assert.equal(response.status, 200);
  const ready = await response.json();
  assert.equal(ready.state, 'accepting'); assert.equal(ready.pending, 0);
  assert.equal(ready.pending, ready.contractUsers.length, 'readiness derives pending from its single inspection');
});

test('every-second import demand keeps the baseline partial index and never scans input history', { timeout:30_000 }, async t => {
  const h=await quietOldExchange(t),db=h.store.connection,sql:string[]=[];
  const prepare=db.prepare.bind(db);
  const observed=t.mock.method(db,'prepare',(query:string)=>{sql.push(query);return prepare(query);});
  try { assert.equal(new RunEventImporter(h.store).hasPublishedTail(),false); }
  finally { observed.mock.restore(); }
  const candidates=sql.find(query=>query.includes(' AS unfinished'))!;
  assert(candidates,'observe the actual demand query');
  const plan=prepare('EXPLAIN QUERY PLAN '+candidates).all().map(row=>String(row.detail));
  assert(plan.some(row=>row.includes('run_attempts_open')),JSON.stringify(plan));
  assert(!plan.some(row=>/^SCAN (?:a|i)(?:$|\s+(?!USING (?:COVERING )?INDEX))/.test(row)),JSON.stringify(plan));
  console.log(JSON.stringify({proof:'indexed-import-demand',plan}));
});

for(const state of ['reserved','attempted','uncertain'] as const) test(`input-only ${state} remains FORMAT protected after completion and ack`, { timeout:30_000 },async t=>{
  const h=await quietOldExchange(t),db=h.store.connection;
  db.prepare('UPDATE run_inputs SET state=? WHERE attempt_id=?').run(state,h.launch.attemptId);
  assert.equal(inspectExecution(h.store).contractUsers[0]?.runId,h.run.id,'pending before completion remains protected/importable');
  assert.throws(()=>new RunEventImporter(h.store).pass(),/FORMAT differs/);
  // Include even inconsistent historical reserved/attempted combinations, without assuming all old writers normalized them.
  db.prepare('UPDATE run_attempts SET completed_digest=? WHERE attempt_id=?').run('d'.repeat(64),h.launch.attemptId);
  const before=db.prepare('SELECT * FROM run_inputs WHERE attempt_id=?').all(h.launch.attemptId);
  assert.equal(inspectExecution(h.store).contractUsers[0]?.runId,h.run.id,'input decision still protects its FORMAT');
  assert.deepEqual(new RunEventImporter(h.store).pass(),[],'no new event can advance a completed/acknowledged exchange');
  assert.equal(new RunEventImporter(h.store).hasPublishedTail(),false);
  assert.deepEqual(db.prepare('SELECT * FROM run_inputs WHERE attempt_id=?').all(h.launch.attemptId),before);
});

test('separate shared inspectors coexist and an exclusive producer still protects old history', {timeout:30_000},async t=>{
  const h=await quietOldExchange(t),file=join(h.store.folder(h.run.id),'manager.lock');
  async function holder(mode:'shared'|'exclusive'){
    const child=spawn(process.execPath,[join(import.meta.dirname,'fixtures/exchange-lock-holder.mjs'),file,mode],{stdio:['ignore','pipe','pipe','ipc']});
    h.children.push(child);
    const exited=once(child,'exit'),message=once(child,'message');
    let timer:ReturnType<typeof setTimeout>;
    const [ready]=await Promise.race([message,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Lock holder deadline')),5000);})]).finally(()=>clearTimeout(timer));
    console.log(JSON.stringify({proof:'lock-holder',mode,...ready}));
    return {ready,release:async()=>{if(child.connected)child.send('release');await exited;}};
  }
  const first=await holder('shared'),second=await holder('shared');
  assert.equal(first.ready.locked,true);assert.equal(second.ready.locked,true);
  assert.deepEqual(new RunEventImporter(h.store).pass(),[]);
  assert.deepEqual(inspectExecution(h.store).contractUsers,[]);
  await first.release();await second.release();
  const producer=await holder('exclusive');assert.equal(producer.ready.locked,true);
  assert.equal(inspectExecution(h.store).contractUsers[0]?.runId,h.run.id);
  assert.throws(()=>new RunEventImporter(h.store).pass(),/FORMAT differs/);
  await producer.release();
  assert.throws(()=>trySharedLock(-1),/EBADF/,'unknown descriptor faults are not ordinary lock contention');
});

for (const evidence of ['tail', 'gap', 'completed-result', 'result', 'result.tmp', 'prompt.tmp', 'pending', 'ack', 'diagnostic', 'producer', 'missing-lock', 'unreadable-tail', 'invalid-reference', 'missing-release', 'duplicate-reference'] as const) {
  test(`old terminal incomplete exchange with ${evidence} stays protected before strict import`, { timeout: 30_000 }, async t => {
    const h = await quietOldExchange(t), db = h.store.connection;
    let lock = -1;
    t.after(() => { if (lock >= 0) closeSync(lock); });
    if (evidence === 'tail' || evidence === 'gap') {
      mkdirSync(join(h.spool, 'events'), { recursive: true });
      writeFileSync(join(h.spool, 'events', evidence === 'gap' ? '000000000003.json' : '000000000001.json'), '{}');
    } else if (evidence === 'completed-result') {
      const bytes=Buffer.from('retained completed reply'),digest=digestBytes(bytes);
      mkdirSync(join(h.spool,'results'),{recursive:true});writeFileSync(join(h.spool,'results',digest+'.bin'),bytes);
      new EventJournal(h.spool,identityOf(h.launch)).append('completed',{outcome:{state:'cancelled',reason:'stopped'},session:null,
        measuredUsage:null,exit:null,result:{state:'present',digest,size:bytes.length}});
    } else if (evidence === 'result') {
      mkdirSync(join(h.spool, 'results'), { recursive: true }); writeFileSync(join(h.spool, 'results', 'unknown.bin'), 'uncommitted reply');
    } else if (evidence.endsWith('.tmp')) writeFileSync(join(h.store.folder(h.run.id), evidence), 'unsaved exchange');
    else if (evidence === 'pending') db.prepare("UPDATE run_inputs SET state='uncertain' WHERE attempt_id=?").run(h.launch.attemptId);
    else if (evidence === 'ack') db.prepare('UPDATE run_attempts SET next_seq=2 WHERE attempt_id=?').run(h.launch.attemptId);
    else if (evidence === 'diagnostic') db.prepare('UPDATE run_attempts SET diagnostic=? WHERE attempt_id=?').run('{"kind":"execution_fault","message":"retained"}', h.launch.attemptId);
    else if (evidence === 'producer') { lock = openSync(join(h.store.folder(h.run.id), 'manager.lock'), constants.O_RDONLY); assert(tryLock(lock)); }
    else if (evidence === 'missing-lock') rmSync(join(h.store.folder(h.run.id), 'manager.lock'));
    else if (evidence === 'unreadable-tail') writeFileSync(join(h.spool, 'events'), 'not a directory');
    else {
      db.prepare("UPDATE run_inputs SET state='uncertain' WHERE attempt_id=?").run(h.launch.attemptId);
      if(evidence==='missing-release')db.prepare("UPDATE run_attempts SET launch_json=json_remove(launch_json,'$.release') WHERE attempt_id=?").run(h.launch.attemptId);
      else if(evidence==='duplicate-reference')db.prepare('UPDATE run_attempts SET launch_json=? WHERE attempt_id=?')
        .run(JSON.stringify(h.old).slice(0,-1)+',"format":"'+h.old.format+'"}',h.launch.attemptId);
      else db.prepare("UPDATE run_attempts SET launch_json=json_set(launch_json,'$.attemptId',?) WHERE attempt_id=?").run(randomUUID(), h.launch.attemptId);
    }
    const before = db.prepare('SELECT * FROM run_attempts WHERE attempt_id=?').get(h.launch.attemptId);
    if (evidence === 'invalid-reference') assert.throws(() => inspectExecution(h.store), /identity mismatch/);
    else if(evidence==='missing-release')assert.throws(()=>inspectExecution(h.store),/release/);
    else if(evidence==='duplicate-reference')assert.throws(()=>inspectExecution(h.store),/Duplicate JSON key/);
    else {
      const references = inspectExecution(h.store);
      assert.deepEqual(references.contractUsers, [{runId:h.run.id,attemptId:h.launch.attemptId,format:h.old.format}]);
      assert.equal(references.runtimeUsers[0]?.release, h.launch.release);
      assert.throws(() => new RunEventImporter(h.store).pass(), /FORMAT differs/, 'old work is refused, never skipped or decoded compatibly');
    }
    assert.deepEqual(db.prepare('SELECT * FROM run_attempts WHERE attempt_id=?').get(h.launch.attemptId), before);
  });
}

test('a real manager still holding a terminal incomplete exchange retains its release with an empty tail', { timeout: 45_000 }, async t => {
  const h = await fixture(t), run = h.create();
  await h.scheduler.settle(h.store);
  await until(() => existsSync(h.receipt), 'fake CLI is live under its real manager');
  const saved=h.store.connection.prepare('SELECT attempt_id FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!;
  const events=join(executionFolder(h.workspace,run.id,String(saved.attempt_id)),'events');
  // The CLI marker and manager startup precede the asynchronous initial input receipt.
  // Observe that final startup receipt before importing the prefix we call empty.
  await until(() => names(events).some(name => JSON.parse(readFileSync(join(events,name),'utf8')).type==='input_taken'), 'manager initial input receipt is published');
  new RunEventImporter(h.store).pass();
  h.store.write(tx => tx.finish({ ...tx.runtimeGet(run.id)!, state:'cancelled',reason:'stopped',ended_at:new Date().toISOString() }, {state:'missing',text:null}));
  h.store.connection.prepare("UPDATE run_inputs SET state='taken' WHERE instruction_run_no=?").run(Number(run.id.slice(1)));
  for (const name of ['prompt.tmp', 'result.tmp']) rmSync(join(h.store.folder(run.id), name), { force: true });
  const attempt=h.store.connection.prepare('SELECT attempt_id,next_seq FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!;
  assert.equal(names(join(executionFolder(h.workspace,run.id,String(attempt.attempt_id)),'events')).length,Number(attempt.next_seq)-1);
  assert(h.children.some(child => child.exitCode === null && child.signalCode === null));
  assert.equal(inspectExecution(h.store).contractUsers[0]?.runId, run.id);
});

test('normal settle resumes past old completed and acknowledged launch history', { timeout: 45_000 }, async t => {
  const h = await fixture(t), sessionId = randomUUID(), old = h.create(false, null, sessionId);
  assert.deepEqual((await h.scheduler.settle(h.store)).launched, [old.id]);
  await until(() => existsSync(h.receipt), 'first fake CLI starts'); writeFileSync(h.gate, 'done');
  await until(() => h.children.every(c => c.exitCode !== null || c.signalCode !== null), 'first manager naturally exits');
  new RunEventImporter(h.store).pass();
  assert.equal(h.store.runtimeGet(old.id)?.state, 'succeeded');
  const cursor = h.store.connection.prepare('SELECT completed_digest,next_seq,acked_seq FROM run_attempts WHERE run_no=?')
    .get(Number(old.id.slice(1)))!;
  assert.ok(cursor.completed_digest); assert.equal(cursor.acked_seq, Number(cursor.next_seq) - 1);
  retainOldLaunch(h.store, old.id);
  assert.deepEqual(inspectExecution(h.store).contractUsers, []);
  assert.deepEqual(new RunEventImporter(h.store).pass(), []);
  assert.equal(readRunFiles(h.workspace, old.id, 'result').files[0]!.text!.trim(), 'synthetic release result');

  const next = h.create(false, old.id);
  assert.ok(h.store.readForSettle().some(r => r.id === old.id), 'resumes retains its completed ancestor in the decision graph');
  assert.deepEqual((await h.scheduler.settle(h.store)).launched, [next.id]);
  assert.equal(attemptOf(h.store, next.id)?.invocation.session?.id, sessionId);
  await until(() => existsSync(h.receipt + '.' + next.id) && h.children.every(c => c.exitCode !== null || c.signalCode !== null), 'resumed fake CLI and manager exit');
  await h.scheduler.settle(h.store);
  assert.equal(h.store.runtimeGet(next.id)?.state, 'succeeded');
  assert.equal(readRunFiles(h.workspace, next.id, 'result').files[0]!.text!.trim(), 'synthetic release result');
});

test('normal import and settle skip old launch_aborted history before decoding a launch', { timeout: 45_000 }, async t => {
  const h = await fixture(t), old = h.create();
  const decision = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  assert.equal((await h.scheduler.launch(h.store, decision, { script: join(h.root, 'absent-manager.mjs') })).failed.length, 1);
  assert.equal(h.store.runtimeGet(old.id)?.state, 'failed');
  const row = h.store.connection.prepare('SELECT diagnostic FROM run_attempts WHERE run_no=?').get(Number(old.id.slice(1)))!;
  assert.equal(JSON.parse(String(row.diagnostic)).kind, 'launch_aborted');
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs WHERE instruction_run_no=?')
    .get(Number(old.id.slice(1)))!.state, 'not_sent');
  retainOldLaunch(h.store, old.id);
  assert.deepEqual(inspectExecution(h.store).contractUsers, []);
  const importer = new RunEventImporter(h.store);
  assert.equal(importer.hasPublishedTail(), false); assert.deepEqual(importer.pass(), []);

  const next = h.create();
  assert.deepEqual((await h.scheduler.settle(h.store)).launched, [next.id]);
  await until(() => existsSync(h.receipt + '.' + next.id), 'next fake CLI starts'); writeFileSync(h.gate, 'done');
  await until(() => h.children.every(c => c.exitCode !== null || c.signalCode !== null), 'next manager exits');
  await h.scheduler.settle(h.store);
  assert.equal(h.store.runtimeGet(next.id)?.state, 'succeeded');
  assert.equal(h.store.connection.prepare('SELECT diagnostic FROM run_attempts WHERE run_no=?')
    .get(Number(old.id.slice(1)))!.diagnostic, row.diagnostic, 'the old diagnostic remains available');
});

test('direct release reservation/spawn excludes prune, recovers saved entries, and defers when release operations are busy', { timeout: 60_000 }, async t => {
  const h = await fixture(t), releases = dirname(h.f.image), run = h.create();
  const held = holdReleases(releases);
  try {
    const deferred = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
    assert.equal(deferred.launches.length, 0); assert.equal(attemptOf(h.store, run.id), null);
    assert.equal(h.store.runtimeGet(run.id)?.state, 'queued');
  } finally { held(); }
  const reserved = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  assert.equal(reserved.launches.length, 1);
  assertHandoffExcluded(releases);
  const snapshot = attemptOf(h.store, run.id)!;
  assert.equal(snapshot.entry, h.f.manager); assert.equal(snapshot.release, h.f.image); assert.equal(snapshot.version, '0.3.0');
  // A crash before spawn leaves the reservation. Recovery must acquire the same release exclusion again.
  h.scheduler.closeLaunches(reserved.launches);
  const reservationCheck = holdReleases(releases);
  try { assert.deepEqual(prune(releases, 0, () => {}, h.workspace), [], 'saved unspawned reservation keeps its release'); }
  finally { reservationCheck(); }
  const blocked = holdReleases(releases);
  try { assert.equal((await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace))).launches.length, 0); }
  finally { blocked(); }
  const recovered = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  assert.equal(recovered.launches[0]?.attemptId, snapshot.attemptId);
  assertHandoffExcluded(releases);
  const launched = await h.scheduler.launch(h.store, recovered);
  assert.deepEqual(launched.launched, [run.id]); holdReleases(releases)();
  await until(() => existsSync(h.receipt), 'fake CLI starts');
  const receipt = JSON.parse(readFileSync(h.receipt, 'utf8'));
  assert.equal(receipt.fd3, false); assert.equal(receipt.fd4, false);
  assert.equal(receipt.env.ALPACAWORK_RUN_CLI, h.f.cli);
  assert.ok(receipt.env.PATH.startsWith(join(h.f.image, 'bin') + ':'));
  assert.equal(existsSync(join(h.workspace, '.alpacawork/runtime')), false);
  assert.equal(existsSync(join(h.f.image, 'runtime.lease')), false);
  // Neither workspace's DB is searched: host argv protects this manager even for a foreign workspace prune.
  const foreign = join(h.root, 'foreign'); mkdirSync(foreign);
  const release = holdReleases(releases);
  try { assert.deepEqual(prune(releases, 0, () => {}, foreign), []); }
  finally { release(); }
  writeFileSync(h.gate, 'done');
  await until(() => h.children.every(c => c.exitCode !== null || c.signalCode !== null), 'manager exits');
  new RunEventImporter(h.store).pass();
  assert.equal(h.store.runtimeGet(run.id)?.state, 'succeeded');
  const reclaim = holdReleases(releases);
  try { assert.deepEqual(prune(releases, 0, () => {}, h.workspace), ['a'.repeat(40)]); }
  finally { reclaim(); }
});

test('old Task and credential-free coordinator CLIs continue across two committed switches with exact stdout', { timeout: 90_000 }, async t => {
  const h = await fixture(t), releases = dirname(h.f.image), taskRun = h.create(), coordinator = h.create(true);
  const decision = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  assert.equal(decision.launches.length, 2);
  await h.scheduler.launch(h.store, decision);
  await until(() => existsSync(h.receipt + '.' + taskRun.id) && existsSync(h.receipt + '.coordinator'), 'both fake CLIs start');
  const owner = JSON.parse(readFileSync(h.receipt + '.' + taskRun.id, 'utf8'));
  const direct = JSON.parse(readFileSync(h.receipt + '.coordinator', 'utf8'));
  assert.equal(direct.env.ALPACAWORK_RUN, undefined); assert.equal(direct.env.ALPACAWORK_RUN_TOKEN, undefined);
  assert.equal(owner.prompt, 'synthetic work'); assert.equal(direct.prompt, 'synthetic coordinator');
  assert.equal(direct.fd4, false); assert.equal(attemptOf(h.store, coordinator.id)?.credential, null);
  const file = join(h.workspace, 'tasks', h.task.id, 'work', 'synthetic.bin'); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from([0, 255, 13, 10]); writeFileSync(file, bytes);
  // These independent releases run the real receiver. Publish the same committed switch result used after deploy;
  // service/deploy mechanics and FORMAT refusal are separately exercised by release.test.ts.
  const versions = ['0.3.1', '0.3.2'], newReleases: string[] = [];
  for (let index = 0; index < versions.length; index++) newReleases.push(join(releases, String(index + 2).repeat(40)));
  h.closeStore();
  // A previous full-tree admission would fail on these bytes. Normal CLI startup must not open them or Node.
  writeFileSync(join(h.f.image, 'DISTRIBUTION.json'), 'intentionally unavailable inventory');
  const preload = join(h.root, 'observe-cli-reads.mjs'), observed = join(h.root, 'reads.json');
  writeFileSync(preload, `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';
const read=fs.readFileSync,walk=fs.readdirSync;const facts={nodeReads:0,distributionReads:0,treeWalks:0};
fs.readFileSync=function(path,...args){const p=typeof path==='number'?fs.realpathSync('/proc/self/fd/'+path):String(path);if(p===process.execPath){facts.nodeReads++;throw Error('NODE_REHASH')}if(p.endsWith('/DISTRIBUTION.json')){facts.distributionReads++;throw Error('DISTRIBUTION_REHASH')}return read.call(this,path,...args)};
fs.readdirSync=function(path,...args){if(String(path).startsWith(${JSON.stringify(h.f.image)})){facts.treeWalks++;throw Error('DISTRIBUTION_WALK')}return walk.call(this,path,...args)};
syncBuiltinESMExports();process.on('exit',()=>fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(facts)));`);
  let active: { close(): Promise<void>; url: string } | undefined;
  for (let index = 0; index < newReleases.length; index++) {
    if (active) { await active.close(); h.servers.splice(h.servers.indexOf(active), 1); }
    const target = newReleases[index]!, old = index === 0 ? h.f.image : newReleases[index - 1]!;
    cpSync(h.f.image, target, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    manifest.version = versions[index]; manifest.alpacawork.source = String(index + 2).repeat(40);
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(target, 'SOURCE'), String(index + 2).repeat(40));
    point(releases, 'previous', old); point(releases, 'current', target);
    saveJournal({ releases, workspace: h.workspace }, { version: 4, skillsWriteStarted: false, opId: randomUUID(), workspace: h.workspace,
      old, target, previous: null, phase: 'committed', schema: 16 });
    active = await startPackagedServer(target, h.workspace, 0); h.servers.push(active!);
    const invoke = async (args: string[], identity: NodeJS.ProcessEnv, unrelatedFd: boolean) => {
      const fd = unrelatedFd ? openSync(file, 'r') : -1;
      const cliArgs = [h.f.cli, '--server', active!.url, ...args];
      const child = spawn(unrelatedFd ? '/bin/bash' : process.execPath,
        unrelatedFd ? ['--noprofile', '--norc', '-c', 'exec "$@"', 'fixture-shell', ...cliArgs] : ['--import', preload, ...cliArgs], {
        env: cleanCliEnv({ ...identity, HOME: h.root, XDG_RUNTIME_DIR: undefined,
          ...(unrelatedFd ? { NODE_OPTIONS: '--import=' + preload } : {}) }),
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd >= 0 ? fd : 'ignore'],
      });
      h.children.push(child); if (fd >= 0) closeSync(fd);
      let stdout = '', stderr = ''; child.stdout!.on('data', b => { stdout += b; }); child.stderr!.on('data', b => { stderr += b; });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try { const [code] = await once(child, 'close'); return { code, stdout, stderr }; }
      finally { clearTimeout(timeout); await stop(child); }
    };
    for (const [identity, unrelatedFd] of [[owner.env, false], [{ ...direct.env, CODEX_THREAD_ID: randomUUID() }, true]] as const) {
      const result = await invoke(['task', 'get', '--task', h.task.id], identity, unrelatedFd);
      assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).task.id, h.task.id);
      assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), { nodeReads: 0, distributionReads: 0, treeWalks: 0 });
    }
    const output = join(h.root, 'output-' + index);
    const download = await invoke(['task', 'file', 'get', '--task', h.task.id, '--path', 'work/synthetic.bin', '--output', output], owner.env, true);
    assert.equal(download.code, 0, download.stderr); assert.deepEqual(readFileSync(output), bytes);
    assert.deepEqual(JSON.parse(download.stdout), { path: output, bytes: bytes.length });
    const denied = await invoke(['task', 'get', '--task', h.task.id], { ...owner.env, ALPACAWORK_RUN_TOKEN: 'f'.repeat(64) }, false);
    assert.notEqual(denied.code, 0); assert.equal(denied.stdout, '');
    const exclusion = holdReleases(releases);
    try { prune(releases, 0, () => {}, h.workspace); assert.ok(existsSync(h.f.image), 'old manager survives both switches/prunes'); }
    finally { exclusion(); }
  }
  writeFileSync(h.gate, 'done');
  await until(() => h.children.every(child => child.exitCode !== null || child.signalCode !== null), 'all owned fake managers and CLIs exit');
  await until(() => {
    const db = new DatabaseSync(controlDatabasePath(h.workspace), { readOnly: true });
    try { return db.prepare("SELECT count(*) AS n FROM runs WHERE id IN (?,?) AND state='succeeded'").get(Number(taskRun.id.slice(1)), Number(coordinator.id.slice(1)))!.n === 2; }
    finally { db.close(); }
  }, 'new serve imports both old manager results');
  // Completion may be imported before the old manager's final acknowledgement.
  // Release retention deliberately lasts until every runtime reference is drained.
  await until(() => {
    const connection = new DatabaseSync(controlDatabasePath(h.workspace), {readOnly:true});
    try { return !executionReferences({root:h.workspace,connection}).runtimeUsers.some(user => user.release === h.f.image); }
    finally { connection.close(); }
  }, 'old manager output acknowledgements release the runtime reference');
  const exclusion = holdReleases(releases);
  try { assert.ok(prune(releases, 0, () => {}, h.workspace).includes('a'.repeat(40)), 'ended old release is reclaimed'); }
  finally { exclusion(); }
});

function assertHandoffExcluded(releases: string) {
  const available = tryHoldReleases(releases); available?.();
  assert.equal(available, null, 'prune can enter the forbidden reservation/spawn window');
}
test('removing exclusion from the actual built scheduler makes the reservation/prune assertion fail', async t => {
  const h = await fixture(t, true); h.create();
  const decision = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  try { assert.equal(decision.launches.length, 1); assert.throws(() => assertHandoffExcluded(dirname(h.f.image)), /forbidden reservation\/spawn window/); }
  finally { h.scheduler.closeLaunches(decision.launches); }
});

test('a configured alpacawork-agent command selects the startup release entry without generating a shim', { timeout: 45_000 }, async t => {
  const h = await fixture(t);
  writeFileSync(join(h.f.image, 'bin/agent.mjs'), "#!/usr/bin/env node\nprocess.argv.push('--fixture-bridge');\n" + readFileSync(join(h.root, 'fake-cli.mjs'), 'utf8'));
  writeFileSync(join(h.workspace, 'config.yaml'), stringify({ limits: { parallel: 4, run_minutes: 0.35 }, agents: { fake: fixtureAgentSetting('codex') } }));
  const run = h.create(), decision = await h.scheduler.settleTransaction(h.store, readAgentsSettings(h.workspace));
  assert.deepEqual((await h.scheduler.launch(h.store, decision)).launched, [run.id]);
  await until(() => existsSync(h.receipt), 'release bridge entry is selected');
  assert.equal(existsSync(join(h.workspace, '.alpacawork/runtime')), false);
  writeFileSync(h.gate, 'done');
  await until(() => h.children.every(c => c.exitCode !== null || c.signalCode !== null), 'owned release bridge exits');
  new RunEventImporter(h.store).pass(); assert.equal(h.store.runtimeGet(run.id)?.state, 'succeeded');
});
