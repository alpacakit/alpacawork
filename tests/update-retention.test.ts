/** Real prune over dedicated synthetic releases; provenance is metadata, never a retention lease. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { platform } from '@alpacawork/core';
import { prune } from '../apps/backend/test-dist/release/switch.js';
import { holdReleases } from '../apps/backend/test-dist/release/layout.js';
import { readUpdateRecord, saveUpdateRecord, updateTarget } from '../apps/backend/test-dist/release/update-record.js';
import { RECOVERY_PROTOCOL } from '../apps/backend/test-dist/release/journal.js';
import { pendingUpdateReferences } from '../apps/backend/test-dist/release/npm-retention.js';
import { releaseArtifacts } from './helpers/release-switch-fixture.ts';
import { ControlStore } from '@alpacawork/db';
import { snapshotGroup } from '../apps/backend/test-dist/release/recovery-data.js';
const manifest=JSON.parse(new TextDecoder().decode(await (await import('node:fs/promises')).readFile(new URL('./fixtures/npm-candidate-manifest.json',import.meta.url))));
test('prune deletes completed npm releases while preserving pending targets, current/previous, journal, backup and live manager',async t=>{
 const root=mkdtempSync(join(tmpdir(),'update-retention-')),releases=join(root,'releases');mkdirSync(releases);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 function release(n:number){const sha=n.toString(16).repeat(40),dir=join(releases,sha),web=join(dir,'apps/backend/public');mkdirSync(web,{recursive:true});
  writeFileSync(join(dir,'SOURCE'),sha);writeFileSync(join(web,'asset-manifest.json'),JSON.stringify({'index.html':{file:'assets/app.js'}}));
  writeFileSync(join(web,'index.html'),'<script src="/assets/app.js"></script>');return dir;}
 const current=release(1),previous=release(2),oldNpm=release(3),pending=release(4),journalTarget=release(5),manager=release(6),backupSource=release(7),backupTarget=release(8);
 symlinkSync(current,join(releases,'current'));symlinkSync(previous,join(releases,'previous'));
 const stages=join(releases,'.release-metadata');mkdirSync(stages,{recursive:true});
 const orphan=join(stages,'9'.repeat(40)+'.json');writeFileSync(orphan,'{}');writeFileSync(orphan+'.tmp','{}');
 const provenance=join(stages,oldNpm.split('/').at(-1)+'.json');writeFileSync(provenance,'{"legacy":"not a retention reference"}');
 const backup=join(releases,'backups','fixture');mkdirSync(backup,{recursive:true});
 const code=(dir:string)=>{mkdirSync(join(dir,'apps/backend/dist'),{recursive:true});writeFileSync(join(dir,'apps/backend/dist/maintenance.js'),'synthetic maintenance');
  writeFileSync(join(dir,'SCHEMA.json'),'{}');writeFileSync(join(dir,'FORMAT'),'format');
  return{source:dir.split('/').at(-1),format:'format',schemaDigest:createHash('sha256').update('{}').digest('hex'),maintenanceDigest:createHash('sha256').update('synthetic maintenance').digest('hex')};};
 writeFileSync(join(backup,'backup.json'),JSON.stringify({version:1,workspace:root,source:backupSource,target:backupTarget,
  protocol:RECOVERY_PROTOCOL,node:process.execPath,nodeVersion:process.version,code:{source:code(backupSource),target:code(backupTarget)}}));
 const candidate={version:1,candidateId:'pending',registryOrigin:'http://127.0.0.1:9',packageName:manifest.name,exactVersion:manifest.version,
  tarball:'http://127.0.0.1:9/a.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64'),metadataDigest:'a'.repeat(64),edition:'production',facts:{...manifest.alpacawork,source:'4'.repeat(40)},
  engines:manifest.engines,environment:{managedNodeVersion:process.version,target:'linux-x64-glibc',edition:'production'},expectedActive:current,changes:'unknown'};
 const opId=randomUUID(),digest='d'.repeat(64),state:any={version:3,offer:null,lastResult:null,operation:{opId,workspace:root,candidate,reviewDigest:digest,
  skills:{root:join(root,'skills'),place:['alpacawork']},phase:'fetching',controller:null,failure:null}};
 const locked=(work:()=>any)=>{const unlock=holdReleases(releases);try{return work();}finally{unlock();}};
 locked(()=>saveUpdateRecord(releases,state));assert.deepEqual(pendingUpdateReferences(releases),[pending,current]);
 rmSync(pending,{recursive:true});assert.deepEqual(pendingUpdateReferences(releases),[pending,current],'the target is protected before rename');release(4);
 writeFileSync(join(releases,'switch.json'),JSON.stringify({version:4,skillsWriteStarted:false,opId:randomUUID(),workspace:root,old:previous,target:journalTarget,previous:null,phase:'old_stopped',schema:null}));
 mkdirSync(join(manager,'apps/backend/dist'),{recursive:true});const entry=join(manager,'apps/backend/dist/run-manager.js');writeFileSync(entry,'setTimeout(()=>{},60000)');
 const child=spawn(process.execPath,[entry],{stdio:'ignore'});const ended=once(child,'exit');await once(child,'spawn');
 const started=platform.run.started(child.pid!);assert(started);
 try{
  assert.deepEqual(locked(()=>prune(releases,0,()=>{})),[oldNpm.split('/').at(-1)]);
  assert.equal(existsSync(oldNpm),false);assert.equal(existsSync(provenance),false);assert.equal(existsSync(orphan),false);assert.equal(existsSync(orphan+'.tmp'),false);
  for(const path of [current,previous,pending,journalTarget,manager,backupSource,backupTarget])assert(existsSync(path),path);
  state.operation.phase='failed';state.operation.failure={kind:'metadata_failed',category:'network'};locked(()=>saveUpdateRecord(releases,state));
  assert(pendingUpdateReferences(releases).includes(pending),'network failure stays resumable');
  state.operation.failure={kind:'metadata_changed',category:'other'};locked(()=>saveUpdateRecord(releases,state));
  assert.deepEqual(pendingUpdateReferences(releases),[]);assert(locked(()=>prune(releases,0,()=>{})).includes('4'.repeat(40)));
 }finally{child.kill('SIGTERM');await ended;}
 assert(locked(()=>prune(releases,0,()=>{})).includes('6'.repeat(40)),'dead manager no longer retains code');
});

test('only a terminal journal backup expires other groups; all retention reads precede deletion',async t=>{
 const root=mkdtempSync(join(tmpdir(),'backup-retention-')),releases=join(root,'releases');mkdirSync(releases);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const images=Object.fromEntries(['a','b','c','d'].map(name=>{
  const folder=join(releases,name);releaseArtifacts(folder);writeFileSync(join(folder,'SOURCE'),name);return[name,folder];
 }));
 symlinkSync('c',join(releases,'current'));symlinkSync('b',join(releases,'previous'));
 const backups=join(releases,'backups'),old=join(backups,'old'),latest=join(backups,'latest'),partial=join(backups,'partial');
 for(const folder of [old,latest,partial])mkdirSync(folder,{recursive:true});
 new ControlStore(root,{busyTimeoutMs:1000},false,true).close();await snapshotGroup(root,latest);
 const code=(source:string)=>({source,format:null,schemaDigest:'not inspected by prune',maintenanceDigest:'not inspected by prune'});
 const metadata=(source:string,target:string)=>({version:1,workspace:root,source,target,protocol:999,node:'/different/node',nodeVersion:'old',
  code:{source:code(source),target:code(target)}});
 const first=metadata(images.a!,images.b!),saved=metadata(images.b!,images.c!);
 writeFileSync(join(old,'backup.json'),JSON.stringify(first));writeFileSync(join(latest,'backup.json'),JSON.stringify(saved));
 const journal={version:4,skillsWriteStarted:false,opId:randomUUID(),workspace:root,old:images.b,target:images.c,previous:images.a,phase:'committed',schema:null,backup:latest};
 const publish=(value:unknown)=>writeFileSync(join(releases,'switch.json'),JSON.stringify(value));
 const locked=()=>{const close=holdReleases(releases);try{return prune(releases,0,()=>{},root);}finally{close();}};
 const unchanged=()=>{assert.deepEqual(readdirSync(backups).sort(),['latest','old','partial']);for(const path of Object.values(images))assert(existsSync(path));};
 // Without a terminal, selected backup no group expires, including an unpublished acquisition.
 for(const value of [null,{...journal,phase:'old_stopped'},{...journal,backup:undefined},
  {...journal,phase:'recovery_floor',recovery:{id:randomUUID(),backup:old,source:images.c,reader:images.c,target:images.a,replaced:[],failure:join(releases,'recovery-evidence','pending')}}]) {
  if(value===null)rmSync(join(releases,'switch.json'),{force:true});else publish(value);
  locked();assert.deepEqual(readdirSync(backups).sort(),['latest','old','partial']);assert(existsSync(images.a!));
 }
 // d is not otherwise retained; reconstruct it after the non-expiring cases above prune ordinary code.
 releaseArtifacts(images.d!);writeFileSync(join(images.d!,'SOURCE'),'d');
 const evidence=join(releases,'recovery-evidence','fixed');mkdirSync(evidence,{recursive:true});
 writeFileSync(join(evidence,'recovery.json'),JSON.stringify({version:1,source:images.d,reader:images.c,target:images.b}));
 publish(journal);
 const detached=join(root,'detached-backups');renameSync(backups,detached);symlinkSync(detached,backups);
 assert.throws(locked);unchanged();rmSync(backups);renameSync(detached,backups);
 for(const value of ['{',JSON.stringify({...saved,workspace:join(root,'foreign')}),
  JSON.stringify({...saved,source:images.a}),JSON.stringify({...saved,target:join(releases,'missing')}),JSON.stringify({...saved,code:null})]) {
  writeFileSync(join(latest,'backup.json'),value);assert.throws(locked);unchanged();
 }
 rmSync(join(latest,'backup.json'));assert.throws(locked);unchanged();
 writeFileSync(join(latest,'backup.json'),JSON.stringify(saved));
 const group=readFileSync(join(latest,'group.json'));rmSync(join(latest,'group.json'));assert.throws(locked);unchanged();writeFileSync(join(latest,'group.json'),group);
 for(const backup of [join(backups,'missing'),root]){publish({...journal,backup});assert.throws(locked);unchanged();}
 publish(journal);
 // A late read fault must not leave old backups already deleted.
 writeFileSync(join(releases,'.release-metadata'),'not a directory');assert.throws(locked);unchanged();rmSync(join(releases,'.release-metadata'));
 writeFileSync(join(evidence,'recovery.json'),'{');assert.throws(locked);unchanged();
 writeFileSync(join(evidence,'recovery.json'),JSON.stringify({version:1,source:images.d,reader:images.c,target:images.b}));
 // Obsolete metadata need not be usable. Interrupted removal/unpublished groups share the same expiry.
 writeFileSync(join(old,'backup.json'),'{');
 mkdirSync(join(releases,'.release-metadata'));const provenance=join(releases,'.release-metadata','9'.repeat(40)+'.json');writeFileSync(provenance,'{}');
 writeFileSync(join(backups,'.DS_Store'),'synthetic Finder metadata');
 assert.deepEqual(locked(),['a']);assert.deepEqual(readdirSync(backups).sort(),['.DS_Store','latest']);assert(existsSync(images.d!),'recovery evidence keeps its diagnostic code');
 assert.equal(readFileSync(join(backups,'.DS_Store'),'utf8'),'synthetic Finder metadata');
 assert.equal(existsSync(provenance),false);assert.deepEqual(locked(),[]);
});
