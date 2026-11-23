/**
 * One Task's derived values, and what a change makes old: the screen projection's two rules over the records
 * (RecordsReader). `deriveTask` evaluates the business rules the tree read evaluated for every Task at once (the ball,
 * the seat's block, the start order, the row's own facts) for one Task, through a seat source that reads only the Tasks
 * those rules ask for. `affected` is the dependency ledger as code:
 * which Tasks and surfaces a batch of changed records reaches. Nothing here reads the database or files; the aggregates
 * (counts, movedAt, the home list's order) are screen-aggregate's.
 */
import { isDeepStrictEqual } from 'node:util';
import { DELIVERY_STATE, controlReplySchema, taskViewRowSchema, type ControlRunDTO, type PlacementDTO, type TaskViewPlacementDTO, type TaskViewRunDTO, type TaskViewRowDTO } from '@alpacawork/contract/control';
import { isRunEnded, isRunMoving, runSpan, sumUsage, userTurn, PARENT_VISIBLE_EVENTS, eventOf, type Ball } from '@alpacawork/contract';
import { taskRowFields } from '@alpacawork/contract/control';
import { compareRunIds, hasContinuableSession, runFailureResolution, type ReadRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { byTaskNumber } from '@alpacawork/contract/moved';
import { openQuestions, speaksForUser, type ControlTask } from '@alpacawork/raw';
import { automaticIndex, type AutomaticIndex, type StoredRequest } from '@alpacawork/runs';
import type { ChangeKey } from '@alpacawork/db';
import { runView } from '../control/tree.js';
import { ballFactsOf, ballOf, type BallSource } from '../control/ball.js';
import { startOrderOf } from '../control/dependencies.js';
import { questionReturnApplicableBy, type QuestionNode } from '../control/question-rules.js';
import { openRequests, endedOwnWork, type ReturnFacts, type RunFacts, type TaskFacts } from '../control/return-rules.js';
import { projectPlacementRuntimes } from '../control/runtime.js';
import { controlTaskView } from '../control/task-dto.js';
import { ownerHeadsOf } from '../control/wake.js';
import { holdingKeys } from './push.js';
import { projectRowFacts } from './row-facts.js';
import { closedPagesOf, homeRowOf } from './screen-aggregate.js';
import { currentPlacementRunIds } from './task-reads.js';
import { runRecordsAvailable } from './run-record-health.js';
import type { AffectedSet, AggregateContribution, DeriveTask, Facet, RecordsChange, RecordsReader, TaskBundle,
  TaskDerived, TaskId } from './projection-contract.js';

// ---------------------------------------------------------------------------------------------------------------------
// Recording reads (the dependency test's hook)

/** One read of the records or the aggregates: the method and its arguments. */
export type RecordedRead = { readonly from: string; readonly method: string; readonly args: readonly unknown[] };
/**
 * `target` with every method call recorded in `sink` under `from` ('records', 'aggregate'), the result unchanged. The
 * dependency test wraps the records it hands deriveTask and the view and History reads, then checks every Task read
 * against `affected`.
 */
export function recordReads<T extends object>(target: T, sink: RecordedRead[], from: string): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') {
        if (typeof property === 'string') sink.push({ from, method: property, args: [] });
        return value;
      }
      return (...args: unknown[]) => {
        if (typeof property === 'string') sink.push({ from, method: property, args });
        return value.apply(object, args);
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// A seat and ball source over the records, reading only what the rules ask for

/**
 * A map that answers `get` and `has` by looking up. The rules a one-Task source serves only look up; iterating would
 * read every Task, so it refuses.
 */
function lookupMap<K, V>(lookup: (key: K) => V | undefined): ReadonlyMap<K, V> {
  return new Proxy({ get: lookup, has: (key: K) => lookup(key) !== undefined } as object, {
    get(target, property) {
      if (property === 'get' || property === 'has') return Reflect.get(target, property);
      return refuse(String(property));
    },
  }) as ReadonlyMap<K, V>;
}
function lookupSet<K>(lookup: (key: K) => boolean): ReadonlySet<K> {
  return new Proxy({ has: lookup } as object, {
    get(target, property) { return property === 'has' ? Reflect.get(target, property) : refuse(String(property)); },
  }) as ReadonlySet<K>;
}
function refuse(what: string): never {
  throw new Error(`A one-Task source cannot read ${what} of every record`);
}

const responsibleOf = (bundle: TaskBundle | undefined) =>
  bundle?.placements.find(placement => placement.active && placement.responsible) ?? null;
const questionNode = (task: ControlTask): QuestionNode =>
  ({ id: task.id, parentId: task.meta.parentId, kind: task.meta.kind, lifecycle: task.meta.lifecycle, log: task.meta.log });
/**
 * The Requests whose order the automatic limit reads: by submission time, then ID, compared as SQLite compares text
 * (the order the Run snapshot reads them in, `ORDER BY submitted_at, id`).
 */
const byPosition = (a: StoredRequest, b: StoredRequest) =>
  a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The seat and ball source of the records: what ballFactsOf and seatFactsOf read, looked up when they ask. The seat's
 * own Task, its senders and targets, its ancestors and the Tasks its questions came from are read; no other.
 */
export function recordsSource(records: RecordsReader): BallSource {
  const bundle = (id: string) => records.bundle(id);
  const ownerBundle = (placementId: string) => {
    const owner = records.placementOwner(placementId);
    return owner === undefined ? undefined : bundle(owner);
  };
  const runOwnerBundle = (id: RunId) => {
    const owner = records.runOwner(id);
    return owner === null ? undefined : bundle(owner);
  };
  const heads = new Map<string, ReadonlyMap<string, ReadRunRecord>>();
  const headsOf = (task: TaskBundle) => {
    let found = heads.get(task.task.id);
    if (!found) heads.set(task.task.id, found = ownerHeadsOf(task.runs, task.requests));
    return found;
  };
  const questions = lookupMap<string, QuestionNode>(id => {
    const task = bundle(id)?.task;
    return task && questionNode(task);
  });
  const facts: ReturnFacts = {
    runs: lookupMap<string, RunFacts>(id => records.run(id as RunId)),
    runOf: lookupMap<string, RunFacts>(request => {
      const id = records.runByRequest(request);
      return id === undefined ? undefined : records.run(id);
    }),
    tasks: lookupMap<string, TaskFacts>(id => {
      const task = bundle(id);
      return task && { ...task.task.meta, id: task.task.id, responsible: responsibleOf(task) !== null };
    }),
    closedRequests: lookupSet<string>(request => records.closedRequest(request)),
  };
  const automatic: AutomaticIndex = {
    count: (placementId, ancestry) => automaticIndex([...new Set([...ancestry, records.placementOwner(placementId)])]
      .flatMap(id => id === undefined ? [] : bundle(id)?.requests ?? []).sort(byPosition)).count(placementId, ancestry),
    reached: (placementId, ancestry, limit) => automatic.count(placementId, ancestry) >= limit,
  };
  const none: ReadonlySet<RunId> = new Set();
  const settings = records.seatSettings();
  return {
    task: id => bundle(id)?.task,
    responsible: id => responsibleOf(bundle(id)),
    head: placementId => {
      const owner = ownerBundle(placementId);
      return (owner && headsOf(owner).get(placementId)) ?? null;
    },
    run: id => records.run(id) ?? null,
    uncertain: placementId => ownerBundle(placementId)?.inputs.uncertain.get(placementId) ?? none,
    inputClosed: id => runOwnerBundle(id)?.inputs.closed.has(id) ?? false,
    returnsTo: id => (bundle(id)?.returns ?? []).filter(row =>
      questionReturnApplicableBy(row, logId => records.logOwner(logId), questions)),
    get requests(): readonly StoredRequest[] { return refuse('the Requests'); },
    automatic, facts,
    openSent: id => openRequests(id, records.sentRequests(id), facts),
    profiles: settings.profiles, automaticLimit: settings.automaticLimit,
    get tasks(): readonly Pick<ControlTask, 'id' | 'meta'>[] { return refuse('the Tasks'); },
    // The question rules only look a Task up (questionApplicable); the source's type names the snapshot's Map.
    questions: questions as Map<string, QuestionNode>,
    moving: id => (bundle(id)?.runs ?? []).some(run => !isRunEnded(run.state)),
    working: id => (bundle(id)?.runs ?? []).some(run => run.state === 'queued' || run.state === 'running'),
    requestsTo: id => bundle(id)?.requests ?? [],
  };
}

/** A Task's ball at the records' point (null when nobody's move is awaited). */
export function ballOfTask(records: RecordsReader, task: TaskId): Ball | null {
  if (!runRecordsAvailable(records)) return null;
  return ballOf(ballFactsOf(recordsSource(records), task));
}

// ---------------------------------------------------------------------------------------------------------------------
// deriveTask


const VIEW_ROW_KEYS = Object.keys(taskViewRowSchema.shape) as (keyof TaskViewRowDTO)[];
const pick = (row: Record<string, unknown>): TaskViewRowDTO =>
  Object.fromEntries(VIEW_ROW_KEYS.flatMap(key => key in row ? [[key, row[key]]] : [])) as TaskViewRowDTO;

/** The start order of a Task from its own Runs and the Tasks it starts after (dependencyStatuses' rule). */
function startOrder(records: RecordsReader, task: TaskBundle) {
  const started = task.runs.some(run => run.role === 'owner' && run.started_at !== null);
  const after = [...task.after].sort((a, b) => byTaskNumber({ id: a }, { id: b })).flatMap(id => {
    const before = records.bundle(id);
    if (!before) return [];
    const { title, state, baseState, hold, lifecycle } = before.task.meta;
    return [{ task: id, title, state, baseState, hold, lifecycle, unfinished: before.runs.some(run => !isRunEnded(run.state)) }];
  });
  const order = startOrderOf(started, after);
  return order.after.length ? order : null;
}

/**
 * Everything one Task's records decide, without what its descendants add: its row, ball, placements and Runs, the live
 * index's choice of them, its part of the aggregates and its push keys.
 */
export const deriveTask: DeriveTask = (records, id) => {
  const bundle = records.bundle(id);
  if (!bundle) throw new Error(`Task ${id} is not in the records`);
  const runsAvailable = runRecordsAvailable(records);
  const view = { ...controlTaskView(bundle.task), files: bundle.files };
  const runs = runsAvailable ? [...bundle.runs].sort(compareRunIds).map(run => runView(run, bundle.runFiles?.get(run.id))) : [];
  const runById = new Map(bundle.runs.map(run => [run.id, run]));
  const activity = new Map(runs.map(run => [run.id, run.activity]));
  const runtimes = projectPlacementRuntimes(bundle.placements, new Map([[id, { state: view.state,
    stateLog: view.log.map(entry => ({ at: entry.at, toState: entry.toState ?? null })) }]]), runsAvailable ? runs : null,
    run => activity.get(run) ?? null);
  const placements: PlacementDTO[] = bundle.placements.map(placement => {
    const headRunId = bundle.headRunIds.get(placement.id) ?? null;
    const head = headRunId ? runById.get(headRunId) : null;
    return { ...placement, responsible: placement.active && placement.responsible, runtime: runtimes.get(placement.id)!, headRunId,
      ...(!runsAvailable || headRunId && !head ? {} : { previousValues: head && hasContinuableSession(head) ? { ...head.launch.values } : null }) };
  });
  const ball = ballOfTask(records, id);
  const base = taskRowFields(view);
  const usage = sumUsage(runs.filter(run => !isRunMoving(run.state)), Date.now());
  const row = pick({ ...base, projectId: records.projectOf(id), ball, usage,
    notice: { ...base.notice, turnKey: userTurn(ball)?.key ?? null }, question: openQuestions(view.log)[0]?.title ?? '',
    startOrder: startOrder(records, bundle) });
  const contribution: AggregateContribution = {
    id, parentId: view.parentId, projectId: row.projectId, kind: view.kind, lifecycle: view.lifecycle,
    state: view.state, baseState: view.baseState, hold: view.hold, ball,
    running: placements.some(placement => placement.active && placement.runtime.runningCount > 0),
    working: placements.some(placement => placement.active && (placement.runtime.runningCount > 0 || placement.runtime.queuedCount > 0)),
    homeWorking: bundle.runs.some(run => run.state === 'queued' || run.state === 'running' || run.state === 'needs_review'),
    usage,
    openRuns: runs.flatMap(run => {
      const span = runSpan(run, null);
      return span && span.to === null ? [[run.id, span.from] as const] : [];
    }),
    movedAt: bundle.runs.reduce((at, run) => Math.max(at, Date.parse(run.ended_at ?? '') || 0, Date.parse(run.started_at ?? '') || 0),
      Date.parse(view.log.at(-1)?.at ?? '') || 0),
  };
  // The live index carries its active placements and its latest ended one, and of its Runs the current heads, every
  // running one, its latest and its latest unresolved failure (index-rows update's choice, of this Task alone).
  const ended = placements.filter(placement => !placement.active)
    .reduce<PlacementDTO | undefined>((latest, placement) => !latest || (placement.endedAt ?? '').localeCompare(latest.endedAt ?? '') > 0 ? placement : latest, undefined);
  const shown = placements.filter(placement => placement.active || placement === ended);
  const current = currentPlacementRunIds(shown, runs);
  const latest = runs.reduce<ControlRunDTO | undefined>((at, run) => !at || run.createdAt.localeCompare(at.createdAt) > 0 ? run : at, undefined);
  const unresolved = runFailureResolution(runs).filter(failure => !failure.resolvedBy).map(failure => failure.run)
    .reduce<ControlRunDTO | undefined>((at, run) => !at || run.createdAt.localeCompare(at.createdAt) > 0 ? run : at, undefined);
  const parent = view.parentId === null ? undefined : records.bundle(view.parentId);
  const pushKeys = [...holdingKeys([view, ...(parent ? [controlTaskView(parent.task)] : [])], ball ? { [id]: ball } : {}).keys()]
    .filter(key => key.startsWith(`${id}:`));
  return { id, row, ball, placements, runs,
    live: { placements: new Set(shown.map(placement => placement.id)),
      runs: new Set(runs.filter(run => current.has(run.id) || run === latest || run === unresolved).map(run => run.id)) },
    contribution, pushKeys };
};

/**
 * A Task's placements and Runs as its opened view carries them: without what a Run's activity shows (the latest output,
 * its kind and tool, the Run's activity), which only the list's patches carry, so activity alone never makes a view old.
 */
export function withoutActivity(derived: Pick<TaskDerived, 'placements' | 'runs'>): { placements: TaskViewPlacementDTO[]; runs: TaskViewRunDTO[] } {
  return { placements: derived.placements.map(placement => {
    const { lastOutputAt: _lastOutputAt, activityKind: _activityKind, toolName: _toolName, ...runtime } = placement.runtime;
    return { ...placement, runtime };
  }), runs: derived.runs.map(run => {
    const { activity: _activity, errorCause: _errorCause, ...durable } = run;
    return durable;
  }) };
}

/** The Task's reply: its last owner Run that ended its own work, and that Run's result state. */
export function replyOf(bundle: TaskBundle) {
  const run = [...bundle.runs].sort(compareRunIds).filter(item => item.role === 'owner' && item.supersededBy === undefined && endedOwnWork(item.state)).at(-1);
  if (!run) return null;
  const state = bundle.resultStates.get(run.id) ?? 'missing';
  return controlReplySchema.parse({ runId: run.id, state: state === 'pending' ? 'missing' : state });
}

// ---------------------------------------------------------------------------------------------------------------------
// affected

const ALL_ROW: readonly Facet[] = ['row', 'view', 'seat', 'push', 'membership'];
/**
 * What another Task's records reach of a Task through its ball: its row, seat, push keys and home membership. Its view
 * shows that ball only through its row, so the view is old only when its derived facts moved (finish).
 */
const BALL: readonly Facet[] = ['row', 'seat', 'push', 'membership'];

/** Whether two lists hold the same items in the same order, by identity: records that kept their rows keep their objects. */
const same = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) =>
  a === b || !!a && !!b && a.length === b.length && a.every((item, at) => item === b[at]);
