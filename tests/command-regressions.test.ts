import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture, currentTaskHash, currentTaskLog } from './helpers/control-fixture.ts';
/** Design probes kept as regressions. No agent is launched. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileWriter} from '@alpacawork/backend/test-dist/raw/storage.js';
import {AGENTS_TEMPLATE} from '@alpacawork/backend/test-dist/agents-settings.js';
import {ControlTaskCommands} from '@alpacawork/backend/test-dist/control/task-commands.js';
import {TaskReportService} from '@alpacawork/backend/test-dist/control/report.js';
import {TaskRequestService} from '@alpacawork/backend/test-dist/control/task-request.js';
import {RequestService} from '@alpacawork/backend/test-dist/control/requests.js';
import {PlacementStore} from '@alpacawork/backend/test-dist/control/placements.js';
import {RunStore} from '@alpacawork/runs';
import {ControlStore} from '@alpacawork/db';
import {startServer} from '@alpacawork/backend/test-dist/receiver/server.js';
import {readServerSettings,saveServerSettings} from '@alpacawork/backend/test-dist/server-settings.js';
import {configSetInput} from '@alpacawork/contract/inputs';
import {parseInput} from '@alpacawork/core';
import {stringify} from 'yaml';
async function setup(t:any) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'command-probe-')));
 let project:string;
 const writer=new FileWriter(root); try {writer.save('config.yaml',null,Buffer.from(AGENTS_TEMPLATE));project=initializeControlFixture(root);} finally {writer.close();}
 const commands=new ControlTaskCommands(root,{kind:'human'});
 const task=(await commands.create({parentId:project,userRequested:null,tasks:[{title:'Parent'}]})).tasks[0];
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 return {root,commands,task,service:new TaskReportService(root)};
}
test('P2 instruction to own member must not change Task state',async t=>{
 const h=await setup(t); const people=new PlacementStore(h.root);
 const owner=people.createAndPlace({taskId:h.task.id,profileKey:'codex',responsible:true}).placement;
 const member=people.createAndPlace({taskId:h.task.id,profileKey:'codex',responsible:false}).placement;people.close();
 const store=new RunStore(h.root,{busyTimeoutMs:0});
 const run=store.write(tx=>{const r=createFixtureRun(store, tx, {task:h.task.id,placementId:owner.id,requestId:globalThis.crypto.randomUUID(),agent:'codex',role:'owner',resumes:null,continues:false,session:null,caller:null,cwd:h.root,launch:{ adapter: 'codex', env: [],argv:['never-launched'],path:'/bin', values: {}}},'record only');tx.update({...r,state:'running',started_at:new Date().toISOString()});return r;});store.close();
 const result=await new TaskRequestService(h.root).request({task:h.task.id,agent:member.id,body:'inspect',opId:'member-state',expectedTaskHash:h.task.hash,expectedPlacementRevision:member.revision},
  {kind:'placement',placementId:owner.id},{kind:'run',runId:run.id,placementId:owner.id,taskId:h.task.id,role:'owner',responsible:true});
 assert.equal(result.task.state,'todo');
 assert.equal(currentTaskLog(h.root,h.task.id).at(-1)?.toState,null);
});
test('P2 operation IDs are unique across Task logs and Requests',async t=>{
 const h=await setup(t);
 const people=new PlacementStore(h.root);
 const placement=people.createAndPlace({taskId:h.task.id,profileKey:'codex',responsible:true}).placement;
 people.close();
 const request=new RequestService(h.root);
 await request.request({taskId:h.task.id,body:'inspect',requestId:'request-id',
  expectedTaskHash:h.task.hash,expectedPlacementRevision:placement.revision},
  {purpose: 'instruction',actor:{kind:'human'}});
 await assert.rejects(h.service.report({task:h.task.id,state:'stopped',title:'report',
  opId:'request-id',expectedTaskHash:h.task.hash},{kind:'human'},{kind:'human'}),
  (e:any)=>e.code==='idempotency_conflict');
 const logged=(await h.service.report({task:h.task.id,state:'stopped',title:'report',
  opId:'log-id',expectedTaskHash:currentTaskHash(h.root,h.task.id)},{kind:'human'},{kind:'human'})).task;
 await assert.rejects(request.request({taskId:h.task.id,body:'again',requestId:'log-id',
  expectedTaskHash:logged.hash,expectedPlacementRevision:placement.revision},
  {purpose: 'instruction',actor:{kind:'human'}}),
  (e:any)=>e.code==='idempotency_conflict');
});
test('P3 settings input accepts valid YAML beyond the old 64 KiB service cap',async t=>{
 const h=await setup(t);
 const before=await readServerSettings(h.root);
 const rules=stringify({limits:before.limits})+'# '+ 'x'.repeat(70*1024)+'\n';
 const saved=await saveServerSettings(h.root,parseInput(configSetInput,{config:rules,agents:before.agentsText,expectedConfigHash:before.hash}));
 assert.deepEqual(saved.limits,before.limits);
});
