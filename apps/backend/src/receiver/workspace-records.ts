/**
 * Immutable control facts and their reverse relations, advanced from the records a committed write named.
 *
 * `emptyWorkspaceRecords(root, observations).load(db, pv)` reads everything in one read transaction; `advance(db,
 * keys, pv)` reads only what the keys name and returns the next records beside these, which their readers keep reading
 * (publish `next` only once the rest of the frame succeeded). Bundles and reverse relations are persistent ordered
 * maps: an advance copies the edited paths, keeps a moved or deleted row's old owner, and the unchanged parts of every
 * bundle keep their objects (affected compares by identity).
 *
 * A Run's folder facts (activity, failure cause) are captured into its bundle's `runFiles` at load and on its `run` or
 * `activity` key, from the watcher's observations when it has them. A coordinator's Runs are not Runs of the records;
 * the Tasks whose records name their messages are a change's owners.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { deepFreeze } from '@alpacawork/core';
import { DEFAULT_SCHEMA, fieldCatalog, fieldDefSchema, hasRequesterSeat, isSeatContinuation, RESULT_HEAD_LENGTH, resultHead,
  type FieldCatalog, type FieldDef, type ReadRunRecord, type RunId, type RunResultState } from '@alpacawork/contract';
import { carrierOf, runFolder, runNumber, runResultStateSchema, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { ControlTreeDTO, ProjectionVersion } from '@alpacawork/contract/control';
import { UNSETTLED_INPUT_STATES } from '@alpacawork/contract/run-protocol';
import type { ChangeKey } from '@alpacawork/db';
import { RunStore, parseStoredPlacement, unclosedSent, type StoredRequest } from '@alpacawork/runs';
import type { TaskLog } from '@alpacawork/raw';
import { dialoguesOf, requestedByUser, saidAt, markMessages } from '../coordinator/messages.js';
import { readProjectionTask } from '../control/task-store.js';
import { readRunActivity } from '../runs/activity.js';
import { readRunFailure } from '../runs/error-cause.js';
import { failureAvailability } from '@alpacawork/contract/agent-diagnostics';
import { readAgentsSettings } from '../agents-settings.js';
import { readControlEnvironment } from '../control/tree.js';
import { ProjectShelf } from '../control/project-shelf.js';
import { seatSettings } from '../control/wake.js';
import type { CoordinatorRunFact, DatabaseChangeKind, KeyOwner, RecordsChange, RunFileRecord, TaskBundle, TaskId, WorkspaceRecords } from './projection-contract.js';
import { historyReferrersOf } from './workspace-history-refs.js';
import { RecordsMap, RecordsIndex } from './records-map.js';
import { finishRecords, type RecordWork } from './record-work.js';
import type { WatchedRun } from './workspace-file-thread.js';
import { runRecordReadError } from './run-record-health.js';
import { coordinatorFileRun } from './coordinator-file-runs.js';
import { bundleReloadKeys, conversationReloadKeys } from './workspace-records-reload.js';
import { databaseKeys, inputInstruction, ownerLookup, readPoint, recordKeys } from './workspace-records-sql.js';
import { latestCompactions } from '../runs/compactions.js';
export { ownerLookup } from './workspace-records-sql.js';

/** Result heads are projection facts, never an addition to the durable Run record. */
export type WorkspaceRunRecord = ReadRunRecord & { readonly resultHead: string | null };
export function resultHeadOf(run: ReadRunRecord | undefined): string | null {
  return run && 'resultHead' in run && typeof run.resultHead === 'string' ? run.resultHead : null;
}
type RunFact = { files: RunFileRecord; record: RuntimeRunRecord; state: RunResultState; head: string | null; view: WorkspaceRunRecord | undefined };
type Identity = { primary: KeyOwner; instruction?: KeyOwner };
type Environment = ReturnType<typeof readControlEnvironment>;
type Settings = ReturnType<typeof seatSettings>;
export interface WorkspaceObservations {
  /** Supplied by the file worker: this callback must return its already collected result, without traversing folders. */
  files?(task: TaskId): TaskBundle['files'];
  /** The Run watcher can supply already observed folder facts at the same observation boundary. */
  runFiles?(run: ReadRunRecord): RunFileRecord;
  /** A config observation is acquired once for load, and only on a config key afterwards. */
  configuration?(): { environment: Environment; settings: Settings };
}
type IndexName = 'children' | 'dependents' | 'runsByTask' | 'runsByPlacement' | 'runByRequest' | 'runReferrers'
  | 'requestsByReceiver' | 'logOwner' | 'placementOwner' | 'returnOwner' | 'closedRequests' | 'returnsByCauseLog'
  | 'deliveriesByWakeRequest' | 'questionsByDestination' | 'dialogueTasks' | 'joinedMessages' | 'messageTasks'
  | 'placementWritesTo' | 'historyReferrers' | 'requestOwner' | 'requestsByCaller' | 'schemaUsers' | 'fieldUsers'
  | 'inputsByAttempt' | 'inputsByInstruction' | 'requesterTasks' | 'runWritesTo' | 'returnsByCauseTask';
type Relations = Partial<Record<IndexName, RecordsIndex>>;
type Edge = readonly [IndexName, string, string];
const empty: readonly string[] = Object.freeze([]);
const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const asRunId = (id: string) => (id.startsWith('R') ? id : `R${id}`) as RunId;
const rowOrder = (a: { submittedAt: string; id: string }, b: { submittedAt: string; id: string }) =>
  a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id);
