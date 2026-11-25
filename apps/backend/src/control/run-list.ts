/**
 * `run list`: the unfinished Runs (`UNFINISHED_SQL`) of the scope authorize gave the caller, one page at a time in
 * Run-number order. A Task's state, hold, archive or shelf hides none of its Runs. Tasks and Runs are read at one read
 * point, which the page names (`observedAt`); a later page is its own read.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { runNumber, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { now } from '@alpacawork/raw';
import { TaskRepository, TaskTree, readControl } from './task-store.js';

export type RunListOptions = { under?: string; limit?: number; cursor?: string };
type ReadError = { code: string; message: string; path: string };

const cursorSchema = z.object({ after: z.number().int().positive(), filter: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/**
 * `scope` is the caller's read scope (a Run's project; null for a person or the coordinator). A Run reads only its own
 * project's Task Runs; the whole workspace also has the coordinator conversation's Runs, which no Task holds, so
 * `--under` leaves them out.
 */
export function readRunList(root: string, options: RunListOptions, scope: string | null) {
  const filter = createHash('sha256').update(JSON.stringify([options.under ?? null, scope])).digest('hex');
  const after = options.cursor === undefined ? 0 : readCursor(options.cursor, filter);
  return readControl(root, db => {
    const observedAt = now();
    const tree = new TaskTree(new TaskRepository(root, db).branch());
    let taskIds: string[] | undefined;
    if (options.under !== undefined) {
      if (!tree.byId.has(options.under) || scope !== null && tree.owningProject(options.under) !== scope)
        throw new Problem(PROBLEM_CODE.notFound, 'Subtree root does not exist', undefined, { reason: { kind: 'subtree_root_does_not_exist' } });
      taskIds = [options.under, ...tree.descendants(options.under).map(task => task.id)];
    }
    const store = new RunStore(root, { busyTimeoutMs: 0 }, true, db);
    let runs: RuntimeRunRecord[];
    try { runs = store.readUnfinished(scope ?? undefined, taskIds); } finally { store.close(); }
    const errors: ReadError[] = [];
    const projectOf = (run: RuntimeRunRecord): string | null => {
      if (run.task === null) return null;
      try { return tree.owningProject(run.task); }
      catch (cause) {
        // The Run stays listed: only where it sits in the tree is unknown.
        errors.push({ code: PROBLEM_CODE.parentUnavailable, path: run.id,
          message: `The project of ${run.task} could not be read${cause instanceof Error ? `: ${cause.message}` : ''}` });
        return null;
      }
    };
    const remaining = runs.filter(run => runNumber(run.id) > after);
    const page = remaining.slice(0, options.limit ?? 100);
    const omitted = remaining.length - page.length;
    return {
      observedAt,
      scope: { project: scope, under: options.under ?? null, coordinatorRuns: scope === null && options.under === undefined },
      runs: page.map(run => ({ id: run.id, task: run.task, project: projectOf(run), placementId: run.placementId, role: run.role,
        agent: run.agent, state: run.state, reason: run.reason, stopRequested: run.stop_requested, createdAt: run.created_at,
        startedAt: run.started_at, parentRun: run.caller?.run ?? null })),
      errors,
      ...(omitted > 0 ? { omitted, cursor: Buffer.from(JSON.stringify({ after: runNumber(page.at(-1)!.id), filter })).toString('base64url') } : {}),
    };
  });
}

function readCursor(encoded: string, filter: string): number {
  let candidate: unknown;
  try { candidate = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { candidate = null; }
  const cursor = cursorSchema.safeParse(candidate);
  if (!cursor.success || cursor.data.filter !== filter) {
    const message = 'Cursor requires the same run list --under and caller';
    throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
      { reason: { kind: 'validation_error' }, issues: [{ path: 'cursor', code: 'invalid_value', message }] });
  }
  return cursor.data.after;
}
