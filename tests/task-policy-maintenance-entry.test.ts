/** The official maintenance entry recognizes historical input but cannot cross the manual public-ID boundary. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTROL_VERSION, ControlStore, controlDatabasePath, controlSchemaManifest, databaseState } from '@alpacawork/db';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { test, type TestContext } from 'node:test';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
const repo=fileURLToPath(new URL('../',import.meta.url));
function state(file:string) {
 const db=new DatabaseSync(file,{readOnly:true});try{return databaseState(db);}finally{db.close();}
}
function invoke(mode:'inspect'|'migrate',root:string) {
 const result=spawnSync(process.execPath,[join(repo,'apps/backend/dist/maintenance.js'),mode,root],
  {env:cleanCliEnv(),encoding:'utf8',timeout:30000});
 assert.ifError(result.error);return result;
}
test('official current-schema inspect and migrate remain no-ops without a bootstrap descriptor',async t=>{
 const r=realpathSync(mkdtempSync(join(tmpdir(),'alpacawork-maintenance-current-')));
 t.after(async()=>{await preserveTestFailure(t,r);rmSync(r,{recursive:true,force:true});});await initializeWorkspace(r);
 // This regression's baseline is a running current DB. Fresh DELETE/inspect preservation is tested separately.
 new ControlStore(r).close();
 const file=controlDatabasePath(r),before=state(file),bytes=readFileSync(file);
 assert.equal('migrations' in controlSchemaManifest(),false);
 const inspected=invoke('inspect',r);assert.equal(inspected.status,0,inspected.stderr);
 assert.equal(JSON.parse(inspected.stdout).schema,CONTROL_VERSION);
 assert.deepEqual(JSON.parse(inspected.stdout).control,{version:CONTROL_VERSION,history:controlSchemaManifest().history});
 for(let attempt=0;attempt<2;attempt++) {
  const migrated=invoke('migrate',r);assert.equal(migrated.status,0,migrated.stderr);
  const result=JSON.parse(migrated.stdout);
  assert.equal(result.schema,CONTROL_VERSION);
  assert.equal(result.migration,undefined);
  assert.deepEqual(state(file),before);assert.deepEqual(readFileSync(file),bytes);
 }
});
