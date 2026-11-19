/** Real HTTP publication failures at the one record boundary; no operation-inode machinery. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { managedUpdateFixture } from './helpers/managed-update.ts';
const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
test('record rename/fsync faults and SIGKILL preserve same-op retry; GET does not repair publication', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)', timeout:180000}, async t=>{
 const f=await managedUpdateFixture(t),manifest=JSON.parse(readFileSync(new URL('./fixtures/npm-candidate-manifest.json',import.meta.url),'utf8'));
 const candidate:any={version:1,candidateId:'fault',registryOrigin:'http://127.0.0.1:9',packageName:manifest.name,exactVersion:manifest.version,
  tarball:'http://127.0.0.1:9/a.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64'),metadataDigest:'a'.repeat(64),edition:'production',facts:manifest.alpacawork,
  engines:manifest.engines,environment:{managedNodeVersion:process.version,target:'linux-x64-glibc',edition:'production'},expectedActive:f.release,changes:'unknown'};
 f.operation.updateDecision(f.releases,()=>f.operation.offerUpdateLocked(f.releases,candidate));
 const file=join(f.releases,'.updates/state.json'),folder=join(f.releases,'.updates'),policy=join(f.root,'policy'),preload=join(f.root,'fault.mjs');
 writeFileSync(policy,'none');
 writeFileSync(preload,`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
 const rename=fs.renameSync,sync=fs.fsyncSync;
 const mode=()=>fs.readFileSync(${JSON.stringify(policy)},'utf8');
 const fail=()=>{throw Object.assign(new Error('Synthetic update publication failure'),{code:'EIO'});};
 fs.renameSync=function(from,to){if(String(to)===${JSON.stringify(file)}&&mode()==='before')fail();return rename(from,to);};
 fs.fsyncSync=function(fd){let path;try{path=fs.realpathSync('/proc/self/fd/'+fd);}catch{}
 if(path===${JSON.stringify(folder)}&&['after','kill'].includes(mode())){if(mode()==='kill')process.kill(process.pid,'SIGKILL');fail();}return sync(fd);};
 syncBuiltinESMExports();`);
 await f.start(f.workspace,[preload]);
 let review=ok(await f.call('/api/update/review?candidateId=fault'));
 let input={opId:randomUUID(),candidateId:review.candidateId,reviewDigest:review.reviewDigest};
 const original=readFileSync(file);writeFileSync(policy,'before');
 assert.notEqual((await f.call('/api/update/confirm',input)).status,200);assert.deepEqual(readFileSync(file),original);
 writeFileSync(policy,'none');ok(await f.call('/api/update/confirm',input));await f.awaitUpdateControllers(input.opId);
 assert.equal(JSON.parse(readFileSync(file,'utf8')).operation.opId,input.opId);
 if(process.platform==='linux'){
  writeFileSync(policy,'after');
  assert.notEqual((await f.call('/api/update/cancel',{opId:input.opId})).status,200);
  assert.notEqual((await f.call('/api/update/cancel',{opId:input.opId})).status,200);
  assert.notEqual((await f.call('/api/update/confirm',input)).status,200);
  const bytes=readFileSync(file);assert.deepEqual(ok(await f.call('/api/update/review')),{kind:'unavailable'});assert.deepEqual(readFileSync(file),bytes);
  writeFileSync(policy,'none');
 }
 ok(await f.call('/api/update/cancel',{opId:input.opId}));
 for(const mode of process.platform==='linux'?['after','kill']:[]){
  const state=JSON.parse(readFileSync(file,'utf8'));
  review=ok(await f.call('/api/update/review?candidateId='+state.offer.candidateId));
  input={opId:randomUUID(),candidateId:review.candidateId,reviewDigest:review.reviewDigest};
  writeFileSync(policy,mode);
  if(mode==='kill'){await assert.rejects(f.call('/api/update/confirm',input));await f.stop();writeFileSync(policy,'none');await f.start(f.workspace,[preload]);}
  else{
   assert.notEqual((await f.call('/api/update/confirm',input)).status,200);
   assert.equal(JSON.parse(readFileSync(file,'utf8')).operation.opId,input.opId);
   const bytes=readFileSync(file);assert.deepEqual(ok(await f.call('/api/update/review')).resume,input);assert.deepEqual(readFileSync(file),bytes);
   assert.notEqual((await f.call('/api/update/confirm',input)).status,200);writeFileSync(policy,'none');
  }
  ok(await f.call('/api/update/confirm',input));await f.awaitUpdateControllers(input.opId);
  assert.deepEqual(ok(await f.call('/api/update/review')).resume,input);
  ok(await f.call('/api/update/cancel',{opId:input.opId}));
 }
 writeFileSync(policy,'none');await f.stop();
});
