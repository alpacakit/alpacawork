/** The screen's Runs and placements of one read point, and this workspace's environment facts. */
import { enabledAgents, type ControlRunDTO, type ControlTreeDTO } from '@alpacawork/contract';
import { CONFIG_FILE } from '@alpacawork/raw';
import { RunStore, type ReadRunSnapshot } from '@alpacawork/runs';
import { runFolder, type ReadRunRecord, type RunActivityView, type RunRecord } from '@alpacawork/contract/run';
import type { PlacementStore } from './placements.js';
import { projectPlacementRuntimes } from './runtime.js';
import { recordedRun } from '../runs/run-view.js';
import { readRunActivity } from '../runs/activity.js';
import { readRunActivityView } from '../agents/context-limits.js';
import { readRunFailure } from '../runs/error-cause.js';
import { failureAvailability, runErrorCause } from '@alpacawork/contract/agent-diagnostics';
import { Problem, PROBLEM_CODE, faultReason, type ProblemReason } from '@alpacawork/core';
import { agentProfile, attachmentLimitOf, readAgentsSettings } from '../agents-settings.js';
import { runtimeAdapter } from '../agents/registry.js';

type ReadError = { code: string; message: string; path: string; reason?: ProblemReason };
const runsUnavailable = (error: Problem): ReadError =>
  ({ code: PROBLEM_CODE.runsUnavailable, message: error.message, reason: error.reason ?? faultReason(error), path: '.alpacawork/alpacawork.sqlite' });

/** What a Run's screen facts read beside its record, from its folder: its activity and its failure's cause. */
export type RunFolderFacts = { readonly activity: RunActivityView | null; readonly errorCause: ControlRunDTO['errorCause'] | undefined };
/**
 * A Run as the screen shows it, with its folder's facts: the one mapping of a Run record to the screen's Run. The
 * projection passes the facts its records captured (TaskBundle.runFiles); controlRuns reads them from the folder.
 */
export function runView(run: ReadRunRecord, files: RunFolderFacts | undefined): ControlRunDTO {
  const errorCause = runErrorCause(run.availability, files?.errorCause);
  return { ...recordedRun(run), takesInput: !!runtimeAdapter(run.launch.adapter)?.input,
    ...(errorCause ? { errorCause } : {}),
    activity: run.state === 'running' ? files?.activity ?? null : null };
}
/** The screen's Runs of `records`, their folder facts read now. */
export function controlRuns(root: string, records: readonly ReadRunRecord[]): ControlRunDTO[] {
  return records.map(run => runView(run, { errorCause: failureAvailability(readRunFailure(root, run)),
    activity: run.state === 'running' ? readRunActivityView(root, run) : null }));
}
/** What a placement's runtime reads of its Task: the wire type leaves out a toState the record holds as null. */
const runtimeTask = (task: Pick<ControlTreeDTO['tasks'][number], 'state' | 'log'>) =>
  ({ state: task.state, stateLog: task.log.map(entry => ({ at: entry.at, toState: entry.toState ?? null })) });
export function projectPlacements(root: string, placed: ReturnType<PlacementStore['placements']>,
  tasks: readonly (Pick<ControlTreeDTO['tasks'][number], 'id' | 'state' | 'log'>)[],
  runs: readonly ControlRunDTO[] | null) {
  const byTask = new Map(tasks.map(task => [task.id, runtimeTask(task)]));
  const activity = (id: RunRecord['id']) => readRunActivity(runFolder(root, id));
  const runtimes = projectPlacementRuntimes(placed, byTask, runs, activity);
  return placed.map(placement => ({ ...placement,
    responsible: placement.active && placement.responsible,
    runtime: runtimes.get(placement.id)! }));
}

/** Workspace facts exist independently of any listed project. */
export function readControlEnvironment(root: string, settings = readAgentsSettings(root)): Pick<ControlTreeDTO, 'root' | 'profiles' | 'attachmentBytes' | 'errors' | 'writable'> {
  const profiles = settings.ok ? enabledAgents(settings.config.agents).map(([key, agent]) => agentProfile(key, agent)) : [];
  if (settings.ok) {
    const first = settings.config.aiStack?.[0]?.agent;
    const index = profiles.findIndex(profile => profile.key === first);
    if (index > 0) profiles.unshift(...profiles.splice(index, 1));
  }
  return { root, profiles,
    attachmentBytes: attachmentLimitOf(settings), writable: settings.ok,
    errors: settings.ok === true ? [] : [{ code: settings.error.code, message: settings.error.message,
      ...(settings.error.reason ? { reason: settings.error.reason } : {}), path: CONFIG_FILE }] };
}

/**
 * Capture all DB-backed tree facts before awaiting any Task or settings I/O: the Runs, placements, Requests and returns
 * of `project`'s Tasks, or of the whole workspace without one.
 */
export function readControlRecords(root: string, project?: string, taskIds?: readonly string[]): {
  snapshot: ReadRunSnapshot | null; error: ReadError | null;
} {
  let store: RunStore | null = null;
  try {
    store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
    const snapshot = store ? store.snapshot(project, taskIds) : null;
    return { snapshot, error: snapshot?.runError ? runsUnavailable(snapshot.runError) : null };
  } finally { store?.close(); }
}
