/**
 * The reads the Run store offers, at the connection's current read point: their SQL, their row decoding and the tables
 * they are offered from. Connections, transactions and writes (with the rows they read to decide) are store.ts's.
 *
 * Scope rule: a list read takes the project Task (its ID) whose own rows it reads (`PROJECT_RUNS_SQL`,
 * `PROJECT_REQUESTS_SQL`); without one it reads the whole workspace, which only maintenance and the
 * screen's whole read do. A read by Run, Request, placement, return or Task ID takes no project. `forSettle` and
 * `read` are always the whole workspace: the parallel limit is shared by every project.
 *
 * Task side and execution: the Task-side reads (`get`, `all`, `snapshot`, `runsOfTask`, `requests`, `getRequest`…)
 * return Task Runs (`RunRecord`) and Requests to Tasks only. Only the execution layer's reads (`read`,
 * `readUnfinished`, `forSettle`, `runtimeGet`, `getText`) return every Run (`RuntimeRunRecord`), the coordinator's too;
 * `run list` reads `readUnfinished` as well, narrowed to a project or Tasks for any caller but a person or coordinator.
 */
import { parseReturnHold } from './return-hold.js';
import type { ProblemReason } from '@alpacawork/core';
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE, deepFreeze, storedJsonDecoder } from '@alpacawork/core';
import { KeptTable, keptOf, controlRoot } from '@alpacawork/db';
import { RUN_ENDED_STATES, RUN_STATE, coordinatorRunRecordSchema, runNumber, runRecordSchema, runResultStateSchema, runtimeRunRecordSchema,
  type CoordinatorRunRecord, type RunResultState, type ReadRunRecord, type RunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { runIdSchema, type RunId } from '@alpacawork/contract/fields';
import { AWAITING_RECEIPT_STATES, UNSETTLED_INPUT_STATES } from '@alpacawork/contract/run-protocol';
import { DELIVERY_STATE, actorSchema, deliveryStateSchema, requestModeSchema, requestPurposeSchema,
  type DeliveryState, type RequestMode, type RequestPurpose } from '@alpacawork/contract/control';
import { isSeatContinuation, RESOLUTION_REASONS, RETURN_OUTCOMES, type ReturnOutcome } from '@alpacawork/contract';
import type { TaskActor } from '@alpacawork/raw';
import { parseRecord, runsUnavailable, storageOperation } from './record-codec.js';

// Decision reads name both state sets as IN lists for the state index.
const sqlList = (states: readonly string[]) => states.map(state => `'${state}'`).join(', ');
/** The one SQL form of `isUnfinished`. */
export const UNFINISHED_SQL = sqlList(Object.values(RUN_STATE).filter(state => !(RUN_ENDED_STATES as readonly string[]).includes(state)));
export const UNSETTLED_INPUTS_SQL = sqlList(UNSETTLED_INPUT_STATES);
export const AWAITING_RECEIPT_SQL = sqlList(AWAITING_RECEIPT_STATES);
/** The one SQL form of a Task's Run (`RunRecord`): every Task-side Run read leaves the coordinator's Runs out by it. */
const TASK_RUN_SQL = 'task_id IS NOT NULL';
/** The one SQL form of a Request to a Task: every Task-side Request read leaves the coordinator conversation's out by it. */
const TASK_REQUEST_SQL = 'task_id IS NOT NULL';
/**
 * A project's own Tasks: those whose nearest project is the project Task whose ID (T42) is the one parameter
 * (index tasks_project). A nested project's Tasks are that project's, not its parent's.
 */
const PROJECT_TASKS = 'FROM tasks WHERE project_task_id = (SELECT id FROM tasks WHERE external_id = ?)';
/** The one SQL form of a project's Runs. */
const PROJECT_RUNS_SQL = `task_id IN (SELECT external_id ${PROJECT_TASKS})`;
/** The one SQL form of a project's rows that name their Task by its ID: placements, Requests and wait cycles. */
export const PROJECT_REQUESTS_SQL = `task_id IN (SELECT external_id ${PROJECT_TASKS})`;
/** A project's returns, which name their Task as the seat they go to (`returns r`). */
const PROJECT_RETURNS_SQL = `r.to_task_id IN (SELECT external_id ${PROJECT_TASKS})`;
/** A project's Task logs (`task_log l`), which name their Task by its row. */
const PROJECT_LOGS_SQL = `l.task_id IN (SELECT id ${PROJECT_TASKS})`;
/** A list read's condition and its parameter: one project's rows when it names one, otherwise the whole workspace's. */
function scoped(fragment: string, project: string | undefined, taskIds?: readonly string[],
  column = 'task_id', taskRows = false): [condition: string, parameters: string[]] {
  const condition = project === undefined ? 'TRUE' : fragment, parameters = project === undefined ? [] : [project];
  if (taskIds === undefined) return [condition, parameters];
  const ids = 'SELECT value FROM json_each(?)';
  return [`${condition} AND ${column} IN (${taskRows ? `SELECT id FROM tasks WHERE external_id IN (${ids})` : ids})`,
    [...parameters, JSON.stringify(taskIds)]];
}
/** The Run ID of a `runs` row's number, as the row's readers name it. */
const runIdOf = (number: unknown): RunId => runIdSchema.parse(`R${number}`);
/** The SQL form of `runNumber`: the row number of a column holding a Run ID. */
const runNumberSql = (column: string) => `CAST(substr(${column},2) AS INTEGER)`;

/**
 * `runId` is the latest trial of this Request; it is never written. `waitCycleId` is the wait
 * cycle of the seat that sent a placement's Request (explicit placement author), and null for a return continuation or a user request.
 */
export interface StoredRequest {
  id: string; taskId: string; placementId: string; placementRevision: number; taskHash: string;
  waitCycleId: string | null;
  answersQuestion?: string | null;
  headRunId: RunId | null; aboutRunId: RunId | null; mode: RequestMode; body: string; purpose: RequestPurpose;
  author: TaskActor; submittedAt: string; deliveryState: DeliveryState; runId: RunId | null;
}
/** Who holds a conversation session: a Task's Run, the coordinator conversation (its latest Run with it), or nobody. */
type SessionOwner = 'task_run' | { coordinator: string; runId: RunId } | null;
export interface StoredAgent { id: string; createdAt: string }
export function parseStoredAgent(row: Record<string, unknown>): StoredAgent {
  return { id: String(row.id), createdAt: String(row.created_at) };
}
/**
 * A single SQLite read point for the control tree; no large prompt or result text. With the Tasks, its facts are all a
 * ball and a seat's wake are derived from.
 */
export interface RunSnapshot {
  records: RunRecord[] | null; runError: Problem | null;
  agents: StoredAgent[]; placements: StoredPlacement[];
  requests: StoredRequest[]; returns: StoredReturn[]; waitCycles: StoredWaitCycle[];
  headRunIds: Map<string, RunId | null>;
  resultStates: Map<RunId, RunResultState>;
  /** Each answered or withdrawn question's first close (task_log_question): the asked log's ID → the closing log's. */
  questionClosures: Map<string, string>;
  /** By placement, the Runs fed as input to the placement's working Run whose receipt is unknown (run_inputs uncertain). */
  uncertainInputs: Map<string, Set<RunId>>;
  /**
   * The Runs whose input is closed (execution-control takesInput's `closed`): their attempt has a diagnostic, or an
   * input whose receipt is not settled.
   */
  inputClosed: Set<RunId>;
}
/** Pure Run readers may share immutable records; the other facts still belong to this snapshot. */
export type ReadRunSnapshot = Omit<RunSnapshot, 'records'> & { records: readonly ReadRunRecord[] | null };
/** A seat's wait cycle. `closedAt` records its Requests' closure, independently of delivery; open Requests are derived from their facts. */
interface StoredWaitCycle { id: string; taskId: string; openedAt: string; closedAt: string | null }
export interface StoredPlacement { id: string; taskId: string; agentId: string; profileKey: string;
  responsible: boolean; active: boolean; revision: number; startedAt: string; endedAt: string | null }
/** The single row reader for both Run decisions and placement commands. */
export function parseStoredPlacement(row: Record<string, unknown>): StoredPlacement {
  const endedAt = row.ended_at === null ? null : String(row.ended_at);
  return { id: String(row.id), taskId: String(row.task_id), agentId: String(row.agent_id),
    profileKey: String(row.profile_key), responsible: Boolean(row.responsible),
    active: endedAt === null, revision: Number(row.revision), startedAt: String(row.started_at), endedAt };
}
export interface ReturnDelivery {
  wakeRequestId: string; reservedAt: string; receivedAt: string | null; consumedAt: string | null;
  releasedAt: string | null; releaseReason: string | null;
}
/**
 * What goes to a seat: the one return that closes a Request (`requestId`; a worker's by the Run whose end closed it, a
 * child's by the log that closed it), or a notice with no Request, caused by `causeLogId`. `resolution` is why an
 * undelivered return no longer waits to be delivered.
 */
export interface StoredReturn {
  id: string; requestId: string | null; outcome: ReturnOutcome; toTaskId: string;
  boundaryRunId: RunId | null; causeLogId: string | null; holdReason: string | null; holdProblemReason: ProblemReason | null; createdAt: string;
  deliveries: ReturnDelivery[];
  resolution: { at: string; reason: (typeof RESOLUTION_REASONS)[number] } | null;
}
type StoredRunText = { record: RuntimeRunRecord; prompt: string | null; result: string | null;
  resultState: RunResultState };
type StoredRunFile = { record: RuntimeRunRecord; text: string | null; state: RunResultState };

// Every Request read carries its latest trial. A Request is the only row in FROM, so
// a condition's `task_id` and `conversation_id` are the Request's.
/** Shared SQL for a request's current Run rather than all its historical trials. */
export const currentRequestRun = (request: string) => `SELECT id FROM runs WHERE request_id = ${request} ORDER BY attempt DESC LIMIT 1`;
const REQUEST_IMMUTABLE_COLUMNS = `q.id, q.task_id, q.placement_id, q.placement_revision, q.task_hash,
  q.wait_cycle_id, q.answers_question, q.head_run_id, q.about_run_id, q.mode, q.body, q.purpose, q.author, q.submitted_at`;
const REQUEST_CURRENT_COLUMNS = `CAST(q.rowid AS TEXT) AS request_row, q.delivery_state,
  (${currentRequestRun('q.id')}) AS run_number`;
const REQUEST_SELECT = `SELECT ${REQUEST_IMMUTABLE_COLUMNS}, ${REQUEST_CURRENT_COLUMNS} FROM requests q`;
const REQUEST_CURRENT_SELECT = `SELECT q.id,q.placement_revision, ${REQUEST_CURRENT_COLUMNS} FROM requests q`;
/** A conversation is a placement's (`placement_id`) or the coordinator conversation (`conversation_id`). */
type ConversationKey = 'placement_id' | 'conversation_id';
const conversationWhere = (key: ConversationKey) => `r.${key} = ? AND q.delivery_state IS NOT ?`;
const nullable = (value: unknown) => value === null ? null : String(value);
/** A stored value of one of the contract's value sets, which the control database's CHECK holds it to as well. */
function storedValue<const T extends readonly string[]>(values: T, value: unknown): T[number] {
  const found = values.find(item => item === value);
  if (found === undefined) throw new Error(`Unknown stored value ${String(value)}`);
  return found;
}
type ImmutableRequest = Omit<StoredRequest, 'deliveryState' | 'runId'>;
/** A Request's author is one of few texts, read again with every Request. */
const storedAuthor = storedJsonDecoder(actorSchema);
function immutableRequest(row: Record<string, unknown>): ImmutableRequest {
  return { id: String(row.id), taskId: String(row.task_id), placementId: String(row.placement_id),
    placementRevision: Number(row.placement_revision), taskHash: String(row.task_hash),
    waitCycleId: nullable(row.wait_cycle_id), answersQuestion: nullable(row.answers_question),
    headRunId: row.head_run_id === null ? null : runIdSchema.parse(row.head_run_id),
    aboutRunId: row.about_run_id === null ? null : runIdSchema.parse(row.about_run_id),
    mode: requestModeSchema.parse(row.mode), body: String(row.body), purpose: requestPurposeSchema.parse(row.purpose),
    author: storedAuthor(String(row.author), String(row.author)), submittedAt: String(row.submitted_at) };
}
function invalidRequest(row: Record<string, unknown>, cause: unknown): Error {
  return runsUnavailable(new Error(`Invalid stored request ${String(row.id)}`, { cause }));
}
function parseRequest(row: Record<string, unknown>, immutable?: ImmutableRequest): StoredRequest {
  try {
    return { ...(immutable ?? immutableRequest(row)),
      deliveryState: deliveryStateSchema.parse(row.delivery_state),
      runId: row.run_number === null ? null : runIdOf(row.run_number) };
  } catch (cause) {
    throw invalidRequest(row, cause);
  }
}
/** A Task-side read's row, selected by `TASK_RUN_SQL` or by a Task or placement. */
export const parseRow = (row: Record<string, unknown>): RunRecord => parseRecord(runRecordSchema, row);
export const parseRuntimeRow = (row: Record<string, unknown>): RuntimeRunRecord => parseRecord(runtimeRunRecordSchema, row);
const parseCoordinatorRow = (row: Record<string, unknown>): CoordinatorRunRecord => parseRecord(coordinatorRunRecordSchema, row);

/**
 * A Run's record for a decision or projection that only reads it. Both consumers bind the shared value to the exact
 * text at their SQLite read point, including older snapshots and a writer's rows that may roll back.
 */
const keptRecords = () => new Map<unknown, { text: unknown; record: RuntimeRunRecord }>();
function decidingRuntimeRecord(root: string): (row: Record<string, unknown>) => RuntimeRunRecord {
  const kept = keptOf(root, 'run_records', keptRecords);
  if (!kept) return parseRuntimeRow;
  return row => {
    const known = kept.get(row.id);
    if (known?.text === row.record) return known!.record;
    const record = deepFreeze(parseRuntimeRow(row));
    kept.set(row.id, { text: row.record, record });
    return record;
  };
}
function decidingRecord(root: string): (row: Record<string, unknown>) => RunRecord {
  const read = decidingRuntimeRecord(root);
  return row => {
    const record = read(row);
    // The task-only boundary retains its schema error for a coordinator row supplied by an invalid caller.
    return record.role === 'coordinator' ? parseRow(row) : record;
  };
}
/** One project's Task Runs with their result states, or the whole workspace's: every list read of Task Runs. */
function taskRunRows(db: DatabaseSync, project?: string, taskIds?: readonly string[]): Record<string, unknown>[] {
  const [condition, parameters] = scoped(PROJECT_RUNS_SQL, project, taskIds);
  return storageOperation(() => db.prepare(`SELECT id, record, result_state FROM runs
    WHERE ${TASK_RUN_SQL} AND ${condition}`).all(...parameters)
    // id is an INTEGER PRIMARY KEY; SQLite-to-JS conversion still rejects unsafe integers before this sort.
    // Order the current rows without spilling their large record text to SQLite's temporary sorter.
    .sort((a, b) => Number(a.id) - Number(b.id)));
}
function runRow(db: DatabaseSync, id: RunId, condition = 'TRUE'): Record<string, unknown> | undefined {
  const n = runNumber(runIdSchema.parse(id));
  return storageOperation(() => db.prepare(`SELECT id, record FROM runs WHERE id = ? AND ${condition}`).get(n));
}
/** A Request's row until a read asks for it (one bad row stays its reader's), then all of it but what may change. */
type KeptRequest = { row: Record<string, unknown>; parsed?: ImmutableRequest };
type UserRequest = { id: string; taskId: string; at: string; row: number };
type RequestPrefix = { rows: Map<string, KeptRequest>; users: Map<string, { latest: UserRequest; all: UserRequest[] }> };
// Match automaticIndex's locale timestamp order, with the original SQLite order breaking locale ties.
const afterUser = (a: UserRequest, b: UserRequest) => a.at.localeCompare(b.at) ||
  Buffer.compare(Buffer.from(a.at), Buffer.from(b.at)) || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
const userRequest = (row: Record<string, unknown>): UserRequest | undefined =>
  row.task_id !== null && (row.author_kind === 'human' || row.author_kind === 'main')
    ? { id: String(row.id), taskId: String(row.task_id), at: String(row.submitted_at), row: Number(row.request_row) } : undefined;
const keptRequests = () => new KeptTable<RequestPrefix>('requests', () => ({ rows: new Map(), users: new Map() }), (kept, rows) => {
  for (const row of rows) {
    kept.rows.set(String(row.request_row), { row });
    const user = userRequest(row);
    if (!user) continue;
    const group = kept.users.get(user.taskId);
    if (!group) kept.users.set(user.taskId, { latest: user, all: [user] });
    else { group.all.push(user); if (afterUser(user, group.latest) > 0) group.latest = user; }
  }
});
/** Immutable Requests and their per-Task user heads have one prefix owner and the same rollback/replacement boundary. */
function requestPrefix(db: DatabaseSync, root: string) {
  const table = keptOf(root || controlRoot(db) || '', 'requests', keptRequests);
  const read = storageOperation(() => table?.at(db, through =>
    db.prepare(`SELECT ${REQUEST_IMMUTABLE_COLUMNS.replace('q.placement_revision', 'CAST(q.placement_revision AS TEXT) AS placement_revision')},
      CAST(q.rowid AS TEXT) AS request_row, CASE WHEN json_valid(q.author) THEN json_extract(q.author,'$.kind') END AS author_kind
      FROM requests q WHERE q.rowid > ? ORDER BY q.rowid`).all(through)));
  return { table, read };
}
/** Only current delivery eligibility is mutable: a normal read checks one immutable user head per Task. */
export function latestUserRequests(db: DatabaseSync, root: string, seats: readonly string[]): Map<string, { id: string; at: string }> {
  const { read } = requestPrefix(db, root), latest = new Map<string, { id: string; at: string }>();
  const choose = (rows: readonly Record<string, unknown>[]) => {
    for (const row of rows) {
      const task = String(row.task_id), at = String(row.submitted_at), prior = latest.get(task);
      if (!prior || at.localeCompare(prior.at) >= 0) latest.set(task, { id: String(row.id), at });
    }
  };
  const eligible = (ids: readonly string[]) => db.prepare(`SELECT id,task_id,submitted_at FROM requests
    WHERE id IN (SELECT value FROM json_each(?)) AND delivery_state NOT IN ('aborted','recorded_unconfirmed')
    ORDER BY submitted_at,id`).all(JSON.stringify(ids));
  if (!read) {
    choose(db.prepare(`SELECT id,task_id,submitted_at FROM requests
      WHERE task_id IN (SELECT value FROM json_each(?)) AND json_extract(author,'$.kind') IN ('human','main')
        AND delivery_state NOT IN ('aborted','recorded_unconfirmed') ORDER BY submitted_at,id`).all(JSON.stringify(seats)));
    return latest;
  }
  const heads = new Map<string, UserRequest>();
  for (const seat of seats) {
    const head = read.kept.users.get(seat)?.latest;
    if (head && head.row <= read.through) heads.set(seat, head);
  }
  const own = read.own.flatMap(row => { const user = userRequest(row); return user ? [user] : []; });
  for (const user of own) if (seats.includes(user.taskId)) {
    const prior = heads.get(user.taskId);
    if (!prior || afterUser(user, prior) > 0) heads.set(user.taskId, user);
  }
  choose(eligible([...heads.values()].map(user => user.id)));
  // Only an ineligible head or an older snapshot needs earlier user candidates; continuations never join this list.
  const missing = seats.filter(seat => !latest.has(seat));
  const candidates = missing.flatMap(seat => (read.kept.users.get(seat)?.all ?? []).filter(user => user.row <= read.through));
  candidates.push(...own.filter(user => missing.includes(user.taskId)));
  if (candidates.length) choose(eligible(candidates.map(user => user.id)));
  return latest;
}

/** Immutable admission links and permanent closes. Mutable Request state is always read by the caller. */
export type AdmissionFacts = { sent: Map<string, string[]>; callers: Map<string, Set<string>> };
class SentLedger {
  private readonly links = new KeptTable<Record<string, unknown>[]>('runs', () => [], (kept, rows) => { for (const row of rows) kept.push(row); });
  private readonly closes = new KeptTable<Record<string, unknown>[]>('returns', () => [], (kept, rows) => { for (const row of rows) kept.push(row); });
  private linkRows?: Record<string, unknown>[];
  private closeRows?: Record<string, unknown>[];
  private linked = 0;
  private closed = 0;
  private readonly byRun = new Map<string, Record<string, unknown>>();
  private readonly byRequest = new Map<string, Record<string, unknown>>();
  private readonly bySeat = new Map<string, Set<string>>();
  private readonly closedRequests = new Map<string, number>();
  private readonly callerFirst = new Map<string, Map<string, number>>();
  private readonly waiting = new Map<string, Record<string, unknown>[]>();
  at(db: DatabaseSync, seats: readonly string[]): AdmissionFacts | undefined {
    const links = this.links.at(db, through => db.prepare('SELECT r.rowid AS ledger_row,r.id,r.task_id,r.caller_run,r.request_id,q.purpose FROM runs r JOIN requests q ON q.id=r.request_id WHERE r.rowid>? ORDER BY r.rowid').all(through));
    const closes = this.closes.at(db, through => db.prepare('SELECT rowid AS ledger_row,id,request_id,to_task_id,cause_log_id,outcome FROM returns WHERE rowid>? ORDER BY rowid').all(through));
    if (!links || !closes) return undefined;
    if (links.kept !== this.linkRows || closes.kept !== this.closeRows) {
      this.linkRows = links.kept; this.closeRows = closes.kept; this.linked = this.closed = 0;
      this.byRun.clear(); this.byRequest.clear(); this.bySeat.clear(); this.closedRequests.clear();
      this.callerFirst.clear(); this.waiting.clear();
    }
    const first = (index: Map<string, Map<string, number>>, owner: string, id: string, row: number) => {
      let group = index.get(owner);
      if (!group) index.set(owner, group = new Map());
      if (!group.has(id)) group.set(id, row);
    };
    const add = (row: Record<string, unknown>) => {
      if (row.caller_run === null) return;
      const caller = this.byRun.get(String(row.caller_run));
      if (!caller) { const waiting = this.waiting.get(String(row.caller_run)) ?? []; waiting.push(row); this.waiting.set(String(row.caller_run), waiting); return; }
      if (caller.task_id === null) return;
      if (row.task_id !== null) first(this.callerFirst, String(row.task_id), String(caller.task_id), Math.max(Number(row.ledger_row), Number(caller.ledger_row)));
      if (isSeatContinuation(row.purpose as RequestPurpose) || this.closedRequests.has(String(row.request_id))) return;
      const seat = String(caller.task_id), group = this.bySeat.get(seat) ?? new Set<string>();
      group.add(String(row.request_id)); this.bySeat.set(seat, group);
    };
    for (; this.linked < links.kept.length; this.linked++) {
      const row = links.kept[this.linked]!, id = `R${row.id}`;
      this.byRun.set(id, row); this.byRequest.set(String(row.request_id), row); add(row);
      for (const child of this.waiting.get(id) ?? []) add(child);
      this.waiting.delete(id);
    }
    for (; this.closed < closes.kept.length; this.closed++) {
      const row = closes.kept[this.closed]!;
      if (row.request_id === null) continue;
      const id = String(row.request_id); this.closedRequests.set(id, Number(row.ledger_row));
      const run = this.byRequest.get(id), caller = run && this.byRun.get(String(run.caller_run));
      if (caller?.task_id != null) this.bySeat.get(String(caller.task_id))?.delete(id);
    }
    const sent = new Map(seats.map(seat => [seat, new Set(this.bySeat.get(seat))]));
    const ownRuns = new Map(links.own.map(row => [`R${row.id}`, row]));
    const runAt = (id: string) => {
      const row = ownRuns.get(id) ?? this.byRun.get(id);
      return row && Number(row.ledger_row) <= links.through ? row : undefined;
    };
    const include = (row: Record<string, unknown>) => {
      if (Number(row.ledger_row) > links.through || row.caller_run === null || isSeatContinuation(row.purpose as RequestPurpose)) return;
      const caller = runAt(String(row.caller_run));
      if (caller?.task_id == null || (this.closedRequests.get(String(row.request_id)) ?? Infinity) <= closes.through) return;
      sent.get(String(caller.task_id))?.add(String(row.request_id));
    };
    // An older snapshot reverses only the newer suffix; it never reselects all historical Requests.
    let low = 0, high = closes.kept.length;
    while (low < high) { const mid = (low + high) >>> 1; if (Number(closes.kept[mid]!.ledger_row) <= closes.through) low = mid + 1; else high = mid; }
    for (let index = low; index < closes.kept.length; index++) {
      const row = this.byRequest.get(String(closes.kept[index]!.request_id)); if (row) include(row);
    }
    for (const group of sent.values()) for (const id of group) {
      const row = this.byRequest.get(id); if (!row || Number(row.ledger_row) > links.through) group.delete(id);
    }
    for (const row of links.own) include(row);
    for (const row of closes.own) if (row.request_id !== null) for (const group of sent.values()) group.delete(String(row.request_id));
    const callers = new Map(seats.map(seat => [seat, new Set<string>()]));
    for (const seat of seats)
      for (const [id, at] of this.callerFirst.get(seat) ?? []) if (at <= links.through) callers.get(seat)!.add(id);
    for (const row of links.own) if (callers.has(String(row.task_id))) {
      const caller = runAt(String(row.caller_run)); if (caller?.task_id != null) callers.get(String(row.task_id))!.add(String(caller.task_id));
    }
    return { sent: new Map([...sent].map(([seat, ids]) => [seat, [...ids]])), callers };
  }
}
/** A single read of the shared links supplies both outgoing candidates and requester ownership. */
export function admissionFacts(db: DatabaseSync, root: string, seats: readonly string[]): AdmissionFacts {
  const kept = keptOf(root || controlRoot(db) || '', 'sent_ledger', () => new SentLedger())?.at(db, seats);
  if (kept) return kept;
  const callers = new Map(seats.map(seat => [seat, new Set<string>()]));
  for (const row of db.prepare(`SELECT DISTINCT r.task_id,caller.task_id AS caller FROM runs r
    JOIN runs caller ON caller.id=CAST(substr(r.caller_run,2) AS INTEGER)
    WHERE r.task_id IN (SELECT value FROM json_each(?)) AND caller.task_id IS NOT NULL`).all(JSON.stringify(seats)))
    callers.get(String(row.task_id))!.add(String(row.caller));
  return { sent: sentFromDatabase(db, seats), callers };
}
/** Historical caller ownership is immutable and independent of how many Requests have closed. */
export function requesterTaskIds(db: DatabaseSync, root: string, seats: readonly string[]): Set<string> {
  return new Set([...admissionFacts(db, root, seats).callers.values()].flatMap(ids => [...ids]));
}
/** Only undisposed causes cross a current routing boundary. Their owner is looked up once, by log ID. */
export function returnCauses(db: DatabaseSync, seats: readonly string[], questionsOnly = false): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const row of db.prepare(`SELECT DISTINCT l.task_id,r.cause_log_id FROM returns r JOIN task_log l ON l.id=r.cause_log_id
    WHERE r.to_task_id IN (SELECT value FROM json_each(?)) AND (?=0 OR r.outcome='question')
      AND NOT EXISTS (SELECT 1 FROM return_resolutions x WHERE x.return_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM return_deliveries d WHERE d.return_id=r.id AND d.consumed_at IS NOT NULL)`)
    .all(JSON.stringify(seats), questionsOnly ? 1 : 0)) {
    const owner = String(row.task_id), ids = owners.get(owner) ?? new Set<string>();
    ids.add(String(row.cause_log_id)); owners.set(owner, ids);
  }
  return owners;
}
/** Current causes retained for callers that need only their IDs. */
export function returnCauseIds(db: DatabaseSync, _root: string, seats: readonly string[], questionsOnly = false): Set<string> {
  return new Set([...returnCauses(db, seats, questionsOnly).values()].flatMap(ids => [...ids]));
}
/** Permanent Request closes, shared by routing's Run selection, facts and writer. */
export function closedRequestIds(db: DatabaseSync, ids: readonly string[]): Set<string> {
  return new Set(db.prepare('SELECT request_id FROM returns WHERE request_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)).map(row => String(row.request_id)));
}

function sentFromDatabase(db: DatabaseSync, seats: readonly string[]): Map<string, string[]> {
  const result = new Map(seats.map(seat => [seat, [] as string[]]));
  for (const row of db.prepare(`SELECT caller.task_id,r.request_id FROM runs caller JOIN runs r ON r.caller_run='R'||caller.id
    JOIN requests q ON q.id=r.request_id WHERE r.attempt=0 AND q.purpose<>'return_continuation' AND caller.task_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM returns closed WHERE closed.request_id=r.request_id) ORDER BY r.id`).all(JSON.stringify(seats)))
    result.get(String(row.task_id))!.push(String(row.request_id));
  return result;
}
/** Candidates only: continuation, delivery and closure policy remain the return rules' responsibility. */
export function unclosedSent(db: DatabaseSync, root: string, seats: readonly string[]): Map<string, string[]> {
  return admissionFacts(db, root, seats).sent;
}

/** Disposal is queried at the business boundary, including a historical Run end when requested. */
export function pendingReturns(db: DatabaseSync, seats: readonly string[], at?: string, includeIncoming = false): StoredReturn[] {
  return decodeReturns(db, db.prepare(`SELECT r.* FROM returns r WHERE (r.to_task_id IN (SELECT value FROM json_each(?))
      OR (? AND r.request_id IN (SELECT id FROM requests WHERE task_id IN (SELECT value FROM json_each(?)))))
    AND NOT EXISTS (SELECT 1 FROM return_resolutions x WHERE x.return_id=r.id AND (? IS NULL OR julianday(x.at)<=julianday(?)))
    AND (? IS NOT NULL OR NOT EXISTS (SELECT 1 FROM return_deliveries d WHERE d.return_id=r.id AND d.consumed_at IS NOT NULL))
    ORDER BY r.created_at,r.id`).all(JSON.stringify(seats), includeIncoming ? 1 : 0, JSON.stringify(seats), at ?? null, at ?? null, at ?? null));
}
/** All Request readers share immutable decoding, but select existence, delivery and Run identity at their read point. */
function requestReader(db: DatabaseSync, root: string) {
  // Unselected immutable rows stay lossless: only a selected row converts its revision to a JS number.
  const { table, read } = requestPrefix(db, root);
  if (table && read) {
    const own = new Map(read.own.map(row => [String(row.request_row), row]));
    return { kept: true, select: REQUEST_CURRENT_SELECT, decode: (row: Record<string, unknown>): StoredRequest => {
      const key = String(row.request_row), kept = read.kept.rows.get(key), ownRow = own.get(key);
      if (ownRow) return parseRequest({ ...ownRow, ...row });
      if (!kept) throw runsUnavailable(new Error(`Request row ${key} is neither kept nor read`));
      try {
        if (!kept.parsed) {
          kept.parsed = immutableRequest(kept.row);
          deepFreeze(kept.parsed.author);
        }
      } catch (cause) { table.forget(); throw invalidRequest(kept.row, cause); }
      return parseRequest(row, kept.parsed);
    } };
  }
  return { kept: false, select: REQUEST_SELECT, decode: (row: Record<string, unknown>) => parseRequest(row) };
}
function allRequests(db: DatabaseSync, root: string, project?: string, taskIds?: readonly string[]): StoredRequest[] {
  const [condition, parameters] = scoped(PROJECT_REQUESTS_SQL, project, taskIds);
  const read = requestReader(db, root);
  if (read.kept) {
    return storageOperation(() => db.prepare(`${read.select} WHERE ${TASK_REQUEST_SQL} AND ${condition}
      ORDER BY submitted_at, id`).all(...parameters)).map(read.decode);
  }
  // Sort only identities in SQLite, not the potentially large bodies. Both reads share the caller's transaction;
  // SQLite still owns BINARY ordering (including unusual text), and decoding sees the same first invalid Request.
  const rows = storageOperation(() => {
    const order = new Map(db.prepare(`SELECT CAST(rowid AS TEXT) AS request_row FROM requests WHERE ${TASK_REQUEST_SQL} AND ${condition}
      ORDER BY submitted_at, id`).all(...parameters).map((row, index) => [String(row.request_row), index]));
    return db.prepare(`${REQUEST_SELECT} WHERE ${TASK_REQUEST_SQL} AND ${condition}`).all(...parameters)
      .sort((a, b) => order.get(String(a.request_row))! - order.get(String(b.request_row))!);
  });
  return rows.map(read.decode);
}
/** A conversation's Runs except those whose Request was aborted. */
function conversationRows(db: DatabaseSync, key: ConversationKey, id: string): Record<string, unknown>[] {
  return storageOperation(() => db.prepare(`SELECT r.id, r.record FROM runs r
    LEFT JOIN requests q ON q.id = r.request_id
    WHERE ${conversationWhere(key)} ORDER BY r.id`)
    .all(id, DELIVERY_STATE.aborted));
}
/** A joined Run's work and reply belong to the Run it joined, so it is never the head. */
function conversationHeadRow(db: DatabaseSync, key: ConversationKey, id: string, exceptRequestId?: string): Record<string, unknown> | undefined {
  return storageOperation(() => db.prepare(`SELECT r.id, r.record FROM runs r
    LEFT JOIN requests q ON q.id = r.request_id
    WHERE ${conversationWhere(key)} AND r.state IS NOT 'joined' AND (? IS NULL OR r.request_id IS NOT ?)
    ORDER BY coalesce(CAST(substr(json_extract(r.record,'$.firstRunId'),2) AS INTEGER),r.id) DESC,r.attempt DESC LIMIT 1`).get(id, DELIVERY_STATE.aborted, exceptRequestId ?? null, exceptRequestId ?? null));
}
/**
 * One project's returns, or the whole workspace's; optional return or destination narrows the same read. Tasks narrow
 * it to their returns: those to them and those closing a Request to them, which go to the seat that sent it.
 */
function allReturns(db: DatabaseSync, project?: string, id?: string, taskId?: string, taskIds?: readonly string[]): StoredReturn[] {
  const [projectCondition, projectParameters] = scoped(PROJECT_RETURNS_SQL, project);
  let condition = projectCondition;
  const parameters = [...projectParameters];
  if (taskIds !== undefined) {
    const ids = 'SELECT value FROM json_each(?)';
    condition += ` AND (r.to_task_id IN (${ids}) OR r.request_id IN (SELECT id FROM requests WHERE task_id IN (${ids})))`;
    parameters.push(JSON.stringify(taskIds), JSON.stringify(taskIds));
  }
  if (id !== undefined) { condition += ' AND r.id=?'; parameters.push(id); }
  if (taskId !== undefined) { condition += ' AND r.to_task_id=?'; parameters.push(taskId); }
  return storageOperation(() => decodeReturns(db, db.prepare(`SELECT r.* FROM returns r WHERE ${condition}
    ORDER BY r.created_at,r.id`).all(...parameters)));
}
/** Related facts belong only to the selected returns, for full snapshots and bounded pages alike. */
function decodeReturns(db: DatabaseSync, rows: Record<string, unknown>[]): StoredReturn[] {
  if (!rows.length) return [];
  return storageOperation(() => {
    const ids = JSON.stringify(rows.map(row => String(row.id)));
    const deliveries = db.prepare(`SELECT * FROM return_deliveries WHERE return_id IN (SELECT value FROM json_each(?))
      ORDER BY reserved_at,wake_request_id`).all(ids);
    const resolutions = db.prepare(`SELECT * FROM return_resolutions WHERE return_id IN (SELECT value FROM json_each(?))`).all(ids);
    const deliveriesByReturn = new Map<string, StoredReturn['deliveries']>();
    for (const item of deliveries) {
      const key = String(item.return_id), group = deliveriesByReturn.get(key) ?? [];
      group.push({ wakeRequestId: String(item.wake_request_id), reservedAt: String(item.reserved_at),
        receivedAt: nullable(item.received_at), consumedAt: nullable(item.consumed_at), releasedAt: nullable(item.released_at),
        releaseReason: nullable(item.release_reason) });
      deliveriesByReturn.set(key, group);
    }
    const resolutionsByReturn = new Map(resolutions.map(item => [String(item.return_id), item]));
    return rows.map(row => {
      const r = resolutionsByReturn.get(String(row.id));
      const hold = row.hold_reason === null ? null : parseReturnHold(String(row.hold_reason));
      return { id: String(row.id), requestId: nullable(row.request_id), outcome: storedValue(RETURN_OUTCOMES, row.outcome),
        toTaskId: String(row.to_task_id), boundaryRunId: row.boundary_run_id === null ? null : runIdSchema.parse(row.boundary_run_id),
        causeLogId: nullable(row.cause_log_id), holdReason: hold?.code ?? null, holdProblemReason: hold?.reason ?? null, createdAt: String(row.created_at),
        deliveries: deliveriesByReturn.get(String(row.id)) ?? [],
        resolution: r ? { at: String(r.at), reason: storedValue(RESOLUTION_REASONS, r.reason) } : null };
    });
  });
}
/**
 * The inputs whose receipt is unknown of the working Runs `condition` selects (`r`: one project's, the whole
 * workspace's, or one placement's): by the placement of the working Run they were fed to (as a person's proxy
 * resolves them), the Runs fed.
 */
function uncertainInputs(db: DatabaseSync, condition: string, parameters: readonly string[]): Map<string, Set<RunId>> {
  const byPlacement = new Map<string, Set<RunId>>();
  for (const row of storageOperation(() => db.prepare(`SELECT r.placement_id, i.instruction_run_no FROM run_inputs i
    CROSS JOIN run_attempts a USING(attempt_id) CROSS JOIN runs r ON r.id = a.run_no
    WHERE i.state = 'uncertain' AND ${TASK_RUN_SQL} AND ${condition} ORDER BY i.instruction_run_no`).all(...parameters))) {
    const runs = byPlacement.get(String(row.placement_id)) ?? new Set<RunId>();
    runs.add(runIdOf(row.instruction_run_no));
    byPlacement.set(String(row.placement_id), runs);
  }
  return byPlacement;
}
/**
 * The Runs `condition` selects (`r`: one project's, the whole workspace's, or one Run) whose input is closed: their
 * attempt has a diagnostic, or an input whose receipt is not settled (taken, never sent, or resolved).
 */
function inputClosedRuns(db: DatabaseSync, condition: string, parameters: readonly (string | number)[]): Set<RunId> {
  return new Set(storageOperation(() => db.prepare(`SELECT a.run_no FROM run_attempts a JOIN runs r ON r.id = a.run_no
    WHERE (a.diagnostic IS NOT NULL OR EXISTS (SELECT 1 FROM run_inputs i WHERE i.attempt_id = a.attempt_id
      AND i.state IN (${UNSETTLED_INPUTS_SQL}))) AND ${TASK_RUN_SQL} AND ${condition}`).all(...parameters))
    .map(row => runIdOf(row.run_no)));
}
function decisionRecords(db: DatabaseSync, conversationId?: string): RuntimeRunRecord[] {
  // Include unfinished runs.
  // Close over children and ancestors so pure rules see every
  // relationship of an included record. Completed unrelated history stays out.
  // The next admission can resume a completed head. Include its ancestry for the conversation's "send now"
  // prediction too: an uncertain receipt must not disappear just because there is no queued successor yet.
  const head = conversationId === undefined ? undefined : conversationHeadRow(db, 'conversation_id', conversationId)?.id;
  // A screen needs its conversation and shared sessions, not the unfinished graph of every Task. Keep the
  // scheduler's unscoped seed unchanged, and close over the same relationships from the screen's own seed.
  const inConversation = conversationId !== undefined;
  return storageOperation(() => db.prepare(`
    WITH RECURSIVE ${inConversation ? `relevant(id) AS (
      SELECT id FROM runs WHERE conversation_id = ?
      UNION SELECT r.id FROM runs r WHERE r.session_id IN
        (SELECT session_id FROM runs WHERE conversation_id = ? AND session_id IS NOT NULL)
    ),` : ''} selected(id) AS (
      SELECT id FROM runs WHERE state IN (${UNFINISHED_SQL}) ${inConversation ? 'AND id IN (SELECT id FROM relevant)' : ''}
      UNION SELECT id FROM runs WHERE id = ?
      UNION SELECT r.id FROM runs r JOIN selected s
        ON r.caller_run = 'R' || s.id
      UNION SELECT p.id FROM runs c JOIN selected s ON c.id = s.id
        JOIN runs p ON p.id = ${runNumberSql('c.caller_run')}
      UNION SELECT p.id FROM runs c JOIN selected s ON c.id = s.id
        JOIN runs p ON p.id = ${runNumberSql('c.resumes_id')}
      UNION SELECT next.id FROM runs c JOIN selected s ON c.id=s.id
        JOIN runs next ON next.id=${runNumberSql("json_extract(c.record,'$.supersededBy')")}
    ) SELECT r.id, r.record FROM runs r JOIN selected s ON r.id = s.id
    ${inConversation ? 'WHERE r.id IN (SELECT id FROM relevant)' : ''}
    ORDER BY r.id
  `).all(...inConversation ? [conversationId, conversationId, head === undefined ? null : Number(head)] : [null]).map(parseRuntimeRow));
}

/** The reads a write transaction may make; the store offers those it needs outside one at a read point of their own. */
export function transactionReads(db: DatabaseSync, root: string) {
  return {
    get(id: RunId): RunRecord | null {
      const row = runRow(db, id, TASK_RUN_SQL);
      return row ? parseRow(row) : null;
    },
    /** Only the named Task Runs; batch callers never decode unrelated records. */
    getMany(ids: readonly RunId[]): Map<RunId, RunRecord> {
      if (!ids.length) return new Map();
      const numbers = [...new Set(ids.map(id => runNumber(runIdSchema.parse(id))))];
      const rows = storageOperation(() => db.prepare(`SELECT id, record FROM runs
        WHERE id IN (SELECT value FROM json_each(?)) AND ${TASK_RUN_SQL}`).all(JSON.stringify(numbers)));
      return new Map(rows.map(row => { const run = parseRow(row); return [run.id, run]; }));
    },
    /** Decision-only batch reads share exact decoded records during the server's kept lifetime. */
    decidingMany(ids: readonly RunId[]): Map<RunId, RunRecord> {
      if (!ids.length) return new Map();
      const numbers = [...new Set(ids.map(id => runNumber(runIdSchema.parse(id))))];
      const rows = storageOperation(() => db.prepare(`SELECT id, record FROM runs
        WHERE id IN (SELECT value FROM json_each(?)) AND ${TASK_RUN_SQL}`).all(JSON.stringify(numbers)));
      return new Map(rows.map(decidingRecord(root)).map(run => [run.id, run]));
    },
    /** Any Run, the coordinator's too: for the execution layer only. */
    runtimeGet(id: RunId): RuntimeRunRecord | null {
      const row = runRow(db, id);
      return row ? parseRuntimeRow(row) : null;
    },
    /** Read-only consumers share decoding with task decisions; execution reads still receive detached values. */
    runtimeDecidingGet(id: RunId): RuntimeRunRecord | null {
      const row = runRow(db, id);
      return row ? decidingRuntimeRecord(root)(row) : null;
    },
    /** One project's Task Runs, or the whole workspace's. */
    all(project?: string, taskIds?: readonly string[]): RunRecord[] { return taskRunRows(db, project, taskIds).map(parseRow); },
    /**
     * Return facts additionally need the referenced caller, resumed and joined-into Runs, even on another Task.
     * Historical references are facts of the selected Runs; project scope limits the seeds, never their references.
     */
    returnRuns(project?: string, taskIds?: readonly string[]): RunRecord[] {
      const records = new Map<number, RunRecord>();
      // The references are in the records the read decodes anyway; the Runs they leave out are few, usually none.
      let rows = taskRunRows(db, project, taskIds);
      const decode = decidingRecord(root);
      while (rows.length) {
        const decoded = rows.map(decode);
        for (const run of decoded) records.set(runNumber(run.id), run);
        const referenced = new Set(decoded.flatMap(run => [run.caller?.run, run.resumes, run.into])
          .flatMap(id => id ? [runNumber(id)] : []).filter(id => !records.has(id)));
        rows = !referenced.size ? [] : storageOperation(() => db.prepare(`SELECT id, record FROM runs
          WHERE id IN (SELECT value FROM json_each(?)) AND ${TASK_RUN_SQL} ORDER BY id`).all(JSON.stringify([...referenced])));
      }
      return [...records].sort(([a], [b]) => a - b).map(([, run]) => run);
    },
    /**
     * One project's owner Runs lacking a Task log named by one of `prefixes` and the Run's ID: only those can have a
     * record still to write. Each Run is looked up by the log's own primary key, before its record is read.
     */
    ownerRunsWithoutLogs(project: string, prefixes: readonly string[]): RunRecord[] {
      const [condition, parameters] = scoped(PROJECT_RUNS_SQL, project);
      const missing = prefixes.map(() => `NOT EXISTS (SELECT 1 FROM task_log l WHERE l.id = ? || 'R' || runs.id)`).join(' OR ');
      return storageOperation(() => db.prepare(`SELECT id, record FROM runs
        WHERE ${TASK_RUN_SQL} AND ${condition} AND (${missing}) AND json_extract(record,'$.role') = 'owner'`)
        .all(...parameters, ...prefixes).sort((a, b) => Number(a.id) - Number(b.id)).map(decidingRecord(root)));
    },
    runsOfTask(taskId: string): RunRecord[] {
      return storageOperation(() => db.prepare('SELECT id, record FROM runs WHERE task_id = ? ORDER BY id').all(taskId).map(parseRow));
    },
    /**
     * The unfinished Runs (`isUnfinished`) on these Tasks but `exceptRunId`, in Run-number order: the one read of a
     * subtree's unfinished Runs, which the finish conditions, archiving and the review's check read.
     */
    unfinishedIn(taskIds: readonly string[], exceptRunId?: RunId): RunId[] {
      return storageOperation(() => db.prepare(`SELECT id FROM runs
        WHERE task_id IN (SELECT value FROM json_each(?)) AND state IN (${UNFINISHED_SQL}) AND id IS NOT ? ORDER BY id`)
        .all(JSON.stringify(taskIds), exceptRunId === undefined ? null : runNumber(runIdSchema.parse(exceptRunId)))
        .map(row => runIdOf(row.id)));
    },
    /** A placement's conversation: its Runs except those whose Request was aborted. */
    conversationRuns(placementId: string): RunRecord[] {
      return conversationRows(db, 'placement_id', placementId).map(parseRow);
    },
    /** Latest Run in a placement's conversation, optionally excluding one pending Request. */
    conversationHead(placementId: string, exceptRequestId?: string): RunRecord | null {
      const row = conversationHeadRow(db, 'placement_id', placementId, exceptRequestId);
      return row ? parseRow(row) : null;
    },
    /**
     * The Runs fed as input to a placement's working Run whose receipt is unknown (run_inputs uncertain): the same read
     * as a snapshot's `uncertainInputs`, for one placement at the write's read point.
     */
    uncertain(placementId: string): ReadonlySet<RunId> {
      return uncertainInputs(db, 'r.placement_id = ?', [placementId]).get(placementId) ?? new Set();
    },
    /** Whether a Run's input is closed: the same read as a snapshot's `inputClosed`, for one Run at the write's read point. */
    inputClosed(id: RunId): boolean { return inputClosedRuns(db, 'r.id = ?', [runNumber(id)]).has(id); },
    /** The coordinator conversation's Runs except those whose Request was aborted. */
    coordinatorRuns(conversationId: string): CoordinatorRunRecord[] {
      return conversationRows(db, 'conversation_id', conversationId).map(parseCoordinatorRow);
    },
    /** Latest Run in the coordinator conversation, optionally excluding one pending Request. */
    coordinatorHead(conversationId: string, exceptRequestId?: string): CoordinatorRunRecord | null {
      const row = conversationHeadRow(db, 'conversation_id', conversationId, exceptRequestId);
      return row ? parseCoordinatorRow(row) : null;
    },
    /** Complete relationship closure for slot and parent decisions. */
    forSettle(): RuntimeRunRecord[] { return decisionRecords(db); },
    /** Admission needs the caller ancestry and the caller's direct children, including completed children. */
    forAdmission(caller?: RunId): RunRecord[] {
      if (caller === undefined) return [];
      return storageOperation(() => db.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT id FROM runs WHERE id=?
        UNION SELECT p.id FROM ancestors a JOIN runs c ON c.id=a.id
          JOIN runs p ON p.id=${runNumberSql('c.caller_run')}
      ), selected(id) AS (
        SELECT id FROM ancestors UNION SELECT id FROM runs WHERE caller_run=?
      ) SELECT r.id,r.record FROM runs r JOIN selected s ON s.id=r.id
        WHERE ${TASK_RUN_SQL} ORDER BY r.id`).all(runNumber(caller), caller).map(parseRow));
    },
    getRequest(id: string): StoredRequest | null {
      const read = requestReader(db, root);
      const row = storageOperation(() => db.prepare(`${read.select} WHERE q.id = ? AND ${TASK_REQUEST_SQL}`).get(id));
      return row ? read.decode(row) : null;
    },
    /** Only the named Task Requests, carrying the same Run identity and decoding as getRequest. */
    getRequests(ids: readonly string[]): Map<string, StoredRequest> {
      if (!ids.length) return new Map();
      const read = requestReader(db, root);
      const rows = storageOperation(() => db.prepare(`${read.select}
        WHERE q.id IN (SELECT value FROM json_each(?)) AND ${TASK_REQUEST_SQL}`).all(JSON.stringify([...new Set(ids)])));
      return new Map(rows.map(row => { const request = read.decode(row); return [request.id, request]; }));
    },
    requests(project?: string, taskIds?: readonly string[]): StoredRequest[] { return allRequests(db, root, project, taskIds); },
    getPlacement(id: string): StoredPlacement | null {
      const row = storageOperation(() => db.prepare('SELECT * FROM placements WHERE id = ?').get(id));
      return row ? parseStoredPlacement(row) : null;
    },
    responsiblePlacement(taskId: string): StoredPlacement | null {
      const row = storageOperation(() => db.prepare(
        'SELECT * FROM placements WHERE task_id = ? AND ended_at IS NULL AND responsible = 1').get(taskId));
      return row ? parseStoredPlacement(row) : null;
    },
    /** Fresh active responsible placements at the current transaction read point; never memoized. */
    responsiblePlacements(project?: string, taskIds?: readonly string[]): StoredPlacement[] {
      const [condition, parameters] = scoped(PROJECT_REQUESTS_SQL, project, taskIds);
      return storageOperation(() => db.prepare(
        `SELECT * FROM placements WHERE ended_at IS NULL AND responsible = 1 AND ${condition}`)
        .all(...parameters).map(parseStoredPlacement));
    },
    /** The returns to these Tasks and the ones closing a Request to them (allReturns). */
    returns(project?: string, taskIds?: readonly string[]): StoredReturn[] { return allReturns(db, project, undefined, undefined, taskIds); },
    getReturn(id: string): StoredReturn | null { return allReturns(db, undefined, id)[0] ?? null; },
  };
}
export type TransactionReads = ReturnType<typeof transactionReads>;

function textRow(db: DatabaseSync, id: RunId, selection: 'both' | 'prompt' | 'result') {
  return storageOperation(() => {
    const columns = selection === 'both' ? 'prompt,result' : `${selection === 'prompt' ? 'prompt' : 'result'} AS text`;
    const row = db.prepare(`SELECT id,record,${columns},typeof(result) AS result_type,result_state FROM runs WHERE id = ?`)
      .get(runNumber(runIdSchema.parse(id)));
    if (!row) return null;
    const record = parseRuntimeRow(row);
    const stored = runResultStateSchema.safeParse(row.result_state);
    const resultState = stored.success ? stored.data : null;
    if (resultState === null || (resultState === 'present') !== (row.result_type !== 'null'))
      throw runsUnavailable(new Error(`Invalid Run result storage: ${id}`));
    return { row, record, resultState: row.result_type !== 'null' && row.result_type !== 'text' ? 'unreadable' as const : resultState };
  });
}

/** The reads only the store offers, each at a read point of its own: nothing a write decides by. */
export function storeReads(db: DatabaseSync, root: string) {
  return {
    /**
     * Only a Run detail read selects large text; list and decision reads select record alone. Any Run, the coordinator's
     * too: its committed text is what cleans its exchange files.
     */
    text(id: RunId): StoredRunText | null {
      const read = textRow(db, id, 'both');
      return read ? { record: read.record, prompt: typeof read.row.prompt === 'string' ? read.row.prompt : null,
        result: typeof read.row.result === 'string' ? read.row.result : null, resultState: read.resultState } : null;
    },
    /** Each named Run's present final reply, its first `length` characters only: what a list says of a reply before it is opened. */
    resultHeads(ids: readonly RunId[], length: number): Map<RunId, string> {
      const numbers = [...new Set(ids.map(id => runNumber(runIdSchema.parse(id))))];
      if (!numbers.length) return new Map();
      return new Map(storageOperation(() => db.prepare(`SELECT id, substr(result, 1, ?) AS head FROM runs
        WHERE result_state = 'present' AND typeof(result) = 'text' AND id IN (${numbers.map(() => '?').join(',')})`)
        .all(length, ...numbers)).map(row => [runIdOf(row.id), String(row.head)]));
    },
    /** One requested body, with the same record and result-storage validation as a two-body cleanup read. */
    fileText(id: RunId, kind: 'prompt' | 'result'): StoredRunFile | null {
      const read = textRow(db, id, kind);
      if (!read) return null;
      const text = typeof read.row.text === 'string' ? read.row.text : null;
      return { record: read.record, text, state: kind === 'prompt' ? text === null ? 'unreadable' : 'present' : read.resultState };
    },
    /**
     * One project's Task Runs, placements, Requests, returns, wait cycles, question closes and unknown
     * receipts at one read point, or the whole workspace's; every agent.
     */
    snapshot<Records extends readonly ReadRunRecord[]>(project: string | undefined, taskIds: readonly string[] | undefined,
      decode: (rows: Record<string, unknown>[]) => Records): Omit<RunSnapshot, 'records'> & { records: Records | null } {
      const rows = taskRunRows(db, project, taskIds);
      // A malformed Run is unknown, but valid placement identity remains available
      // from this same read point so the screen can show unknown activity.
      let records: Records | null = null, runError: Problem | null = null;
      try { records = decode(rows); } catch (error) { runError = error instanceof Problem ? error : runsUnavailable(error); }
      const agents = storageOperation(() => db.prepare('SELECT * FROM agents ORDER BY created_at, id').all().map(parseStoredAgent));
      const [taskCondition, taskParameters] = scoped(PROJECT_REQUESTS_SQL, project, taskIds);
      const placements = storageOperation(() => db.prepare(`SELECT * FROM placements WHERE ${taskCondition} ORDER BY started_at, id`)
        .all(...taskParameters).map(parseStoredPlacement));
      const requests = allRequests(db, root, project, taskIds), returns = allReturns(db, project, undefined, undefined, taskIds);
      const waitCycles = storageOperation(() => db.prepare(`SELECT * FROM wait_cycles WHERE ${taskCondition} ORDER BY opened_at, id`)
        .all(...taskParameters).map(row => ({ id: String(row.id), taskId: String(row.task_id), openedAt: String(row.opened_at),
          closedAt: nullable(row.closed_at) })));
      // Only the logs' facts: the full texts stay out of a list read.
      const [logCondition, logParameters] = scoped(PROJECT_LOGS_SQL, project, taskIds, 'l.task_id', true);
      const questionClosures = new Map(storageOperation(() => db.prepare(`SELECT c.question_log_id, c.log_id
        FROM task_log_question c JOIN task_log l ON l.id = c.question_log_id WHERE ${logCondition}`).all(...logParameters))
        .map(row => [String(row.question_log_id), String(row.log_id)]));
      const uncertain = uncertainInputs(db, ...scoped(PROJECT_RUNS_SQL, project, taskIds, 'r.task_id'));
      const inputClosed = inputClosedRuns(db, ...scoped(PROJECT_RUNS_SQL, project, taskIds, 'r.task_id'));
      const headRunIds = new Map<string, RunId | null>();
      if (records) {
        const aborted = new Set(requests.filter(request => request.deliveryState === DELIVERY_STATE.aborted).map(request => request.id));
        for (const placement of placements) headRunIds.set(placement.id, null);
        // Records are in Run-number order, the same ordering as conversationHead.
        for (const run of records) if (run.placementId && run.state !== 'joined' && !aborted.has(run.requestId ?? ''))
          headRunIds.set(run.placementId, run.id);
      }
      const resultStates = new Map(rows.map(row => [runIdOf(row.id), String(row.result_state) as RunResultState]));
      return { records, runError, agents, placements, requests, returns, waitCycles, headRunIds, resultStates,
        questionClosures, uncertainInputs: uncertain, inputClosed };
    },
    /** Every Run, the coordinator's too (settle, host monitor, startup recovery). */
    everyRun(): RuntimeRunRecord[] {
      return storageOperation(() => db.prepare('SELECT id, record FROM runs ORDER BY id').all().map(parseRuntimeRow));
    },
    /**
     * The Runs not yet ended (queued, running, needs_review…), in Run-number order, without the ended history the
     * periodic checks never look at: the coordinator's too, unless a project or Tasks narrow it to those Task Runs.
     */
    unfinished(project?: string, taskIds?: readonly string[]): RuntimeRunRecord[] {
      const [condition, parameters] = scoped(PROJECT_RUNS_SQL, project, taskIds);
      return storageOperation(() => db.prepare(`SELECT id, record FROM runs WHERE state IN (${UNFINISHED_SQL}) AND ${condition} ORDER BY id`)
        .all(...parameters).map(parseRuntimeRow));
    },
    /**
     * Who holds any of these conversation sessions. A Task Run's session wins over a coordinator Run's: a session a Task
     * Run works in never speaks as a coordinator. A running coordinator Run owns its session ahead of queued or joined
     * messages sharing it; their Requests are delivered into that Run, not new executions.
     */
    sessionOwner(sessionIds: readonly string[]): SessionOwner {
      return storageOperation(() => {
        let owner: SessionOwner = null;
        for (const id of sessionIds) {
          const row = db.prepare(`SELECT id, conversation_id FROM runs WHERE session_id = ?
            ORDER BY conversation_id IS NOT NULL, state='running' DESC, id DESC LIMIT 1`).get(id);
          if (!row) continue;
          if (row.conversation_id === null) return 'task_run';
          owner ??= { coordinator: String(row.conversation_id), runId: runIdOf(row.id) };
        }
        return owner;
      });
    },
    /** Returns addressed to one Task, retaining the caller's project boundary when supplied. */
    returnsForTask(taskId: string, project?: string): StoredReturn[] { return allReturns(db, project, undefined, taskId); },
    /** The destination, cursor and related facts are selected at one read point, in the existing (created_at,id) order. */
    returnPage(input: { task: string; after?: string; limit: number }, project?: string): { returns: StoredReturn[]; nextAfter: string | null } {
      return storageOperation(() => {
        const [scope, parameters] = scoped(PROJECT_RETURNS_SQL, project);
        const condition = `${scope} AND r.to_task_id=?`;
        parameters.push(input.task);
        const cursor = input.after === undefined ? undefined : db.prepare(`SELECT r.created_at,r.id FROM returns r
          WHERE ${condition} AND r.id=?`).get(...parameters, input.after);
        if (input.after !== undefined && !cursor) throw new Problem(PROBLEM_CODE.invalidInput, 'Unknown return cursor', undefined,
          { reason: { kind: 'unknown_return_cursor' } });
        // Only identities are needed for the lookahead. Payloads and their history are read for the page itself.
        const keys = db.prepare(`SELECT r.id FROM returns r WHERE ${condition}
          ${cursor ? 'AND (r.created_at,r.id) > (?,?)' : ''} ORDER BY r.created_at,r.id LIMIT ?`)
          .all(...parameters, ...cursor ? [String(cursor.created_at), String(cursor.id)] : [], input.limit + 1);
        const ids = keys.slice(0, input.limit).map(row => String(row.id));
        const rows = ids.length ? db.prepare(`SELECT * FROM returns WHERE id IN (SELECT value FROM json_each(?))
          ORDER BY created_at,id`).all(JSON.stringify(ids)) : [];
        return { returns: decodeReturns(db, rows), nextAfter: keys.length > input.limit ? ids.at(-1)! : null };
      });
    },
    /** A conversation reads only its lane and shared sessions, so an unrelated broken Task Run cannot hide it. */
    forSettle(conversationId?: string): RuntimeRunRecord[] { return decisionRecords(db, conversationId); },
  };
}
