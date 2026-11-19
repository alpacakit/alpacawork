/** History names are collected over all records, independently of the page or cursor currently open. */
import { eventOf, PARENT_VISIBLE_EVENTS, type RunId } from '@alpacawork/contract';
import { isRunInTrouble } from '@alpacawork/contract/run';
import type { TaskLog } from '@alpacawork/raw';
import type { RecordsReader, TaskBundle, TaskId } from './projection-contract.js';

/** Candidates come from reverse relations; no workspace scan is needed to resolve a named Task. */
export function historyReferrersOf(records: RecordsReader, named: TaskId, candidates: Iterable<TaskId>,
  causedReturns: readonly TaskBundle['returns'][number][], writtenTasks: (run: RunId) => readonly TaskId[]): readonly TaskId[] {
  const found = new Set<TaskId>();
  const actual = (id: RunId): RunId => {
    const seen = new Set<RunId>();
    while (!seen.has(id)) {
      seen.add(id);
      const run = records.run(id);
      if (run?.state !== 'joined' || !run.into) break;
      id = run.into;
    }
    return id;
  };
  const kindOf = (entry: TaskLog) => {
    const kind = entry.kind === 'dependencies_changed' ? 'changed' : eventOf(entry);
    return kind === 'error' && entry.runId && records.runOwner(entry.runId) === records.logOwner(entry.id) && isRunInTrouble(records.run(entry.runId)?.state ?? 'queued') ? null : kind;
  };
  const parentSees = (entry: TaskLog) => {
    const kind = kindOf(entry);
    return !!kind && PARENT_VISIBLE_EVENTS.has(kind) && kind !== 'review' && !(kind === 'question' && !entry.askedTo);
  };
  const add = (id: TaskId, parent: boolean) => {
    found.add(id);
    const above = parent ? records.parent(id) : null;
    if (above) found.add(above);
  };
  for (const id of new Set([named, ...candidates])) {
    const bundle = records.bundle(id);
    if (!bundle) continue;
    for (const entry of bundle.task.meta.log) {
      if (!kindOf(entry)) continue;
      const parentAuthor = entry.actor.kind === 'placement' ? records.placementOwner(entry.actor.placementId) : undefined;
      const mentions = named === id || parentAuthor !== id && parentAuthor === named || entry.kind === 'asked' && entry.askedTo === named
        || entry.kind === 'dependencies_changed' && [...entry.dependencies?.after ?? [], ...entry.dependencies?.previous ?? []].includes(named);
      if (mentions) add(id, parentSees(entry));
    }
    for (const request of bundle.requests) {
      if (request.purpose === 'return_continuation') continue;
      const parentAuthor = request.author.kind === 'placement' ? records.placementOwner(request.author.placementId) : undefined;
      if (named !== id && (parentAuthor === id || parentAuthor !== named)) continue;
      const runId = records.runByRequest(request.id), role = runId ? records.run(runId)?.role : undefined;
      const placement = bundle.placements.find(value => value.id === request.placementId);
      add(id, role ? role !== 'worker' : placement?.responsible !== false);
    }
    if (named === id) {
      if (bundle.dialogues.length) found.add(id);
      if (bundle.runs.some(run => isRunInTrouble(run.state) || run.state === 'cancelled' && run.reason === 'scope_invalidated')) add(id, true);
    }
  }
  // Causes appear on a child's log event in its parent's History. A joined wake can be on another Task.
  for (const value of causedReturns) for (const delivery of value.deliveries) {
    const wake = records.runByRequest(delivery.wakeRequestId);
    if (!wake) continue;
    const receiving = actual(wake), pending = [receiving], seen = new Set<RunId>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const ref of records.runReferrers(id)) if (records.run(ref)?.state === 'joined' && actual(ref) === receiving) pending.push(ref);
      for (const task of writtenTasks(id)) {
        const bundle = records.bundle(task);
        if (bundle?.task.meta.log.some(entry => entry.runId && entry.kind !== 'review_approved' && parentSees(entry) && actual(entry.runId) === receiving)) {
          const parent = records.parent(task);
          if (parent) found.add(parent);
        }
      }
    }
  }
  return [...found].sort();
}
