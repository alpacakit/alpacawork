/** Rows and keyed patches from the published incremental projection. */
import { currentTransition, waitStates, type ControlIndexDTO, type ControlRunDTO, type IndexPatchDTO, type PlacementDTO,
  type ProjectionVersion, type RequiredPvDTO, type TaskRowDTO } from '@alpacawork/contract/control';
import { projectRowFacts } from './row-facts.js';
import type { AffectedSet, AggregateChanges, ScreenAggregate, TaskDerived, TaskId } from './projection-contract.js';
import type { ChildCounts, HomeRowDTO } from './task-reads.js';
import { MapUndo } from './map-undo.js';

/** Keep only the facts the current state is drawn from (its ball is the server's). Chronology belongs to timeline/history. */
function liveLog(log: TaskRowDTO['stateLog'], state: TaskRowDTO['state'], baseState: TaskRowDTO['baseState']): TaskRowDTO['stateLog'] {
  const states = log.filter(entry => entry.toState !== null);
  // The report the current or held wait began with, and the hold a restoration ends, so a restored
  // wait still reads as begun by that report.
  const waits = waitStates(log);
  const waited = waits.at(-1)?.toState === 'held' ? waits.at(-2) : waits.at(-1);
  const restoredHold = states.at(-1) && !waits.includes(states.at(-1)!) ? states.at(-2) : undefined;
  const latest = [
    states.at(-1), waited, restoredHold,
    currentTransition({ state, stateLog: log }), currentTransition({ state: baseState, stateLog: log }),
    [...log].reverse().find(entry => entry.kind === 'reported'),
    [...log].reverse().find(entry => entry.estimateMinutes !== undefined),
    [...log].reverse().find(entry => entry.kind.startsWith('review_')),
    [...log].reverse().find(entry => entry.startsEstimateRound === true),
  ];
  const ids = new Set(latest.filter(Boolean).map(entry => entry!.id));
  return log.filter(entry => ids.has(entry.id));
}

// ---------------------------------------------------------------------------------------------------------------------
// The incremental projection's rows and patches

/** A Task's list row: its own derived row, and what its descendants decide (the aggregates). */
export function composeRow(derived: TaskDerived, aggregate: ScreenAggregate): TaskRowDTO {
  const { id, row } = derived;
  return { ...row, movedAt: aggregate.movedAt(id), usageBelow: aggregate.usageBelow(id),
    runsBelow: aggregate.runsBelow(id).map(([run, at]) => [run, at] as [typeof run, number]),
    rowFacts: projectRowFacts(row, derived.placements, derived.runs, aggregate.children(id)?.runningBelow ?? 0,
      aggregate.workingBelow(id), aggregate.runningRuns(id)) };
}
/** The row the live index carries: only the log entries its current state is drawn from. */
export const liveRow = (row: TaskRowDTO): TaskRowDTO => ({ ...row, stateLog: liveLog(row.stateLog, row.state, row.baseState) });

/** The resources the aggregates changed: the closed pages whose rows or order moved, and the search scopes of their Tasks. */
export type AggregateResources = { readonly page: ReadonlySet<string>; readonly search: ReadonlySet<string>; readonly timeline?: ReadonlySet<string> };
/**
 * What an aggregate update changed, as resources: its changed pages, and the search and timeline scopes of the Tasks
 * whose aggregate values (child counts, movedAt, usage below) moved, since both return their rows with those values.
 * `timelineOf` names a Task's timeline scopes (`root`, itself and its ancestors).
 */
export function aggregateResources(changed: AggregateChanges, scopesOf: (task: TaskId) => readonly string[],
  timelineOf: (task: TaskId) => readonly string[] = () => []): AggregateResources {
  return { page: changed.pages, search: new Set([...changed.tasks].flatMap(task => [...scopesOf(task)])),
    timeline: new Set([...changed.tasks].flatMap(task => [...timelineOf(task)])) };
}
/** A Task's timeline scopes: every project's (`root`), its own and each of its ancestors'. */
export const timelineScopes = (ancestors: (task: TaskId) => readonly TaskId[]) => (task: TaskId): string[] => ['root', task, ...ancestors(task)];
/** The Tasks a patch compares: those a batch affected, and those whose aggregate values or home position moved. */
export const patchCandidates = (affected: AffectedSet, changed: AggregateChanges): Set<TaskId> =>
  new Set([...affected.tasks.keys(), ...changed.tasks]);