const sameMap = <K, V>(a: ReadonlyMap<K, V> | undefined, b: ReadonlyMap<K, V> | undefined) =>
  a === b || !!a && !!b && a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

/** Run folder observations are not compared as records: activity marks the list, and a changed failure cause History too (keyRelations). */
function durableRecords(bundle: TaskBundle | undefined) {
  if (!bundle) return undefined;
  const { runFiles: _runFiles, ...records } = bundle;
  return records;
}

/** What changed in one Task's records between two points, as the ledger's conditions ask. */
function changesOf(before: TaskBundle | undefined, after: TaskBundle | undefined) {
  const a = before?.task.meta, b = after?.task.meta;
  const appeared = !before !== !after;
  const meta = (key: keyof ControlTask['meta']) => appeared || a?.[key] !== b?.[key];
  const openUserQuestions = (bundle: TaskBundle | undefined) =>
    bundle ? openQuestions(bundle.task.meta.log).filter(q => q.askedTo === null).map(q => q.id).join() : '';
  const openAll = (bundle: TaskBundle | undefined) => bundle ? openQuestions(bundle.task.meta.log).map(q => q.id).join() : '';
  const unfinished = (bundle: TaskBundle | undefined) => !!bundle?.runs.some(run => !isRunEnded(run.state));
  const working = (bundle: TaskBundle | undefined) => !!bundle?.runs.some(run => run.state === 'queued' || run.state === 'running');
  const responsible = (bundle: TaskBundle | undefined) => responsibleOf(bundle)?.id ?? null;
  const resetPosition = (bundle: TaskBundle | undefined) => {
    const resets = (bundle?.requests ?? []).filter(request => request.deliveryState !== DELIVERY_STATE.aborted &&
      request.deliveryState !== DELIVERY_STATE.recorded_unconfirmed && speaksForUser(request.author)).sort(byPosition);
    const last = resets.at(-1);
    return last ? `${last.submittedAt}|${last.id}` : '';
  };
  const added = (before?.task.meta.log.length ?? 0) < (after?.task.meta.log.length ?? 0)
    ? after!.task.meta.log.slice(before?.task.meta.log.length ?? 0) : [];
  const log = appeared || a?.log !== b?.log;
  const runs = appeared || !same(before?.runs, after?.runs);
  const placements = appeared || !same(before?.placements, after?.placements);
  const requests = appeared || !same(before?.requests, after?.requests);
  const returns = appeared || !same(before?.returns, after?.returns);
  return {
    any: !isDeepStrictEqual(durableRecords(before), durableRecords(after)),
    appeared, log, runs, placements, requests, returns,
    title: meta('title'), parent: meta('parentId'), kind: meta('kind'), lifecycle: meta('lifecycle'),
    state: meta('state') || meta('baseState') || meta('hold'),
    settings: appeared || JSON.stringify(before?.task.settings ?? null) !== JSON.stringify(after?.task.settings ?? null),
    values: appeared || before?.task.values !== after?.task.values,
    files: appeared || before?.files !== after?.files,
    after: appeared || !same(before?.after, after?.after),
    dialogues: appeared || !same(before?.dialogues, after?.dialogues) || before?.answerTexts !== after?.answerTexts,
    inputs: appeared || !sameMap(before?.inputs.uncertain, after?.inputs.uncertain) || before?.inputs.closed !== after?.inputs.closed,
    heads: appeared || !sameMap(before?.headRunIds, after?.headRunIds) || !sameMap(before?.resultStates, after?.resultStates),
    unfinished: appeared || unfinished(before) !== unfinished(after),
    openUserQuestions: appeared || openUserQuestions(before) !== openUserQuestions(after),
    openQuestions: appeared || openAll(before) !== openAll(after),
    working: appeared || working(before) !== working(after),
    responsible: appeared || responsible(before) !== responsible(after),
    reset: appeared || resetPosition(before) !== resetPosition(after),
    parentVisible: added.some(entry => {
      const kind = eventOf(entry);
      return kind !== null && PARENT_VISIBLE_EVENTS.has(kind);
    }),
  };
}

