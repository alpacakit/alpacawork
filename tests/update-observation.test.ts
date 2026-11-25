/** Formal HTTP: one bounded record, immutable authorization, no GET repair or live-content freshness. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { managedUpdateFixture } from './helpers/managed-update.ts';
const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
function offer(f: Awaited<ReturnType<typeof managedUpdateFixture>>, candidateId='fixed') {
 const manifest=JSON.parse(readFileSync(new URL('./fixtures/npm-candidate-manifest.json',import.meta.url),'utf8'));
 const candidate={version:1 as const,candidateId,registryOrigin:'http://127.0.0.1:9',packageName:manifest.name,exactVersion:manifest.version,
  tarball:'http://127.0.0.1:9/a.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64'),metadataDigest:'a'.repeat(64),edition:'production' as const,facts:manifest.alpacawork,
  engines:manifest.engines,environment:{managedNodeVersion:process.version,target:'linux-x64-glibc' as const,edition:'production' as const},expectedActive:f.release,changes:'unknown' as const};
 f.operation.updateDecision(f.releases,()=>f.operation.offerUpdateLocked(f.releases,candidate));
}
test('review/confirm/replay/cancel use one record; edits are accepted and consumed offers never revive', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)', timeout:120000}, async t=>{
 const f=await managedUpdateFixture(t);offer(f);
 const record=join(f.releases,'.updates','state.json'),read=()=>JSON.parse(readFileSync(record,'utf8'));
 // A periodic check that observes the same release again keeps the offer a person may be reviewing.
 offer(f,'observed-again');assert.equal(read().offer.candidateId,'fixed');
 await f.start();
 assert.deepEqual(ok(await f.call('/api/update/review')),{kind:'unavailable'});
 const bytes=readFileSync(record),review=ok(await f.call('/api/update/review?candidateId=fixed'));
 assert.equal(review.kind,'ready');assert.deepEqual(readFileSync(record),bytes);
 writeFileSync(join(f.skills,'alpacawork/SKILL.md'),'edited after reviewing');
 assert.equal(ok(await f.call('/api/update/review?candidateId=fixed')).reviewDigest,review.reviewDigest);
 // A placement selection change is a change to the authority being granted.
 const receiptFile=join(f.control,'installed.json'),originalReceipt=readFileSync(receiptFile),receipt=JSON.parse(originalReceipt.toString());
 receipt.skills.push({...receipt.skills[0],name:'alpacawork-betterquality'});writeFileSync(receiptFile,JSON.stringify(receipt));
 const input={opId:randomUUID(),candidateId:'fixed',reviewDigest:review.reviewDigest};
 assert.notEqual((await f.call('/api/update/confirm',input)).status,200);
 writeFileSync(receiptFile,originalReceipt);
 const {holdReleases}=await import(pathToFileURL(join(f.output,'release/layout.js')).href);const releaseLock=holdReleases(f.releases);
 try{const busy=await f.call('/api/update/confirm',input);assert.equal(busy.status,409);assert.equal(busy.body.error.detail.reason,'operation_busy');}finally{releaseLock();}
 const [first,second]=await Promise.all([f.call('/api/update/confirm',input),f.call('/api/update/confirm',input)]);
 ok(first);ok(second);await f.awaitUpdateControllers(input.opId);
 // An accepted confirmation survives a release publication that has not unlocked yet.
 const publication=holdReleases(f.releases);
 const replay=f.operation.confirmUpdate(f.workspace,input);
 publication();
 assert.deepEqual(await replay,{...input,terminal:null});
 // A persistent external lock still refuses the replay at the human command's deadline.
 const external=holdReleases(f.releases);let ticks=0;
 const clock=t.mock.method(performance,'now',()=>ticks++===0?0:5_000);
 try{await assert.rejects(f.operation.confirmUpdate(f.workspace,input),error=>
  error instanceof Error&&'detail' in error&&(error.detail as any).reason==='operation_busy');}
 finally{clock.mock.restore();external();}
 assert.equal(read().operation.phase,'failed');assert.equal(read().offer,null);
 assert.notEqual((await f.call('/api/update/confirm',{...input,reviewDigest:'0'.repeat(64)})).status,200);
 assert.notEqual((await f.call('/api/update/confirm',{...input,opId:randomUUID()})).status,200);
 assert.deepEqual(ok(await f.call('/api/update/review')).resume,input);
 const original=readFileSync(record);
 for(const invalid of [{version:1},{...read(),operation:{...read().operation,skills:{...read().operation.skills,place:['custom']}}}]){
  writeFileSync(record,JSON.stringify(invalid));const before=readFileSync(record);
  assert.deepEqual(ok(await f.call('/api/update/review')),{kind:'unavailable'});
  assert.notEqual((await f.call('/api/update/confirm',input)).status,200);
  assert.deepEqual(readFileSync(record),before);
  writeFileSync(record,original);
 }
 const cancelledResponse=ok(await f.call('/api/update/cancel',{opId:input.opId}));
 assert.deepEqual(ok(await f.call('/api/update/cancel',{opId:input.opId})),cancelledResponse);
 const cancelled=read();assert.equal(cancelled.operation,null);assert.equal(cancelled.lastResult.result,'cancelled');
 assert.notEqual(cancelled.offer.candidateId,input.candidateId);
 assert.equal(ok(await f.call('/api/update/confirm',input)).terminal,'cancelled');
 // The same replay also survives publication of its retained terminal result.
 const terminalPublication=holdReleases(f.releases);
 const terminalReplay=f.operation.confirmUpdate(f.workspace,input);
 terminalPublication();
 assert.deepEqual(await terminalReplay,{...input,terminal:'cancelled'});
 // Bounded result retention must not turn the old confirmation into a new operation.
 cancelled.lastResult=null;writeFileSync(record,JSON.stringify(cancelled));
 assert.notEqual((await f.call('/api/update/confirm',input)).status,200);
 assert.deepEqual(ok(await f.call('/api/update/review')),{kind:'unavailable'});
 assert.equal(read().operation,null);await f.stop();
});

test('confirm reads current under its lock and reads scope, runtime and receipt once on acceptance and replay', { skip: process.platform !== 'linux' && 'glibc target detection via process.report' }, async t=>{
 const f=await managedUpdateFixture(t);offer(f);
 const review=await f.operation.reviewUpdate(f.workspace,'fixed');assert.equal(review.kind,'ready');
 if(review.kind!=='ready')throw Error('Expected review');
 const input={opId:randomUUID(),candidateId:'fixed',reviewDigest:review.reviewDigest};
 const layout=await import(pathToFileURL(join(f.output,'release/layout.js')).href);
 const status=await import(pathToFileURL(join(f.output,'release/update-status.js')).href);
 for(const step of ['accept','replay']){
  const reads:string[]=[],opens:string[]=[];
  const originalRead=fs.readFileSync,originalOpen=fs.openSync,originalLink=fs.readlinkSync;
  const read=t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{
   reads.push(String(args[0]));return Reflect.apply(originalRead,fs,args);
  });
  const open=t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{
   opens.push(String(args[0]));return Reflect.apply(originalOpen,fs,args);
  });
  let currentReads=0;
  const link=t.mock.method(fs,'readlinkSync',(...args:Parameters<typeof fs.readlinkSync>)=>{
   if(String(args[0])===join(f.releases,'current')){
    currentReads++;const unlock=layout.tryHoldReleases(f.releases);
    if(unlock){unlock();assert.fail('current was inspected before acquiring the decision lock');}
   }
   return Reflect.apply(originalLink,fs,args);
  });
  const report=t.mock.method(process.report,'getReport');syncBuiltinESMExports();
  try{
   assert.deepEqual(await f.operation.confirmUpdate(f.workspace,input),{...input,terminal:null});
   assert.equal(currentReads,1,step);assert.equal(report.mock.callCount(),1,'one runtime resolution on '+step);
   for(const file of ['.updates/state.json','switch.json'])assert.equal(reads.filter(p=>p===join(f.releases,file)).length,1,file);
   assert.equal(opens.filter(p=>p===join(f.control,'installed.json')).length,1);
  }finally{read.mock.restore();open.mock.restore();link.mock.restore();report.mock.restore();syncBuiltinESMExports();}
  const saved=JSON.parse(readFileSync(join(f.releases,'.updates/state.json'),'utf8'));
  assert.deepEqual(saved.operation.skills,{root:f.skills,place:['alpacawork']});
  assert.equal('approval' in saved.operation,false);
  // A stopped accepted operation has no executor; status does not manufacture progress or write repairs.
  const before=readFileSync(join(f.releases,'.updates/state.json'));
  const originalReadStatus=fs.readFileSync,observed:string[]=[];
  const count=t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{
   observed.push(String(args[0]));return Reflect.apply(originalReadStatus,fs,args);
  });syncBuiltinESMExports();
  try{
   assert.deepEqual(status.updateStatus(f.workspace),{kind:'attention',opId:input.opId,version:review.version});
   for(const file of ['.updates/state.json','switch.json'])assert.equal(observed.filter(p=>p===join(f.releases,file)).length,1,file);
  }finally{count.mock.restore();syncBuiltinESMExports();}
  assert.deepEqual(readFileSync(join(f.releases,'.updates/state.json')),before);
 }
});

test('an accepted update listing private add-ons replays without changing its authority', { skip: process.platform !== 'linux' && 'glibc target detection via process.report' }, async t => {
 const f = await managedUpdateFixture(t);
 const receiptFile = join(f.control, 'installed.json'), receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
 for (const name of ['alpacawork-betterquality', 'alpacawork-majority', 'alpacawork-try-and-keep'])
  receipt.skills.push({ ...receipt.skills[0], name });
 writeFileSync(receiptFile, JSON.stringify(receipt));
 offer(f);
 const review = await f.operation.reviewUpdate(f.workspace, 'fixed');
 assert.equal(review.kind, 'ready');
 if (review.kind !== 'ready') throw Error('Expected review');
 assert.deepEqual(review.skills, ['alpacawork', 'alpacawork-betterquality']);
 const input = { opId: randomUUID(), candidateId: 'fixed', reviewDigest: review.reviewDigest };
 await f.operation.confirmUpdate(f.workspace, input);
 const record = join(f.releases, '.updates/state.json'), saved = JSON.parse(readFileSync(record, 'utf8'));
 // The previous release could have accepted these four names under its own digest.
 saved.operation.skills.place = receipt.skills.map((skill: { name: string }) => skill.name);
 writeFileSync(record, JSON.stringify(saved));
 assert.deepEqual(await f.operation.confirmUpdate(f.workspace, input), { ...input, terminal: null });
 assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).operation, saved.operation);
});
