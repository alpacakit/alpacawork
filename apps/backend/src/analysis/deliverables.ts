import { isAbsolute, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inlineLinks } from '@alpacawork/contract/report-media';
import type { AnalysisDeliverable } from '@alpacawork/contract/analysis';
import { taskFolder } from '../control/task-store.js';
import { prLinks } from '../references.js';
import type { TraceRun, TraceTask } from './timeline.js';

type Value = Pick<AnalysisDeliverable, 'task' | 'field' | 'entry' | 'ref'>;

/** The item as written, with its reference. One item can contain more than one link. */
export function deliverableRefs(db: DatabaseSync, tasks: readonly string[]): Value[] {
  const ids = JSON.stringify(tasks);
  const fields = db.prepare(`SELECT t.external_id AS task, v.field_id AS field, v.value
    FROM (
      SELECT task_id, field_id, value FROM task_values
      WHERE task_id IN (SELECT value FROM json_each(?)) AND field_id IN ('artifact','pr')
      UNION
      SELECT task_id, field_id, value FROM task_value_versions
      WHERE task_id IN (SELECT value FROM json_each(?)) AND field_id IN ('artifact','pr') AND value IS NOT NULL
    ) v JOIN tasks t ON t.id=v.task_id ORDER BY t.number,v.field_id,v.value`).iterate(ids, ids);
  const distinct = new Map<string, Value>();
  for (const row of fields) {
    const values: unknown = JSON.parse(String(row.value));
    if (!Array.isArray(values)) continue;
    const task = String(row.task), field = String(row.field) as Value['field'];
    for (const entry of values) {
      if (typeof entry !== 'string') continue;
      const links = inlineLinks(entry).filter(link => !link.image).map(link => link.href.trim());
      const prs = [...prLinks([entry])];
      const bare = entry.trim().split(/\s+—\s+/, 1)[0]!;
      for (const ref of new Set([...links, ...prs, ...(!links.length && !prs.length && bare ? [bare] : [])])) {
        const value = { task, field, entry, ref };
        distinct.set(JSON.stringify(value), value);
      }
    }
  }
  return [...distinct.values()];
}

const commitFrom = (ref: string) => /^(?:(?:[^@\s]+)@|https?:\/\/[^\s]+\/commit\/)?([a-f0-9]{7,64})$/i.exec(ref)?.[1]?.toLowerCase();

export function fileReference(root: string, task: string, ref: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(ref)) return null;
  const folder = resolve(root, taskFolder(task));
  try {
    const decoded = decodeURIComponent(ref), candidate = resolve(folder, decoded), within = relative(folder, candidate);
    return isAbsolute(decoded) || within && within !== '..' && !within.startsWith('../') ? candidate : null;
  } catch { return null; }
}

export function joinDeliverables(root: string, refs: readonly Value[], tasks: readonly TraceTask[],
  runs: readonly TraceRun[]): AnalysisDeliverable[] {
  const parents = new Map(tasks.map(task => [task.id, task.parent]));
  const beneath = new Map<string, TraceRun[]>();
  for (const run of runs) {
    if (run.summary.state === 'unsupported' || run.summary.state === 'pending') continue;
    for (let task: string | null = run.task; task !== null && parents.has(task); task = parents.get(task) ?? null) {
      const present = beneath.get(task) ?? [];
      present.push(run);
      beneath.set(task, present);
    }
  }
  return refs.map(value => {
    const { task, ref } = value, available = beneath.get(task) ?? [], [pr] = prLinks([ref]), commit = !pr && commitFrom(ref);
    const path = pr || commit ? null : fileReference(root, task, ref);
    const matching = available.filter(({ summary }) => {
      const { produced } = summary!;
      if (pr) return produced.prs.some(item => item.url === pr);
      if (commit) return produced.commits.some(item => item.sha.startsWith(commit) || commit.startsWith(item.sha));
      return path !== null && produced.files.some(item => item.path === path);
    }).map(run => run.id);
    const match = !matching.length ? 'none' : pr ? 'pr' : commit ? 'commit' : 'file';
    return { ...value, runs: matching, match };
  });
}