/** Gathers the facets each Task gets and the scopes of the resources that change. */
class Gather {
  readonly tasks = new Map<TaskId, Set<Facet>>();
  meta = false;
  constructor(readonly readers: readonly RecordsReader[]) {}
  add(task: TaskId | null | undefined, facets: readonly Facet[]): void {
    if (task === null || task === undefined || !this.readers.some(reader => reader.bundle(task))) return;
    const held = this.tasks.get(task) ?? new Set<Facet>();
    for (const facet of facets) held.add(facet);
    this.tasks.set(task, held);
  }
  addAll(tasks: Iterable<TaskId>, facets: readonly Facet[]): void { for (const task of tasks) this.add(task, facets); }
  /** A Task's subtree at either point. */
  subtree(task: TaskId): Set<TaskId> {
    return new Set(this.readers.flatMap(reader => reader.bundle(task) ? [...reader.subtree(task)] : []));
  }
  each<T>(read: (reader: RecordsReader) => readonly T[] | Iterable<T>): Set<T> {
    return new Set(this.readers.flatMap(reader => [...read(reader)]));
  }
}

/**
 * The closed pages that list a Task at a point, by the aggregate's own rule (closedPagesOf over the home list's row for
 * it): what a changed row of it reaches. Whether work runs below it does not matter here (it decides only the doing
 * section, never a closed page).
 */
