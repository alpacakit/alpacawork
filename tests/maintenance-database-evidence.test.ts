/** Current SQLite evidence distinguishes facts from WAL/SHM representations. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectDatabaseFacts, openDatabase, rowsDigest } from '@alpacawork/db';
import { rawFileState, captureRawFiles } from './helpers/raw-file-state.ts';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
test('typed evidence distinguishes NULL, empty text/BLOB, int64, adjacent REAL and int64 row identities', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE sample(value ANY) STRICT; INSERT INTO sample(rowid,value) VALUES(9007199254740993,NULL)');
    const values=[null,'',Buffer.alloc(0),Buffer.from([0,255]),9007199254740992n,9007199254740993n,1.0000000000000002,1.0000000000000004];
    const digests=values.map(value=>{db.prepare('UPDATE sample SET value=?').run(value);return rowsDigest(db,'sample');});
    assert.equal(new Set(digests).size,values.length);
    const before=rowsDigest(db,'sample');db.exec('UPDATE sample SET rowid=9007199254740992');
    assert.notEqual(rowsDigest(db,'sample'),before);
  } finally {db.close();}
});
function fixture(t: TestContext) {
  const base=realpathSync(mkdtempSync(join(tmpdir(),'maintenance-evidence-'))),root=join(base,'data');
  const original=createOriginal({tasks:14,logs:19,runs:7,seed:'maintenance-evidence'},join(base,'originals'));
  copyWorkspace(original.root,root);
  t.after(async()=>{await preserveTestFailure(t,base,{databaseRoot:root});removeWorkspace(root);removeWorkspace(original.root);rmSync(base,{recursive:true,force:true});});
  const host=join(root,'.alpacawork/host.sqlite');openDatabase(host,'host',{busyTimeoutMs:1000}).$client.close();
  return {base,root,host};
}
const rawState=(root:string)=>rawFileState(root).map(row=>row.path.endsWith('-shm')?{...row,sha256:'derived read marks'}:row);
const maintenance=(root:string)=>spawnSync(process.execPath,['apps/backend/dist/maintenance.js','migrate',root],
  {encoding:'utf8',timeout:30000,env:cleanCliEnv()});

test('WAL-only host writes and deleted allocator rows remain observable database facts',t=>{
  const h=fixture(t),before=inspectDatabaseFacts(h.host,'host'),db=new DatabaseSync(h.host);
  try {
    db.exec('PRAGMA wal_autocheckpoint=0; INSERT INTO minutes(at,memory_free_average,memory_free_min) VALUES(1,3,2)');
    const written=inspectDatabaseFacts(h.host,'host');assert.notDeepEqual(written,before);
    db.exec("INSERT INTO episodes(start_at,last_at,detail) VALUES(1,1,'allocator'); DELETE FROM episodes; DELETE FROM minutes");assert.notDeepEqual(inspectDatabaseFacts(h.host,'host'),before);
  }finally{db.close();}
});
test('certification and state share one SQLite snapshot while a concurrent COMMIT belongs to the next observation',t=>{
  const h=fixture(t),writer=new DatabaseSync(h.host),before=inspectDatabaseFacts(h.host,'host');
  const prepare=DatabaseSync.prototype.prepare;let committed=false;
  DatabaseSync.prototype.prepare=function(sql:string){
    if(!committed&&this!==writer&&sql==='PRAGMA user_version'){
      committed=true;writer.exec('INSERT INTO minutes(at,memory_free_average,memory_free_min) VALUES(21,3,2)');
    }
    return prepare.call(this,sql);
  };
  try{assert.deepEqual(inspectDatabaseFacts(h.host,'host'),before);assert(committed);}
  finally{DatabaseSync.prototype.prepare=prepare;writer.close();}
  assert.notDeepEqual(inspectDatabaseFacts(h.host,'host'),before);
});

test('maintenance authenticates current host committed WAL read-only before writable initialization',async t=>{
  const h=fixture(t),initial=maintenance(h.root);
  assert.equal(initial.status,0,initial.stderr);
  const writer=spawnSync(process.execPath,['--input-type=module','-e',`
    import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;UPDATE __drizzle_migrations SET hash='U9 invalid current host history'");
    process.stderr.write('U9_HOST_COMMITTED_WAL\\n');process.kill(process.pid,'SIGKILL');`,h.host],{encoding:'utf8',timeout:20000});
  assert.equal(writer.signal,'SIGKILL');assert.match(writer.stderr,/U9_HOST_COMMITTED_WAL/);
  const wal=readFileSync(h.host+'-wal');assert(wal.length>32);assert(wal.readUInt32BE(36)>0,'reach a committed WAL frame');
  const hook=join(h.base,'host-open-hook.mjs');
  writeFileSync(hook,`import{createRequire,syncBuiltinESMExports}from'node:module';const sqlite=createRequire(import.meta.url)('node:sqlite'),Original=sqlite.DatabaseSync;
    sqlite.DatabaseSync=class extends Original{constructor(...args){super(...args);const[file,options]=args;
      if(String(file)===${JSON.stringify(h.host)}&&options?.readOnly)process.stderr.write('U9_HOST_READONLY_OPEN\\n');
      if(String(file)===${JSON.stringify(h.host)}&&!options?.readOnly)process.stderr.write('U9_ORIGINAL_HOST_WRITABLE_OPEN\\n');}};syncBuiltinESMExports();`);
  const before=rawState(h.root);captureRawFiles(h.root,join(h.base,'host-auth-before-raw'));
  const refused=spawnSync(process.execPath,['--import',hook,'apps/backend/dist/maintenance.js','migrate',h.root],
    {env:cleanCliEnv(),encoding:'utf8',timeout:20000});
  captureRawFiles(h.root,join(h.base,'host-auth-after-raw')); // before assertions or cleanup, including unexpected success.
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/Unknown or modified migration history/);
  assert.match(refused.stderr,/U9_HOST_READONLY_OPEN/);assert.doesNotMatch(refused.stderr,/U9_ORIGINAL_HOST_WRITABLE_OPEN/);
  assert.deepEqual(rawState(h.root),before,'durable DB/WAL bytes, and config survive host refusal');
  t.diagnostic(JSON.stringify({case:'host-current-history-WAL',bytes:wal.length,writerPid:writer.pid,maintenancePid:refused.pid,status:refused.status,stderr:refused.stderr}));
});
