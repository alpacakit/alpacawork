import { pathToFileURL } from 'node:url';
/** Frozen evidence remains readable and tamper-evident after its old producer is retired. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControlDatabase, validateMaintenanceControlSchema, certifySnapshot } from '@alpacawork/db';
import { sealMigrationEvidence, validateMigrationEvidence } from '../packages/db/src/control-migration-snapshot.ts';

function sealedEvidence() {
  const root=mkdtempSync(join(tmpdir(),'sealed-evidence-'));mkdirSync(join(root,'.alpacawork'));
  const db=openControlDatabase(root,{busyTimeoutMs:1000},false,true);
  const close=db.close.bind(db);db.close=()=>{close();rmSync(root,{recursive:true,force:true});};
  const metadata=JSON.stringify({sourceVersion:14,sourceSchema:[],
    sourceSchemaDigest:createHash('sha256').update('[]').digest('hex'),evidenceCounts:{tasks:1},
    transformation:{from:14,to:15,checksum:'a'.repeat(64)},operationalAfter:{tables:[]}});
  // Fixed SQLite cells and independently framed digest; the old capture/DDL producer is absent.
  db.exec('BEGIN');
  db.prepare('INSERT INTO control_migration_evidence VALUES (?,?,?,?)').run('historical','tasks','9007199254740993',"[[\"rowid\",\"integer\",\"39303037313939323534373430393933\"],[\"id\",\"integer\",\"39303037313939323534373430393933\"],[\"body\",\"text\",\"4F726967696E616C00E697A5E69CACE8AA9E\"],[\"optional\",\"null\",null]]");
  db.prepare('INSERT INTO control_migration_sources VALUES (?,?,?)').run('historical',metadata,sealMigrationEvidence(metadata,'327d59b0f7b0eb115bdeae78860a19e2a9d39550efd3b2bd21b4de86316dfa19'));
  db.exec('COMMIT');
  return db;
}
test('sealed historical evidence retains exact integer, NULL and embedded-NUL text cells and prevents mutation',()=>{
 const db=sealedEvidence();try {
  assert.doesNotThrow(()=>validateMigrationEvidence(db));
  assert.doesNotThrow(()=>validateMaintenanceControlSchema(db)); assert.doesNotThrow(()=>certifySnapshot(db,'control'));
  const row=db.prepare('SELECT source_rowid,cells FROM control_migration_evidence').get()!;
  assert.equal(row.source_rowid,'9007199254740993');
  const cells=JSON.parse(String(row.cells));
  assert.deepEqual(cells.find(cell=>cell[0]==='optional'),['optional','null',null]);
  assert.deepEqual(cells.find(cell=>cell[0]==='body'),['body','text',Buffer.from('Original\0日本語').toString('hex').toUpperCase()]);
  for(const sql of ['DELETE FROM control_migration_evidence',"UPDATE control_migration_evidence SET cells='[]'",'DELETE FROM control_migration_sources',"UPDATE control_migration_sources SET metadata='{}'"])
   assert.throws(()=>db.exec(sql),/immutable/);
  assert.throws(()=>db.prepare('INSERT INTO control_migration_evidence VALUES (?,?,?,?)').run('historical','tasks','2','[]'),/sealed/);
  assert.doesNotThrow(()=>validateMigrationEvidence(db));
  assert.doesNotThrow(()=>validateMaintenanceControlSchema(db)); assert.doesNotThrow(()=>certifySnapshot(db,'control'));
 }finally{db.close();}
});
for(const [name,sql] of [
 ['substituted cells',"DROP TRIGGER control_migration_evidence_update; UPDATE control_migration_evidence SET cells='[[\"rowid\",\"integer\",\"32\"]]'"],
 ['missing cells','DROP TRIGGER control_migration_evidence_delete; DELETE FROM control_migration_evidence'],
 ['substituted provenance',"DROP TRIGGER control_migration_sources_update; UPDATE control_migration_sources SET metadata=json_set(metadata,'$.acquisition','fabricated')"],
 ['missing source','DROP TRIGGER control_migration_sources_delete; DELETE FROM control_migration_sources'],
] as const)test(`historical evidence validator detects ${name} even after immutable guards are bypassed`,()=>{
 const db=sealedEvidence();try{db.exec('PRAGMA foreign_keys=OFF');db.exec(sql);assert.throws(()=>validateMigrationEvidence(db),/Migration snapshot/);assert.throws(()=>validateMaintenanceControlSchema(db));assert.throws(()=>certifySnapshot(db,'control'));}finally{db.close();}
});

test('the snapshot tamper detector fails when the actual stopped evidence validation is removed',async t=>{
 const root=mkdtempSync(join(tmpdir(),'evidence-validator-mutant-')),pkg=join(root,'db');mkdirSync(pkg);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const part of ['dist','drizzle'])cpSync(new URL('../packages/db/'+part,import.meta.url),join(pkg,part),{recursive:true});
 symlinkSync(new URL('../node_modules',import.meta.url).pathname,join(root,'node_modules'));
 const file=join(pkg,'dist/index.js'),source=readFileSync(file,'utf8'),changed=source.replace('validateMigrationEvidence(db);','');
 assert.notEqual(changed,source);writeFileSync(file,changed);
 const mutant=await import(pathToFileURL(file).href),db=sealedEvidence();
 try {
  db.exec('DROP TRIGGER control_migration_evidence_delete; DELETE FROM control_migration_evidence');
  const detector=(certify:typeof certifySnapshot)=>assert.throws(()=>certify(db,'control'),/Migration snapshot/);
  detector(certifySnapshot);assert.throws(()=>detector(mutant.certifySnapshot),{code:'ERR_ASSERTION'});
 }finally{db.close();}
});
