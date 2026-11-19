/** Coordinator Run observation follows the published records without traversing Task bundles or all Runs. */
import type { RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract';
import type { ChangeKey } from '@alpacawork/db';
import type { DatabaseWorkspaceRecords } from './workspace-records.js';
import type { WatchedRun, WatchedRunUpdate } from './workspace-file-thread.js';

export function coordinatorFileRun(run: RuntimeRunRecord | undefined): WatchedRun | undefined {
  return run?.task === null && (run.state === 'running' || run.state === 'failed')
    ? { id: run.id, task: null, state: run.state } : undefined;
}

export function coordinatorFileRunChanges(previous: DatabaseWorkspaceRecords | undefined, current: DatabaseWorkspaceRecords,
  keys: readonly ChangeKey[], full: boolean): WatchedRunUpdate {
  if (full) {
    const upsert = [...current.coordinatorFileRuns()], retained = new Set(upsert.map(run => run.id));
    return { upsert, remove: [...previous?.coordinatorFileRuns() ?? []].filter(run => !retained.has(run.id)).map(run => run.id) };
  }
  const candidates = new Set<RunId>();
  for (const key of keys) {
    if (key.kind === 'run' || key.kind === 'activity') candidates.add((key.id.startsWith('R') ? key.id : `R${key.id}`) as RunId);
    else if (key.kind === 'request') {
      const before = previous?.runByRequest(key.id), after = current.runByRequest(key.id);
      if (before) candidates.add(before);
      if (after) candidates.add(after);
    }
  }
  const upsert: WatchedRun[] = [], remove: RunId[] = [];
  for (const id of candidates) {
    const before = coordinatorFileRun(previous?.runtimeRun(id)), after = coordinatorFileRun(current.runtimeRun(id));
    if (after && (!before || before.state !== after.state)) upsert.push(after);
    else if (before && !after) remove.push(id);
  }
  return { upsert, remove };
}
