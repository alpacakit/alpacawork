/** Formal HTTP and the real detached controller, writer and shared switch journal. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { platform } from '@alpacawork/core';
import { managedUpdateFixture } from './helpers/managed-update.ts';
import { simpleUpdateCandidate } from './helpers/simple-update-candidate.ts';
const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
async function until(read:()=>Promise<any>,accept:(value:any)=>boolean,ms=240000):Promise<any>{let last:unknown;for(const end=Date.now()+ms;Date.now()<end;){try{last=await read();if(accept(last))return last;}catch(error){last=String(error);}await delay(50);}throw new Error('Timed out: '+JSON.stringify(last));}

test('one confirmation: read-only review, rejected authority, failed fetch, same-op retry, real candidate and same URL', { skip: process.platform !== 'linux' && 'GNU tar --transform and a linux-x64-glibc fixture image', timeout:600000}, async t=>{
 const f=await managedUpdateFixture(t),candidate=await simpleUpdateCandidate(t,f);
 const {ManagedSkillsWriter}=await import(pathToFileURL(join(f.output,'installation/skills.js')).href);
 await new ManagedSkillsWriter({root:f.skills}).install({version:2,operationId:randomUUID(),release:f.release,intent:{place:['alpacawork','alpacawork-betterquality'],remove:[]}});
 await f.start();const status=async()=>ok(await f.call('/api/update/status'));
 const available=await until(status,s=>s.kind==='available');
 const snapshot=()=>({current:readlinkSync(join(f.releases,'current')),
  previous:existsSync(join(f.releases,'previous'))?readlinkSync(join(f.releases,'previous')):null,
  switch:readFileSync(join(f.releases,'switch.json'),'utf8'),skills:f.image(f.skills),
  updates:existsSync(join(f.releases,'.updates'))?f.image(join(f.releases,'.updates')):null,
  candidates:existsSync(join(f.releases,'.npm-candidates'))?f.image(join(f.releases,'.npm-candidates')):null});
 const before=snapshot();
 assert.deepEqual(ok(await f.call('/api/update/review')),{kind:'unavailable'});
 const review=ok(await f.call('/api/update/review?candidateId='+available.candidateId));
 assert.deepEqual(Object.keys(review).sort(),['candidateId','kind','resume','reviewDigest','skills','version']);
 assert.equal(review.kind,'ready');assert.deepEqual(review.skills,['alpacawork','alpacawork-betterquality'],'the confirmation names the installed skills it overwrites');assert.equal(review.resume,null);
 assert.deepEqual(snapshot(),before);
 const input={opId:randomUUID(),candidateId:available.candidateId,reviewDigest:review.reviewDigest};
 const denied=await f.call('/api/update/confirm',input,{authorization:'Alpacawork-Run R1:'+ '0'.repeat(64)});
 assert.notEqual(denied.status,200);assert.equal(existsSync(join(f.releases,'.updates',input.opId)),false);
 const oldJournal=readFileSync(join(f.releases,'switch.json'));
 writeFileSync(join(f.releases,'switch.json'),JSON.stringify({...JSON.parse(oldJournal.toString()),version:999}));
 assert.notEqual((await f.call('/api/update/confirm',input)).status,200);
 writeFileSync(join(f.releases,'switch.json'),oldJournal);
 writeFileSync(join(f.skills,'alpacawork/SKILL.md'),'hand edited after review');
 candidate.failMetadata(true);ok(await f.call('/api/update/confirm',input));
 assert.equal((await status()).kind,'fetching','the accepted controller owns acquisition before its result');
 const failed=await until(status,s=>s.kind==='failed');assert.equal('cause'in failed,false);
 assert.equal(json(join(f.releases,'switch.json')).phase,'committed');
 await f.awaitUpdateControllers(input.opId);
 const resume=ok(await f.call('/api/update/review?candidateId='+input.candidateId));assert.deepEqual(resume.resume,input);
 const record=join(f.releases,'.updates','state.json'),original=json(record).operation.skills;
 assert.equal(json(record).version,3);
 assert.deepEqual(original,{root:f.skills,place:['alpacawork','alpacawork-betterquality']});
 assert.equal('approval' in json(record).operation,false);
 candidate.failMetadata(false);
 f.configureUpdate({faults:{enospc:[f.release],partialSkill:[join(f.releases,candidate.sha)],killInstall:[join(f.releases,candidate.sha)]}});
 ok(await f.call('/api/update/confirm',input));
 const started=await status();assert.equal(started.kind,'fetching','the live retry takes precedence over its saved failure');
 await until(status,s=>s.kind==='failed');await f.awaitUpdateControllers(input.opId);
 assert.match(readFileSync(join(f.releases,'.updates','controller.log'),'utf8'),/ENOSPC|capacity/i);
 ok(await f.call('/api/update/confirm',input));
 // Fail a real selected-directory rename after another managed skill was overwritten.
 await until(async()=>json(join(f.releases,'switch.json')),j=>j.phase==='target_ready'&&j.skillsWriteStarted);
 await f.awaitUpdateControllers(input.opId);
 const attention=await until(status,s=>s.kind==='attention');assert.deepEqual(Object.keys(attention).sort(),['kind','opId','version']);
 assert.equal(json(join(f.skills,'.alpacawork/installed.json')).state,'installing');
 assert.equal(json(join(f.releases,'switch.json')).target,join(f.releases,candidate.sha));
 const stoppedJournal=readFileSync(join(f.releases,'switch.json'));
 const backup=JSON.parse(stoppedJournal.toString()).backup;assert(backup,'the real switch made its stopped DB backup');
 const recover=()=>spawnSync(process.execPath,[join(f.releases,candidate.sha,'apps/backend/dist/backend.js'),'--workspace',f.workspace,
  'release','recover','--releases',f.releases,'--service',f.definition.name,'--backup',backup],{
   env:{...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('ALPACAWORK_'))),
    ...f.installationEnvironment,ALPACAWORK_MANAGED_RELEASES:f.releases,NODE_OPTIONS:'--import='+f.adapter},encoding:'utf8',timeout:30000});
 const refusal=()=>{
  const recovery=recover();assert.notEqual(recovery.status,0);
  const error=JSON.parse(recovery.stderr).error;
  assert.deepEqual(error,{code:'conflict',
   message:'After an app update has overwritten skills, you cannot restore the previous version from this backup. The current version and data have not been changed.',
   retry:'reread',reason:{kind:'recovery_after_skill_update_unsupported'}});
  return error;
 };
 refusal();
 assert.deepEqual(readFileSync(join(f.releases,'switch.json')),stoppedJournal);

 const stoppedFiles=snapshot();
 const selected=ok(await f.call('/api/update/review'));assert.deepEqual(snapshot(),stoppedFiles);assert.deepEqual(selected.resume,input);
 ok(await f.call('/api/update/confirm',input));
 await f.awaitUpdateControllers(input.opId);await until(status,s=>s.kind==='attention');
 assert.equal(json(join(f.skills,'.alpacawork/installed.json')).state,'complete');
 // The successful Store publication survived another lost controller answer.
 const evidence=join(f.releases,'recovery-evidence','broken');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'recovery.json'),'{');
 const obsolete=join(f.releases,'backups','obsolete');mkdirSync(obsolete);
 ok(await f.call('/api/update/confirm',input));
 const done=await until(status,s=>s.kind==='done');assert.equal(done.version,'0.3.1');
 await f.awaitUpdateControllers(input.opId);
 assert.match(readFileSync(join(f.releases,'.updates','controller.log'),'utf8'),/Post-update prune failed; update remains committed/);
 assert(existsSync(obsolete),'a retention read fault must precede deletion, without failing the committed update');
 assert.equal(json(join(f.releases,'switch.json')).version,4);
 assert.equal(json(join(f.releases,'switch.json')).skillsWriteStarted,true);
 assert.deepEqual(json(join(f.skills,'.alpacawork/installed.json')).skills.map((s:any)=>s.name),original.place);
 assert.equal(json(record).operation,null);assert.equal(json(record).lastResult.result,'committed');
 const requests=candidate.downloads();ok(await f.call('/api/update/confirm',input));assert.equal(candidate.downloads(),requests);
 const committedFiles=snapshot();t.diagnostic('Completed update recovery refusal: '+JSON.stringify(refusal()));assert.deepEqual(snapshot(),committedFiles);
 await f.stop();
});

test('cancelling a later aborted update cannot recover the backup preceding a completed skill overwrite', {skip:process.platform!=='linux'&&'linux fixture image',timeout:240000},async t=>{
 const f=await managedUpdateFixture(t),candidate=await simpleUpdateCandidate(t,f);
 await f.start();
 const status=async()=>ok(await f.call('/api/update/status'));
 const available=await until(status,s=>s.kind==='available');
 const review=ok(await f.call('/api/update/review?candidateId='+available.candidateId));
 const first={opId:randomUUID(),candidateId:available.candidateId,reviewDigest:review.reviewDigest};
 await until(()=>f.call('/api/update/confirm',first),r=>r.status===200);await until(status,s=>s.kind==='done');await f.awaitUpdateControllers(first.opId);
 const committed=json(join(f.releases,'switch.json')),backup=committed.backup,target=join(f.releases,candidate.sha);
 assert(backup);assert.equal(committed.skillsWriteStarted,true);
 assert.equal(json(join(f.skills,'.alpacawork/installed.json')).request.release,target);
 // Repository deployments may select any prepared release. Fail this second selection only after stopping B.
 f.configureUpdate({failRestart:[f.release]});
 const location=join(f.output,'release/location.js');
 writeFileSync(location,`export const thisRelease=()=>${JSON.stringify(target)};`);
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ALPACAWORK_'))),
  ...f.installationEnvironment,ALPACAWORK_MANAGED_RELEASES:f.releases,NODE_OPTIONS:'--import='+f.adapter};
 const accepted=spawnSync(process.execPath,['--input-type=module','-e',`
  import{readPackageVersion}from'@alpacawork/core/package-version';
  import{randomUUID}from'node:crypto';
  const operation=await import(${JSON.stringify(pathToFileURL(join(f.output,'release/update-operation.js')).href)});
  const runtime=await import(${JSON.stringify(pathToFileURL(join(f.output,'release/update-runtime.js')).href)});
  const {InstallationStore,installationPath}=await import(${JSON.stringify(pathToFileURL(join(f.output,'installation/store.js')).href)});
  const facts=readPackageVersion(${JSON.stringify(f.release)}),candidate={kind:'prepared',origin:'Synthetic second deployment',candidateId:randomUUID(),
   exactVersion:facts.version,edition:facts.edition,facts,expectedActive:${JSON.stringify(target)}};
  console.log(operation.acceptPreparedUpdate(runtime.resolveUpdateRuntime(${JSON.stringify(f.workspace)}),candidate,
   {root:${JSON.stringify(f.skills)},place:['alpacawork']},${JSON.stringify(target)},new InstallationStore(installationPath(process.env)).read()));
 `],{env,cwd:process.cwd(),encoding:'utf8',timeout:30000});
 assert.equal(accepted.status,0,accepted.stderr);const second=accepted.stdout.trim();
 const failed=spawnSync(process.execPath,[join(target,'apps/backend/dist/release/update-controller.js'),'run',f.workspace,second],{env,encoding:'utf8',timeout:120000});
 assert.notEqual(failed.status,0,failed.stdout+failed.stderr);
 const aborted=json(join(f.releases,'switch.json'));assert.equal(aborted.phase,'aborted',failed.stderr);assert.equal(aborted.skillsWriteStarted,false);
 assert.equal(aborted.old,target);assert.equal(aborted.target,f.release);
 await until(()=>f.call('/api/update/cancel',{opId:second}),r=>r.status===200);assert.equal(json(join(f.releases,'.updates/state.json')).operation,null);
 // Stop our recorded fixture PID before comparing all DB and record bytes.
 const stopped=spawnSync(process.execPath,['--import',f.adapter,'--input-type=module','-e',
  `const{platform}=await import(${JSON.stringify(pathToFileURL(join(target,'apps/backend/dist/fixture-platform.js')).href)});if(!platform.service.stop(${JSON.stringify(f.definition.name)}))process.exit(1);`,join(target,'apps/backend/dist/backend.js')],{env,encoding:'utf8',timeout:20000});
 assert.equal(stopped.status,0,stopped.stderr);
 const snapshot=()=>({workspace:f.image(f.workspace),skills:f.image(f.skills),journal:readFileSync(join(f.releases,'switch.json'),'utf8'),
  update:readFileSync(join(f.releases,'.updates/state.json'),'utf8'),current:readlinkSync(join(f.releases,'current')),previous:readlinkSync(join(f.releases,'previous'))});
 f.configureUpdate({failRestart:[]});
 const before=snapshot();
 const refused=spawnSync(process.execPath,[join(target,'apps/backend/dist/backend.js'),'--workspace',f.workspace,'release','recover',
  '--releases',f.releases,'--service',f.definition.name,'--backup',backup],{env,encoding:'utf8',timeout:30000});
 assert.notEqual(refused.status,0,refused.stdout);assert.equal(JSON.parse(refused.stderr).error.reason.kind,'recovery_backup_switch_mismatch');
 assert.match(JSON.parse(refused.stderr).error.message,/backup does not belong to the last application switch/);
 assert.deepEqual(snapshot(),before,'rejected recovery must leave DBs, skills, records and links unchanged');
});
