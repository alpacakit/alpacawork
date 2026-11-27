/** Export the stopped production control database for an isolated rehearsal. */
import { randomUUID } from 'node:crypto';
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertControlWriterAvailable, automationSecretsTables, controlDatabasePath, ControlStore, holdControlWriter, openControlDatabase } from '@alpacawork/db';
import { bundleLifecycle, listBundleAutomations } from '@alpacawork/backend/test-dist/automations/bundle-store.js';

const sqlName = (value: string) => '"' + value.replaceAll('"', '""') + '"';

/** Copy a single committed snapshot without ever writing secret rows to a file. */
function copyControlWithoutSecrets(source: string, target: string): void {
  const output = new DatabaseSync(target);
  try {
    output.prepare('ATTACH DATABASE ? AS source').run(pathToFileURL(source).href + '?mode=ro');
    output.exec('PRAGMA foreign_keys=OFF; BEGIN');
    const schema = output.prepare(`SELECT type,name,sql FROM source.sqlite_schema
      WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY rowid`).all() as
      { type: string; name: string; sql: string }[];
    for (const item of schema.filter(item => item.type === 'table')) {
      output.exec(item.sql);
      if (automationSecretsTables.includes(item.name)) continue;
      const columns = output.prepare("SELECT name FROM pragma_table_xinfo(?,'source') WHERE hidden=0 ORDER BY cid")
        .all(item.name).map(row => sqlName(String(row.name))).join(',');
      const table = sqlName(item.name);
      output.exec(`INSERT INTO main.${table}(${columns}) SELECT ${columns} FROM source.${table}`);
    }
    // Triggers are installed after replaying already-validated rows.
    for (const item of schema.filter(item => item.type !== 'table')) output.exec(item.sql);
    const version = Number(output.prepare('PRAGMA source.user_version').get()?.user_version);
    output.exec(`PRAGMA user_version=${version}; COMMIT`);
  } finally { output.close(); }
}

export function copyRehearsalControl(source: string, destination: string): void {
  source = realpathSync(source);
  destination = realpathSync(destination);
  if (source === destination || source.startsWith(destination + sep) || destination.startsWith(source + sep))
    throw new Error('Choose a separate rehearsal directory outside the original');

  const original = controlDatabasePath(source), target = controlDatabasePath(destination);
  const targetFolder = dirname(target);
  mkdirSync(targetFolder, { mode: 0o700, recursive: true });
  if (realpathSync(targetFolder) !== targetFolder) throw new Error('The rehearsal database folder must not be a symlink');

  assertControlWriterAvailable(source);
  openControlDatabase(source, { busyTimeoutMs: 1000 }, true).close();
  const release = holdControlWriter(destination);
  let staging: string | undefined;
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (lstatSync(target + suffix, { throwIfNoEntry: false }))
        throw new Error('The rehearsal destination already has control database files');
    }
    staging = mkdtempSync(join(tmpdir(), 'alpacawork-private-rehearsal-'));
    const staged = controlDatabasePath(staging);
    mkdirSync(dirname(staged), { mode: 0o700 });
    copyControlWithoutSecrets(original, staged);

    const control = new ControlStore(staging);
    try {
      control.write(db => {
        const at = new Date();
        for (const automation of listBundleAutomations(db, null)) {
          if (automation.enabled || db.prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND state IN ('waiting','running')").get(automation.uuid))
            bundleLifecycle(db, staging!, automation, { kind: 'disabled' }, { kind: 'system' }, at);
        }
        db.prepare(`UPDATE automation_runs SET state=CASE WHEN run_started_at IS NULL THEN 'skipped' ELSE 'stopped' END,
          phase=NULL,attempt=NULL,finished_at=?,reason_kind='off',reason='Preserved from the stopped workspace'
          WHERE state='running'`).run(at.toISOString());
        db.prepare('UPDATE automation_previews SET attempt=NULL WHERE attempt IS NOT NULL').run();
        db.prepare("UPDATE automation_operations SET outcome='failed',code=CASE WHEN name='send' THEN 'unknown_result' ELSE 'temporary' END WHERE outcome='running'").run();
        db.prepare('UPDATE workspace_identity SET id=?').run(randomUUID());
      });
      control.connection.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    } finally { control.close(); }
    chmodSync(staged, 0o600);
    copyFileSync(staged, target, constants.COPYFILE_EXCL);
  } finally {
    try { if (staging) rmSync(staging, { recursive: true, force: true }); }
    finally { release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , source, destination, ...extra] = process.argv;
  if (source && destination && !extra.length) copyRehearsalControl(source, destination);
  else throw new Error('Usage: node scripts/dev-fixtures/rehearsal-control-copy.ts <stopped-source> <rehearsal-directory>');
}
