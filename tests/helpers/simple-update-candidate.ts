import {backendBundleWith} from './backend-bundle.ts';
/** Actual emitted candidate, assembled normally and transported through a loopback npm registry. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { assembleFixtureDistribution, fixtureCommit, npmTarball } from './distribution-fixture.ts';
import { prepareUpdateFixtureRuntime } from './update-service.ts';
import type { managedUpdateFixture } from './managed-update.ts';
export async function simpleUpdateCandidate(t: TestContext, f: Awaited<ReturnType<typeof managedUpdateFixture>>, unknown = false) {
 const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')); pkg.version = '0.3.1';
 const changes = { 'package.json': JSON.stringify(pkg), 'skills/alpacawork/SKILL.md': readFileSync(resolve('skills/alpacawork/SKILL.md'), 'utf8') + '\nSynthetic next release skill change.\n' };
 const sha=fixtureCommit(resolve('.'),join(f.root,'objects'),unknown?'unknown-update':'actual-writer2',changes);
 mkdirSync(join(f.root,'catalog'),{recursive:true});
 const image=join(f.root,'catalog',sha),built=join(f.root,'candidate-build');
 assembleFixtureDistribution(resolve('.'),built,image,sha,built=>{
  prepareUpdateFixtureRuntime(built,f.root);
  for (const [file, bytes] of Object.entries(changes)) writeFileSync(join(built, file), bytes);
  if(unknown){const file=backendBundleWith(built,'update: one(3)');let code=readFileSync(file,'utf8');
   code=code.replace('update: one(3)', 'update: {read:[999],write:999,migrate:[]}');
   assert(code.includes('write:999'));writeFileSync(file,code);}
 });
 const manifest=JSON.parse(readFileSync(join(image,'package.json'),'utf8'));
 assert.equal(manifest.alpacawork.update.records.update.write,unknown?999:3);
 assert.equal(manifest.alpacawork.update.records.journal.write,4);
 const archive=join(f.root,'candidate.tgz');
 npmTarball(archive,['--format=ustar','--transform=s,^,package/,',...readdirSync(image)],image);
 const bytes=readFileSync(archive);let origin='';let failMetadata=false,downloads=0;
 const registry=createServer((req,res)=>{
  if(req.url?.endsWith('.tgz')){downloads++;res.end(bytes);return;}
  if(failMetadata){res.writeHead(503);res.end('{}');return;}
  const version={...manifest,dist:{tarball:origin+'/'+sha+'.tgz',integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({name:manifest.name,'dist-tags':{latest:manifest.version},versions:{[manifest.version]:version}}));
 });
 await new Promise<void>(done=>registry.listen(0,'127.0.0.1',done));const address=registry.address();assert(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port;
 t.after(()=>new Promise<void>((done,reject)=>{registry.closeAllConnections();registry.close(error=>error?reject(error):done());}));
 writeFileSync(f.runtime.registry.userConfig,'registry='+origin+'/\n');
 f.configureUpdate({registry:{...f.runtime.registry,npmCli:resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),packageName:manifest.name,deadlineMs:20000,fetchTimeoutMs:5000}});
 return{sha,image,manifest,failMetadata:(value:boolean)=>{failMetadata=value;},downloads:()=>downloads};
}