function pageScopes(reader: RecordsReader, derived: TaskDerived | undefined, task: TaskId): string[] {
  const own = derived?.contribution;
  if (!own) return [];
  const parent = own.parentId === null ? undefined : reader.bundle(own.parentId)?.task;
  const home = homeRowOf(own, parent ? [{ id: parent.id, kind: parent.meta.kind, lifecycle: parent.meta.lifecycle,
    baseState: parent.meta.baseState, hold: parent.meta.hold, working: false }] : [], false);
  return closedPagesOf(own, home?.section, reader.scopes(task));
}

/**
 * Which Tasks and surfaces a batch of changes reaches: the owners of the changed records, and through the ledger's
 * relations the Tasks whose values read them, each only when the fact it reads moved between the two points.
 */
/**
 * Each Task's own derived row at the two points of a change, when the caller already holds them (its previous frame's
 * derivations and the ones it made for this change); without them, affected derives the rows it compares.
 */
export interface DerivedRows {
  before(task: TaskId): TaskDerived | undefined;
  after(task: TaskId): TaskDerived | undefined;
}
export const affected = (change: RecordsChange, rows?: DerivedRows): AffectedSet => {
  const { before, after } = change;
  const gather = new Gather([before, after]);
  const owners = new Set<TaskId>(change.owners);
  const coordinatorRequests = new Set<string>(), coordinatorRuns = new Set<RunId>();
  for (const key of change.keys) keyRelations(key, change, gather, owners, coordinatorRequests, coordinatorRuns);

  // A coordinator's Request or Run belongs to no Task, and the records hold no Run of it (run() names Tasks' Runs): the
  // Tasks whose records name its message are among the owners (RecordsChange.owners). Each shows the coordinator in its
  // History (H5: the coordinator end of a record, the dialogue's answer), whether or not its own records moved.
  const coordinator = coordinatorRequests.size > 0 || coordinatorRuns.size > 0 || change.keys.some(key => key.kind === 'conversation');
  for (const y of owners) {
    const was = before.bundle(y), is = after.bundle(y);
    const c = changesOf(was, is);
    if (coordinator) gather.add(y, ['history']);
    if (!c.any) continue;
    // The owner itself: its row, ball, view and seat read its own records.
    gather.add(y, ALL_ROW);
    if (c.log || c.requests || c.runs || c.returns || c.dialogues || c.placements) gather.add(y, ['history']);
    if (c.files) gather.add(y, ['files', 'view']);
    // The timeline also carries what no row does: the Task's History events, its Runs' spans and its placements.
    if (c.log || c.runs || c.placements) gather.add(y, ['timeline']);

    // R14: the Tasks that start after Y (their rows, views, closed page rows and search rows carry the start order).
    if (c.title || c.state || c.lifecycle || c.unfinished) gather.addAll(gather.each(reader => reader.dependents(y)), ['row', 'view']);
    // R5, R6, R19, B9: a move, a kind change or a lifecycle change re-places and re-judges the whole subtree.
    if (c.parent || c.kind || c.lifecycle) gather.addAll(gather.subtree(y), [...ALL_ROW, 'history']);
    // R16: the ancestors' heads every view below shows; H8: the History events that name Y.
    if (c.title || c.parent || c.kind || c.lifecycle) {
      gather.addAll(gather.subtree(y), ['view']);
      gather.addAll(gather.each(reader => reader.historyReferrers(y)), ['history']);
    }
    // R19, B9: the questions addressed to Y.
    if (c.kind || c.lifecycle || c.parent) gather.addAll(gather.each(reader => reader.questionsByDestination(y)), [...BALL, 'view', 'history']);
    // N2: the direct children's end notices read Y's kind and lifecycle.
    if (c.kind || c.lifecycle) gather.addAll(gather.each(reader => reader.children(y)), ['push', 'membership']);
    // B6, S3: the Tasks waiting on a Request to Y (closureOf reads Y's log, lifecycle, responsible and Runs, and
    // whether a Request awaits closure reads its delivery state).
    if (c.log || c.lifecycle || c.responsible || c.runs || c.requests) gather.addAll(gather.each(reader => reader.sendersTo(y)), BALL);
    // B7: a failed Task whose requester is Y reads Y's open questions to the user and whether Y works.
    if (c.openUserQuestions || c.working) {
      const candidates = gather.each(reader => [...reader.targetsFromAll(y), ...reader.children(y)]);
      gather.addAll([...candidates].filter(id => after.bundle(id)?.task.meta.baseState === 'error'), BALL);
    }
    // B4, S4: the returns caused by Y's questions read whether they are still open and applicable.
    if (c.openQuestions || c.lifecycle || c.state) gather.addAll(gather.each(reader => reader.returnsByCauseTask(y)), BALL);
    // B8: a reset of the automatic limit on Y reaches every seat below it.
    if (c.reset) gather.addAll(gather.subtree(y), BALL);
    // H1: a parent shows its children's parent-visible events and Requests, whether a child's question is still open,
    // and the child's title; a move takes them from the old parent's History to the new one's.
    if (c.parentVisible || c.openQuestions || c.parent || c.title || c.requests || c.runs) gather.addAll(gather.each(reader => {
      const parent = reader.parent(y);
      return parent === null ? [] : [parent];
    }), ['history']);
    // H8: the crew a History names reads Y's placements and Runs.
    if (c.placements || c.runs) gather.addAll(gather.each(reader => reader.historyReferrers(y)), ['history']);
    // H2: History authors and recipients read the placements Y wrote with.
    if (c.placements) for (const placement of gather.each(reader => reader.bundle(y)?.placements ?? []))
      gather.addAll(gather.each(reader => reader.placementWritesTo(placement.id)), ['history']);
    // R11, B2, S2, H2: Runs elsewhere name Y's Runs (caller, resumes, into), and deliveries name the Requests they carried.
    if (c.runs) for (const run of changedItems(was?.runs, is?.runs)) runRelations(run.id, run.requestId, gather);
    // H2, S2: the returns to Y name the log they were caused by.
    if (c.returns) for (const row of changedItems(was?.returns, is?.returns))
      if (row.causeLogId !== null) for (const reader of gather.readers) gather.add(reader.logOwner(row.causeLogId), ['history']);
    // A9: the projects the screen lists.
    if (is?.task.meta.kind === 'project' || was?.task.meta.kind === 'project')
      if (c.title || c.settings || c.lifecycle || c.parent || c.appeared) gather.meta = true;
  }

  // H4, H5: the coordinator's Requests and Runs reach the Tasks their messages and dialogues name.
  for (const request of coordinatorRequests) coordinatorRelations(request, gather);
  for (const run of coordinatorRuns) {
    for (const reader of [before, after]) {
      const record = reader.run(run);
      if (record) coordinatorRelations(record.requestId, gather);
      for (const message of reader.joinedMessages(run)) coordinatorRelations(message, gather);
    }
  }
  return finish(gather, before, after, rows ?? derivedRows(before, after));
};
/** The rows affected compares when its caller holds none: each derived once per point, only when asked. */
function derivedRows(before: RecordsReader, after: RecordsReader): DerivedRows {
  const at = (records: RecordsReader) => {
    const made = new Map<TaskId, TaskDerived | undefined>();
    return (task: TaskId) => {
      if (!made.has(task)) made.set(task, records.bundle(task) ? deriveTask(records, task) : undefined);
      return made.get(task);
    };
  };
  return { before: at(before), after: at(after) };
}

