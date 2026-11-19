import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventJournal} from '@alpacawork/backend/test-dist/runs/execution-files.js';
import {manageRun} from '@alpacawork/backend/test-dist/runs/manager.js';
const [root,id,attempt]=process.argv.slice(2);
const append=EventJournal.prototype.append;
EventJournal.prototype.append=function(type,payload) {
 if(type==='started') {
  writeFileSync(join(root,'spawn-window.json'),JSON.stringify({managerPid:process.pid,agentPid:payload.pid,deadline:Date.now()+20000}));
  process.kill(process.pid,'SIGKILL');
 }
 return append.call(this,type,payload);
};
await manageRun(root,id,attempt);