/**
 * The versions an applied batch gives the resources it changed: each affected Task's view and History by its
 * facets, the page, search and timeline scopes it named, and the resources the aggregate update changed. Only the
 * records that changed are copied.
 */
export function raiseRequiredPv(previous: RequiredPvDTO, affected: AffectedSet, pv: ProjectionVersion,
  aggregate: AggregateResources = { page: new Set(), search: new Set() }): { next: RequiredPvDTO; patch: IndexPatchDTO['requiredPv'] } {
  const raised = { view: [] as string[], history: [] as string[], page: [...new Set([...affected.scopes.page, ...aggregate.page])],
    timeline: [...new Set([...affected.scopes.timeline, ...aggregate.timeline ?? []])], search: [...new Set([...affected.scopes.search, ...aggregate.search])] };
  for (const [task, facets] of affected.tasks) {
    if (facets.has('view')) raised.view.push(task);
    if (facets.has('history')) raised.history.push(task);
  }
  const next = { ...previous }, patch = {} as IndexPatchDTO['requiredPv'];
  for (const kind of ['view', 'history', 'page', 'timeline', 'search'] as const) {
    const keys = raised[kind].filter(key => previous[kind][key] !== pv);
    patch[kind] = { upsert: Object.fromEntries(keys.map(key => [key, pv])), remove: [] };
    if (keys.length) next[kind] = { ...previous[kind], ...patch[kind].upsert };
  }
  return { next, patch };
}

type CountRecords = Omit<ControlIndexDTO['counts'], 'children'>;
/** What one patch reads of the frame it publishes: the Tasks that may have changed, and how each is listed now. */
export interface PatchSource {
  readonly rev: number;
  readonly generation: string;
  readonly pv: ProjectionVersion;
  /** The Tasks whose live row, live placements and Runs, home row or child counts may have changed. */
  readonly candidates: Iterable<TaskId>;
  /** Its live row (liveRow), or undefined when the live index does not carry it. */
  row(task: TaskId): TaskRowDTO | undefined;
  /** The placements and Runs the live index carries of it (none when it is not live). */
  placements(task: TaskId): readonly PlacementDTO[];
  runs(task: TaskId): readonly ControlRunDTO[];
  home(task: TaskId): { readonly row: HomeRowDTO; readonly after: TaskId | null } | undefined;
  children(task: TaskId): ChildCounts | undefined;
  /** The scope counts as of the frame; null when the aggregates say none changed. */
  readonly counts: CountRecords | null;
  readonly requiredPv: IndexPatchDTO['requiredPv'];
  /** The index's small fields as of the frame, whole: the patch carries the ones that changed. */
  readonly meta: Required<IndexPatchDTO['meta']>;
}
const keyed = <V>(undo: MapUndo, kept: Map<string, string>, upsert: Record<string, V>, remove: string[], key: string, value: V | undefined) => {
  const json = value === undefined ? undefined : JSON.stringify(value);
  if (json === kept.get(key)) return;
  if (json === undefined) { undo.delete(kept, key); remove.push(key); }
  else { undo.set(kept, key, json); upsert[key] = value!; }
};
const empty = (patch: { upsert: object; remove: readonly unknown[] }) => !Object.keys(patch.upsert).length && !patch.remove.length;

/**
 * The SSE patches of the incremental projection: it keeps what it last sent, key by key, and sends what changed among
 * the candidates and the scope counts, the raised versions and the small fields that changed. Null when nothing did.
 */
export class IndexPatcher {
  private readonly rows = new Map<string, string>();
  private readonly placements = new Map<string, string>();
  private readonly runs = new Map<string, string>();
  private readonly ownedPlacements = new Map<TaskId, Set<string>>();
  private readonly ownedRuns = new Map<TaskId, Set<string>>();
  private readonly home = new Map<string, string>();
  private readonly children = new Map<string, string>();
  private readonly counts = { closed: new Map<string, string>(), home: new Map<string, string>(), tasks: new Map<string, string>(), all: '' };
  private readonly meta = new Map<string, string>();