/** Immutable Request arrays share their lookup across publications; replacement arrays get a fresh lookup. */
const requestIndexes = new WeakMap<TaskBundle['requests'], ReadonlyMap<string, TaskBundle['requests'][number]>>();
function requestIn(requests: TaskBundle['requests'], id: string): TaskBundle['requests'][number] | undefined {
  let index = requestIndexes.get(requests);
  if (!index) {
    index = new Map(requests.map(request => [request.id, request]));
    requestIndexes.set(requests, index);
  }
  return index.get(id);
}
const logMessage = (entry: TaskLog) => entry.actor.kind === 'main' ? entry.actor.message : undefined;
function* logEdges(task: TaskId, log: readonly TaskLog[]): Generator<Edge> {
  for (const entry of log) {
    yield ['logOwner', entry.id, task];
    if (entry.runId) yield ['runWritesTo', entry.runId, task];
    if (logMessage(entry)) yield ['messageTasks', logMessage(entry)!, task];
    if (entry.actor.kind === 'placement') yield ['placementWritesTo', entry.actor.placementId, task];
    if (entry.askedTo) { yield ['questionsByDestination', entry.askedTo, task]; yield ['historyReferrers', entry.askedTo, task]; }
    for (const id of [...entry.dependencies?.after ?? [], ...entry.dependencies?.previous ?? []]) yield ['historyReferrers', id, task];
  }
}
function* bundleEdges(id: TaskId, bundle: TaskBundle, part: keyof TaskBundle): Generator<Edge> {
  if (part === 'task') {
    if (bundle.task.meta.parentId) yield ['children', bundle.task.meta.parentId, id];

  }
  if (part === 'placements') for (const p of bundle.placements) yield ['placementOwner', p.id, id];
  if (part === 'after') for (const after of bundle.after) yield ['dependents', after, id];
  if (part === 'requests') for (const request of bundle.requests) {
    yield ['requestsByReceiver', id, request.id]; yield ['requestOwner', request.id, id];
    if (request.author.kind === 'main' && request.author.message) yield ['messageTasks', request.author.message, id];
    if (request.author.kind === 'placement') yield ['placementWritesTo', request.author.placementId, id];
  }
  if (part === 'returns') for (const value of bundle.returns) {
    yield ['returnOwner', value.id, id];
    if (value.requestId) yield ['closedRequests', value.requestId, value.id];
    if (value.causeLogId) yield ['returnsByCauseLog', value.causeLogId, value.id];
    const cause = bundle.returnCauseTasks?.get(value.id);
    if (cause) yield ['returnsByCauseTask', cause, value.id];
    for (const delivery of value.deliveries) yield ['deliveriesByWakeRequest', delivery.wakeRequestId, value.id];
  }
  if (part === 'dialogues') for (const dialogue of bundle.dialogues) {
    yield ['dialogueTasks', dialogue.messageId, id]; yield ['messageTasks', dialogue.messageId, id];
  }
}
function runEdges(run: RuntimeRunRecord): Edge[] {
  const edges: Edge[] = [['runByRequest', run.requestId, run.id]];
  if (run.task !== null) edges.push(['runsByTask', run.task, run.id], ['runsByPlacement', run.placementId, run.id]);
  for (const ref of unique([run.caller?.run, run.resumes, run.into].filter((id): id is string => !!id))) edges.push(['runReferrers', ref, run.id]);
  if (run.caller) edges.push(['requestsByCaller', run.caller.run, run.requestId]);
  if (run.role === 'coordinator' && run.state === 'joined' && run.into) edges.push(['joinedMessages', run.into, run.requestId]);
  return edges;
}
function readRun(db: DatabaseSync, store: RunStore, id: RunId, files: (run: RuntimeRunRecord) => RunFileRecord): RunFact | undefined {
  const record = store.runtimeDecidingGet(id);
  if (!record) return undefined;
  const row = db.prepare(`SELECT result_state,typeof(result) AS result_type,
    CASE WHEN typeof(result)='text' THEN substr(result,1,?) END AS head
    FROM runs WHERE id=?`).get(RESULT_HEAD_LENGTH, runNumber(id))!;
  const state = runResultStateSchema.parse(row.result_state);
  if ((state === 'present') !== (row.result_type !== 'null')) throw new Error(`Invalid Run result storage: ${id}`);
  const head = state === 'present' && typeof row.head === 'string' ? resultHead(row.head) : null;
  return { files: deepFreeze(files(record)), record: deepFreeze(record), view: record.task === null ? undefined : deepFreeze({ ...record, resultHead: head }), state: row.result_type !== 'null' && row.result_type !== 'text' ? 'unreadable' : state,
    head };
}
function taskRun(fact: RunFact): WorkspaceRunRecord | undefined {
  return fact.view;
}
const freshBundle = (task: TaskBundle['task']): TaskBundle => ({ task, placements: [], runs: [], resultStates: new Map(),
  headRunIds: new Map(), requests: [], unclosedSent: [], returns: [], returnCauseTasks: new Map(), runFiles: new Map(), waitCycles: [], inputs: { uncertain: new Map(), closed: new Set() }, after: [],
  dialogues: [], answerTexts: {}, requestedByUser: null, files: [] });
const parts: readonly (keyof TaskBundle)[] = ['task', 'placements', 'runs', 'runFiles', 'requests', 'unclosedSent', 'returns', 'waitCycles', 'inputs', 'after', 'dialogues', 'answerTexts', 'requestedByUser', 'files'];

