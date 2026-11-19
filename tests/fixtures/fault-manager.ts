/** The real manager, killed after a durable observation or immediately after its stdin transfer attempt. */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventJournal } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { AgentInputChannel } from '@alpacawork/backend/test-dist/runs/input.js';
import { manageRun } from '@alpacawork/backend/test-dist/runs/manager.js';
const [root,id,attempt]=process.argv.slice(2);
if(!root||!id||!attempt)throw Error('Manager subject arguments missing');
const stage=readFileSync(join(root,'manager-fault-stage'),'utf8').trim();
const kill=()=>{writeFileSync(join(root,'manager-fault.json'),JSON.stringify({stage,pid:process.pid}));process.kill(process.pid,'SIGKILL')};
const append=EventJournal.prototype.append;
EventJournal.prototype.append=function(type:any,payload:any){if(stage==='result-blob'&&type==='completed')kill();const event=append.call(this,type,payload);if(type===stage)kill();return event} as typeof append;
if(stage==='stdin-write'){
 const write=AgentInputChannel.prototype.write;
 AgentInputChannel.prototype.write=function(...args:any[]){const result=(write as any).apply(this,args);kill();return result};
}
await manageRun(root,id,attempt);
