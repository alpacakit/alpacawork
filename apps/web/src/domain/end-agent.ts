import type { ControlRunDTO, HistoryCrewDTO, PlacementDTO } from '@alpacawork/contract/control';
import { agentLabel } from './agent-label';
import type { FlowEnd } from './flow';
import type { PeopleIndex } from './people';

/**
 * Who stood at one end of a History record, said as every tag says an agent (agentLabel: model(effort)). The one
 * rule for every end and every kind of row: the Run the record itself links at that end; otherwise the Run of the
 * placement standing at that Task's end when it was written, the one it came from (`from`: the latest started by then)
 * or the one that takes it in (`to`: the first started from then, else the latest before). A placement with no such Run
 * is said by its agent and "unknown"; you, and a Coordinator no record links, are no placement and say no agent.
 */
export type EndAgent = (end: FlowEnd, at: string, side: 'from' | 'to') => string | undefined;

/** The agent a record links at an end: the Run it was written by or taken in by, as the record carries it. */
export const recordedAgent = (end: FlowEnd) => end.party !== 'you' && end.profileKey && end.modelId !== undefined
  ? agentLabel(end.modelId, end.effort, end.profileKey) : undefined;

type Placed = Pick<PlacementDTO, 'id' | 'taskId' | 'profileKey' | 'responsible' | 'startedAt' | 'endedAt'>;
type Ran = Pick<ControlRunDTO, 'id' | 'placementId' | 'agent' | 'modelId' | 'effort' | 'createdAt'> & { startedAt?: string | null };

/**
 * The live index's placements and Runs, with those the History pages bring of the Tasks they name (`crews`, each page's
 * as it came): finished Tasks are in no live index, and the live index holds only each placement's latest Run. Every Run
 * is counted once by its ID, whichever brought it, so an older row is said by the Run of its own time.
 */
export function endAgents(people: Pick<PeopleIndex, 'placements' | 'runsByPlacement'>, crews: readonly (readonly [string, HistoryCrewDTO])[] = []): EndAgent {
  const placements = new Map<string, Placed>(people.placements);
  const runs = new Map<string, Ran>();
  for (const list of people.runsByPlacement.values()) for (const run of list) runs.set(run.id, run);
  for (const [taskId, crew] of crews) {
    for (const placement of crew.placements) if (!placements.has(placement.id)) placements.set(placement.id, { ...placement, taskId });
    for (const run of crew.runs) if (!runs.has(run.id)) runs.set(run.id, { ...run, createdAt: run.at, startedAt: run.at });
  }
  const runsByPlacement = new Map<string, Ran[]>();
  for (const run of runs.values()) {
    const list = runsByPlacement.get(run.placementId);
    if (list) list.push(run);
    else runsByPlacement.set(run.placementId, [run]);
  }
  const byTask = new Map<string, Placed[]>();
  for (const placement of placements.values()) {
    const list = byTask.get(placement.taskId);
    if (list) list.push(placement);
    else byTask.set(placement.taskId, [placement]);
  }
  const standing = (end: FlowEnd, at: string) => {
    // A Task's own end is its responsible; one placed after is not who stood there, and a member is said as one.
    const preferred = (placement: Placed) => end.role === 'member' ? !placement.responsible : placement.responsible;
    let first: Placed | undefined;
    for (const placement of byTask.get(end.taskId!) ?? []) {
      if (!(placement.startedAt <= at && (placement.endedAt === null || placement.endedAt > at))
        || end.profileKey && placement.profileKey !== end.profileKey) continue;
      // Keep the earliest of the preferred role; equal starts retain the index's original order.
      if (!first || preferred(placement) && !preferred(first)
        || preferred(placement) === preferred(first) && placement.startedAt.localeCompare(first.startedAt) < 0) first = placement;
    }
    return first;
  };
  const begun = (run: Ran) => run.startedAt ?? run.createdAt;
  const sorted = new Map<string, readonly Ran[]>();
  const runsOf = (id: string) => sorted.get(id) ?? sorted.set(id, [...runsByPlacement.get(id) ?? []].sort((a, b) => begun(a).localeCompare(begun(b)))).get(id)!;
  const before = (runs: readonly Ran[], at: string) => {
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i]!;
      if (begun(run) <= at) return run;
    }
  };
  const after = (runs: readonly Ran[], at: string) => runs.find(run => begun(run) >= at);
  return (end, at, side) => {
    const recorded = recordedAgent(end);
    if (recorded || !end.taskId || end.party === 'you' || end.party === 'coordinator') return recorded;
    const placement = standing(end, at);
    if (!placement) return undefined;
    const runs = runsOf(placement.id);
    const run = side === 'from' ? before(runs, at) ?? after(runs, at) : after(runs, at) ?? before(runs, at);
    return run ? agentLabel(run.modelId, run.effort, run.agent) : agentLabel(null, null, placement.profileKey);
  };
}
