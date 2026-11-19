/** Placement status is derived from Run state and each managed Run's output. */
import { compareRunIds, runFailureResolution } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import type { RunActivity } from '@alpacawork/contract/run';
import { failureAttentionWindow, type ControlRunDTO, type PlacementDTO } from '@alpacawork/contract';

type Runtime = PlacementDTO['runtime'];
type Placement = Pick<PlacementDTO, 'id' | 'endedAt'>;
type Task = { state: string; stateLog: readonly { at: string; toState: string | null }[] };
type Failure = ReturnType<typeof runFailureResolution<ControlRunDTO>>[number];

function runtimeForPlacement(placement: Placement, task: Task | undefined, own: readonly ControlRunDTO[],
  failures: readonly Failure[], activity: (runId: RunId) => RunActivity | null): Runtime {
  const running = own.filter(run => run.state === 'running').sort(compareRunIds);
  const queued = own.filter(run => run.state === 'queued').sort(compareRunIds);
  const failed = failures.filter(({ run, resolvedBy }) =>
    failureAttentionWindow(run, resolvedBy, placement, task).ongoing).map(({ run }) => run);
  const latestFailure = failed.at(-1);
  const displayState: Runtime['displayState'] = failed.length ? 'attention' : running.length ? 'running' : 'idle';
  const sourceRunIds = (failed.length ? failed : running.length ? running : queued).map(run => run.id);
  const runningSince = running.map(run => run.startedAt).filter((at): at is string => at !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const latest = displayState === 'running' ? running.map(run => activity(run.id)).filter((item): item is RunActivity => item !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] : undefined;
  return {
    displayState,
    reason: latestFailure?.reason ?? null,
    sourceRunIds,
    runningCount: running.length,
    queuedCount: queued.length,
    since: displayState === 'running' ? runningSince : displayState === 'attention' ? latestFailure?.endedAt ?? latestFailure?.startedAt ?? latestFailure?.createdAt ?? null : null,
    lastOutputAt: latest?.at ?? null,
    activityKind: latest?.kind ?? null,
    toolName: latest?.toolName ?? null,
  };
}

/** Prepare shared Run facts once for the complete set of placements in a tree. */
export function projectPlacementRuntimes(placements: readonly (Placement & { taskId: string })[],
  tasks: ReadonlyMap<string, Task>, runs: readonly ControlRunDTO[] | null,
  activity: (runId: RunId) => RunActivity | null): Map<string, Runtime> {
  const result = new Map<string, Runtime>();
  if (!runs) {
    for (const placement of placements) result.set(placement.id, unknownRuntime());
    return result;
  }
  const own = new Map<string, ControlRunDTO[]>(), failures = new Map<string, Failure[]>();
  for (const run of runs) {
    const group = own.get(run.placementId) ?? [];
    group.push(run);
    own.set(run.placementId, group);
  }
  for (const failure of runFailureResolution(runs)) {
    const group = failures.get(failure.run.placementId) ?? [];
    group.push(failure);
    failures.set(failure.run.placementId, group);
  }
  for (const placement of placements) result.set(placement.id, runtimeForPlacement(placement,
    tasks.get(placement.taskId), own.get(placement.id) ?? [], failures.get(placement.id) ?? [], activity));
  return result;
}

function unknownRuntime(): Runtime {
  return { displayState: 'unknown', reason: 'runs_unavailable',
    sourceRunIds: [], runningCount: 0, queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null };
}
