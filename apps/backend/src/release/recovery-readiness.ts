import { atomicJson } from './atomic-json.js';
import { backendEntry } from '../app-paths.js';
/** A restored target proves it can boot before ordinary DB open, publication, import or business HTTP. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionPath } from '@alpacawork/contract/connection';
import { workspaceJournal } from './journal.js';
export async function awaitRecoveryCommit(root:string,release:string,port:number):Promise<void> {
  const journal=workspaceJournal(root);
  if(journal?.phase!=='recovery_ready')return;
  if(journal.recovery?.target!==release)throw new Error('Recovery target identity differs');
  const generation=randomUUID(),schema=JSON.parse(readFileSync(join(release,'SCHEMA.json'),'utf8'));
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'&&req.url==='/api/runtime/readiness')res.end(JSON.stringify({state:'recovery_ready',workspace:root,generation,
      schema:schema.control.version,control:schema.control,host:schema.host}));
    else {res.statusCode=503;res.end(JSON.stringify({error:'Recovery has not committed; business HTTP is closed'}));}
  });
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);done();});});
  const address=server.address() as {port:number};
  atomicJson(connectionPath(root),{url:`http://127.0.0.1:${address.port}/`,publicUrl:null,generation,runManager:backendEntry('run-manager', release)});
  try {
    for(const deadline=performance.now()+90_000;performance.now()<deadline;) {
      const current=workspaceJournal(root);
      if(current?.recovery?.id!==journal.recovery.id)throw new Error('Recovery identity changed during readiness');
      if(current.phase==='recovered')return;
      if(current.phase!=='recovery_ready')throw new Error('Recovery left readiness without committing');
      await delay(100);
    }
    throw new Error('Recovery readiness commit timed out');
  } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
}
