/** Stable installation identity must be readable before the target's normal DB migration. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { controlDatabasePath, openControlDatabase, readControlWorkspaceIdentity, packagedMigrations, standardMigrationHistorySQL, MIGRATIONS_TABLE } from '@alpacawork/db';
import { workspaceIdentity } from '../apps/backend/test-dist/installation/store.js';
import { registerInstallation } from '../apps/backend/test-dist/installation/setup.js';
/** beta.1's fresh control schema, before the later question-structure migration. */
function publishedDatabase(t: { after(cleanup: () => void): unknown }) {
  const root = mkdtempSync(join(tmpdir(), 'published-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.alpacawork'));
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  const db = new DatabaseSync(controlDatabasePath(root));
  try {
    // A fresh database has no application data to transform, as in the production migrator.
    db.function('alpacawork_data_migration', (_name: string) => 0);
    const migrations = packagedMigrations('control').filter(item => item.name <= '20261108010000_drop_task_values_evidence');
    for (const item of migrations) db.exec(readFileSync(`packages/db/drizzle/control/${item.name}/migration.sql`, 'utf8'));
    db.exec(standardMigrationHistorySQL('control'));
    for (const item of migrations) {
      const date = item.name.slice(0, 14);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE}(name,hash,created_at) VALUES (?,?,?)`).run(item.name, item.hash,
        Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(8,10)}:${date.slice(10,12)}:${date.slice(12,14)}Z`));
    }
  } finally { db.close(); }
  return { root };
}

test('a published beta migration prefix retains identity and can register before migration; unknown history is refused without writes', async t => {
  const {root}=publishedDatabase(t),home=join(root,'home'),workspace=root,releases=join(root,'releases');
  for(const path of [home,releases])mkdirSync(path,{recursive:true,mode:0o700});
  const file=controlDatabasePath(workspace),db=new DatabaseSync(file);
  const id=db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id;db.close();
  const hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex'),before=hash();
  assert.throws(()=>openControlDatabase(workspace,{busyTimeoutMs:1000},true),/explicit.*migration/);
  assert.equal(readControlWorkspaceIdentity(workspace,{busyTimeoutMs:1000}),id);assert.equal(workspaceIdentity(workspace),id);assert.equal(hash(),before);
  const env:NodeJS.ProcessEnv={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config')};delete env.SUDO_USER;delete env.SUDO_UID;
  const installed=await registerInstallation({cwd:root,env,explicit:workspace},releases);assert.equal(installed.workspaceIdentity,id);assert.equal(hash(),before);
  const corrupt=new DatabaseSync(file);corrupt.prepare('UPDATE __drizzle_migrations SET hash=? WHERE id=1').run('0'.repeat(64));corrupt.close();const damaged=hash();
  assert.throws(()=>workspaceIdentity(workspace),/Unknown or modified migration history/);assert.equal(hash(),damaged);
  const empty=new DatabaseSync(file);empty.exec('DELETE FROM __drizzle_migrations');empty.close();const withoutHistory=hash();
  assert.throws(()=>readControlWorkspaceIdentity(workspace,{busyTimeoutMs:1000}),{
    code:'database_unavailable',message:'Workspace identity requires a known control migration history',
    reason:{kind:'workspace_identity_history_required'},
  });assert.equal(hash(),withoutHistory);
});