/** The items of `after` not in `before` and of `before` not in `after`, by identity. */
function changedItems<T>(before: readonly T[] | undefined, after: readonly T[] | undefined): T[] {
  const was = new Set(before ?? []), is = new Set(after ?? []);
  return [...(after ?? []).filter(item => !was.has(item)), ...(before ?? []).filter(item => !is.has(item))];
}

/** What a changed Run reaches outside its Task: the Runs that name it, and the returns its Request delivered. */
function runRelations(run: RunId, request: string | null, gather: Gather): void {
  for (const referrer of gather.each(reader => reader.runReferrers(run)))
    for (const reader of gather.readers) gather.add(reader.runOwner(referrer), BALL);
  if (request === null) return;
  for (const returnId of gather.each(reader => reader.deliveriesByWakeRequest(request))) {
    gather.addAll(gather.each(reader => [reader.returnOwner(returnId)].filter((id): id is string => id !== undefined)), [...BALL, 'history']);
    for (const reader of gather.readers) {
      const owner = reader.returnOwner(returnId);
      const row = owner === undefined ? undefined : reader.bundle(owner)?.returns.find(item => item.id === returnId);
      const cause = row?.causeLogId == null ? undefined : reader.logOwner(row.causeLogId);
      gather.add(cause, ['history']);
    }
  }
}

