/** Stopped migration application. SQL owns its transaction/history; existing evidence owns
 * the immutable before-images and forward-resumable config receipt. No ordinary read fallback. */
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { strictJson, Problem, PROBLEM_CODE, errorBody } from '@alpacawork/core';
import { digest } from '@alpacawork/raw';
import { storedTaskLogSchema } from '@alpacawork/raw/task-log-schema';
import { compileAgentSetting } from '@alpacawork/contract/agent-settings';
import { resolveAgentSelection } from '@alpacawork/contract/agent-selection';
import { returnHold, parseReturnHold } from '@alpacawork/runs';
import { ControlStore, packagedMigrations, databaseMigrationHistory, writeMigrationEvidence } from '@alpacawork/db';
import { parseConfig } from '../config.js';
import type { FileWriter } from '../raw/storage.js';
import { dryRunAgentMigration, migratePlacementSelections, historicalPlacementPolicy, isEmptyPlacementSelection, type MigrationDiagnostic, type AgentMigrationInput } from './migration.js';

export const AGENT_SETTINGS_MIGRATION = 'agent-settings-v1';
export const AGENT_SETTINGS_SQL = '20261106020000_agent_settings';
const configOperation = 'maintenance/agent-settings-v1/config';
export class AgentMigrationBlocked extends Error {
  constructor(readonly diagnostics: MigrationDiagnostic[]) {
    super(diagnostics.map(d => `${d.path}: ${d.code}: ${d.reason}`).join('; '));
  }
}
function block(path: string, reason: string): never {
  throw new AgentMigrationBlocked([{ path, code: 'migration_blocked', reason }]);
}
const tables = {
  returns: 'hold_reason', runs: 'record', task_log: 'entry', run_attempts: 'launch_json',
} as const;
type Table = keyof typeof tables;
type Cell = { rowid: number; key: string; raw: string | null };
type Change = Cell & { table: Table; value: unknown };
function* cells(db: DatabaseSync, table: Table): Generator<Cell> {
  const column = tables[table];
  for (const row of db.prepare(`SELECT rowid AS rowid, ${table === 'run_attempts' ? 'run_no' : 'id'} AS key, ${column} AS raw FROM ${table} ORDER BY rowid`).iterate()) {
    if (!Number.isSafeInteger(row.rowid)) block(`$.${table}`, 'Unsafe SQLite row identity');
    yield { rowid: Number(row.rowid), key: String(row.key), raw: row.raw === null ? null : String(row.raw) };
  }
}
const location = (table: Table, cell: Cell) => `$.${table}[${JSON.stringify(cell.key)}].${tables[table]}`;
function json(cell: Cell, table: Table): Record<string, unknown> {
  try {
    const value = strictJson(Buffer.from(cell.raw!));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) block(location(table, cell), 'Expected stored object');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AgentMigrationBlocked) throw error;
    return block(location(table, cell), 'Invalid/duplicate-key stored JSON');
  }
}
/** SQL owns the transaction: inspect, convert and retain only changed historical cells once. */
export function applyAgentSettingsMigration(name: string, db: DatabaseSync, config: Buffer) {
  if (name !== AGENT_SETTINGS_MIGRATION || !db.isTransaction) block('$.migration', 'Unexpected data migration name or transaction');
  if (db.prepare("SELECT 1 FROM file_operations WHERE state<>'published' LIMIT 1").get())
    block('$.file_operations', 'Unpublished file operations remain; resolve them with the old version before migrating');
  if (db.prepare('SELECT 1 FROM cli_operations WHERE op_id=?').get(configOperation))
    block('$.cli_operations', 'Migration config receipt ID is already occupied before this migration');
  const parsed = parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(config));
  const source = Object.fromEntries((Object.keys(tables) as Table[]).map(table => [table, [...cells(db, table)]])) as Record<Table, Cell[]>;
  const pendingHold = !databaseMigrationHistory(db, 'control').some(row => row.name === '20261106020001_return_hold');
  for (const cell of source.returns) if (cell.raw !== null) {
    try { pendingHold ? returnHold(cell.raw) : parseReturnHold(cell.raw); }
    catch { block(location('returns', cell), 'Invalid held-return code/reason; preserve original evidence'); }
  }
  const runValues = source.runs.map(cell => { const value = json(cell, 'runs');
    if (value.id !== `R${cell.key}`) block(location('runs', cell), 'Run identity differs from its storage row');
    return { path: location('runs', cell), value }; });
  const attempts = source.run_attempts.map(cell => ({ path: location('run_attempts', cell), value: json(cell, 'run_attempts'), settled: true,
    prompt: (() => { const row = db.prepare('SELECT prompt FROM runs WHERE id=?').get(Number(cell.key));
      if (!row) block(location('run_attempts', cell), 'Execution has no canonical Run prompt'); return String(row.prompt); })() }));
  // executionReference binds this same triple for live obligations. Migration must bind
  // EVERY stored attempt, including completed/acked history outside that live index.
  const workspaceId = db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()?.id;
  for (const [index, item] of attempts.entries()) {
    const cell = source.run_attempts[index]!;
    const row = db.prepare('SELECT attempt_id FROM run_attempts WHERE run_no=?').get(Number(cell.key));
    const expected = { runId: `R${cell.key}`, attemptId: row?.attempt_id, workspaceId };
    for (const [field, id] of Object.entries(expected)) if (item.value[field] !== id)
      block(`${item.path}.${field}`, `Execution reference identity mismatch: ${field}=${JSON.stringify(item.value[field])}, expected ${JSON.stringify(id)}`);
  }
  const result = dryRunAgentMigration({ agents: parsed.values.agents, runs: runValues, launchValues: [], attempts });
  if (result.ok === false) throw new AgentMigrationBlocked(result.diagnostics);
  const historical = new Map<string, Record<string, unknown>[]>();
  for (const item of result.value.runs) {
    const placement = item.value.placementId;
    if (typeof placement === 'string') {
      const records = historical.get(placement) ?? []; records.push(item.value); historical.set(placement, records);
    }
  }
  const logs = source.task_log.filter(cell => cell.raw !== null).map(cell => ({ cell, value: json(cell, 'task_log') }));
  const choices: AgentMigrationInput['launchValues'] = [];
  const initial = new Map<string, ReturnType<typeof compileAgentSetting>>();
  for (const { cell, value } of logs) if (Object.hasOwn(value, 'launchValues') && value.launchValues !== null) {
    const path = location('task_log', cell) + '.launchValues', placement = String(value.placementId);
    const row = db.prepare('SELECT profile_key FROM placements WHERE id=?').get(placement);
    if (!row) block(path, 'Placement identity is missing');
    const profile = String(row.profile_key), records = historical.get(placement);
    const choice = { path, profile, value: value.launchValues };
    // Empty choices need neither an adapter nor a restored profile.
    if (isEmptyPlacementSelection(choice.value)) { choices.push(choice); continue; }
    let policy: { adapter: ReturnType<typeof compileAgentSetting>['adapter']; preserveSpeed: boolean };
    if (records?.length) {
      const result = historicalPlacementPolicy(records, path);
      if (result.ok === false) throw new AgentMigrationBlocked(result.diagnostics);
      policy = result.value;
    } else {
      // No execution has happened: these are future first-admission values. The same
      // stopped, sealed config is evidence only for this case, never for a past Run.
      const setting = result.value.agents[profile];
      if (!setting) block(path, `Unused placement profile ${JSON.stringify(profile)} is missing from sealed config`);
      const compiled = compileAgentSetting(profile, setting);
      initial.set(path, compiled);
      policy = { adapter: compiled.adapter, preserveSpeed: Object.hasOwn(setting.params, 'speed') };
    }
    choices.push({ ...choice, ...policy });
  }
  const selections = migratePlacementSelections(choices);
  if (selections.ok === false) throw new AgentMigrationBlocked(selections.diagnostics);
  result.value.launchValues = selections.value;
  result.notices.push(...selections.notices);
  for (const item of result.value.launchValues) {
    const compiled = initial.get(item.path);
    if (compiled) try { resolveAgentSelection(compiled, item.value); }
    catch (error) { block(item.path, `Unused placement selection is not valid for sealed config: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const continuation = result.notices.filter(notice => notice.code === 'continuation_selection_required');
  // Each affected saved Run counts once, including historical and coordinator Runs, not conversation heads.
  const continuationSummary = { count: continuation.length, paths: continuation.map(notice => notice.path) };
  const changes: Change[] = [];
  source.runs.forEach((cell, i) => changes.push({ ...cell, table: 'runs', value: result.value.runs[i]!.value }));
  const selected = new Map(result.value.launchValues.map(item => [item.path, item.value]));
  for (const { cell, value } of logs) {
    const path = location('task_log', cell), values = selected.get(path + '.launchValues');
    const target = values ? { ...value, launchValues: values } : value;
    const checked = storedTaskLogSchema.safeParse(target);
    if (!checked.success) block(path, 'Invalid complete Task history: ' + checked.error.message);
    changes.push({ ...cell, table: 'task_log', value: target });
  }
  source.run_attempts.forEach((cell, i) => changes.push({ ...cell, table: 'run_attempts', value: result.value.attempts[i]!.value }));
  parsed.document.set('agents', result.value.agents);
  const after = Buffer.from(parsed.document.toString());
  const sourceSchema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.type, row.name, row.tbl_name, row.sql]);
  const configReceipt = { beforeDigest: digest(config), afterDigest: digest(after), afterBytes: after.toString('base64') };
  const changed = changes.filter(change => !isDeepStrictEqual(json(change, change.table), change.value));
  for (const change of changed) db.prepare(`UPDATE ${change.table} SET ${tables[change.table]}=? WHERE rowid=?`)
    .run(JSON.stringify(change.value), change.rowid);
  const unavailable = new Problem(PROBLEM_CODE.restoreChanged, 'This operation is unavailable because it predates the migration', { notFoundProvesUnexecuted: false });
  const body = errorBody(unavailable);
  db.prepare('UPDATE cli_operations SET status=?,response_json=?').run(unavailable.status, JSON.stringify(body));
  db.prepare('UPDATE file_operations SET result_json=? WHERE result_json IS NOT NULL')
    .run(JSON.stringify({ status: unavailable.status, body }));
  const migration = packagedMigrations('control').find(item => item.name === AGENT_SETTINGS_SQL)!;
  const originals = [...changed, ...(pendingHold ? source.returns.filter(cell => cell.raw !== null).map(cell => ({ ...cell, table: 'returns' as const })) : [])];
  const counts = Object.fromEntries((Object.keys(tables) as Table[]).map(table => [table, originals.filter(change => change.table === table).length]));
  writeMigrationEvidence(db, AGENT_SETTINGS_MIGRATION, { sourceVersion: 16, sourceSchema,
    transformation: { from: 16, to: 16, kind: AGENT_SETTINGS_MIGRATION, checksum: migration.hash }, config: configReceipt,
    operationalAfter: { tables: counts, continuation: continuationSummary } }, originals.map(change => ({ table: change.table, rowid: change.rowid,
      cells: [['rowid', 'integer', Buffer.from(String(change.rowid)).toString('hex').toUpperCase()],
        [tables[change.table], 'text', Buffer.from(change.raw!).toString('hex').toUpperCase()]] })));
  return { counts, notices: result.notices, continuation: continuationSummary };
}

/** A frozen event is an instruction only to this stopped maintenance operation; ordinary reads never use it. */
export function resumeAgentSettingsConfig(db: DatabaseSync, writer: Pick<FileWriter, 'root' | 'read' | 'save'>, publish: boolean): boolean {
  const row = db.prepare('SELECT metadata FROM control_migration_sources WHERE id=?').get(AGENT_SETTINGS_MIGRATION);
  if (!row) return false;
  const receipt = JSON.parse(String(row.metadata)).config;
  const completed = db.prepare('SELECT operation,fingerprint,status,response_json FROM cli_operations WHERE op_id=?').get(configOperation);
  if (completed) {
    if (completed.operation !== configOperation || completed.fingerprint !== receipt.afterDigest || completed.status !== 200 ||
        JSON.parse(String(completed.response_json)).configDigest !== receipt.afterDigest) block('$.cli_operations', 'Migration completion receipt differs');
    return false; // Subsequent normal config edits belong to their own operations, not this frozen event.
  }
  const bytes = writer.read('config.yaml');
  const current = bytes === null ? null : digest(bytes);
  if (current !== receipt.beforeDigest && current !== receipt.afterDigest)
    block('$.config.yaml', 'Config differs from both before and committed target; preserve files and resolve the conflict');
  if (publish) {
    if (current !== receipt.afterDigest) writer.save('config.yaml', current, Buffer.from(receipt.afterBytes, 'base64'));
    const store = new ControlStore(writer.root, { busyTimeoutMs: 1000 });
    try { store.writeOperation({ opId: configOperation, operation: configOperation, fingerprint: receipt.afterDigest }, () => {
      const after = writer.read('config.yaml');
      if (after === null || digest(after) !== receipt.afterDigest) block('$.config.yaml', 'Config changed before publication receipt');
      return { status: 200, body: { migration: AGENT_SETTINGS_MIGRATION, configDigest: receipt.afterDigest } };
    }); } finally { store.close(); }
  }
  return true;
}
