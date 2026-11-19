/** The real launcher must expose a reviewable plan without mutating a managed destination. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { observeNpmCandidate, acquireNpmCandidate } from '../apps/backend/test-dist/release/npm-candidate.js';
import { localCli } from '../apps/backend/test-dist/installation/local-cli.js';
import { managedUpdateFixture } from './helpers/managed-update.ts';

test('public deploy without a terminal prints the bound plan; an incorrect confirmation changes nothing', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)', timeout:60000}, async t => {
  const f=await managedUpdateFixture(t), record=join(f.home,'.config/alpacawork/installation.json');
  const files=[record,join(f.releases,'switch.json'),join(f.skills,'.alpacawork/installed.json')];
  const before=files.map(file=>readFileSync(file,'utf8'));
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ALPACAWORK_'))),...f.installationEnvironment};
  const command=(extra:string[]=[])=>spawnSync(process.execPath,[join(f.release,'bin/alpacawork.mjs'),'deploy',resolve('.'),...extra],{env,encoding:'utf8',timeout:15000});
  const preview=command();assert.equal(preview.status,0,preview.stderr);
  const body=JSON.parse(preview.stdout);assert.equal(body.reason,'confirmation_required');assert.equal(body.installed,false);
  assert.equal(body.plan.workspace,f.workspace);assert.equal(body.plan.current.release,f.release);assert.equal(body.plan.target.release,f.release);
  assert.match(body.confirm,/^[a-f0-9]{64}$/);
  const rejected=command(['--confirm','incorrect']);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/plan changed/);
  assert.deepEqual(files.map(file=>readFileSync(file,'utf8')),before);
  assert.equal(existsSync(join(f.releases,'.updates/state.json')),false);
  const pending=join(f.releases,'a'.repeat(40));mkdirSync(pending);
  const journal=JSON.parse(before[1]!);writeFileSync(files[1]!,JSON.stringify({...journal,old:f.release,target:pending,phase:'old_stopped'}));
  assert.equal(localCli(f.installationEnvironment,'deploy').release,pending,'deployment resumes with the stopped target even while current still points at old code');
  assert.equal(localCli(f.installationEnvironment).release,f.release,'ordinary task CLI keeps its current-release selection');
  writeFileSync(files[1]!,before[1]!);
  // The installation remains authoritative when setup runs from a separately installed global package.
  const owner=readFileSync(join(f.output,'release/update-runtime-owner.js'),'utf8');
  const binding="import { thisRelease } from './location.js';";assert(owner.includes(binding));
  const globalOwner=join(f.output,'release/global-launcher-runtime.js');
  writeFileSync(globalOwner,owner.replace(binding,`const thisRelease=()=>${JSON.stringify(join(f.root,'global-package'))};`));
  const globalRuntime=await import(pathToFileURL(globalOwner).href);
  assert.equal(globalRuntime.resolveUpdateRuntime(f.workspace,f.installationEnvironment).place.releases,f.releases);
});

test('npm acquisition reuses the same source SHA without a screen operation or an npm provenance receipt', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)', timeout:60000}, async t => {
  const f=await managedUpdateFixture(t),manifest=JSON.parse(readFileSync(join(f.release,'package.json'),'utf8'));
  let origin='',tarballs=0;
  const registry=createServer((request,response)=>{
    if(request.url!.endsWith('.tgz')){tarballs++;response.writeHead(500);response.end();return;}
    const version={...manifest,dist:{tarball:origin+'/unused.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}};
    response.setHeader('content-type','application/json');response.end(JSON.stringify({name:manifest.name,'dist-tags':{latest:manifest.version},versions:{[manifest.version]:version}}));
  });
  await new Promise<void>(done=>registry.listen(0,'127.0.0.1',done));const address=registry.address();assert(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port;
  t.after(()=>new Promise<void>(done=>{registry.closeAllConnections();registry.close(()=>done());}));
  const config=join(f.root,'reuse.npmrc'),global=join(f.root,'reuse-global.npmrc');writeFileSync(config,'registry='+origin+'/\n');writeFileSync(global,'');
  const request={...f.runtime.registry,nodeExecutable:process.execPath,npmCli:resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),userConfig:config,globalConfig:global,packageName:manifest.name};
  const observed=await observeNpmCandidate({releases:f.releases,candidateId:randomUUID(),expectedActive:f.release,registry:request,environment:f.runtime.environment});
  assert(observed.ok,JSON.stringify(observed));
  const reused=await acquireNpmCandidate({releases:f.releases,candidate:observed.value,registry:request});
  assert(reused.ok,JSON.stringify(reused));assert.equal(reused.value.release,f.release);assert.equal(tarballs,0);
  assert.equal(existsSync(join(f.releases,'.updates/state.json')),false);assert.equal(existsSync(join(f.releases,'.release-metadata')),false);
  // Reapplying that same version must still pass through the target controller and overwrite selected skills.
  await f.start();const original=JSON.parse(readFileSync(join(f.skills,'.alpacawork/installed.json'),'utf8')).operationId;
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ALPACAWORK_'))),...f.installationEnvironment,
    NODE_OPTIONS:'--import='+f.adapter,npm_config_userconfig:config,npm_config_globalconfig:global,npm_config_registry:origin+'/'};
  const run=async(extra:string[]=[])=>JSON.parse((await promisify(execFile)(process.execPath,
    [join(f.release,'bin/alpacawork.mjs'),'deploy','npm:'+manifest.name+'@'+manifest.version,...extra],{env,timeout:30000})).stdout);
  const plan=await run();assert.equal(plan.reason,'confirmation_required');
  const applied=await run(['--confirm',plan.confirm]);assert.equal(applied.installed,true);
  assert.equal(applied.url, `http://127.0.0.1:${f.port}/`, 'completed updates return the actual ready URL even after their operation is compacted');
  const ready = await fetch(new URL('/api/runtime/readiness', applied.url), { headers: { Connection: 'close' } });
  assert.equal(ready.status, 200); assert.equal((await ready.json()).state, 'accepting');
  assert.notEqual(JSON.parse(readFileSync(join(f.skills,'.alpacawork/installed.json'),'utf8')).operationId,original);
  const journal=JSON.parse(readFileSync(join(f.releases,'switch.json'),'utf8'));assert.equal(journal.phase,'committed');assert.equal(journal.skillsWriteStarted,true);
  assert.equal(tarballs,0);await f.stop();
});