export class DatabaseWorkspaceRecords implements WorkspaceRecords {
  private bundles = new RecordsMap<TaskBundle>();
  private runs = new RecordsMap<RunFact>();
  private coordinatorFileIndex = new RecordsMap<WatchedRun>();
  private runErrors = new RecordsMap<ControlTreeDTO['errors'][number]>();
  private identities = new RecordsMap<Identity>();
  private ownerIdentities = new RecordsIndex();
  private conversations = new RecordsMap<Readonly<Record<string, unknown>>>();
  private conversationIdentities = new RecordsIndex();
  private identityConversations = new RecordsMap<string>();
  private coordinatorRequests = new RecordsMap<Readonly<Record<string, unknown>>>();
  private relations: Relations = {};
  private definitions = new RecordsMap<FieldDef>();
  private schemas = new RecordsMap<readonly string[]>();
  private projects = new RecordsMap<TaskBundle['task']>();
  private fields: FieldCatalog = fieldCatalog([]);
  private projectShelf = new ProjectShelf([]);
  private config!: { environment: Environment; settings: Settings };
  constructor(private readonly root: string, readonly pv: ProjectionVersion, private readonly observations: WorkspaceObservations = {}) {}
  private fork(pv: ProjectionVersion): DatabaseWorkspaceRecords {
    const next = new DatabaseWorkspaceRecords(this.root, pv, this.observations);
    next.bundles = this.bundles; next.runs = this.runs; next.runErrors = this.runErrors; next.identities = this.identities;
    next.coordinatorFileIndex = this.coordinatorFileIndex;
    next.ownerIdentities = this.ownerIdentities; next.conversations = this.conversations;
    next.conversationIdentities = this.conversationIdentities; next.identityConversations = this.identityConversations;
    next.coordinatorRequests = this.coordinatorRequests;
    next.relations = { ...this.relations }; next.definitions = this.definitions; next.schemas = this.schemas;
    next.inputEdges = this.inputEdges; next.schemaEdges = this.schemaEdges;
    next.projects = this.projects; next.fields = this.fields; next.projectShelf = this.projectShelf; next.config = this.config;
    return next;
  }
  private values(index: IndexName, key: string): readonly string[] { return this.relations[index]?.values(key) ?? empty; }
  private edges(source: string, values: Iterable<Edge>, add: boolean) {
    finishRecords(this.edgeSteps(source, values, add));
  }
  private *edgeSteps(source: string, values: Iterable<Edge>, add: boolean): RecordWork<void> {
    for (const [index, key, value] of values) {
      this.relations[index] = (this.relations[index] ?? new RecordsIndex()).change(key, value, source, add);
      yield;
    }
  }
  private setRun(id: RunId, value: RunFact | undefined) { finishRecords(this.setRunSteps(id, value)); }
  private *setRunSteps(id: RunId, value: RunFact | undefined): RecordWork<void> {
    const previous = this.runs.get(id)?.record, record = value?.record;
    const senderChanged = previous?.task !== record?.task || previous?.requestId !== record?.requestId || previous?.caller?.run !== record?.caller?.run;
    const callers = senderChanged ? unique([id, ...this.values('runReferrers', id)]) : [];
    const senderEdges = (run: RuntimeRunRecord | undefined): Edge[] => {
      const sender = run?.caller ? this.runs.get(run.caller.run)?.record.task : undefined;
      return sender && run ? [['requesterTasks', sender, run.task!]] : [];
    };
    for (const ref of callers) yield* this.edgeSteps(`sender:${ref}`, senderEdges(this.runs.get(ref)?.record), false);
    const before = this.runs.get(id);
    if (before) yield* this.edgeSteps(`run:${id}`, runEdges(before.record), false);
    this.runs = value ? this.runs.set(id, value) : this.runs.delete(id);
    const observed = coordinatorFileRun(value?.record);
    this.coordinatorFileIndex = observed ? this.coordinatorFileIndex.set(id, deepFreeze(observed)) : this.coordinatorFileIndex.delete(id);
    if (value) yield* this.edgeSteps(`run:${id}`, runEdges(value.record), true);
    for (const ref of callers) yield* this.edgeSteps(`sender:${ref}`, senderEdges(this.runs.get(ref)?.record), true);
  }
  private setBundle(id: TaskId, value: TaskBundle | undefined) { finishRecords(this.setBundleSteps(id, value)); }
  private *setBundleSteps(id: TaskId, value: TaskBundle | undefined): RecordWork<void> {
    const before = this.bundles.get(id);
    const oldLog = before?.task.meta.log ?? [], newLog = value?.task.meta.log ?? [];
    if (oldLog !== newLog) {
      const extended = newLog.length >= oldLog.length && (!oldLog.length || newLog[oldLog.length - 1] === oldLog.at(-1));
      if (!extended) yield* this.edgeSteps(`${id}:log`, logEdges(id, oldLog), false);
      yield* this.edgeSteps(`${id}:log`, logEdges(id, extended ? newLog.slice(oldLog.length) : newLog), true);
    }
    for (const part of parts) if (before?.[part] !== value?.[part]) {
      if (part === 'requests' || part === 'returns') {
        const was = new Map((before?.[part] ?? []).map(row => [row.id, row]));
        const is = new Map((value?.[part] ?? []).map(row => [row.id, row]));
        for (const key of new Set([...was.keys(), ...is.keys()])) if (was.get(key) !== is.get(key)) {
          if (before && was.has(key)) yield* this.edgeSteps(`${id}:${part}:${key}`, bundleEdges(id, { ...before, [part]: [was.get(key)] } as TaskBundle, part), false);
          if (value && is.has(key)) yield* this.edgeSteps(`${id}:${part}:${key}`, bundleEdges(id, { ...value, [part]: [is.get(key)] } as TaskBundle, part), true);
        }
      } else {
        if (before) yield* this.edgeSteps(`${id}:${part}`, bundleEdges(id, before, part), false);
        if (value) yield* this.edgeSteps(`${id}:${part}`, bundleEdges(id, value, part), true);
      }
    }
    this.bundles = value ? this.bundles.set(id, deepFreeze(value)) : this.bundles.delete(id);
    if (before?.task.meta.kind === 'project') this.projects = this.projects.delete(id);
    if (value?.task.meta.kind === 'project') this.projects = this.projects.set(id, value.task);
  }
  private readRunFiles(run: RuntimeRunRecord): RunFileRecord {
    if (run.task === null) return { activity: null, errorCause: undefined };
    const observed = this.observations.runFiles?.(run);
    return observed ? structuredClone(observed) : {
      activity: run.state === 'running' ? readRunActivity(runFolder(this.root, run.id)) : null,
      errorCause: failureAvailability(readRunFailure(this.root, run)),
    };
  }
  private readRunFact(db: DatabaseSync, store: RunStore, id: RunId): RunFact | undefined {
    try {
      const fact = readRun(db, store, id, run => this.readRunFiles(run));
      this.runErrors = this.runErrors.delete(id);
      return fact;
    } catch (error) {
      this.runErrors = this.runErrors.set(id, runRecordReadError(error));
      return undefined;
    }
  }
  private configuration() {
    if (this.observations.configuration) return deepFreeze(structuredClone(this.observations.configuration()));
    const settings = readAgentsSettings(this.root);
    return deepFreeze({ environment: readControlEnvironment(this.root, settings), settings: seatSettings(settings) });
  }
  load(db: DatabaseSync, pv: ProjectionVersion): DatabaseWorkspaceRecords {
    return readPoint(db, () => {
      const next = new DatabaseWorkspaceRecords(this.root, pv, this.observations);
      next.config = next.configuration();
      const store = new RunStore(this.root, { busyTimeoutMs: 0 }, true, db);
      try {
        for (const row of db.prepare('SELECT id FROM runs ORDER BY id').all()) {
          const id = asRunId(String(row.id)); next.setRun(id, next.readRunFact(db, store, id));
        }
        for (const row of db.prepare('SELECT external_id FROM tasks ORDER BY number').all()) {
          const id = String(row.external_id), task = readProjectionTask(db, id, undefined, undefined, this.root)!;
          next.setBundle(id, next.readBundle(db, store, freshBundle(task), new Set(parts)));
        }
        for (const row of db.prepare('SELECT id,definition FROM field_defs ORDER BY id').all())
          next.definitions = next.definitions.set(String(row.id), fieldDefSchema.parse(JSON.parse(String(row.definition))));
        next.fields = fieldCatalog([...next.definitions.values()]);
        for (const id of next.projects.keys()) next.readSchema(db, id);
        next.refreshProjectFacts();
        for (const key of databaseKeys(db)) next.readIdentity(db, key);
        next.readInputs(db);
        return next;
      } finally { store.close(); }
    });
  }
  private readBundle(db: DatabaseSync, store: RunStore, previous: TaskBundle, read: ReadonlySet<keyof TaskBundle>): TaskBundle {
    return finishRecords(this.readBundleSteps(db, store, previous, read));
  }
  private *readBundleSteps(db: DatabaseSync, store: RunStore, previous: TaskBundle, read: ReadonlySet<keyof TaskBundle>, delta?: { requests: readonly string[]; returns: readonly string[] }): RecordWork<TaskBundle> {
    let value = previous;
    const id = previous.task.id;
    const put = <K extends keyof TaskBundle>(key: K, data: TaskBundle[K]) => { value = { ...value, [key]: data }; };
    if (read.has('placements')) {
      const placements = db.prepare('SELECT * FROM placements WHERE task_id=? ORDER BY started_at,id').all(id).map(parseStoredPlacement);
      const compactions = latestCompactions(db, placements.map(placement => placement.id));
      put('placements', placements.map(placement => ({ ...placement, compaction: compactions.get(placement.id) ?? null })));
    }
    if (read.has('requests')) {
      const requests = delta ? new Map(previous.requests.map(row => [row.id, row])) : new Map<string, StoredRequest>();
      const ids = delta?.requests ?? db.prepare('SELECT id FROM requests WHERE task_id=? ORDER BY submitted_at,id').all(id).map(row => String(row.id));
      for (const requestId of ids) {
        const row = store.getRequest(requestId);
        if (row?.taskId === id) requests.set(row.id, deepFreeze(row)); else requests.delete(requestId);
        yield;
      }
      put('requests', [...requests.values()].sort(rowOrder));
    }
    if (read.has('unclosedSent')) {
      const candidates = unclosedSent(db, this.root, [id]).get(id)!;
      put('unclosedSent', candidates.flatMap(request => store.getRequest(request) ?? []));
    }
    yield;
    if (read.has('returns')) {
      const returns = delta ? new Map(previous.returns.map(row => [row.id, row])) : new Map<string, TaskBundle['returns'][number]>();
      if (delta) {
        for (const returnId of delta.returns) {
          const row = store.getReturn(returnId);
          if (row?.toTaskId === id) returns.set(row.id, deepFreeze(row)); else returns.delete(returnId);
          yield;
        }
      } else {
        let after: string | undefined;
        do {
          const page = store.readReturnPage({ task: id, after, limit: 64 });
          for (const row of page.returns) returns.set(row.id, deepFreeze(row));
          after = page.nextAfter ?? undefined; yield;
        } while (after !== undefined);
      }
      put('returns', [...returns.values()].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const causes = delta ? new Map(previous.returnCauseTasks) : new Map<string, string>();
      if (delta) for (const key of delta.returns) causes.delete(key);
      const changed = delta ? delta.returns.flatMap(key => returns.get(key) ?? []) : [...returns.values()];
      for (const row of changed) if (row.causeLogId) {
        const owner = db.prepare('SELECT t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE l.id=?').get(row.causeLogId);
        if (owner) causes.set(row.id, String(owner.external_id));
      }
      put('returnCauseTasks', causes);
    }
    if (read.has('waitCycles')) put('waitCycles', db.prepare('SELECT * FROM wait_cycles WHERE task_id=? ORDER BY opened_at,id').all(id)
      .map(row => ({ id: String(row.id), taskId: id, openedAt: String(row.opened_at), closedAt: row.closed_at === null ? null : String(row.closed_at) })));
    if (read.has('after')) put('after', db.prepare('SELECT after_task_id FROM task_dependencies WHERE task_id=? ORDER BY after_task_id').all(id).map(row => String(row.after_task_id)));
    yield;
    if (read.has('runs')) {
      const facts = this.values('runsByTask', id).map(run => this.runs.get(run)!).sort((a, b) => runNumber(a.record.id) - runNumber(b.record.id));
      put('runFiles', new Map(facts.map(fact => [fact.record.id, fact.files])));
      put('runs', facts.map(fact => taskRun(fact)!)); put('resultStates', new Map(facts.map(fact => [fact.record.id, fact.state])));
    }
    yield;
    if (read.has('runs') || read.has('placements') || read.has('requests')) {
      const heads = new Map<string, RunId | null>(value.placements.map(placement => [placement.id, null]));
      const aborted = new Set(value.requests.filter(request => request.deliveryState === 'aborted').map(request => request.id));
      for (const run of value.runs) if (run.state !== 'joined' && !aborted.has(run.requestId)) heads.set(run.placementId, run.id);
      put('headRunIds', heads);
    }
    yield;
    if (read.has('inputs')) {
      const inputs = db.prepare(`SELECT i.*,a.run_no,r.placement_id FROM run_inputs i JOIN run_attempts a USING(attempt_id)
        JOIN runs r ON r.id=a.run_no WHERE r.task_id=? ORDER BY i.input_id`).all(id);
      const uncertain = new Map<string, Set<RunId>>(), closed = new Set<RunId>();
      for (const row of inputs) {
        yield;
        if (row.state === 'uncertain') { const group = uncertain.get(String(row.placement_id)) ?? new Set<RunId>();
          group.add(asRunId(String(row.instruction_run_no))); uncertain.set(String(row.placement_id), group); }
        if ((UNSETTLED_INPUT_STATES as readonly string[]).includes(String(row.state))) closed.add(asRunId(String(row.run_no)));
      }
      for (const row of db.prepare('SELECT a.run_no FROM run_attempts a JOIN runs r ON r.id=a.run_no WHERE r.task_id=? AND a.diagnostic IS NOT NULL').all(id)) closed.add(asRunId(String(row.run_no)));
      put('inputs', { uncertain, closed });
    }
    yield;
    if (read.has('dialogues')) put('dialogues', dialoguesOf(db, [value.task]));
    if (read.has('answerTexts')) put('answerTexts', Object.fromEntries(db.prepare('SELECT log_id,text FROM log_texts WHERE log_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(value.task.meta.log.filter(entry => entry.kind === 'answered').map(entry => entry.id))).map(row => [String(row.log_id), String(row.text)])));
    if (read.has('requestedByUser')) {
      const at = saidAt(db, markMessages([value.task.meta.log]));
      put('requestedByUser', requestedByUser(value.task.meta.log, message => at.get(message)));
    }
    yield;
    if (read.has('files')) put('files', structuredClone(this.observations.files?.(id) ?? []));
    return value;
  }
  private inputEdges = new RecordsMap<readonly Edge[]>();
  private readInputs(db: DatabaseSync, ids?: readonly string[]) { finishRecords(this.readInputSteps(db, ids)); }
  private *readInputSteps(db: DatabaseSync, ids?: readonly string[]): RecordWork<void> {
    const rows = db.prepare(`SELECT i.input_id,i.attempt_id,i.instruction_run_no,a.run_no FROM run_inputs i JOIN run_attempts a USING(attempt_id)
      ${ids === undefined ? '' : 'WHERE i.input_id IN (SELECT value FROM json_each(?))'}`).all(...ids === undefined ? [] : [JSON.stringify(ids)]);
    for (const id of ids ?? []) {
      const before = this.inputEdges.get(id);
      if (before) yield* this.edgeSteps(`input:${id}`, before, false);
      this.inputEdges = this.inputEdges.delete(id);
    }
    for (const row of rows) {
      yield;
      const id = String(row.input_id), edges: Edge[] = [['inputsByAttempt', String(row.attempt_id), id],
        ['inputsByInstruction', asRunId(String(row.instruction_run_no)), id]];
      yield* this.edgeSteps(`input:${id}`, edges, true); this.inputEdges = this.inputEdges.set(id, edges);
    }
  }
  private identityKey(key: ChangeKey): string {
    if (['task_value', 'dependency', 'stop_epoch', 'files', 'project_field'].includes(key.kind)) return `task:${key.id}`;
    if (key.kind === 'activity' || key.kind === 'attempt' && /^R?\d+$/.test(key.id)) return `run:${asRunId(key.id)}`;
    if (key.kind === 'start_grant') return `request:${key.id}`;
    if (key.kind === 'resolution') return `return:${key.id}`;
    if (key.kind === 'delivery') return `return:${key.id.slice(0, key.id.indexOf(':'))}`;
    return `${key.kind}:${key.id}`;
  }
  private readIdentity(db: DatabaseSync, key: ChangeKey): Identity | undefined {
    if (key.kind === 'activity' && this.identities.has(this.identityKey(key))) return this.identities.get(this.identityKey(key));
    const kind = key.kind === 'activity' ? 'run' : key.kind;
    if (kind === 'files' || kind === 'config' || kind === 'person') return undefined;
    const primary = ownerLookup[kind as DatabaseChangeKind](db, [key.id]).get(key.id);
    const identity = primary ? { primary, ...(key.kind === 'input' ? { instruction: inputInstruction(db, key.id) } : {}) } : undefined;
    const canonical = this.identityKey(key), before = this.identities.get(canonical);
    for (const [value, add] of [[before, false], [identity, true]] as const)
      for (const owner of [value?.primary.task, value?.instruction?.task]) if (owner)
        this.ownerIdentities = this.ownerIdentities.change(owner, canonical, canonical, add);
    this.identities = identity ? this.identities.set(canonical, identity) : this.identities.delete(canonical);
    if (key.kind === 'request' || key.kind === 'run') {
      const oldConversation = this.identityConversations.get(canonical);
      const row = key.kind === 'request' ? db.prepare('SELECT * FROM requests WHERE id=? AND task_id IS NULL').get(key.id)
        : db.prepare('SELECT conversation_id FROM runs WHERE id=? AND task_id IS NULL').get(runNumber(asRunId(key.id)));
      if (oldConversation) this.conversationIdentities = this.conversationIdentities.change(oldConversation, canonical, canonical, false);
      const conversation = row?.conversation_id == null ? undefined : String(row.conversation_id);
      this.identityConversations = conversation ? this.identityConversations.set(canonical, conversation) : this.identityConversations.delete(canonical);
      if (conversation) this.conversationIdentities = this.conversationIdentities.change(conversation, canonical, canonical, true);
      if (key.kind === 'request') this.coordinatorRequests = row ? this.coordinatorRequests.set(key.id, deepFreeze({ ...row })) : this.coordinatorRequests.delete(key.id);
    }
    if (key.kind === 'conversation') {
      const row = db.prepare('SELECT * FROM coordinator_conversations WHERE id=?').get(key.id);
      this.conversations = row ? this.conversations.set(key.id, deepFreeze({ ...row })) : this.conversations.delete(key.id);
    }
    return identity;
  }
  private readSchema(db: DatabaseSync, project: TaskId) {
    const rows = db.prepare('SELECT field_id FROM project_fields WHERE project_task_id=(SELECT id FROM tasks WHERE external_id=?) ORDER BY position').all(project);
    const fields = rows.length ? rows.map(row => String(row.field_id)) : undefined;
    const changed = !isDeepStrictEqual(this.schemas.get(project), fields);
    this.schemas = fields ? this.schemas.set(project, fields) : this.schemas.delete(project);
    return changed;
  }
  private schemaEdges = new RecordsMap<readonly Edge[]>();
  private refreshProjectFacts() {
    this.projectShelf = new ProjectShelf([...this.projects.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))));
    for (const [id, edges] of this.schemaEdges) this.edges(`schema:${id}`, edges, false);
    this.schemaEdges = new RecordsMap();
    for (const id of this.projects.keys()) {
      const schema = this.schemaOf(id), edges: Edge[] = schema.from ? [['schemaUsers', schema.from, id]] : [];
      const seen = new Set<string>();
      const field = (key: string) => {
        if (seen.has(key)) return;
        seen.add(key); edges.push(['fieldUsers', key, id]);
        for (const member of this.fields.get(key)?.members ?? []) field(member);
      };
      schema.fields.forEach(field); this.schemaEdges = this.schemaEdges.set(id, edges); this.edges(`schema:${id}`, edges, true);
    }
  }
  /** Re-read complete selected bundles in one read transaction; callers publish only the returned next instance. */
  reloadBundles(db: DatabaseSync, tasks: readonly TaskId[], pv: ProjectionVersion, extraKeys: readonly ChangeKey[] = []): RecordsChange & { readonly next: DatabaseWorkspaceRecords } {
    return readPoint(db, () => finishRecords(this.reloadBundleSteps(db, tasks, pv, extraKeys)));
  }
  /** The caller owns the read transaction until this iterator completes or is returned. */
  *reloadBundleSteps(db: DatabaseSync, tasks: readonly TaskId[], pv: ProjectionVersion, extraKeys: readonly ChangeKey[] = []): RecordWork<RecordsChange & { readonly next: DatabaseWorkspaceRecords }> {
    if (!db.isTransaction) throw new Error('Bundle assembly requires a SQLite read transaction');
    const keys = new Map<string, ChangeKey>();
    const add = (key: ChangeKey) => keys.set(JSON.stringify(key), key);
    const previous = (identity: string): ChangeKey => {
      const colon = identity.indexOf(':');
      return { kind: identity.slice(0, colon) as ChangeKey['kind'], id: identity.slice(colon + 1) };
    };
    for (const task of tasks) {
      for (const identity of this.ownerIdentities.values(task)) { add(previous(identity)); yield; }
      for (const key of bundleReloadKeys(db, [task])) { add(key); yield; }
    }
    for (const key of extraKeys) {
      add(key); yield;
      if (key.kind !== 'conversation') continue;
      for (const identity of this.conversationIdentities.values(key.id)) { add(previous(identity)); yield; }
      for (const linked of conversationReloadKeys(db, key.id)) { add(linked); yield; }
    }
    return yield* this.advanceSteps(db, [...keys.values()], pv, tasks);
  }
  conversationIds(): Iterable<string> { return this.conversations.keys(); }
  conversation(id: string): Readonly<Record<string, unknown>> | undefined { return this.conversations.get(id); }
  conversationFacts(id: string): unknown {
    return { conversation: this.conversation(id), records: this.conversationIdentities.values(id).map(key => {
      const colon = key.indexOf(':'), kind = key.slice(0, colon), identity = key.slice(colon + 1);
      return [key, kind === 'request' ? this.coordinatorRequests.get(identity) : this.runs.get(identity)];
    }) };
  }
  advance(db: DatabaseSync, written: readonly ChangeKey[], pv: ProjectionVersion, reload: readonly TaskId[] = []): RecordsChange & { readonly next: DatabaseWorkspaceRecords } {
    return readPoint(db, () => finishRecords(this.advanceSteps(db, written, pv, reload)));
  }
  /** A candidate stays private while the caller schedules its read transaction's checkpoints. */
  *advanceSteps(db: DatabaseSync, written: readonly ChangeKey[], pv: ProjectionVersion, reload: readonly TaskId[] = []): RecordWork<RecordsChange & { readonly next: DatabaseWorkspaceRecords }> {
    if (!db.isTransaction) throw new Error('Record assembly requires a SQLite read transaction');
    const keys = recordKeys(db, written);
    const next = this.fork(pv), owners = new Set<TaskId>();
    const reads = new Map<TaskId, Set<keyof TaskBundle>>(), logs = new Set<TaskId>(), values = new Set<TaskId>();
    const changedRuns = new Set<RunId>(), messages = new Set<string>(), inputIds = new Set<string>();
    let projectFacts = false;
    const need = (id: string, ...parts: (keyof TaskBundle)[]) => {
      owners.add(id); const wanted = reads.get(id) ?? new Set<keyof TaskBundle>();
      parts.forEach(part => wanted.add(part)); reads.set(id, wanted);
    };
    const reloadTasks = new Set(reload);
    for (const id of reload) { need(id, ...parts); logs.add(id); values.add(id); }
    const identities = (identity: Identity | undefined): TaskId[] => {
      const found: TaskId[] = [];
      for (const value of [identity?.primary, identity?.instruction]) {
        if (value?.task) found.push(value.task);
        if (value?.coordinator) messages.add(value.coordinator);
      }
      return found;
    };
    for (const key of keys) {
      yield;
      const before = this.identities.get(this.identityKey(key));
      const after = next.readIdentity(db, key);
      const ids = unique([...identities(before), ...identities(after)]);
      if (key.kind === 'field_def') {
        for (const project of this.fieldUsers(key.id)) owners.add(project);
        const row = db.prepare('SELECT definition FROM field_defs WHERE id=?').get(key.id);
        const definition = row ? fieldDefSchema.parse(JSON.parse(String(row.definition))) : undefined;
        projectFacts ||= !isDeepStrictEqual(next.definitions.get(key.id), definition);
        next.definitions = definition ? next.definitions.set(key.id, definition) : next.definitions.delete(key.id);
      }
      if (key.kind === 'project_field') projectFacts = next.readSchema(db, key.id) || projectFacts;
      if (key.kind === 'config') next.config = next.configuration();
      if (key.kind === 'conversation') messages.add(key.id);
      if (key.kind === 'person' || key.kind === 'config' || key.kind === 'conversation') continue;
      if (key.kind === 'input') inputIds.add(key.id);
      if (key.kind === 'attempt') {
        const number = /^R?\d+$/.test(key.id) ? Number(key.id.replace(/^R/, '')) : null;
        for (const row of db.prepare('SELECT input_id FROM run_inputs WHERE attempt_id=? OR attempt_id=(SELECT attempt_id FROM run_attempts WHERE run_no=?)').all(key.id, number)) inputIds.add(String(row.input_id));
      }
      if (key.kind === 'run' || key.kind === 'activity') changedRuns.add(asRunId(key.id));
      if (key.kind === 'request') {
        const row = db.prepare('SELECT caller.task_id FROM runs r JOIN runs caller ON caller.id=CAST(substr(r.caller_run,2) AS INTEGER) WHERE r.request_id=?').get(key.id);
        if (row?.task_id != null) need(String(row.task_id), 'unclosedSent');
      }
      for (const id of ids) {
        need(id);
        switch (key.kind) {
          case 'task': need(id, 'task'); break;
          case 'task_value': need(id, 'task'); values.add(id); break;
          case 'log': need(id, 'task', 'answerTexts', 'requestedByUser', 'dialogues'); logs.add(id); break;
          case 'placement': need(id, 'placements'); break;
          case 'request': need(id, 'requests', 'task', 'dialogues', 'requestedByUser', 'unclosedSent'); logs.add(id); break;
          case 'wait_cycle': need(id, 'waitCycles'); break;
          case 'dependency': need(id, 'after'); break;
          case 'run': need(id, 'runs', 'requests', 'inputs', 'unclosedSent'); break;
          case 'activity': need(id, 'runs'); break;
          case 'attempt': case 'input': need(id, 'inputs'); break;
          case 'return': case 'delivery': case 'resolution': need(id, 'returns', 'unclosedSent'); break;
          case 'dialogue': case 'refusal': need(id, 'dialogues'); break;
          case 'files': need(id, 'files'); break;
        }
      }
    }
    const store = new RunStore(this.root, { busyTimeoutMs: 0 }, true, db);
    try {
      for (const id of changedRuns) {
        yield;
        const before = this.runs.get(id)?.record;
        const held = this.runs.get(id);
        const after = held && !keys.some(key => key.kind === 'run' && key.id === id)
          ? { ...held, files: deepFreeze(next.readRunFiles(held.record)) }
          : next.readRunFact(db, store, id);
        yield* next.setRunSteps(id, after);
        for (const run of [before, after?.record]) if (run?.caller) {
          const sender = next.runOwner(run.caller.run); if (sender) need(sender, 'unclosedSent');
        }
        if (before?.task === null) messages.add(before.requestId);
        if (after?.record.task === null) messages.add(after.record.requestId);
        for (const message of unique([...this.joinedMessages(id), ...next.joinedMessages(id)])) messages.add(message);
      }
      for (const message of messages) {
        yield;
        // A conversation key also names all the messages in that conversation, only on its explicit change.
        const linked = db.prepare(`SELECT t.external_id FROM task_dialogues d JOIN tasks t ON t.id=d.task_uuid JOIN requests q ON q.id=d.request_id
          WHERE q.id=? OR q.conversation_id=?`).all(message, message).map(row => String(row.external_id));
        for (const id of unique([...this.messageTasks(message), ...next.messageTasks(message), ...linked])) need(id, 'dialogues', 'requestedByUser');
      }
      for (const [id, wanted] of reads) {
        yield;
        const before = this.bundles.get(id);
        const task = wanted.has('task') || !before ? readProjectionTask(db, id, reloadTasks.has(id) ? undefined : before?.task,
          { log: logs.has(id), values: values.has(id) }, this.root) : before.task;
        if (wanted.has('task') && (before?.task.meta.kind === 'project' || task?.meta.kind === 'project'))
          projectFacts ||= !isDeepStrictEqual(before?.task, task);
        if (!task) { yield* next.setBundleSteps(id, undefined); next.schemas = next.schemas.delete(id);
          for (const run of this.values('runsByTask', id)) yield* next.setRunSteps(run, undefined);
          continue; }
        if (!before) {
          parts.forEach(part => wanted.add(part)); projectFacts ||= task.meta.kind === 'project';
          for (const row of db.prepare('SELECT id FROM runs WHERE task_id=? ORDER BY id').all(id)) {
            const run = asRunId(String(row.id)); if (!next.runs.has(run)) yield* next.setRunSteps(run, next.readRunFact(db, store, run));
          }
          for (const row of db.prepare('SELECT input_id FROM run_inputs i JOIN run_attempts a USING(attempt_id) JOIN runs r ON r.id=a.run_no WHERE r.task_id=?').all(id)) inputIds.add(String(row.input_id));
        }
        const requestIds = new Set(keys.filter(key => key.kind === 'request').map(key => key.id));
        for (const run of changedRuns) for (const row of [this.runs.get(run), next.runs.get(run)]) if (row) requestIds.add(row.record.requestId);
        const returnIds = keys.filter(key => ['return', 'delivery', 'resolution'].includes(key.kind))
          .map(key => key.kind === 'delivery' ? key.id.slice(0, key.id.indexOf(':')) : key.id);
        const bundle = yield* next.readBundleSteps(db, store, { ...(before ?? freshBundle(task)), task }, wanted,
          before && !reloadTasks.has(id) ? { requests: [...requestIds], returns: returnIds } : undefined);
        yield* next.setBundleSteps(id, bundle);
        if (task.meta.kind === 'project' && !before) next.readSchema(db, id);
      }
      if (inputIds.size) yield* next.readInputSteps(db, [...inputIds]);
      if (projectFacts) {
        next.fields = keys.some(key => key.kind === 'field_def') ? fieldCatalog([...next.definitions.values()]) : this.fields;
        next.refreshProjectFacts();
        yield;
        for (const key of keys) if (key.kind === 'field_def') for (const id of next.fieldUsers(key.id)) owners.add(id);
      }
      return { keys, before: this, after: next, next, owners };
    } finally { store.close(); }
  }

  taskIds(): Iterable<TaskId> { return this.bundles.keys(); }
  bundle(task: TaskId): TaskBundle | undefined { return this.bundles.get(task); }
  run(id: RunId): WorkspaceRunRecord | undefined {
    return this.runs.get(id)?.view;
  }
  /** Execution identity for outside observations, including coordinator Runs that have no Task bundle. */
  runtimeRun(id: RunId): RuntimeRunRecord | undefined { return this.runs.get(id)?.record; }
  /** Only coordinator Runs whose activity or failed stdout needs observation; no Task Runs are traversed. */
  coordinatorFileRuns(): Iterable<WatchedRun> { return this.coordinatorFileIndex.values(); }
  parent(task: TaskId): TaskId | null { return this.bundle(task)?.task.meta.parentId ?? null; }
  children(task: TaskId): readonly TaskId[] { return this.values('children', task); }
  ancestors(task: TaskId): readonly TaskId[] {
    const found: TaskId[] = [], seen = new Set([task]);
    let parent = this.parent(task);
    while (parent !== null) {
      if (seen.has(parent) || found.length >= 31 || !this.bundle(parent)) throw new Error(`Invalid Task ancestry: ${task}`);
      seen.add(parent); found.push(parent); parent = this.parent(parent);
    }
    return found;
  }
  *subtree(task: TaskId): Iterable<TaskId> {
    if (!this.bundle(task)) return;
    const pending = [task], seen = new Set<string>();
    while (pending.length) { const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id); yield id; pending.push(...this.children(id)); }
  }
  projectOf(task: TaskId): TaskId {
    for (const id of [task, ...this.ancestors(task)]) if (this.bundle(id)?.task.meta.kind === 'project') return id;
    throw new Error(`Task has no project: ${task}`);
  }
  scopes(task: TaskId): readonly string[] {
    const project = this.projectOf(task);
    return !this.projectShelf.listed.has(project) ? ['root'] : ['root', ...[project, ...this.ancestors(project)].reverse()
      .filter(id => this.bundle(id)?.task.meta.kind === 'project' && this.projectShelf.listed.has(id))];
  }
  logOwner(log: string): TaskId | undefined { return this.values('logOwner', log)[0]; }
  runOwner(run: RunId): TaskId | null { return this.runs.get(run)?.record.task ?? null; }
  requestOwner(request: string): TaskId | null { return this.values('requestOwner', request)[0] ?? null; }
  placementOwner(placement: string): TaskId | undefined { return this.values('placementOwner', placement)[0]; }
  returnOwner(id: string): TaskId | undefined { return this.values('returnOwner', id)[0]; }
  dependents(task: TaskId): readonly TaskId[] { return this.values('dependents', task); }
  runByRequest(request: string): RunId | undefined {
    return (this.values('runByRequest', request) as readonly RunId[]).reduce<RunId | undefined>((last, id) =>
      last === undefined || runNumber(id) > runNumber(last) ? id : last, undefined);
  }
  runReferrers(run: RunId): readonly RunId[] { return this.values('runReferrers', run) as readonly RunId[]; }
  closedRequest(request: string): boolean { return this.values('closedRequests', request).length > 0; }
  /** The stored identities let a bounded audit remove a missing closing return without scanning other bundles. */
  closingReturnIds(request: string): readonly string[] { return this.values('closedRequests', request); }
  private request(id: string) {
    const owner = this.requestOwner(id), requests = owner ? this.bundle(owner)?.requests : undefined;
    return requests ? requestIn(requests, id) : undefined;
  }
  private sender(request: StoredRequest | undefined): TaskId | null {
    if (!request || isSeatContinuation(request.purpose) || !hasRequesterSeat(request)) return null;
    const run = this.runByRequest(request.id);
    const caller = run && this.runs.get(run)?.record.caller?.run;
    return caller ? this.runOwner(caller) : null;
  }
  sendersTo(task: TaskId): readonly TaskId[] {
    return unique(this.values('requestsByReceiver', task).flatMap(id => {
      const sender = this.sender(this.request(id)); return sender && !this.closedRequest(id) ? [sender] : [];
    }));
  }
  targetsFromAll(task: TaskId): readonly TaskId[] {
    return this.values('requesterTasks', task);
  }
  sentRequests(task: TaskId): readonly StoredRequest[] { return this.bundle(task)?.unclosedSent ?? []; }
  returnsByCauseTask(task: TaskId): readonly TaskId[] {
    return unique(this.values('returnsByCauseTask', task).flatMap(id => this.returnOwner(id) ?? []));
  }
  deliveriesByWakeRequest(request: string): readonly string[] { return this.values('deliveriesByWakeRequest', request); }
  questionsByDestination(task: TaskId): readonly TaskId[] { return this.values('questionsByDestination', task); }
  dialogueTasks(request: string): readonly TaskId[] { return this.values('dialogueTasks', request); }
  joinedMessages(run: RunId): readonly string[] {
    const trial = this.runs.get(run)?.record;
    if (trial?.role !== 'coordinator' || trial.attempt === undefined) return this.values('joinedMessages', run);
    return unique(this.values('runByRequest', trial.requestId).filter(id => runNumber(id as RunId) <= runNumber(run))
      .flatMap(id => this.values('joinedMessages', id)));
  }
  messageTasks(message: string): readonly TaskId[] { return this.values('messageTasks', message); }
  placementWritesTo(placement: string): readonly TaskId[] {
    return this.values('placementWritesTo', placement).filter(task => task !== this.placementOwner(placement));
  }
  historyReferrers(task: TaskId): readonly TaskId[] {
    const own = this.values('historyReferrers', task);
    const authors = (this.bundle(task)?.placements ?? []).flatMap(placement => this.placementWritesTo(placement.id));
    const caused = this.values('returnsByCauseTask', task)
      .flatMap(id => { const owner = this.returnOwner(id); return owner ? this.bundle(owner)?.returns.filter(value => value.id === id) ?? [] : []; });
    return historyReferrersOf(this, task, [...own, ...authors], caused, run => this.values('runWritesTo', run));
  }
  schemaUsers(project: TaskId): readonly TaskId[] { return this.values('schemaUsers', project); }
  fieldUsers(field: string): readonly TaskId[] { return this.values('fieldUsers', field); }
  inputsByAttempt(attempt: string): readonly string[] { return this.values('inputsByAttempt', attempt); }
  inputsByInstruction(run: RunId): readonly string[] { return this.values('inputsByInstruction', run); }
  fileOwner(folder: string): TaskId | undefined {
    const id = folder.startsWith('tasks/') ? folder.slice(6) : folder;
    return this.bundle(id) ? id : undefined;
  }
  coordinatorRun(message: string): CoordinatorRunFact | undefined {
    const id = this.runByRequest(message), run = id ? this.runs.get(id)?.record : undefined;
    if (run?.role !== 'coordinator') return undefined;
    const actual = carrierOf(run, key => this.runs.get(key)?.record);
    if (!actual) return undefined;
    return { agent: actual.agent, modelId: actual.launch.values.model?.trim() || null, effort: actual.launch.values.effort?.trim() || null };
  }
  catalog(): FieldCatalog { return this.fields; }
  schemaOf(project: TaskId): ControlTreeDTO['projectSchemas'][string] {
    for (const id of [project, ...this.ancestors(project)]) {
      const fields = this.schemas.get(id); if (fields) return { fields: [...fields], from: id };
    }
    return { fields: [...DEFAULT_SCHEMA], from: null };
  }
  seatSettings(): Settings { return this.config.settings; }
  shelf(): ProjectShelf { return this.projectShelf; }
  environment(): Environment {
    const error = this.runErrors.values().next().value;
    return error ? { ...this.config.environment, writable: false, errors: [...this.config.environment.errors, error] } : this.config.environment;
  }
}
/** Construct an unloaded reader; load/advance return new instances and leave every published reader untouched. */
export function emptyWorkspaceRecords(root: string, observations: WorkspaceObservations = {}): DatabaseWorkspaceRecords {
  return new DatabaseWorkspaceRecords(root, 0 as ProjectionVersion, observations);
}