  patch(source: PatchSource): IndexPatchDTO | null {
    const undo = new MapUndo(), previousAll = this.counts.all;
    try { return this.build(source, undo); }
    catch (error) {
      undo.rollback();
      this.counts.all = previousAll;
      throw error;
    }
  }

  private build(source: PatchSource, undo: MapUndo): IndexPatchDTO | null {
    const tasks = { upsert: [] as TaskRowDTO[], remove: [] as string[] };
    const placements = { upsert: [] as PlacementDTO[], remove: [] as string[] };
    const runs = { upsert: [] as ControlRunDTO[], remove: [] as string[] };
    const home = { upsert: [] as { row: HomeRowDTO; after: TaskId | null }[], remove: [] as string[] };
    const children = { upsert: {} as Record<string, ChildCounts>, remove: [] as string[] };
    for (const task of new Set(source.candidates)) {
      const row = source.row(task), json = row && JSON.stringify(row);
      if (json !== this.rows.get(task)) {
        if (row) { undo.set(this.rows, task, json!); tasks.upsert.push(row); }
        else { undo.delete(this.rows, task); tasks.remove.push(task); }
      }
      this.owned(task, source.placements(task), this.ownedPlacements, this.placements, placements, undo);
      this.owned(task, source.runs(task), this.ownedRuns, this.runs, runs, undo);
      const listed = source.home(task), entry = listed && JSON.stringify(listed);
      if (entry !== this.home.get(task)) {
        if (listed) { undo.set(this.home, task, entry!); home.upsert.push({ row: listed.row, after: listed.after }); }
        else { undo.delete(this.home, task); home.remove.push(task); }
      }
      keyed(undo, this.children, children.upsert, children.remove, task, source.children(task));
    }
    const counts: IndexPatchDTO['counts'] = { closed: { upsert: {}, remove: [] }, home: { upsert: {}, remove: [] },
      tasks: { upsert: {}, remove: [] }, children };
    if (source.counts) {
      for (const kind of ['closed', 'home', 'tasks'] as const) {
        const now = source.counts[kind] as Record<string, unknown>, kept = this.counts[kind];
        for (const scope of new Set([...kept.keys(), ...Object.keys(now)]))
          keyed(undo, kept, counts[kind].upsert as Record<string, unknown>, counts[kind].remove as string[], scope, now[scope]);
      }
      const all = JSON.stringify(source.counts.all);
      if (all !== this.counts.all) { this.counts.all = all; counts.all = source.counts.all; }
    }
    const meta: IndexPatchDTO['meta'] = {};
    for (const [field, value] of Object.entries(source.meta)) {
      const json = JSON.stringify(value);
      if (json === this.meta.get(field)) continue;
      undo.set(this.meta, field, json);
      (meta as Record<string, unknown>)[field] = value;
    }
    const required = source.requiredPv;
    const changed = tasks.upsert.length || tasks.remove.length || placements.upsert.length || placements.remove.length
      || runs.upsert.length || runs.remove.length || home.upsert.length || home.remove.length
      || !empty(counts.closed) || !empty(counts.home) || !empty(counts.tasks) || !empty(counts.children) || counts.all
      || Object.values(required).some(each => !empty(each)) || Object.keys(meta).length;
    if (!changed) return null;
    return { rev: source.rev, generation: source.generation, sourcePv: source.pv, tasks, placements, runs, home, counts,
      requiredPv: required, meta };
  }

  /** A Task's live placements or Runs against what was sent of it: the changed ones, and the ones it no longer carries. */
  private owned<T extends { id: string }>(task: TaskId, items: readonly T[], owned: Map<TaskId, Set<string>>, kept: Map<string, string>,
    out: { upsert: T[]; remove: string[] }, undo: MapUndo): void {
    const before = owned.get(task) ?? new Set<string>(), now = new Set<string>();
    for (const item of items) {
      now.add(item.id);
      const json = JSON.stringify(item);
      if (kept.get(item.id) !== json) { undo.set(kept, item.id, json); out.upsert.push(item); }
    }
    for (const id of before) if (!now.has(id)) { undo.delete(kept, id); out.remove.push(id); }
    if (now.size) undo.set(owned, task, now); else undo.delete(owned, task);
  }
}
