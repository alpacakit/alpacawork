/** Recent completed estimate rounds, derived from Task reports and the Run that made each report. */
import { invalidatesEstimate, isReviewMark, taskStateIntervals, taskStateMinutes } from '@alpacawork/contract';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { RunStore } from '@alpacawork/runs';
import { TaskRepository, controlSnapshotView } from './task-store.js';
import type { ControlSource } from './task-views.js';

type Task = ControlSource['tasks'][number];
type Report = Task['log'][number];
export type EstimateCondition = { agent: string; values: Record<string, string | null> };

/** A Run's agent and every launch choice are the complete estimate conditions. */
function sameEstimateCondition(run: ControlSource['runRecords'][number], condition: EstimateCondition): boolean {
  return run.agent === condition.agent && isDeepStrictEqual(run.launch.values, condition.values);
}

type EstimateExample = {
  taskId: string;
  estimateMinutes: number;
  actualMinutes: number;
  reportedAt: string;
};

const isEstimate = (entry: Report): entry is Report & { estimateMinutes: number } =>
  entry.kind === 'reported' && entry.estimateMinutes !== undefined;
/** The work is handed over when it finishes, or when its done report puts it to the user's review. */
const isHandoff = (entry: Report) => entry.toState === 'done' || isReviewMark(entry);

/** The order examples are shown in: the latest handoff first, ties by Task number. */
const newestFirst = (a: EstimateExample, b: EstimateExample) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt) ||
  a.taskId.localeCompare(b.taskId, 'en', { numeric: true });

/** One latest displayed estimate per completed work stage; a Task can supply at most one final example. */
export function estimateExamples(source: Pick<ControlSource, 'tasks' | 'runRecords' | 'errors'>,
  condition: EstimateCondition) {
  if (source.errors.length) return { ...condition, examples: [] as EstimateExample[], errors: source.errors };
  const runs = new Map(source.runRecords.map(run => [run.id, run]));
  const examples: EstimateExample[] = [];
  for (const task of source.tasks) {
    // Every scored span ends at a recorded handoff; the still-open final state has no outcome.
    const intervals = taskStateIntervals(task.log, Number.POSITIVE_INFINITY);
    let estimate: (Report & { estimateMinutes: number }) | null = null;
    for (const entry of task.log) {
      if (invalidatesEstimate(entry)) estimate = null;
      if (isEstimate(entry) && !isHandoff(entry)) estimate = entry;
      if (!isHandoff(entry)) continue;
      if (estimate?.runId && estimate.actor.kind === 'placement') {
        const run = runs.get(estimate.runId);
        const from = Date.parse(estimate.at), to = Date.parse(entry.at);
        if (run?.task === task.id && run.placementId === estimate.actor.placementId &&
          sameEstimateCondition(run, condition) && Number.isFinite(from) && Number.isFinite(to) && to > from)
          examples.push({ taskId: task.id, estimateMinutes: estimate.estimateMinutes,
            actualMinutes: Math.round(taskStateMinutes(intervals, from, to, 'doing')),
            reportedAt: entry.at });
      }
      estimate = null;
    }
  }
  examples.sort(newestFirst);
  const distinct: EstimateExample[] = [], seen = new Set<string>();
  for (const example of examples) {
    if (seen.has(example.taskId)) continue;
    seen.add(example.taskId);
    distinct.push(example);
    if (distinct.length === 3) break;
  }
  return { ...condition, examples: distinct, errors: source.errors };
}

/**
 * Candidate handoffs newest first, then the existing scoring rule over each
 * candidate's own history. Once 3 results outrank the next candidate time no
 * older Task can change the answer. A Task is scored once; no Task state is stored.
 */
export function databaseEstimateExamples(root: string, db: DatabaseSync, condition: EstimateCondition, project?: string) {
  const repository = new TaskRepository(root, db), store = new RunStore(root, { busyTimeoutMs: 10_000 }, true, db);
  const seen = new Set<string>(), examples: EstimateExample[] = [];
  let cutoff: number | null = null;
  try {
    const candidates = db.prepare(`SELECT t.external_id,l.at,julianday(l.at) AS sort_at FROM task_log l INDEXED BY task_log_handoffs
      CROSS JOIN tasks t ON t.id=l.task_id
      WHERE json_extract(l.entry,'$.toState') IN ('done','waiting')
      ${project === undefined ? '' : 'AND t.project_task_id=(SELECT id FROM tasks WHERE external_id=?)'} ORDER BY julianday(l.at) DESC`);
    const boundaryTime = db.prepare('SELECT julianday(?) AS at');
    for (const row of candidates.iterate(...(project === undefined ? [] : [project]))) {
      // SQLite rounds fractional timestamps to milliseconds. Exhaust its whole
      // boundary bucket too, so Date.parse's finer tie-break cannot be skipped.
      if (cutoff !== null && Number(row.sort_at) < cutoff) break;
      const taskId = String(row.external_id);
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      const task = repository.metadataWithHistory(taskId);
      const runIds = new Set(task.meta.log.filter(isEstimate).flatMap(entry => entry.runId ? [entry.runId] : []));
      // Keep the candidate boundary lazy: an older Task outside the top three
      // never contributes decoded history or Runs to this read.
      const runRecords = [...store.getMany([...runIds]).values()];
      const scored = estimateExamples({ tasks: controlSnapshotView({ root, tasks: [task] }).tasks,
        runRecords, errors: [] }, condition);
      examples.push(...scored.examples);
      examples.sort(newestFirst);
      examples.splice(3);
      if (examples.length === 3) cutoff = Number(boundaryTime.get(new Date(Date.parse(examples[2]!.reportedAt)).toISOString())!.at);
    }
    return { ...condition, examples, errors: [] };
  } finally { store.close(); }
}
