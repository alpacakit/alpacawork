/** Trace the real process, including its import closure. A positive sqlite read must trip the same check. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setup} from './runs-runtime.fixture.ts';
import {settleTransaction,launch} from '@alpacawork/backend/test-dist/runs/scheduler.js';
import {readAgentsSettings} from '@alpacawork/backend/test-dist/agents-settings.js';
import {controlDatabasePath} from '@alpacawork/db';
test('real manager and agent never open the control DB; deliberate read fails the syscall audit',{skip:process.platform!=='linux'&&'Linux syscall observation'},async t=>{
 assert.equal(spawnSync('strace',['-V']).status,0,'syscall audit requires strace; no fallback counted as success');
 const h=await setup(t),run=h.create('plain',{output:'traced subject'}),trace=join(h.root,'manager-open.trace'),wrapper=join(h.root,'traced-manager.mjs');
 writeFileSync(wrapper,`import{spawnSync}from'node:child_process';const r=spawnSync('strace',['-f','-e','trace=openat,openat2','-o',${JSON.stringify(trace)},process.execPath,${JSON.stringify(resolve('apps/backend/dist/run-manager.js'))},...process.argv.slice(2)],{env:process.env,stdio:['ignore',1,2,3,'ignore']});process.exit(r.status??1);`);
 await launch(h.store,await settleTransaction(h.store,readAgentsSettings(h.root)),{script:wrapper});await h.waitState(run,'succeeded');
 const audit=(path:string)=>readFileSync(path,'utf8').split('\n').filter(line=>line.includes('.sqlite'));
 assert.ok(existsSync(trace));assert.deepEqual(audit(trace),[]);const positive=join(h.root,'intentional-db-open.trace');
 const check=spawnSync('strace',['-f','-e','trace=openat,openat2','-o',positive,process.execPath,'--input-type=module','-e',`import{DatabaseSync}from'node:sqlite';new DatabaseSync(${JSON.stringify(controlDatabasePath(h.root))},{readOnly:true}).close()`],{encoding:'utf8'});
 assert.equal(check.status,0,check.stderr);assert.ok(audit(positive).some(line=>line.includes('alpacawork.sqlite')),'a deliberate real DB open must fail the audit');
 console.log(JSON.stringify({proof:'manager-syscalls',trace,positive,subject:h.store.get(run.id)!.pids,sqliteOpens:audit(trace),intentionalOpens:audit(positive)}));
});
