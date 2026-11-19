/** Each recovery case owns its data, immutable releases, service and evidence. */
import { assembleFixtureDistribution, fixtureCommit } from './distribution-fixture.ts';
import { preserveTestFailure } from './failure-workspace.ts';
import { appendTestMigration } from './packaged-migration.ts';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlStore, holdControlWriter, controlSchemaManifest, canMigrateControlSchema, migrationPrefix, packagedMigrations, openDatabase } from '@alpacawork/db';
import { createOriginal, copyWorkspace, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';
import { readGroup } from '@alpacawork/backend/test-dist/release/recovery-data.js';
import { backupStoppedWorkspace } from '@alpacawork/backend/test-dist/release/switch.js';
import { saveJournal, loadJournal, type SwitchJournal } from '@alpacawork/backend/test-dist/release/journal.js';
import { point } from '@alpacawork/backend/test-dist/release/layout.js';
import { registerInstallation, inspectInstallationService, recordInstallationService } from '@alpacawork/backend/test-dist/installation/setup.js';

const cleanEnv=()=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>(!key.startsWith('ALPACAWORK_')||key.startsWith('ALPACAWORK_E2E_GUARD_')||key==='ALPACAWORK_E2E_BACKEND_GUARD')&&!['CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_CODE_SESSION_ID'].includes(key))),ALPACAWORK_SERVER:process.env.ALPACAWORK_SERVER??'http://127.0.0.1:9',ALPACAWORK_FAILURE_EVIDENCE_DIR:process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR});
async function completed(child:ChildProcess,ms=30_000) {
 const timeout=setTimeout(()=>child.kill('SIGKILL'),ms);
 try {const [code,signal]=await once(child,'exit');return{code,signal};}finally{clearTimeout(timeout);}
}
export async function setup(t:TestContext,future:boolean|'ungated'|'protocol1'=false,config?:string,prepare?: (built:string,name:string)=>void){
 const evidence:unknown[]=[];
 const base=realpathSync(mkdtempSync(join(tmpdir(),'release-recovery-'))),workspace=join(base,'data'),releases=join(base,'releases');
 // The optional evidence path is a prefix; each private root writes its own file.
 const evidenceFile=process.env.ALPACAWORK_RECOVERY_EVIDENCE ? process.env.ALPACAWORK_RECOVERY_EVIDENCE+'.'+basename(base)+'.json' : undefined;
 mkdirSync(releases);const original=createOriginal({tasks:14,logs:19,runs:7,seed:'recovery-v1'},join(base,'originals'));copyWorkspace(original.root,workspace);
 if(config!==undefined)writeFileSync(join(workspace,'config.yaml'),config);
 // This restoration fixture has no pending automatic continuation: close synthetic seats on the disposable copy.
 const closedSeats=new ControlStore(workspace);closedSeats.write(db=>db.prepare("UPDATE placements SET ended_at='2026-10-30T00:00:00.000Z'").run());closedSeats.close();
 const host=openDatabase(join(workspace,'.alpacawork/host.sqlite'),'host',{busyTimeoutMs:1000});host.$client.close();
 // Every release, including deliberate migration/gate faults, is sealed before it can serve.
 const sources=Object.fromEntries(['a','b','c'].map(name=>[name,fixtureCommit(resolve('.'),join(base,'source-objects'),name)]));
 const images=Object.fromEntries(['a','b','c'].map(name=>[name,join(releases,sources[name]!)])) as Record<'a'|'b'|'c',string>;
 for(const name of ['a','b','c']) {
  // Unprepared releases are assembled once per test process and copied (distribution-fixture.ts).
  const changed=prepare!==undefined||name==='b'&&future===true||name==='a'&&(future==='ungated'||future==='protocol1');
  assembleFixtureDistribution(resolve('.'),join(base,'build-'+name),images[name as 'a'|'b'|'c'],sources[name],changed?built=>{
   if(name==='b'&&future===true) {
    const assets=join(built,'apps/backend/dist/assets/db');
    for(const [kind,sql]of [['control',"CREATE TABLE failed_partial_schema(x TEXT);\n--> statement-breakpoint\nINSERT INTO failed_partial_schema VALUES ('committed');"],['host',"CREATE TABLE rolled_back_host(x TEXT CHECK(x <> 'fail'));\n--> statement-breakpoint\nINSERT INTO rolled_back_host SELECT 'fail' FROM episodes;"]] as const) {
     appendTestMigration(assets,kind,sql);
    }
   }
   if(name==='a'&&future==='ungated')writeFileSync(join(built,'apps/backend/dist/maintenance.js'),"throw Error('old code has no recovery protocol')");
   if(name==='a'&&future==='protocol1')writeFileSync(join(built,'apps/backend/dist/maintenance.js'),"console.log('1')");
   prepare?.(built,name);
  }:undefined);
  if(name==='b'&&future===true) {
   const candidate=JSON.parse(readFileSync(join(images.b,'SCHEMA.json'),'utf8'));
   assert.equal(canMigrateControlSchema(controlSchemaManifest(),candidate.control),true,'candidate control migrations must extend the current history');
   assert.equal(migrationPrefix(packagedMigrations('host'),candidate.host),true,'candidate host migrations must extend the current history');
   evidence.push({case:'candidate migration append',current:{control:controlSchemaManifest(),host:packagedMigrations('host')},candidate});
  }
 }
 point(releases,'current',images.a);
 const place={workspace,releases,service:'recovery-fixture.service',say:()=>{}};
 const journal:SwitchJournal={version:4,skillsWriteStarted:false,opId:randomUUID(),workspace,old:images.a,target:images.b,previous:null,phase:'old_stopped',schema:16};
 saveJournal(place,journal);
 if(config!==undefined){await (await import('@alpacawork/backend/test-dist/release/recovery-data.js')).snapshotGroup(workspace,join(releases,'backups',journal.opId),['config.yaml']);}
 const backupStarted=performance.now(),backup=await backupStoppedWorkspace(place,journal.target,journal);
 evidence.push({case:'T0 backup',elapsedMs:performance.now()-backupStarted,dbBytes:readGroup(backup,workspace).databases.map(db=>({name:db.name,bytes:db.digest?lstatSync(join(backup,db.name+'.sqlite')).size:0})),files:readGroup(backup,workspace).fileState.map(file=>file.path),node:process.version,platform:process.platform});journal.backup=backup;journal.phase='committed';saveJournal(place,journal);point(releases,'current',journal.target);
 writeFileSync(join(base,'service.json'),JSON.stringify(place));
 const unused=createServer();await new Promise<void>(done=>unused.listen(0,'127.0.0.1',done));const unusedPort=(unused.address() as {port:number}).port;await new Promise<void>(done=>unused.close(()=>done()));
 writeFileSync(join(workspace,'.alpacawork/connection.json'),JSON.stringify({url:`http://127.0.0.1:${unusedPort}/`,publicUrl:null,generation:randomUUID(),runManager:join(journal.target,'apps/backend/dist/run-manager.js')}),{mode:0o600});
 const env={...cleanEnv(),ALPACAWORK_RECOVERY_FIXTURE:base,HOME:join(base,'home'),XDG_CONFIG_HOME:join(base,'home/.config'),XDG_STATE_HOME:join(base,'home/.local/state')};mkdirSync(env.HOME,{mode:0o700});
 await registerInstallation({cwd:base,env,explicit:workspace},releases);
 await recordInstallationService(releases,workspace,await inspectInstallationService(releases,workspace,env,place.service),env);
 const serviceModule=resolve('tests/fixtures/recovery-service.mjs');
 const exec=async(args:string[],options:{kill?:string;cli?:boolean;diagnostic?:string;backup?:string}={})=>{
  let script=join(base,'driver.mjs');
  if(!existsSync(script))writeFileSync(script,`import {recoverBackup}from ${JSON.stringify(new URL('../../apps/backend/test-dist/release/switch.js',import.meta.url).href)};import{holdReleases}from ${JSON.stringify(new URL('../../apps/backend/test-dist/release/layout.js',import.meta.url).href)};import{readFileSync}from'node:fs';const p=JSON.parse(readFileSync(${JSON.stringify(join(base,'service.json'))},'utf8'));p.say=()=>{};const close=holdReleases(p.releases);try{console.log(JSON.stringify(await recoverBackup(p,process.argv[2],(phase)=>{if(phase===process.env.KILL_PHASE)process.kill(process.pid,'SIGKILL');})));}finally{close();}`);
  const started=performance.now(),startedAt=new Date().toISOString();
  // The unbundled CLI shares the local service adapter; immutable target maintenance/serve remain real bundles.
  const child=spawn(process.execPath,['--import',serviceModule,...(options.cli?[resolve('apps/backend/test-dist/backend-entry.js'),'--workspace',workspace,'release',options.diagnostic?'operation':'recover','--releases',releases,...options.diagnostic?[]:['--service',place.service],'--backup',options.backup??backup,...options.diagnostic?['--op-id',options.diagnostic]:[]]:[script,options.backup??backup])],{env:{...env,KILL_PHASE:options.kill},stdio:['ignore','pipe','pipe']});
  // Recovery includes several independently bounded maintenance/readiness steps, not one 40-second operation.
  const out:Buffer[]=[],err:Buffer[]=[];child.stdout!.on('data',c=>out.push(c));child.stderr!.on('data',c=>err.push(c));const result={...await completed(child,120_000),stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8'),pid:child.pid,elapsedMs:performance.now()-started,startedAt,finishedAt:new Date().toISOString()};evidence.push({action:'recover',kill:options.kill,cli:options.cli,diagnostic:options.diagnostic,...result});return result;
 };
 t.after(async()=>{
  await preserveTestFailure(t,base,{databaseRoot:workspace,diagnostics:()=>({journal:loadJournal(place),serveLog:existsSync(join(base,'serve.log'))?readFileSync(join(base,'serve.log'),'utf8'):null,serviceEvents:existsSync(join(base,'service-events.jsonl'))?readFileSync(join(base,'service-events.jsonl'),'utf8'):null})});
  const stop=spawnSync(process.execPath,['--import',serviceModule,'--input-type=module','-e',`import{platform}from'@alpacawork/core';if(!platform.service.stop('fixture'))process.exit(1)`],{env,encoding:'utf8',timeout:20_000});
  let writerReleased=false,writerReleaseError:string|undefined;
  if(stop.status===0)try{const releaseWriter=holdControlWriter(workspace);releaseWriter();writerReleased=true;}catch(error){writerReleaseError=String(error);}
  evidence.push({base,stop:stop.status,stopSignal:stop.signal,stopError:stop.error,stopStderr:stop.stderr,writerReleased,writerReleaseError,serviceEvents:existsSync(join(base,'service-events.jsonl'))?readFileSync(join(base,'service-events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)):[]});
  if(evidenceFile){mkdirSync(dirname(evidenceFile),{recursive:true});writeFileSync(evidenceFile,JSON.stringify({test:t.name,node:process.version,pid:process.pid,base,workspace,releases,evidence},null,2));}
  try {
   assert.equal(stop.status,0,stop.error?.message??stop.stderr??'Recovery fixture service did not stop');
   assert.equal(writerReleased,true,writerReleaseError??'Stopped recovery fixture retained its writer lease');
   removeWorkspace(workspace);removeWorkspace(original.root);rmSync(base,{recursive:true,force:true});
  } catch(error) {
   await preserveTestFailure(t,base,{databaseRoot:workspace,failure:{error},diagnostics:()=>({journal:loadJournal(place),stop:{status:stop.status,signal:stop.signal,error:stop.error,stderr:stop.stderr},serveLog:existsSync(join(base,'serve.log'))?readFileSync(join(base,'serve.log'),'utf8'):null,serviceEvents:existsSync(join(base,'service-events.jsonl'))?readFileSync(join(base,'service-events.jsonl'),'utf8'):null})});
   throw error;
  }
 });
 const start=async()=>{
   const result=spawnSync(process.execPath,['--import',serviceModule,'--input-type=module','-e',`import{startReady}from ${JSON.stringify(new URL('../fixtures/recovery-service.mjs',import.meta.url).href)};if(!await startReady())process.exit(1)`],{env,encoding:'utf8',timeout:20_000});assert.equal(result.status,0,result.error?.message??result.stderr);
   for(let n=0;n<100;n++){try{const c=JSON.parse(readFileSync(join(workspace,'.alpacawork/connection.json'),'utf8'));const r=await fetch(new URL('/api/runtime/readiness',c.url));if(r.ok&&(await r.json()).state==='accepting')return c.url as string;}catch{}await delay(30);}throw Error('Fixture serve did not start');
 };
 const stop=()=>{const result=spawnSync(process.execPath,['--import',serviceModule,'--input-type=module','-e',`import{platform}from'@alpacawork/core';if(!platform.service.stop('fixture'))process.exit(1)`],{env,encoding:'utf8',timeout:20_000});assert.equal(result.status,0,result.stderr);};
 const cli=async(origin:string,args:string[],credentials:NodeJS.ProcessEnv={})=>{
  const child=spawn(process.execPath,[resolve('apps/cli/dist/cli.js'),'--server',origin,...args],{env:{...env,...credentials},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout!.on('data',c=>stdout+=c);child.stderr!.on('data',c=>stderr+=c);return{...await completed(child,15_000),stdout,stderr,pid:child.pid};
 };
 return {base,workspace,releases,images,place,journal,backup,exec,start,stop,cli,env,evidence,evidenceFile};
}
