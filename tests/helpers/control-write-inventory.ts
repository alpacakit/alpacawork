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
  'apps/backend/src/control/task-values-migration.ts']);
export const routingFiles = new Set(['apps/backend/src/control/return-router.ts', 'apps/backend/src/control/return-lifecycle.ts',
  'apps/backend/src/control/task-reports.ts', 'apps/backend/src/runs/event-importer.ts']);
// A value version is written only beside the task_values change whose touch announces the same write.
export const unobservedTables = new Set(['agents', 'cli_operations', 'file_path_reservations', 'file_operations',
  'run_commands', 'task_sequence', 'run_sequence', 'workspace_identity', 'control_migration_sources',
  'control_migration_evidence', 'control_schema_migrations', '__drizzle_migrations', 'task_value_versions',
  'task_value_versions_since']);
/** These columns carry protocol progress, not screen or seat facts. */
export const unobservedColumns: Record<string, string[]> = {
  run_attempts: ['next_seq', 'last_digest', 'claimed', 'spawn_intent', 'started_json', 'completed_digest', 'dirty', 'acked_seq'],
};
export const protocolOnly = (site: WriteSite) => {
  if (site.table !== 'run_attempts') return false;
  const set = /^UPDATE run_attempts SET ([\s\S]+?) WHERE\b/.exec(site.sql)?.[1];
  if (!set) return false;
  const columns = [...set.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map(match => match[1]!);
  return columns.length > 0 && columns.every(column => unobservedColumns.run_attempts!.includes(column));
};
export const trackedSite = (site: WriteSite) => !maintenanceFiles.has(site.file)
  && !unobservedTables.has(site.table) && !protocolOnly(site);

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
