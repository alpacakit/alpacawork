/** Current immutable execution acceptance boundaries. */
import {test} from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {usesSlot,conversationInUse} from '@alpacawork/runs';import {controlDatabasePath} from '@alpacawork/db';
import {alive,cli,driver,execute,receipts,setup,until,type Harness} from './harness.ts';
// Top-level fault suites run once via test:node in all. Standalone acceptance
// covers only its own cases; use test:node for those six fault groups.
async function lost(h:Harness,run:{id:string;session?:any}){const summary=await h.tick();const current=h.getStore().get(run.id)!;assert.equal(current.state,'needs_review');assert.equal(current.reason,'manager_lost');assert.equal(usesSlot(current),true);assert.equal(conversationInUse(h.getStore().snapshot().records,run.session.id),true);return current;}
test('B1: HTTP receiver SIGKILL after admission COMMIT leaves one queued Run and Request', async t => {
  const h = await setup(t);
  assert.ok(h.task && h.placement);
  const bodyFile = h.gate('b1-body.md'), requestId = randomUUID();
  writeFileSync(bodyFile, '{"token":"B1"}');
  const result = await execute(h.root, driver,
    [h.root, h.task.id, bodyFile, requestId, h.task.hash, String(h.placement.revision)]).done;
  assert.equal(result.signal, 'SIGKILL'); assert.equal(result.stdout, '');
  const [run] = h.records(); assert.equal(h.records().length, 1); assert.equal(run.state, 'queued'); assert.equal(receipts(h.root).length, 0);
  assert.equal(run.requestId, requestId);
  assert.equal(h.getStore().readRequests().length, 1);
  h.integrity();
});

test('lost manager stop ends its recorded agent group before cancelling the Run', async t => {
  const h = await setup(t);
  await h.server();
  const run = h.seed({}, 'queued', { group: true, stubborn: true });
  await h.tick();
  const running = await h.ready(run.id);
  await until(() => receipts(h.root).filter(receipt => receipt.pgid === running.pids.agent).length === 3,
    'agent, child and grandchild started');
  assert.ok(running.pids.manager);
  process.kill(running.pids.manager, 'SIGKILL');
  await until(() => !alive(running.pids.manager!), 'manager killed');
  await lost(h, run);
  assert.equal(alive(running.pids.agent!, true), true);

  const stopping = cli(h.root, 'run stop', { run: run.id });
  await until(() => h.getStore().get(run.id)?.stop_requested, 'stop request recorded');
  const stopped = await stopping;
  assert.equal(stopped.code, 0, stopped.stderr);
  // The CLI receipt captures the committed request; process termination follows that commit.
  assert.deepEqual(stopped.body?.stop_requested, [run.id]);
  await until(() => !alive(running.pids.agent!, true), 'stopped agent group gone');
  await h.waitState(run.id,'cancelled');
  assert.equal(h.getStore().get(run.id)?.state, 'cancelled');
  assert.equal(h.getStore().get(run.id)?.reason, 'stopped');
  h.integrity();
});

for(const before of[true,false])test(`launch outbox SIGKILL ${before?'before':'after'} commit recovers one initial invocation`,async t=>{
 const h=await setup(t),run=h.seed({},'queued',{token:'outbox'}),mode=before?'settle-before-commit':'settle-after-commit';h.closeStore();
 const result=await execute(h.root,resolve('tests/acceptance/crash-driver.ts'),[h.root,mode]).done;assert.equal(result.signal,'SIGKILL',result.stderr);
 const marker=JSON.parse(readFileSync(h.gate('crash-reached'),'utf8'));assert.equal(marker.point,mode);assert.deepEqual(marker.boundary,{database:controlDatabasePath(h.root),write:true,state:'running'});
 assert.equal(h.getStore().get(run.id)!.state,before?'queued':'running');assert.equal(receipts(h.root).length,0);
 await h.tick();await h.waitState(run.id,'succeeded');await h.tick();assert.equal(receipts(h.root).filter(r=>r.prompt===JSON.stringify({token:'outbox'})).length,1);assert.equal(h.records().length,1);h.oncePerRun();h.integrity();
});
