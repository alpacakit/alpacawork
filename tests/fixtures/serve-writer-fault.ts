/** Faults at real commit boundaries in an isolated serve, with an absolute expiry. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { ControlStore, controlDatabasePath } from '@alpacawork/db';
const [root,mode,marker,gate]=process.argv.slice(2);
if(!root||!mode||!marker)throw Error('Fault subject arguments missing');
const expiry=setTimeout(()=>process.exit(99),30000);
if(mode==='import-before-commit'||mode==='import-after-commit'||mode==='wake-before-commit'||mode==='wake-after-commit'){
  const exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql:string){
    let target=false;
    if(sql==='COMMIT'&&this.location()===controlDatabasePath(root)&&this.isTransaction&&!existsSync(marker)){
      target=mode.startsWith('wake-')?!!this.prepare("SELECT 1 FROM return_deliveries").get():!!this.prepare('SELECT 1 FROM run_attempts WHERE completed_digest IS NOT NULL').get();
      if(target&&(mode==='import-before-commit'||mode==='wake-before-commit')){writeFileSync(marker,JSON.stringify({stage:mode,pid:process.pid}));process.kill(process.pid,'SIGKILL');}
    }
    const result=exec.call(this,sql);
    if(target&&(mode==='import-after-commit'||mode==='wake-after-commit')){writeFileSync(marker,JSON.stringify({stage:mode,pid:process.pid}));process.kill(process.pid,'SIGKILL');}
    return result;
  };
}
if(mode==='stop-before-publication'||mode==='stop-pause'){
  const original=ControlStore.prototype.writeOperationAsync;
  ControlStore.prototype.writeOperationAsync=async function(input:any,...args:any[]){
    const receipt=await (original as any).call(this,input,...args);
    if(input.operation==='run/stop'&&!existsSync(marker)){
      writeFileSync(marker,JSON.stringify({stage:mode,pid:process.pid}));
      if(mode==='stop-before-publication')process.kill(process.pid,'SIGKILL');
      while(!existsSync(gate!))await delay(10);
    }
    return receipt;
  };
}
const app=await startServer(root,0);
process.on('SIGTERM',()=>void app.close().then(()=>process.exit(0)));
console.log(JSON.stringify({url:app.url,pid:process.pid,generation:app.generation}));
process.on('exit',()=>clearTimeout(expiry));