function coordinatorRelations(request: string, gather: Gather): void {
  gather.addAll(gather.each(reader => reader.dialogueTasks(request)), ['history']);
  gather.addAll(gather.each(reader => reader.messageTasks(request)), ['history']);
}

/**
 * The relations a change key gives by its kind alone, before the owners' records are compared: what belongs to no Task
 * (settings, files, activity, the person, the coordinator) and the definitions every Task of a subtree reads.
 */
function keyRelations(key: ChangeKey, change: RecordsChange, gather: Gather, owners: Set<TaskId>,
  coordinatorRequests: Set<string>, coordinatorRuns: Set<RunId>): void {
  const { before, after } = change;
  switch (key.kind) {
    case 'config':
      // B10, A9, A10: the agents and limits every seat reads, and the index's small fields.
      gather.addAll(new Set([...before.taskIds(), ...after.taskIds()]), [...BALL, 'view', 'history']);
      gather.meta = true;
      return;
    case 'person': case 'conversation':
      gather.meta = true;
      return;
    case 'files':
      gather.add(key.id, ['files', 'view']);
      return;
    case 'activity': {
      const run = key.id as RunId;
      // Only the list carries what activity shows (withoutActivity): an opened view or the timeline does not read it again.
      const owners = gather.each(reader => [reader.runOwner(run)].filter((id): id is string => id !== null));
      gather.addAll(owners, ['row']);
      // History says a failed Run's cause from these folder facts, so a cause read later changes where that row is shown.
      const causeOf = (reader: RecordsReader) => {
        const owner = reader.runOwner(run);
        return owner === null ? undefined : reader.bundle(owner)?.runFiles?.get(run)?.errorCause;
      };
      if (causeOf(before)?.cause !== causeOf(after)?.cause) for (const owner of owners)
        gather.addAll([owner, ...gather.each(reader => [reader.parent(owner)].filter((id): id is string => id !== null)),
          ...gather.each(reader => reader.historyReferrers(owner))], ['history']);
      return;
    }
    case 'field_def':
      // R18: the schemas that use the definition, and every Task that reads them.
      for (const project of gather.each(reader => reader.fieldUsers(key.id))) gather.addAll(gather.subtree(project), ['view']);
      return;
    case 'project_field':
      // R18: a project's schema reaches its subtree and the projects that take it.
      gather.addAll(gather.subtree(key.id), ['view']);
      for (const project of gather.each(reader => reader.schemaUsers(key.id))) gather.addAll(gather.subtree(project), ['view']);
      owners.add(key.id);
      return;
    case 'request':
      if (before.requestOwner(key.id) === null && after.requestOwner(key.id) === null) coordinatorRequests.add(key.id);
      return;
    case 'run': {
      const run = key.id as RunId;
      if (before.runOwner(run) === null && after.runOwner(run) === null) coordinatorRuns.add(run);
      return;
    }
    default:
      // Every other key names a record of a Task: its owner is in `owners`, and its records are compared there.
      return;
  }
}

