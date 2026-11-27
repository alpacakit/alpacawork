/** Independent source inventory: adding a business write requires an explicit classification and exercise. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';

export type WriteSite = { file: string; sql: string; table: string; line: number };
export const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
export function writeSites(repo: string): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const file of ['packages/db/src', 'packages/runs/src', 'apps/backend/src'].flatMap(area => files(join(repo, area)))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const sql = normalizeSql(ts.isTemplateExpression(node)
          ? node.head.text + node.templateSpans.map(span => '{{}}' + span.literal.text).join('') : node.text);
        const write = /^(?:INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)|UPDATE\s+(\w+)\s+SET\b|DELETE\s+FROM\s+(\w+))/i.exec(sql);
        if (write) sites.push({ file: relative(repo, file), sql, table: write[1] ?? write[2] ?? write[3]!,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return sites;
}
export const siteId = (site: Pick<WriteSite, 'file' | 'sql'>) => `${site.file}: ${site.sql}`;
export const maintenanceFiles = new Set(['packages/db/src/control-migration-snapshot.ts',
  'packages/db/src/recovery-evidence.ts', 'apps/backend/src/agents/migration-storage.ts',
  'apps/backend/src/control/task-values-migration.ts', 'apps/backend/src/maintenance.ts']);
export const routingFiles = new Set(['apps/backend/src/control/return-router.ts', 'apps/backend/src/control/return-lifecycle.ts',
  'apps/backend/src/control/task-reports.ts', 'apps/backend/src/runs/event-importer.ts']);
// A value version is written only beside the task_values change whose touch announces the same write.
export const unobservedTables = new Set(['agents', 'cli_operations', 'file_path_reservations', 'file_operations',
  'run_commands', 'task_sequence', 'run_sequence', 'workspace_identity', 'control_migration_sources',
  'control_migration_evidence', 'automation_cursor', 'automation_save_requests', 'automation_pending_skill_events', 'analysis_run_skills', 'automation_signal_receipts', 'control_schema_migrations', '__drizzle_migrations', 'task_value_versions',
  'task_value_versions_since', 'coordinator_reset_ops']);
/** These columns carry protocol progress, not screen or seat facts. */
export const unobservedColumns: Record<string, string[]> = {
  coordinator_conversations: ['visible_turns'],
  automations: ['next_at', 'event_after', 'host_pressure_after', 'host_pressure_cursor'],
  automation_previews: ['attempt'],
  automation_runs: ['attempt'],
  run_attempts: ['next_seq', 'last_digest', 'claimed', 'spawn_intent', 'started_json', 'completed_digest', 'dirty', 'acked_seq'],
};
export const protocolOnly = (site: WriteSite) => {
  if (!['run_attempts', 'automations', 'automation_previews', 'automation_runs'].includes(site.table)) return false;
  const set = /^UPDATE \w+ SET ([\s\S]+?) WHERE\b/.exec(site.sql)?.[1];
  if (!set) return false;
  const columns = [...set.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map(match => match[1]!);
  return columns.length > 0 && columns.every(column => unobservedColumns[site.table]!.includes(column));
};
// These writes require a full storage budget. The fixture covers ordinary retention.
const storageCapSite = (site: WriteSite) => site.file === 'apps/backend/src/automations/bundle-runs.ts'
  && /^DELETE FROM automation_(?:run_data|signal_items|operation_data|previews|task_inputs) WHERE rowid IN \(SELECT value FROM json_each\(\?\)\)/.test(site.sql);
// An interrupted, unfinished preview has no public operation history to invalidate.
const previewProtocolSite = (site: WriteSite) => site.file === 'apps/backend/src/automations/bundle-runtime.ts'
  && site.table === 'automation_operations' && site.sql.endsWith("WHERE preview_id=? AND outcome='running'");
export const writeSiteStatus = (site: WriteSite) => maintenanceFiles.has(site.file) ? 'maintenance'
  : unobservedTables.has(site.table) || protocolOnly(site) || previewProtocolSite(site) ? 'unobserved'
    : storageCapSite(site) ? 'storage-cap'
      : routingFiles.has(site.file) ? 'pending-routing' : 'touch';
export const trackedSite = (site: WriteSite) => {
  const status = writeSiteStatus(site);
  return status === 'touch' || status === 'pending-routing';
};

/** Records successful execution, not preparation or a matching touch call. Only a test installs this observer. */
export function observeWriteSites(sites: readonly WriteSite[]) {
  const seen = new Set<string>(), original = DatabaseSync.prototype.prepare;
  const patterns = sites.map(site => ({ site, pattern: new RegExp('^' + site.sql.split('{{}}')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') }));
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = original.call(this, sql), normalized = normalizeSql(sql);
    const stack = new Error().stack ?? '';
    const matches = patterns.filter(({ site, pattern }) => pattern.test(normalized)
      && (site.file.startsWith('packages/db/') ? stack.includes('packages/db/dist/')
        : stack.includes(site.file.replace('src/', site.file.startsWith('apps/') ? 'test-dist/' : 'dist/').replace(/\.ts$/, '.js'))));
    if (matches.length) for (const method of ['run', 'get', 'all', 'iterate'] as const) {
      const execute = statement[method].bind(statement);
      Object.defineProperty(statement, method, { configurable: true, writable: true,
        value: (...args: Parameters<typeof execute>) => {
          const result = (execute as (...values: unknown[]) => unknown)(...args);
          matches.forEach(({ site }) => seen.add(siteId(site)));
          return result;
        } });
    }
    return statement;
  };
  return { seen, close: () => { DatabaseSync.prototype.prepare = original; } };
}
