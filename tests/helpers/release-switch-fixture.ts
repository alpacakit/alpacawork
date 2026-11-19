/** Private per-case release root, local service adapter and cleanup Owner. */
import { preserveTestFailure } from "./failure-workspace.ts";
/** Switch protocol through its real journal/files, with a local service adapter; systemd is exercised separately. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { platform } from "@alpacawork/core";
import { controlSchemaManifest, sameControlSchema, ControlStore } from "@alpacawork/db";
import { point } from "@alpacawork/backend/test-dist/release/layout.js";

export function releaseArtifacts(root: string) {
 const backend=join(root,'apps/backend/dist'), web=join(root,'apps/backend/public');
 mkdirSync(join(backend,'receiver'),{recursive:true});mkdirSync(join(web,'assets'),{recursive:true});
 writeFileSync(join(backend,'backend.js'),"import './receiver/server.js';");writeFileSync(join(backend,'receiver/server.js'),'// fixture server');
 writeFileSync(join(web,'index.html'),'<script type="module" src="/assets/app.js"></script>');
 writeFileSync(join(web,'assets/app.js'),'// fixture app');writeFileSync(join(web,'assets/mermaid.js'),'// fixture mermaid');
 writeFileSync(join(web,'asset-manifest.json'),JSON.stringify({'index.html':{file:'assets/app.js'},'mermaid-frame.html':{file:'assets/mermaid.js'}}));
}

export const CURRENT = controlSchemaManifest().version;

export const NEXT = CURRENT;

export const futureSchema = { version: NEXT, history: [...controlSchemaManifest().history, { name: '20990101000000_next', hash: 'b'.repeat(64) }] };

import { installationPath, workspaceIdentity } from '@alpacawork/backend/test-dist/installation/store.js';
import { serviceDefinition, servicePath } from '@alpacawork/backend/test-dist/installation/setup.js';

export function setup(t:TestContext,formats:Record<string,string>,future:readonly string[]=[]){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'alpacawork-release-'))),releases=join(root,'releases'),workspace=join(root,'data');mkdirSync(join(workspace,'.alpacawork'),{recursive:true,mode:0o700});
 new ControlStore(workspace,{busyTimeoutMs:1000},false,true).close();
 const originalEnvironment={HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME};
 const home=join(root,'home');mkdirSync(home);process.env.HOME=home;process.env.XDG_CONFIG_HOME=join(home,'.config');
 const recordPath=installationPath(process.env),nodeExecutable=realpathSync(process.execPath);
 mkdirSync(join(home,'.config/alpacawork'),{recursive:true});
 const identity=workspaceIdentity(workspace);
 writeFileSync(recordPath,JSON.stringify({version:4,home,nodeExecutable,uid:process.getuid!(),releases,workspace,workspaceIdentity:identity,
  service:{port:5499,name:'alpacawork-test.service',publicHost:null,environmentPath:servicePath(process.env)}}));
 t.after(()=>{for(const[key,value]of Object.entries(originalEnvironment))if(value===undefined)delete process.env[key];else process.env[key]=value;});

 const state={workspace,schema:CURRENT,control:controlSchemaManifest() as {version:number;history:{name:string;hash:string}[]},host:null,unfinishedRuns:[] as string[],contractUsers:[] as {runId:string;attemptId:string;format:string}[],unpublishedStops:0,failStops:false,invalidStops:false,legacyHttp:false,wrongReadyHistory:false,acceptedFacts:[] as string[]};

 const save=()=>writeFileSync(join(workspace,'inspection.json'),JSON.stringify(state));save();
 for(const[name,format]of Object.entries(formats)){const release=join(releases,name);mkdirSync(join(release,'apps/backend/dist'),{recursive:true});writeFileSync(join(release,'package.json'),JSON.stringify({type:'module',private:true}));writeFileSync(join(release,'SOURCE'),name+'\n');writeFileSync(join(release,'FORMAT'),format+'\n');writeFileSync(join(release,'SCHEMA.json'),JSON.stringify({control:future.includes(name)?futureSchema:controlSchemaManifest(),host:[]}));writeFileSync(join(release,'apps/backend/dist/maintenance.js'),`import ${JSON.stringify(new URL('../fixtures/release-maintenance.ts',import.meta.url).href)};`);}
 for (const name of Object.keys(formats)) releaseArtifacts(join(releases, name));
 let server:Server|null=null,restarts=0,generation='',quiesced=false;const log:string[]=[],children:ChildProcess[]=[];
 const stopServe=async()=>{if(server){const old=server;server=null;old.closeAllConnections();await new Promise<void>(done=>old.close(()=>done()))}};
 const service={...platform.service,observe:()=>({state:'matching' as const,running:false,registrationStarts:false}),register:()=>true,known:()=>true,stop:()=>{log.push('stop');writeFileSync(join(workspace,'service-stopped'),'');void stopServe();return true},restart:()=>{log.push('restart');void stopServe().then(()=>{const release=realpathSync(join(releases,'current'));Object.assign(state,JSON.parse(readFileSync(join(workspace,'inspection.json'),'utf8')));if(state.schema!==JSON.parse(readFileSync(join(release,'SCHEMA.json'),'utf8')).control.version||!sameControlSchema(state.control,JSON.parse(readFileSync(join(release,'SCHEMA.json'),'utf8')).control)||existsSync(join(release,'migrated-failure'))||existsSync(join(release,'broken'))){restarts++;return}rmSync(join(workspace,'service-stopped'),{force:true});generation=randomUUID();quiesced=false;save();server=createServer((req,res)=>{// Each fixture probe ends with its serve generation; no idle socket can race a synchronous switch.
 res.setHeader('Connection','close');res.setHeader('Content-Type','application/json');if(req.url==='/api/runtime/quiesce'){log.push('drain');if(state.failStops){res.statusCode=503;res.end('{}');return}quiesced=true;res.end(JSON.stringify({state:'drained',workspace,generation,nonce:state.invalidStops?'':randomUUID()}));return}if(req.url==='/api/runtime/preflight'){const{control,host,...legacy}=state;res.end(JSON.stringify(state.legacyHttp?legacy:state));return}if(req.url==='/fixture/facts'){
  if(req.method==='POST'){state.acceptedFacts.push('accepted after migration');save();}
  res.end(JSON.stringify(state.acceptedFacts));return;
 }const wrong=state.wrongReadyHistory&&basename(release)==='b';if(wrong)restarts++;res.end(JSON.stringify({state:quiesced?'drained':'accepting',workspace,generation,schema:state.schema,control:wrong?{...state.control,history:state.control.history?.map(row=>({...row,hash:'d'.repeat(64)}))}:state.control,host:state.host}))}).listen(0,'127.0.0.1',()=>{const{port}=server!.address()as{port:number};writeFileSync(join(workspace,'.alpacawork/connection.json'),JSON.stringify({url:`http://127.0.0.1:${port}/`,publicUrl:null,generation,runManager:join(release,'apps/backend/dist/run-manager.js')}))})});return true},restarts:()=>restarts};
 const original=platform.service;platform.service=service;
 t.after(async()=>{try{await preserveTestFailure(t,root,{databaseRoot:workspace,diagnostics:()=>({state,log})});}finally{platform.service=original;for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}await stopServe();rmSync(root,{recursive:true,force:true})}});
 const place={releases,workspace,service:'alpacawork-test.service',say:(line:string)=>log.push(line)};
 const start=async(name:string)=>{const beforeGeneration=generation;point(releases,'current',join(releases,name));service.restart();for(let n=0;n<100;n++){try{if(JSON.parse(readFileSync(join(workspace,'.alpacawork/connection.json'),'utf8')).generation!==beforeGeneration)break}catch{}await delay(10);}assert.ok(existsSync(join(workspace,'.alpacawork/connection.json')));log.length=0};
 const manager=async(name:string)=>{const entry=join(releases,name,'fixture-manager.mjs');writeFileSync(entry,'setTimeout(()=>{},60000)');const child=spawn(process.execPath,[entry],{stdio:'ignore'});children.push(child);await once(child,'spawn');return child};
 return{releases,workspace,place,state,save,log,manager,start,current:()=>readlinkSync(join(releases,'current')),journal:()=>JSON.parse(readFileSync(join(releases,'switch.json'),'utf8'))};
}

export const resolveEntry=()=>new URL('../../apps/backend/dist/backend.js',import.meta.url).pathname;

export const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ALPACAWORK_')||k.startsWith('ALPACAWORK_E2E_GUARD_')||k==='ALPACAWORK_E2E_BACKEND_GUARD'));

export function migrationSetup(t: TestContext) {
  const h = setup(t, { a: 'f1', b: 'f1', c: 'f1' }, ['b', 'c']);
  const migrations = () => existsSync(join(h.workspace, 'maintenance.jsonl'))
    ? readFileSync(join(h.workspace, 'maintenance.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.mode === 'migrate') : [];
  return { ...h, target: join(h.releases, 'b'), migrations };
}

export function diagnosticArtifacts(root: string, sha: string) {
  const backend = join(root, 'apps/backend/dist'), web = join(root, 'apps/backend/public');
  writeFileSync(join(root, 'SOURCE'), sha + '\n');
  mkdirSync(join(backend, 'diagnostics'));
  writeFileSync(join(backend, 'diagnostics/receiver.js'), 'import { performanceWriter } from "./writer.js";\nimport { readSample } from "./protocol.js";');
  writeFileSync(join(backend, 'diagnostics/writer.js'), 'import { MAX_LOG_BYTES } from "./protocol.js";');
  writeFileSync(join(backend, 'diagnostics/protocol.js'), '// diagnostic fixture');
  writeFileSync(join(backend, 'edition.js'), `import { createWorkspacePerformanceReceiver } from './diagnostics/receiver.js';\nexport const createPerformanceReceiver = root => createWorkspacePerformanceReceiver(root, '${sha}-diagnostic');\n`);
  writeFileSync(join(backend, 'receiver/server.js'), `import { createPerformanceReceiver } from '../edition.js';\ncreatePerformanceReceiver?.(root); performanceReceiver?.handle(req, res, origin);`);
  writeFileSync(join(web, 'index.html'), '<script type="module" src="/assets/diagnostic-test.js"></script>');
  writeFileSync(join(web, 'assets/diagnostic-test.js'), `// /__dev-performance ${sha}-diagnostic\nimport(\`./app.js\`);`);
  writeFileSync(join(web, 'asset-manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/diagnostic-test.js', dynamicImports: ['src/main.tsx'], startup: ['src/main.tsx'] },
    'src/main.tsx': { file: 'assets/app.js' }, 'mermaid-frame.html': { file: 'assets/mermaid.js' } }));
}