/**
 * What of a Task's listed row (a closed page's, a search's or the timeline's) the Task itself decides: its derived row,
 * the row facts its own placements and Runs give (as if nothing below it worked), and its own part of the aggregates
 * (its usage, open Runs and latest move). Without what activity shows, which none of those resources carries.
 */
function listedRow(derived: TaskDerived | undefined): string {
  if (!derived) return '';
  // Row facts read the placements' run counts and display state and the Runs' states, never their activity.
  return JSON.stringify([derived.row, projectRowFacts(derived.row, derived.placements, derived.runs, 0, 0, 0), derived.contribution]);
}

/** What a Task's view shows of its derived facts: its row (its ball too), placements and Runs, without activity. */
const viewFacts = (derived: TaskDerived | undefined) => JSON.stringify(derived ? [derived.row, withoutActivity(derived)] : null);
/**
 * What the strips and axis of the rows above a Task read of it (belowRuns, busy, earliest): its Runs' spans, whether it
 * is read at all (it exists in a listed project) and where it sits.
 */
const readAbove = (reader: RecordsReader, derived: TaskDerived | undefined, task: TaskId) =>
  !reader.bundle(task) || !reader.shelf().listed.has(reader.projectOf(task)) ? null
    : JSON.stringify([derived?.runs.map(run => [run.id, run.state, run.createdAt, run.startedAt, run.endedAt]) ?? [], reader.ancestors(task)]);

