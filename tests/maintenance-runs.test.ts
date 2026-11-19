/** Real stopped maintenance over current synthetic data and copied packaged SQL. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath, databaseState, openDatabase, holdControlWriter } from '@alpacawork/db';
import { maintenance } from '@alpacawork/backend/test-dist/maintenance.js';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { releaseFixture } from './helpers/release-fixture.ts';
import { appendTestMigration } from './helpers/packaged-migration.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';

const options = {busyTimeoutMs:1000};
function fixture(t: {after(fn:()=>void):unknown}, live = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(),'stopped-drizzle-'))), root=join(base,'data');
  const original=createOriginal({tasks:14,logs:19,runs:7,seed:'maintenance-current'},join(base,'originals'));
  copyWorkspace(original.root,root); t.after(()=>{removeWorkspace(root);removeWorkspace(original.root);rmSync(base,{recursive:true,force:true});});
  const host=join(root,'.alpacawork/host.sqlite'); openDatabase(host,'host',options).$client.close();
  const raw=new DatabaseSync(controlDatabasePath(root));
  raw.exec(`UPDATE runs SET record=json_set(record,'$.state','${live?'running':'succeeded'}') WHERE id=1`); raw.close();
  const finish=()=>{const raw=new DatabaseSync(controlDatabasePath(root));try{raw.exec("UPDATE runs SET record=json_set(record,'$.state','succeeded') WHERE id=1");}finally{raw.close();}};
  return {base,root,host,finish};
}
function state(root:string) {
  return ['alpacawork','host'].map(name=>{const raw=new DatabaseSync(join(root,'.alpacawork',name+'.sqlite'),{readOnly:true});
    try{return databaseState(raw);}finally{raw.close();}});
}
function command(root:string,entry='apps/backend/dist/maintenance.js', mode='migrate') {
  return spawnSync(process.execPath,[entry,mode,root],{encoding:'utf8',timeout:30000,env:cleanCliEnv()});
}

test('explicit compaction requires a stopped writer and ended Runs, and its real CLI preserves all logical rows', async t => {
  const h=fixture(t);rememberEvidenceWorkspace(t,h.root);const before=state(h.root);
  await assert.rejects(maintenance(h.root,'compact'),/all Runs naturally end: R1/);
  assert.deepEqual(state(h.root),before);
  h.finish();
  const ended=state(h.root), release=holdControlWriter(h.root);
  try {
    const refused=command(h.root,undefined,'compact');assert.notEqual(refused.status,0);
    assert.match(refused.stderr,/Another serve writer owns this workspace/);
  } finally { release(); }
  assert.deepEqual(state(h.root),ended);
  const compacted=spawnSync(process.execPath,['apps/backend/dist/backend.js','--workspace',h.root,
    'workspace','maintenance','--mode','compact'],{encoding:'utf8',timeout:30000,env:cleanCliEnv()});
  assert.equal(compacted.status,0,compacted.stderr);
  assert.deepEqual(JSON.parse(compacted.stdout).unfinishedRuns,[]);
  assert.deepEqual(state(h.root),ended);
});

test('same-schema maintenance and its real CLI are no-ops while an existing Run remains live',async t=>{
  const h=fixture(t);rememberEvidenceWorkspace(t,h.root);const before=state(h.root),config=readFileSync(join(h.root,'config.yaml'));
  const result=await maintenance(h.root,'migrate');assert(result.unfinishedRuns.includes('R1'));
  const child=command(h.root);assert.equal(child.status,0,child.stderr);assert(JSON.parse(child.stdout).unfinishedRuns.includes('R1'));
  assert.deepEqual(state(h.root),before);assert.deepEqual(readFileSync(join(h.root,'config.yaml')),config);
  assert.equal(existsSync(join(h.root,'.alpacawork/control-upgrades')),false);
});

for(const kind of ['control','host'] as const)test(`${kind}-only pending SQL defers before writes under a live Run, then succeeds after natural completion`,t=>{
  const h=fixture(t);rememberEvidenceWorkspace(t,h.root);const {image}=releaseFixture(h.base);
  appendTestMigration(join(image,'apps/backend/dist/assets/db'),kind,'CREATE TABLE added_by_history (id INTEGER PRIMARY KEY) STRICT;');
  const entry=join(image,'apps/backend/dist/maintenance.js'),before=state(h.root);
  const refused=command(h.root,entry);assert.notEqual(refused.status,0);assert.match(refused.stderr,/all Runs naturally end: R1/);
  assert.deepEqual(state(h.root),before);assert.equal(existsSync(join(h.root,'.alpacawork/control-upgrades')),false);
  h.finish();const migrated=command(h.root,entry);assert.equal(migrated.status,0,migrated.stderr);
  const file=kind==='control'?controlDatabasePath(h.root):h.host,db=new DatabaseSync(file,{readOnly:true});
  try{assert(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='added_by_history'").get());}finally{db.close();}
  assert.equal(command(h.root,entry).status,0);
});

test('failed standard SQL rolls back unchanged DB bytes and the same maintenance resumes after the data repair',t=>{
  const h=fixture(t,false);rememberEvidenceWorkspace(t,h.root);const {image}=releaseFixture(h.base);
  const writer=new DatabaseSync(h.host);writer.exec('INSERT INTO minutes(at,memory_free_average,memory_free_min) VALUES(1,0,0)');writer.close();
  appendTestMigration(join(image,'apps/backend/dist/assets/db'),'host',
    'CREATE TABLE added_by_history (value REAL CHECK(value>0)) STRICT;\n--> statement-breakpoint\nINSERT INTO added_by_history SELECT memory_free_min FROM minutes;');
  const entry=join(image,'apps/backend/dist/maintenance.js'),before=readFileSync(h.host),facts=state(h.root);
  const failed=command(h.root,entry);assert.notEqual(failed.status,0);assert.match(failed.stderr,/migration failed/);
  assert.deepEqual(readFileSync(h.host),before);assert.deepEqual(state(h.root),facts);
  const repair=new DatabaseSync(h.host);repair.exec('DELETE FROM minutes');repair.close();
  const resumed=command(h.root,entry);assert.equal(resumed.status,0,resumed.stderr);
  const raw=new DatabaseSync(h.host,{readOnly:true});try{assert(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name='added_by_history'").get());}finally{raw.close();}
});

for(const sql of ["UPDATE __drizzle_migrations SET hash=printf('%064d',1)",'DELETE FROM __drizzle_migrations'])
 test(`live maintenance refuses invalid history before treating it as a no-op: ${sql}`,async t=>{
  const h=fixture(t);rememberEvidenceWorkspace(t,h.root);const raw=new DatabaseSync(controlDatabasePath(h.root));raw.exec(sql);raw.close();
  const before=state(h.root);await assert.rejects(maintenance(h.root,'migrate'),/history/);assert.deepEqual(state(h.root),before);
 });
