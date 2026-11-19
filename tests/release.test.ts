/** Release switch and release-root contracts; cases remain serial within this process. */
/** Switch protocol through its real journal/files, with a local service adapter; systemd is exercised separately. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { platform } from "@alpacawork/core";
import { holdReleases, point } from "@alpacawork/backend/test-dist/release/layout.js";
import { prune, switchTo } from "@alpacawork/backend/test-dist/release/switch.js";
import { NEXT, setup, resolveEntry, cleanEnv } from './helpers/release-switch-fixture.ts';

test('same FORMAT switch drains before stop and preserves the old code user',async t=>{const h=setup(t,{a:'f1',b:'f1'});await h.start('a');const old=await h.manager('a');h.state.contractUsers.push({runId:'R1',attemptId:'attempt',format:'f1'});h.save();const ready=await switchTo(h.place,join(h.releases,'b'));assert.equal(ready.release,'b');assert.equal(h.current(),'b');assert.equal(readlinkSync(join(h.releases,'previous')),'a');assert.deepEqual(h.log.filter(s=>['drain','stop','restart'].includes(s)),['drain','stop','restart']);assert.equal(old.exitCode,null);assert.equal(h.journal().phase,'committed')});

test('an unimported completion or uncertain input refuses another FORMAT even without a process',async t=>{const h=setup(t,{a:'f1',b:'f2'});await h.start('a');h.state.unfinishedRuns.push('Rqueued');h.save();await assert.rejects(switchTo(h.place,join(h.releases,'b')),/FORMAT differs/);assert.deepEqual(h.log,[]);h.state.unfinishedRuns=[];h.state.contractUsers.push({runId:'R1',attemptId:'unimported',format:'f1'});h.save();await assert.rejects(switchTo(h.place,join(h.releases,'b')),/FORMAT differs/);assert.deepEqual(h.log,[]);assert.equal(h.current(),'a')});

test('another workspace using an older release does not block this workspace FORMAT change',async t=>{const h=setup(t,{a:'f1',b:'f2'});await h.start('a');await h.manager('a');assert.equal((await switchTo(h.place,join(h.releases,'b'))).release,'b')});

test('post-stop preflight catches a newly reserved contract user and restores the compatible old serve',async t=>{const h=setup(t,{a:'f1',b:'f2'});await h.start('a');const stop=platform.service.stop;platform.service.stop=()=>{h.state.contractUsers.push({runId:'R2',attemptId:'race',format:'f1'});h.save();return stop('test')};await assert.rejects(switchTo(h.place,join(h.releases,'b')),/Switch aborted/);assert.equal(h.current(),'a');assert.equal(h.journal().phase,'aborted');assert.match(h.journal().abortReason,/FORMAT differs/)});

test('failed stop publication never calls service.stop or selects a target; replay resumes the same journal',async t=>{const h=setup(t,{a:'f1',b:'f1'});await h.start('a');h.state.failStops=true;await assert.rejects(switchTo(h.place,join(h.releases,'b')),/handoff/);assert.equal(h.current(),'a');assert.equal(h.log.includes('stop'),false);const op=h.journal().opId;h.state.failStops=false;assert.equal((await switchTo(h.place,join(h.releases,'b'))).release,'b');assert.equal(h.journal().opId,op)});

test('a host that cannot stop after the barrier leaves current unchanged',async t=>{const h=setup(t,{a:'f1',b:'f1'});await h.start('a');platform.service.stop=()=>false;await assert.rejects(switchTo(h.place,join(h.releases,'b')),/did not stop/);assert.equal(h.current(),'a')});

test('failed readiness returns to the old serve and closes the switch',async t=>{const h=setup(t,{a:'f1',b:'f1'});await h.start('a');writeFileSync(join(h.releases,'b','broken'),'');await assert.rejects(switchTo(h.place,join(h.releases,'b')),/did not become ready/);assert.equal(h.current(),'a');assert.equal(h.journal().phase,'aborted')});

test('a committed schema change never rolls back; the same switch recovers forward',async t=>{const h=setup(t,{a:'f1',b:'f1'},['b']);await h.start('a');writeFileSync(join(h.releases,'b','migrated-failure'),'');await assert.rejects(switchTo(h.place,join(h.releases,'b')),/forward recovery/);assert.equal(h.current(),'b');assert.equal(h.state.schema,NEXT);assert.equal(h.journal().phase,'target_selected');rmSync(join(h.releases,'b','migrated-failure'));assert.equal((await switchTo(h.place,join(h.releases,'b'))).release,'b');assert.equal(h.journal().phase,'committed')});

test('prune retains a live manager by its release entry in host argv',async t=>{const h=setup(t,{a:'f1',b:'f1',c:'f1',d:'f1'});await h.start('a');await switchTo(h.place,join(h.releases,'b'));await h.manager('c');assert.deepEqual(prune(h.releases,0,()=>{}),['d']);assert.ok(existsSync(join(h.releases,'c')))});

test('one release operation at a time per release root',t=>{const h=setup(t,{a:'f1'}),close=holdReleases(h.releases);try{assert.throws(()=>holdReleases(h.releases),/Another release operation/)}finally{close()}holdReleases(h.releases)()});

test('an already-current ready release needs no restart',async t=>{const h=setup(t,{a:'f1'});await h.start('a');assert.equal((await switchTo(h.place,join(h.releases,'a'))).release,'a');assert.deepEqual(h.log,[])});

test('pending target resumes before its producer and rejects other producer targets without building them', async t => {
  const h = setup(t, { a: 'f1', b: 'f1', c: 'f1' }); await h.start('a');
  point(h.releases, 'previous', join(h.releases, 'c'));
  const stop = platform.service.stop; platform.service.stop = () => false;
  let builds = 0;
  const target = { release: join(h.releases, 'b'), prepare: async () => { builds++; return join(h.releases, 'b'); } };
  await assert.rejects(switchTo(h.place, target), /did not stop/);
  assert.equal(builds, 1); const operation = h.journal().opId;
  await assert.rejects(switchTo(h.place, { link: 'previous' }), /pending switch/);
  await assert.rejects(switchTo(h.place, { release: join(h.releases, 'c'), prepare: async () => { throw Error('must not build another target'); } }), /pending switch/);
  platform.service.stop = stop;
  assert.equal((await switchTo(h.place, { ...target, prepare: async () => { throw Error('must not rebuild a pending target'); } })).release, 'b');
  assert.equal(h.journal().opId, operation); assert.equal(h.journal().phase, 'committed'); assert.equal(builds, 1);
});

test('rollback reexecution resolves the saved previous target after current and previous links have moved', async t => {
  const h = setup(t, { a: 'f1', b: 'f1' }); await h.start('a');
  point(h.releases, 'previous', join(h.releases, 'b'));
  const restart = platform.service.restart; platform.service.restart = () => { throw Error('interrupt target restart'); };
  await assert.rejects(switchTo(h.place, { link: 'previous' }), /interrupt target restart/);
  const pending = h.journal(); assert.equal(pending.phase, 'target_selected');
  assert.equal(h.current(), 'b'); assert.equal(readlinkSync(join(h.releases, 'previous')), 'a');
  platform.service.restart = restart;
  assert.equal((await switchTo(h.place, { link: 'previous' })).release, 'b');
  assert.equal(h.journal().opId, pending.opId); assert.equal(h.journal().phase, 'committed');
});

test('unreadable SOURCE stops prune instead of silently omitting the release',{skip:process.getuid?.()===0&&'root reads all files'},async t=>{const h=setup(t,{a:'f1',b:'f1'});chmodSync(join(h.releases,'b','SOURCE'),0);try{assert.throws(()=>prune(h.releases,0,()=>{}),{code:'EACCES'})}finally{chmodSync(join(h.releases,'b','SOURCE'),0o644)}});

test('release status resolves the release directory by its real path',async t=>{const h=setup(t,{a:'f1'}),linked=join(h.releases,'..','linked');symlinkSync(h.releases,linked);const r=spawnSync(process.execPath,[resolveEntry(),'release','status','--releases',linked],{encoding:'utf8',env:cleanEnv()});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).releases[0].release,'a')});

test('a prepared switch refreshes a drained token after the old serve generation restarted',async t=>{
 const h=setup(t,{a:'f1',b:'f1'});await h.start('a');const stop=platform.service.stop;platform.service.stop=()=>false;
 await assert.rejects(switchTo(h.place,join(h.releases,'b')),/did not stop/);const previous=h.journal();assert.equal(previous.phase,'prepared');assert.ok(previous.drained);
 platform.service.stop=stop;await h.start('a');await switchTo(h.place,join(h.releases,'b'));assert.equal(h.journal().opId,previous.opId);assert.notEqual(h.journal().drained.generation,previous.drained.generation);assert.equal(h.log.filter(line=>line==='drain').length,1);
});

test('a durable target_ready phase rechecks readiness and commits without another restart',async t=>{
 const h=setup(t,{a:'f1',b:'f1'});await h.start('a');await switchTo(h.place,join(h.releases,'b'));const journal=h.journal();journal.phase='target_ready';writeFileSync(join(h.releases,'switch.json'),JSON.stringify(journal));h.log.length=0;await switchTo(h.place,join(h.releases,'b'));assert.equal(h.journal().phase,'committed');assert.equal(h.log.includes('restart'),false);
});

test('a completed skill overwrite prevents a previous-application rollback before service operations',async t=>{
 const h=setup(t,{a:'f1',b:'f1'});await h.start('a');await switchTo(h.place,join(h.releases,'b'));
 const journal={...h.journal(),skillsWriteStarted:true};writeFileSync(join(h.releases,'switch.json'),JSON.stringify(journal));h.log.length=0;
 await assert.rejects(switchTo(h.place,{link:'previous'}),/Skills have been overwritten/);assert.equal(h.current(),'b');assert.deepEqual(h.log,[]);
});