/**
 * The scopes of the resources that changed. Closed pages and search return a Task's row as it is: when an affected
 * Task's own row (what activity alone never moves) differs between the two points, every scope it is listed in at
 * either point changes. A row's time strip is made from its own row (without what descendants decide), History events,
 * log, Runs and placements, and from the spans of the Runs below it: a Task's own strip changes with its row, its
 * records (its timeline facet) and its History; its ancestors' strips change only when what they read of it
 * (readAbove) changes, at either point. What descendants decide of a row (counts, movedAt and the order) is the aggregate's
 * (aggregateResources), and no strip carries it. A Task whose row was reached has its view made old when its derived
 * facts moved.
 */
function finish(gather: Gather, before: RecordsReader, after: RecordsReader, rows: DerivedRows): AffectedSet {
  // A view shows its Task's derived facts: whatever reached them made the view old when they moved.
  for (const [task, facets] of gather.tasks)
    if (facets.has('row') && !facets.has('view') && viewFacts(rows.before(task)) !== viewFacts(rows.after(task))) gather.add(task, ['view']);
  return rescope({ tasks: gather.tasks, scopes: { page: new Set(), search: new Set(), timeline: new Set() }, meta: gather.meta },
    gather.tasks.keys(), before, after, rows);
}

/**
 * The scopes `tasks`' facets reach by the rule above, added to the set's own. A publication that gives Tasks facets of
 * its own after `affected` (a records repair, a retried or failed derivation, run records becoming readable or not)
 * reaches their scopes through it too.
 */
export function rescope(set: AffectedSet, tasks: Iterable<TaskId>, before: RecordsReader, after: RecordsReader, rows: DerivedRows): AffectedSet {
  const page = new Set(set.scopes.page), search = new Set(set.scopes.search), timeline = new Set(set.scopes.timeline);
  for (const task of tasks) {
    const facets = set.tasks.get(task);
    if (!facets) continue;
    const rowChanged = facets.has('row') && listedRow(rows.before(task)) !== listedRow(rows.after(task));
    const own = rowChanged || facets.has('timeline') || facets.has('history');
    const below = readAbove(before, rows.before(task), task) !== readAbove(after, rows.after(task), task);
    if (!rowChanged && !own && !below) continue;
    for (const [reader, derived] of [[before, rows.before(task)], [after, rows.after(task)]] as const) {
      if (!reader.bundle(task)) continue;
      if (rowChanged) {
        for (const scope of pageScopes(reader, derived, task)) page.add(scope);
        for (const scope of reader.scopes(task)) search.add(scope);
      }
      if (own) timeline.add(task);
      if (below) for (const lane of reader.ancestors(task)) timeline.add(lane);
    }
  }
  return { ...set, scopes: { page, search, timeline } };
}

