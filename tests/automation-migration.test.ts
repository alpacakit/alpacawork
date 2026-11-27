import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { migrateDatabase, packagedMigrations } from '@alpacawork/db';

test('the migration backfills log positions, starts at the old tail and preserves positions through compaction', t => {
  const folder = fileURLToPath(new URL('../packages/db/drizzle/control/', import.meta.url));
  const previous = mkdtempSync(join(tmpdir(), 'alpacawork-automation-migration-'));
  const history = packagedMigrations('control');
  const automation = history.findIndex(({ name }) => name.endsWith('_automations'));
  assert.ok(automation > 0);
  for (const { name } of history.slice(0, automation)) cpSync(join(folder, name), join(previous, name), { recursive: true });
  const db = new DatabaseSync(join(previous, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(previous, { recursive: true, force: true }); });
  db.function('alpacawork_data_migration', (_name) => 0);
  const client = drizzle({ client: db });
  migrate(client, { migrationsFolder: previous });
  const at = '2026-10-14T00:01:00.000Z';
  db.prepare(`INSERT INTO tasks(id,kind,number,title,lifecycle,base_state,hold,revision,settings,created_at,updated_at)
    VALUES ('project','project',1,'Project','active','todo',0,1,'{"color":"#39659b"}',?,?)`).run(at, at);
  const add = (id: string, when: string, ordinal: number) => db.prepare(
    "INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,'project',?,?)",
  ).run(id, ordinal, JSON.stringify({ id, kind: 'comment', at: when }));
  add('Llate', '2026-10-14T00:03:00.000Z', 0);
  add('LsameB', '2026-10-14T00:02:00.000Z', 1);
  add('LsameA', '2026-10-14T09:02:00+09:00', 2);

  migrateDatabase(client, 'control');
  const positions = () => db.prepare('SELECT id,event_sequence FROM task_log ORDER BY event_sequence')
    .all().map(row => [row.id, row.event_sequence]);
  assert.deepEqual(positions(), [['LsameA', 1], ['LsameB', 2], ['Llate', 3]]);
  assert.equal(db.prepare('SELECT event_sequence FROM automation_cursor').get()!.event_sequence, 3);
  assert.ok(db.prepare("SELECT name FROM pragma_table_info('automation_versions') WHERE name='contract_version'").get());
  add('Lnew', at, 3);
  db.exec('VACUUM');
  assert.deepEqual(positions(), [['LsameA', 1], ['LsameB', 2], ['Llate', 3], ['Lnew', 4]]);
  assert.equal(db.prepare('SELECT event_sequence FROM automation_cursor').get()!.event_sequence, 3);
  assert.throws(() => db.prepare("UPDATE task_log SET event_sequence=10 WHERE id='Lnew'").run(), /immutable/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
