import { agentSettingsSchema } from '@alpacawork/contract';
import { runtimeRunRecordSchema } from '@alpacawork/contract/run';
import { inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
// Copy a alpacawork root for measurement, reading the source only.
// Usage: node e2e/perf/copy-root.mjs <source-root> <dest>
//
// Task files (tasks/) and Run files are cloned; SQLite databases are copied with the online backup
// API from a read-only connection, so a live serve keeps writing undisturbed. The copy never
// launches an agent: profiles are disabled and saved launches become /usr/bin/false. connection.json,
// push.json and run-credential.key stay behind (serve makes its own; no push is ever sent).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import YAML from "yaml";

const [source, dest] = process.argv.slice(2).map((path) => path && resolve(path));
if (!source || !dest) throw new Error("Usage: copy-root.mjs <source-root> <dest>");
if (existsSync(dest)) throw new Error(`Destination exists: ${dest}`);
if (dest.startsWith(`${source}/`)) throw new Error("The copy must live outside the source root");
const controlPath = join(source, ".alpacawork", "alpacawork.sqlite");
if (!existsSync(controlPath)) throw new Error(`Missing control database: ${controlPath}`);
const configDocument = YAML.parseDocument(readFileSync(join(source, "config.yaml"), "utf8"));
if (configDocument.errors.length) throw configDocument.errors[0];
const agents = configDocument.toJS().agents;
if (!agents || typeof agents !== "object" || !Object.keys(agents).length)
  throw new Error("config.yaml has no agent profiles to neutralise");
agentSettingsSchema.parse(agents);
for (const name of Object.keys(agents)) configDocument.setIn(['agents', name, 'enabled'], false);

const clone = (from, to) => cpSync(from, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
mkdirSync(join(dest, ".alpacawork"), { recursive: true });
for (const [from, to] of [
  [join(source, "tasks"), join(dest, "tasks")],
  [join(source, ".alpacawork", "runs"), join(dest, ".alpacawork", "runs")],
]) if (existsSync(from)) clone(from, to);
for (const name of ["workspace", "notice-state.json", "personal-settings.json"])
  if (existsSync(join(source, ".alpacawork", name))) copyFileSync(join(source, ".alpacawork", name), join(dest, ".alpacawork", name));
{
  const db = new DatabaseSync(controlPath, { readOnly: true });
  try { await backup(db, join(dest, ".alpacawork", "alpacawork.sqlite")); } finally { db.close(); }
}
writeFileSync(join(dest, ".alpacawork", "lock"), "");

// Disable future admission, and neutralise every frozen execution snapshot through its codec.
writeFileSync(join(dest, 'config.yaml'), String(configDocument));
const copied = new DatabaseSync(join(dest, '.alpacawork', 'alpacawork.sqlite'));
try {
  const update = copied.prepare('UPDATE runs SET record=? WHERE id=?');
  for (const row of copied.prepare('SELECT id,record FROM runs').all()) {
    const run = runtimeRunRecordSchema.parse(JSON.parse(String(row.record)));
    const inert = runtimeRunRecordSchema.parse({ ...run, launch: inertFixtureLaunch(run.launch.adapter, run.launch.values) });
    update.run(JSON.stringify(inert), row.id);
  }
} finally { copied.close(); }
const control = new DatabaseSync(join(dest, ".alpacawork", "alpacawork.sqlite"), { readOnly: true });
try {
  console.log(`${dest}: ${control.prepare("SELECT count(*) AS count FROM tasks").get().count} tasks`);
} finally { control.close(); }
