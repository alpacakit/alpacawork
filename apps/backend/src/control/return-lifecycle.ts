import { closedRequestIds, pendingReturns, unclosedSent } from '@alpacawork/runs';
import type { RoutingReadContext } from './routing-read-work.js';
import { questionSnapshot, questionReturnApplicable } from './question-rules.js';
/**
 * The return domain. Returns are what goes to a seat: one closing return per Request it sent, and one notice per cause
 * log (a question, an urgent note, an answer, a new responsible, a work change). Which Requests are open is derived from
 * return-rules isOpen (committed closing return, otherwise closureOf): the ball, the finish conditions, the requester and the wake rules read
 * it, never a stored wait cycle. A Request's closing return is written once, when returns_close holds none for it.
 */
import type { ProblemReason } from '@alpacawork/core';
import { touch, type ChangeKey } from '@alpacawork/db';
import { routingRequests, type RoutingTasks } from './routing-work.js';
import { returnHold } from '@alpacawork/runs';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isSeatContinuation, type RESOLUTION_REASONS } from '@alpacawork/contract';
import { terminal, TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { carrierOf, compareRunIds, type ReadRunRecord, type RunRecord } from '@alpacawork/contract/run';
import { questionsOf, speaksForUser, type TaskLog } from '@alpacawork/raw';
import type { TaskDecisionFacts } from './routing-facts.js';
import { isUnfinished, PROJECT_REQUESTS_SQL, type ReturnDelivery, type RunTransaction, type StoredPlacement, type StoredRequest,
  type StoredReturn } from '@alpacawork/runs';
import { resolveUncertainInputs } from '../runs/execution-control.js';
import { arrivingRequests, awaitsClosure, closureOf, cycleClosed, isOpen, openRequests as openRequestsOf, ranToSuccess, requesterSeat,
  returnFacts, returnIdOf, openRequestsBySeat, taskFailure, userWorkFailed, urgentTarget as urgentTargetIn, type ReturnFacts, type ReturnNotice } from './return-rules.js';
import { failedDeliveryBlocked, seatFailed, seatRunBefore } from './wake.js';

/** What a return's delivery and resolution facts make of it; there is no writable status. */
type ReturnDisposition = 'pending' | 'carried' | 'in_flight' | 'disposed';
type ResolutionReason = (typeof RESOLUTION_REASONS)[number];
/**
 * Why a delivery was released. One never sent (its wake Request was aborted) leaves its return pending, to go again by
 * itself; any other carries the return to the next Request to the seat (W0): a failed or stopped turn, a seat that
 * failed before its continuation started, or a receipt a person's proxy sent again.
 */
type ReleaseReason = 'not_delivered' | 'unsuccessful' | 'seat_failed' | 'resent_by_person';

/**
 * Disposed once a delivery was consumed or the return was resolved; in flight while a delivery is out; carried once a
 * delivery that went out did not succeed (it waits for a Request to the seat, never a wake by itself); else pending.
 */
export function returnDisposition(row: StoredReturn): ReturnDisposition {
  if (row.resolution || row.deliveries.some(d => d.consumedAt)) return 'disposed';
  if (row.deliveries.some(d => !d.releasedAt)) return 'in_flight';
  return row.deliveries.some(d => !d.priorSeat && d.releaseReason !== 'not_delivered') ? 'carried' : 'pending';
}
export function activeDelivery(row: StoredReturn) { return row.deliveries.find(d => !d.releasedAt && !d.consumedAt); }

/**
 * A read or a transition uses the same input-specific receipt facts, on its own connection: whether the agent took the
 * wake's input, and the Run whose work it went into (a joined Run's `into`).
 */
type ReturnReceipt<Run> = { received: boolean; unknown: boolean; actual: Run | null };
export function returnReceipt<Run extends ReadRunRecord>(db: DatabaseSync, records: readonly Run[], delivery: ReturnDelivery): ReturnReceipt<Run> {
  const wake = records.find(run => run.requestId === delivery.wakeRequestId);
  const states = wake ? inputStatesByRequest(db, [delivery.wakeRequestId]).get(delivery.wakeRequestId) ?? [] : [];
  return receiptFrom(wake, states, id => records.find(run => run.id === id));
}

/** The one receipt rule for both single reads and batches. */
function receiptFrom<Run extends ReadRunRecord>(wake: Run | undefined, states: readonly string[],
  find: (id: string) => Run | undefined): ReturnReceipt<Run> {
  if (!wake) return { received: false, unknown: false, actual: null };
  const actual = carrierOf(wake, find) ?? null;
  const notSent = states.length > 0 && states.every(state => state === 'not_sent');
  return { received: wake.state === 'joined' ? states.includes('taken') : !!wake.pids.agent && !notSent,
    unknown: states.includes('uncertain'), actual };
}

/** One operation's input evidence; callers do not retain receipts across writes to run_inputs. */
function returnReceipts<Run extends ReadRunRecord>(db: DatabaseSync, records: readonly Run[],
  deliveries: readonly ReturnDelivery[]): Map<string, ReturnReceipt<Run>> {
  if (!deliveries.length) return new Map();
  const byRequest = new Map<string, Run>(), byId = new Map<string, Run>();
  for (const run of records) {
    if (!byRequest.has(run.requestId)) byRequest.set(run.requestId, run);
    if (!byId.has(run.id)) byId.set(run.id, run);
  }
  const ids = [...new Set(deliveries.map(delivery => delivery.wakeRequestId))];
  const inputs = inputStatesByRequest(db, ids.filter(id => byRequest.has(id)));
  return new Map(ids.map(id => [id, receiptFrom(byRequest.get(id), inputs.get(id) ?? [], target => byId.get(target))]));
}

/** The states of the inputs that carried a wake Request's Run to an agent (run_inputs): its own launch's, or a working Run's it joined. */
function inputStatesByRequest(db: DatabaseSync, wakeRequestIds: readonly string[]): Map<string, string[]> {
  const states = new Map<string, string[]>();
  if (!wakeRequestIds.length) return states;
  for (const row of db.prepare(`SELECT r.request_id,i.state FROM runs r JOIN run_inputs i ON i.instruction_run_no=r.id
    WHERE r.request_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...new Set(wakeRequestIds)]))) {
    const id = String(row.request_id), group = states.get(id) ?? [];
    group.push(String(row.state)); states.set(id, group);
  }
  return states;
}
/** A delivery's receipt is unknown while an input that carried it is uncertain: nothing sends it again by itself. */
export const receiptUnknown = (db: DatabaseSync, delivery: ReturnDelivery): boolean =>
  unknownReceipts(db, [delivery]).has(delivery.wakeRequestId);
/** Pages share the same receipt rule, reading each carried Request's inputs once. */
export function unknownReceipts(db: DatabaseSync, deliveries: readonly ReturnDelivery[]): ReadonlySet<string> {
  return new Set([...inputStatesByRequest(db, deliveries.map(delivery => delivery.wakeRequestId))]
    .filter(([, states]) => states.includes('uncertain')).map(([id]) => id));
}

/**
 * What a seat leaves open for whoever holds it next: the Requests it sent that have not closed, and the returns to it
 * not disposed.
 */
export type Obligations = { requests: StoredRequest[]; returns: StoredReturn[] };

/** The same read-only projection for a launch, a handover and explicit CLI retrieval. */
export function openObligationsOf(taskId: string, requests: readonly StoredRequest[], rows: readonly StoredReturn[],
  facts: ReturnFacts, tasks: ReturnType<typeof questionSnapshot>): Obligations {
  return { requests: openRequestsOf(taskId, requests, facts),
    returns: rows.filter(row => row.toTaskId === taskId && questionReturnApplicable(row, tasks) && returnDisposition(row) !== 'disposed') };
}

/** The only writer of returns, their deliveries and resolutions, and wait cycles. */
export class ReturnLifecycle {
  private readonly routing: RoutingTasks;
  private reconciled?: ReturnLifecycle;
  private revision = -1;
  private runRevision = -1;
  private readonly shared: { revision: number; runs: number; views: Map<string, ReturnLifecycle> };
  /** Each seat set owns its read caches; a query never changes another operation's scope. */
  private at(work: RoutingTasks): ReturnLifecycle {
    const key = JSON.stringify([...work.tasks].sort());
    let view = this.shared.views.get(key);
    if (!view) {
      view = new ReturnLifecycle(this.db, this.tx, this.tasks, this.project, this.context, this.root, work, this.shared);
      this.shared.views.set(key, view);
    }
    return view;
  }
  private seat(taskId: string) { return this.at({ tasks: new Set([taskId]) }); }
  private refresh(): void {
    if (this.runRevision !== this.shared.runs) {
      this.runRevision = this.shared.runs;
      this.runRecords = undefined; this.requestRecords = undefined; this.factIndex = undefined;
    }
    if (this.revision !== this.shared.revision) {
      this.revision = this.shared.revision;
      this.returnRecords = undefined; this.factIndex = undefined;
    }
  }
  private runRecords?: RunRecord[];
  private requestRecords?: StoredRequest[];
  private returnRecords?: StoredReturn[];
  private factIndex?: ReturnFacts;
  private responsibleRecords: readonly StoredPlacement[] = [];
  private questionIndex?: ReturnType<typeof questionSnapshot>;
  private get questionTasks() { return this.questionIndex ??= questionSnapshot(this.tasks); }
  private applicable(row: StoredReturn, at?: string) { return questionReturnApplicable(row, this.questionTasks, at); }
  private logIndex?: Map<string, { log: TaskLog; task: TaskDecisionFacts }>;
  // These facts are stable within this Owner's transaction; only its own writes invalidate its read point.
  private get records() {
    this.refresh();
    return this.runRecords ??= this.routingRuns();
  }
  /** Ancestors supply user resets. Return rules read only a seed Run's direct caller and joined-into Run. */
  private routingRuns(extra: readonly StoredReturn[] = []): RunRecord[] {
    // Keep Requests for automatic-limit accounting. A permanent closing Return
    // already answers their closure without reading the historical Run again.
    const closed = closedRequestIds(this.db, this.requests.map(request => request.id));
    const seeds = new Set<RunRecord['id']>();
    for (const request of this.requests) {
      if (!request.runId || speaksForUser(request.author) && !this.routing.tasks.has(request.taskId)) continue;
      if (awaitsClosure(request) && !closed.has(request.id)) seeds.add(request.runId);
    }
    // Receipts and stale continuations have their own obligations, even when
    // the Request they carried needs no closing Return. Rendering pending
    // returns reads their named Request/Run directly in returnLinesOf.
    const wakes = [...this.rows, ...extra].flatMap(row => row.deliveries
      .filter(delivery => !delivery.releasedAt && !delivery.consumedAt).map(delivery => delivery.wakeRequestId));
    for (const request of this.tx.getRequests(wakes).values()) if (request.runId) seeds.add(request.runId);
    for (const row of this.db.prepare(`SELECT r.id FROM runs r JOIN requests q ON q.id=r.request_id
      WHERE r.task_id IN (SELECT value FROM json_each(?)) AND r.state='queued' AND q.purpose='return_continuation'`)
      .all(JSON.stringify([...this.routing.tasks]))) seeds.add(`R${row.id}` as RunRecord['id']);
    const records = this.tx.decidingMany([...seeds]);
    let boundary = [...records.values()];
    while (boundary.length) {
      const references = new Set<RunRecord['id']>();
      for (const run of boundary) {
        for (const id of [run.caller?.run, run.state === 'joined' ? run.into : null, run.supersededBy])
          if (id && !records.has(id)) references.add(id);
      }
      boundary = [...this.tx.decidingMany([...references]).values()];
      for (const run of boundary) records.set(run.id, run);
    }
    return [...records.values()].sort(compareRunIds);
  }
  private get requests() {
    this.refresh();
    return this.requestRecords ??= routingRequests(this.db, this.tx, this.routing, this.root);
  }
  private get rows() { this.refresh(); return this.returnRecords ??= pendingReturns(this.db, [...this.routing.tasks], undefined, true); }
  /** The return rules' facts of this read point, indexed once; a Task is responsible while a responsible holds it. */
  private get facts(): ReturnFacts {
    this.refresh();
    if (this.factIndex) return this.factIndex;
    // With no Task there is no responsible to read.
    this.responsibleRecords = this.tasks.length === 0 ? [] : this.tx.responsiblePlacements(this.project, this.tasks.map(task => task.id));
    const responsible = new Set(this.responsibleRecords.map(placement => placement.taskId));
    const facts = returnFacts(this.tasks.map(task => ({ ...task.meta, responsible: responsible.has(task.id) })), this.records, this.rows);
    facts.closedRequests = closedRequestIds(this.db, this.requests.map(request => request.id));
    return this.factIndex = facts;
  }
  /** Every log of the Tasks by its ID, with its Task. */
  private get logs(): ReadonlyMap<string, { log: TaskLog; task: TaskDecisionFacts }> {
    if (!this.logIndex) {
      this.logIndex = new Map();
      for (const task of this.tasks) for (const log of task.meta.log) this.logIndex.set(log.id, { log, task });
    }
    return this.logIndex;
  }
  /** The facts this Owner holds at this point of its transaction, read once: what its own writes changed is read again. */
  get current(): { requests: readonly StoredRequest[]; returns: readonly StoredReturn[]; facts: ReturnFacts;
    responsible: readonly StoredPlacement[] } {
    if (this.reconciled && this.reconciled !== this) return this.reconciled.current;
    const facts = this.facts;
    return { requests: this.requests, returns: this.rows, facts, responsible: this.responsibleRecords };
  }
  /**
   * `project` is the project Task whose Runs, Requests and returns are read, as `tasks` were; none reads the whole
   * workspace. `db` is the write's control connection, on which `tx` and the Task writes of the same transaction work.
   */
  constructor(readonly db: DatabaseSync, readonly tx: RunTransaction, readonly tasks: readonly TaskDecisionFacts[],
    readonly project?: string, readonly context?: RoutingReadContext, private readonly root = '', work?: RoutingTasks,
    shared?: { revision: number; runs: number; views: Map<string, ReturnLifecycle> }) {
    this.routing = work ?? { tasks: new Set(tasks.map(task => task.id)) };
    this.shared = shared ?? { revision: 0, runs: 0, views: new Map() };
    if (!shared) this.shared.views.set(JSON.stringify([...this.routing.tasks].sort()), this);
  }

  /** All return writes invalidate the derived rows and record their changed facts in the transaction's ChangeScope. */
  private change(key: ChangeKey, sql: string, ...values: SQLInputValue[]): void {
    if (this.db.prepare(sql).run(...values).changes) {
      this.shared.revision++;
      touch(this.db, key);
    }
  }
  /** An abort changed Runs and Requests: they are read again. */
  private runsChanged(): void {
    this.shared.runs++;
  }

  /**
   * A delivery whose receipt is unknown stays out (a person's proxy sends it again, resendUnconfirmed). One whose wake
   * Request was aborted is released to pending. Once its Run ended, it is consumed if the agent took it and the turn
   * succeeded; otherwise it is released and carried, and nothing wakes the seat with it again by itself.
   */
  private reconcileDeliveries(work?: RoutingTasks): void {
    const requests = new Map(this.requests.map(request => [request.id, request]));
    const rows = work ? this.rows.filter(row => work.tasks.has(row.toTaskId)) : this.rows;
    const deliveries = rows.flatMap(row => row.deliveries.filter(delivery => !delivery.releasedAt && !delivery.consumedAt));
    // This loop writes only return_deliveries, so its input evidence remains at this read point.
    const receipts = returnReceipts(this.db, deliveries.length ? this.records : [], deliveries);
    const at = new Date().toISOString();
    for (const row of rows) for (const delivery of row.deliveries) {
      if (delivery.releasedAt || delivery.consumedAt) continue;
      const receipt = receipts.get(delivery.wakeRequestId)!;
      if (receipt.received && !delivery.receivedAt)
        this.change({ kind: 'delivery', id: JSON.stringify([row.id, delivery.wakeRequestId]) }, 'UPDATE return_deliveries SET received_at=? WHERE return_id=? AND wake_request_id=?', at, row.id, delivery.wakeRequestId);
      if (receipt.unknown) continue;
      const request = requests.get(delivery.wakeRequestId);
      if (!request || request.deliveryState === DELIVERY_STATE.aborted) { this.release(row.id, delivery.wakeRequestId, 'not_delivered'); continue; }
      if (!receipt.actual || isUnfinished(receipt.actual)) continue;
      if (receipt.received && ranToSuccess(receipt.actual))
        this.change({ kind: 'delivery', id: JSON.stringify([row.id, delivery.wakeRequestId]) }, 'UPDATE return_deliveries SET consumed_at=? WHERE return_id=? AND wake_request_id=?', at, row.id, delivery.wakeRequestId);
      else this.release(row.id, delivery.wakeRequestId, 'unsuccessful');
    }
  }
  private release(id: string, wakeRequestId: string, reason: ReleaseReason): void {
    this.change({ kind: 'delivery', id: JSON.stringify([id, wakeRequestId]) }, `UPDATE return_deliveries SET released_at=?,release_reason=? WHERE return_id=? AND wake_request_id=? AND consumed_at IS NULL AND released_at IS NULL`, new Date().toISOString(), reason, id, wakeRequestId);
  }
  private resolve(id: string, reason: ResolutionReason): void {
    this.change({ kind: 'resolution', id }, 'INSERT INTO return_resolutions(return_id,reason,at) VALUES (?,?,?)', id, reason, new Date().toISOString());
  }
  /** A return goes out with a Request to its seat; the reason it was held with no longer stands. */
  private deliver(id: string, requestId: string, at: string): void {
    this.change({ kind: 'delivery', id: JSON.stringify([id, requestId]) }, 'INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at) VALUES (?,?,?)', id, requestId, at);
    this.change({ kind: 'return', id }, 'UPDATE returns SET hold_reason=NULL WHERE id=?', id);
  }
  /** Each of `requests` that closed (closureOf) and has no closing return gets one, to the seat that sent it. */
  private close(requests: readonly StoredRequest[], work?: RoutingTasks): void {
    const closed = closedRequestIds(this.db, this.requests.map(request => request.id));
    for (const request of requests) {
      if (closed.has(request.id) || !awaitsClosure(request)) continue;
      const closure = closureOf(request, this.facts);
      // A Request from the user closes into no seat; the user reads the Task.
      const seat = closure && requesterSeat(request, this.facts);
      if (!closure || !seat || work && !work.tasks.has(seat)) continue;
      const cause = closure.causeLogId === null ? undefined : this.logs.get(closure.causeLogId)?.log;
      const run = closure.runId === null ? undefined : this.records.find(item => item.id === closure.runId);
      const id = returnIdOf({ requestId: request.id });
      if (!this.db.prepare('INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,cause_log_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, request.id, seat, closure.outcome, closure.runId, closure.causeLogId, cause?.at ?? run?.ended_at ?? new Date().toISOString())
        .changes) continue;
      touch(this.db, { kind: 'return', id });
      this.joinClosing(this.tx.getReturn(id)!);
    }
  }
  /**
   * A closing return `close` wrote joins this read point by its ID, in the rows' order, and closes its Request in the
   * facts: the growing returns are not read again for each one.
   */
  private joinClosing(row: StoredReturn): void {
    const rows = this.rows;
    this.revision = ++this.shared.revision;
    const at = rows.findIndex(other => other.createdAt > row.createdAt ||
      other.createdAt === row.createdAt && other.id > row.id);
    rows.splice(at === -1 ? rows.length : at, 0, row);
    if (this.factIndex && row.requestId !== null)
      this.factIndex = { ...this.factIndex, closedRequests: new Set([...this.factIndex.closedRequests, row.requestId]) };
  }
  /** Records that all of a cycle's Requests closed; delivery selection never reads this timestamp. */
  private closeCycle(id: string): void {
    this.change({ kind: 'wait_cycle', id }, 'UPDATE wait_cycles SET closed_at=? WHERE id=?', new Date().toISOString(), id);
  }
  /** Why a return no seat should take any more is resolved, or null. */
  private clearing(row: StoredReturn, tasks: ReadonlyMap<string, TaskDecisionFacts>): ResolutionReason | null {
    const seat = tasks.get(row.toTaskId);
    const cause = row.requestId === null && row.causeLogId !== null ? this.logs.get(row.causeLogId) : undefined;
    const result = evaluate(TASK_POLICY.clearReturn, { seatBase: seat?.meta.baseState ?? null,
      originBase: cause?.task.meta.baseState ?? null, question: row.outcome === 'question',
      closed: !!cause && !!questionsOf(cause.task.meta.log).find(question => question.asked.id === cause.log.id)?.closing });
    return result.code === 'open' ? null : result.code as ResolutionReason;
  }
  /**
   * Resolves the returns not yet out that no seat should take any more: those to a seat whose Task finished, a notice
   * from a Task that was stopped (its questions and urgent notes go with it), and a question closed by its answer, its
   * withdrawal or its expiry. However a question closes, only this clears what was not delivered of it; a return
   * already delivered is not taken back, the next start text's changes tell it.
   */
  private clear(work?: RoutingTasks): void {
    const tasks = new Map(this.tasks.map(task => [task.id, task]));
    for (const row of this.rows) {
      if (work && !work.tasks.has(row.toTaskId)) continue;
      const disposition = returnDisposition(row);
      if (disposition !== 'pending' && disposition !== 'carried') continue;
      const reason = this.clearing(row, tasks);
      if (reason) this.resolve(row.id, reason);
    }
  }
  /**
   * Holds pending returns with the immutable Problem code and structured reason that refused the Request carrying them (too_deep, too_many_children,
   * ...); the user's turn names it until a Request to the seat carries them. ReturnRouter calls it.
   */
  hold(ids: readonly string[], code: string, problemReason?: ProblemReason): void {
    const tasks = new Set(ids.flatMap(id => { const row = this.tx.getReturn(id); return row ? [row.toTaskId] : []; }));
    return this.at({ tasks }).holdSelected(ids, code, problemReason);
  }
  private holdSelected(ids: readonly string[], code: string, problemReason?: ProblemReason): void {
    const reason = JSON.stringify(returnHold(code, problemReason));
    for (const row of this.rows) if (ids.includes(row.id) && returnDisposition(row) === 'pending')
      this.change({ kind: 'return', id: row.id }, 'UPDATE returns SET hold_reason=? WHERE id=? AND hold_reason IS NOT ?', reason, row.id, reason);
  }
  /**
   * This read point's deliveries, closing returns, wait cycles and resolutions, in that order: deliveries are consumed or
   * released, each Request that closed gets its closing return once (to requesterSeat), each cycle whose Requests all
   * closed records it, and what no seat should take any more is resolved. ReturnRouter.pass calls it.
   */
  reconcile(work?: RoutingTasks): { runs: RunRecord[]; requests: StoredRequest[]; returns: StoredReturn[] } {
    const view = this.at(work ?? { tasks: new Set(this.tasks.map(task => task.id)) });
    this.reconciled = view;
    return view.reconcileSelected(work);
  }
  private reconcileSelected(work?: RoutingTasks): { runs: RunRecord[]; requests: StoredRequest[]; returns: StoredReturn[] } {
    this.reconcileDeliveries(work);
    this.settleLoans([...work?.tasks ?? this.routing.tasks], new Date().toISOString());
    this.close(this.requests, work);
    const [condition, parameters]: [string, string[]] = work
      ? ['AND task_id IN (SELECT value FROM json_each(?))', [JSON.stringify([...work.tasks])]]
      : this.project === undefined ? ['', []] : [`AND ${PROJECT_REQUESTS_SQL}`, [this.project]];
    for (const cycle of this.db.prepare(`SELECT id FROM wait_cycles WHERE closed_at IS NULL ${condition}`).all(...parameters)) {
      const id = String(cycle.id);
      if (cycleClosed(this.requests.filter(request => request.waitCycleId === id), this.facts)) this.closeCycle(id);
    }
    this.clear(work);
    return { runs: this.records, requests: this.requests, returns: this.rows };
  }
  /**
   * The open wait cycle of a seat sending a Request, for the Request's wait_cycle_id. When every Request of the open
   * cycle has closed (return-rules closureOf), that cycle is closed first and a new one opens. Pending returns are
   * delivered independently; a Request sent after its siblings closed waits in a cycle of its own. RequestService
   * calls it when it admits a placement's Request.
   */
  cycleFor(seat: string): string {
    return this.seat(seat).cycleForSelected(seat);
  }
  private cycleForSelected(seat: string): string {
    const open = this.db.prepare('SELECT id FROM wait_cycles WHERE task_id=? AND closed_at IS NULL').get(seat);
    if (open) {
      const id = String(open.id);
      const requests = this.requests.filter(request => request.waitCycleId === id);
      if (!cycleClosed(requests, this.facts)) return id;
      this.close(requests);
      this.closeCycle(id);
    }
    const id = randomUUID();
    this.change({ kind: 'wait_cycle', id }, 'INSERT INTO wait_cycles(id,task_id,opened_at) VALUES (?,?,?)', id, seat, new Date().toISOString());
    return id;
  }
  /**
   * A notice to a seat in the caller's transaction, after the caller wrote its cause log there. task-questions
   * (question, answer, urgent), task-reports (urgent), task-commands and TaskTransition (work_changed) and placement-commands (handover)
   * call it.
   */
  notice(kind: ReturnNotice, toTaskId: string, causeLogId: string, multipleDestinations = false): void {
    const id = returnIdOf({ causeLogId, outcome: kind, ...(multipleDestinations ? { toTaskId } : {}) });
    this.change({ kind: 'return', id }, 'INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES (?,?,?,?,?)',
      id, toTaskId, kind, causeLogId, new Date().toISOString());
  }
  /** A child's change reaches the requester of its responsible, without closing that Request or its workers'. */
  workChanged(taskId: string, causeLogId: string): void {
    return this.seat(taskId).workChangedSelected(taskId, causeLogId);
  }
  private workChangedSelected(taskId: string, causeLogId: string): void {
    const facts = this.facts;
    const requests = this.requests.filter(request => request.taskId === taskId && facts.runOf.get(request.id)?.role === 'owner');
    const seats = openRequestsBySeat(requests, facts);
    for (const seat of seats.keys()) this.notice('work_changed', seat, causeLogId, seats.size > 1);
  }
  /** An open direct user instruction or a failure of that work awaiting the user. */
  hasUserWork(task: TaskDecisionFacts): boolean {
    const view = this.seat(task.id), facts = view.facts;
    if (view.requests.some(request => request.taskId === task.id && speaksForUser(request.author) &&
      facts.runOf.get(request.id)?.role === 'owner' && isOpen(request, facts))) return true;
    if (task.meta.baseState !== 'error') return false;
    const cause = taskFailure(task.meta.log);
    return cause !== undefined && userWorkFailed(task.id, cause.id, view.requests, facts);
  }

  /** A moved B may still be running when its instruction closes. Its new parent handles a later failure. */
  notifyMovedLoanFailure(task: TaskDecisionFacts, entry: TaskLog): void {
    const run = entry.runId ? this.tx.get(entry.runId) : undefined;
    const request = run ? this.tx.getRequest(run.requestId) : undefined;
    if (!request?.loanRequestId || this.tx.getReturn(returnIdOf({ requestId: request.id }))?.outcome !== 'moved') return;
    const view = this.seat(task.id);
    if (userWorkFailed(task.id, entry.id, view.requests, view.facts)) return;
    const parent = view.facts.tasks.get(task.meta.parentId ?? '');
    if (parent?.responsible) this.notice('work_changed', parent.id, entry.id);
  }
  /**
   * Apply the ordinary request closure at the write that can end a loan or its borrowed work. The
   * caller supplies fresh Task facts; a replaced responsible still holds the same recipient seat.
   */
  settleLoans(changed: readonly string[], at: string): void {
    const selected = JSON.stringify(changed);
    const grants = this.db.prepare(`SELECT q.id,c.task_id AS lender FROM requests q
      JOIN wait_cycles c ON c.id=q.wait_cycle_id WHERE q.task_id IN (SELECT value FROM json_each(?))
      AND q.lent_task_id IS NOT NULL AND q.loan_ended_at IS NULL`).all(selected);
    for (const grant of grants) {
      const loan = this.tx.getRequest(String(grant.id))!;
      const closure = closureOf(loan, this.facts);
      if (!closure && loan.deliveryState !== DELIVERY_STATE.aborted && !this.facts.closedRequests.has(loan.id)) continue;
      this.endLoan(loan, String(grant.lender), at, closure?.outcome === 'succeeded');
    }
    const borrowed = this.db.prepare(`SELECT q.id FROM requests q
      WHERE q.task_id IN (SELECT value FROM json_each(?)) AND q.loan_request_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.request_id=q.id)`).all(selected);
    if (borrowed.length) this.close([...this.tx.getRequests(borrowed.map(row => String(row.id))).values()]);
  }
  private endLoan(loan: StoredRequest, lender: string, at: string, completed: boolean): void {
    this.change({ kind: 'request', id: loan.id }, 'UPDATE requests SET loan_ended_at=? WHERE id=?', at, loan.id);
    if (completed) return; // The ordinary finish guard already requires the borrower to have taken every return.
    const uses = this.db.prepare(`SELECT q.id,r.id AS result FROM requests q LEFT JOIN returns r ON r.request_id=q.id
      WHERE q.loan_request_id=? AND q.delivery_state<>'aborted'`).all(loan.id);
    if (!uses.length) return;
    this.reconcileDeliveries({ tasks: new Set([loan.taskId]) });
    for (const use of uses) {
      const id = String(use.id);
      const result = use.result === null ? undefined : this.tx.getReturn(String(use.result));
      if (result && returnDisposition(result) === 'disposed') continue;
      this.change({ kind: 'request', id }, 'UPDATE requests SET return_task_id=? WHERE id=?', lender, id);
      if (result) {
        const delivery = activeDelivery(result);
        if (delivery) {
          this.release(result.id, delivery.wakeRequestId, 'not_delivered');
          this.cancelUndeliveredWake(delivery.wakeRequestId);
        }
        this.change({ kind: 'return', id: result.id }, 'UPDATE returns SET to_task_id=?,hold_reason=NULL WHERE id=?', lender, result.id);
      }
    }
    this.runsChanged();
  }

  /** A saved but unsent continuation contains the old destination's result text. Draw its input again. */
  private cancelUndeliveredWake(requestId: string): void {
    const request = this.tx.getRequest(requestId);
    if (!request?.runId || !isSeatContinuation(request.purpose)) return;
    const run = this.tx.get(request.runId);
    if (run?.state !== 'queued') return;
    this.tx.abortRequest(run, requestId);
    for (const row of this.rows) this.release(row.id, requestId, 'not_delivered');
    this.runsChanged();
  }
  /**
   * A Request on the user's behalf to a Task's responsible sends again what its agent may not have taken: the
   * deliveries to the Task whose receipt is unknown are released (resent_by_person), so that Request's carry takes
   * them, and the unknown inputs of `placementId`, the responsible's, are resolved (execution-control, which also ends
   * the queued Runs they carried). RequestService calls it before it reads the placement's conversation, so the
   * Request neither waits for nor resumes a Run ended here.
   */
  resendUnconfirmed(taskId: string, placementId: string): void {
    return this.seat(taskId).resendUnconfirmedSelected(taskId, placementId);
  }
  private resendUnconfirmedSelected(taskId: string, placementId: string): void {
    const selected = this.rows.flatMap(row => {
      const delivery = row.toTaskId === taskId ? activeDelivery(row) : undefined;
      return delivery ? [{ row, delivery }] : [];
    });
    const unknown = unknownReceipts(this.db, selected.map(each => each.delivery));
    for (const { row, delivery } of selected)
      if (unknown.has(delivery.wakeRequestId)) this.release(row.id, delivery.wakeRequestId, 'resent_by_person');
    resolveUncertainInputs(this.db, this.tx, placementId);
    this.runsChanged();
  }
  /**
   * Carries the returns waiting for a Task's responsible (pending, carried, or held with a reason) to a Request to it,
   * inserted before in this transaction, after clearing what no seat should take as reconcile does. RequestService calls
   * it for every Request to a responsible (W0) but a seat's own W1–W3 continuation, which reserves its wake's returns
   * alone; the server's own continuation (wake.isServerRequest) carries them after its reserve.
   */
  carry(taskId: string, requestId: string): void {
    return this.seat(taskId).carrySelected(taskId, requestId);
  }
  private carrySelected(taskId: string, requestId: string): void {
    this.clear();
    const at = new Date().toISOString();
    for (const row of this.rows) {
      const disposition = returnDisposition(row);
      if (row.toTaskId === taskId && this.applicable(row) && (disposition === 'pending' || disposition === 'carried')) this.deliver(row.id, requestId, at);
    }
  }
  /**
   * Reserves `ids`, the returns a seat's own continuation (purpose return_continuation) was drawn from (wake.deliverable), to its
   * Request, inserted before in this transaction, after clearing what no seat should take as reconcile does; false,
   * reserving none, when one of them is no longer pending. Only those go: the closing returns a wake leaves while a
   * Request the seat sent is open, and the carried ones, which only a Request to the seat takes, stay, unless the
   * continuation is the server's own (W0), which then carries them too (carry). RequestService calls it.
   */
  reserve(ids: readonly string[], requestId: string): boolean {
    return this.seat(this.tx.getRequest(requestId)?.taskId ?? '').reserveSelected(ids, requestId);
  }
  private reserveSelected(ids: readonly string[], requestId: string): boolean {
    this.clear();
    const pending = new Set(this.rows.filter(row => returnDisposition(row) === 'pending' && this.applicable(row)).map(row => row.id));
    if (!ids.every(id => pending.has(id))) return false;
    const at = new Date().toISOString();
    for (const id of ids) this.deliver(id, requestId, at);
    return true;
  }
  /**
   * Aborts the continuations still queued for a seat that wake.seatFailed says is failed, and carries their
   * deliveries, so a failed seat is not woken; the server's own Request (wake.isServerRequest, W0) goes on.
   * Only the work set's seats are considered. ReturnRouter calls it after reconciliation.
   */
  abortStaleContinuations(work: RoutingTasks): void {
    return this.at(work).abortStaleContinuationsSelected(work);
  }
  private abortStaleContinuationsSelected(work: RoutingTasks): void {
    const tasks = new Map(this.tasks.map(task => [task.id, task]));
    const requests = new Map(this.requests.map(request => [request.id, request]));
    let aborted = false;
    for (const run of this.records) {
      const request = requests.get(run.requestId), task = tasks.get(run.task);
      if (!work.tasks.has(run.task) || run.state !== 'queued' || !request || !isSeatContinuation(request.purpose) || !task ||
        !seatFailed(task.meta, seatRunBefore(this.tx.conversationRuns(run.placementId), run))) continue;
      if (!failedDeliveryBlocked(true, this.rows.filter(row => row.deliveries.some(delivery => delivery.wakeRequestId === request.id &&
        !delivery.releasedAt)))) continue;
      this.tx.abortRequest(run, request.id);
      for (const row of this.rows) for (const delivery of row.deliveries)
        if (delivery.wakeRequestId === request.id) this.release(row.id, request.id, 'seat_failed');
      aborted = true;
    }
    if (aborted) this.runsChanged();
  }
  /** Where an urgent note of the Task goes at this read point (return-rules urgentTarget); the user refuses it. */
  urgentTarget(taskId: string): string {
    return this.seat(taskId).urgentTargetSelected(taskId);
  }
  private urgentTargetSelected(taskId: string): string {
    return urgentTargetIn(taskId, this.requests, this.facts);
  }
  /**
   * The Requests a seat sent that have not closed: return-rules openRequests, derived by isOpen, over this
   * transaction's facts; never a stored cycle. TaskTransition reads it to tell whether a Task can finish.
   */
  openRequests(taskId: string): StoredRequest[] {
    return this.seat(taskId).openRequestsSelected(taskId);
  }
  private openRequestsSelected(taskId: string): StoredRequest[] {
    return openRequestsOf(taskId, this.requests, this.facts);
  }
  /**
   * The returns to a seat that nothing disposed and `runId` has not received: what a Task reporting from that Run still
   * has to take (TaskTransition). Made of the returns' disposition and the receipt reconcile reads; no rule of its own.
   */
  undelivered(taskId: string, runId?: string): StoredReturn[] {
    return this.seat(taskId).undeliveredSelected(taskId, runId);
  }
  private undeliveredSelected(taskId: string, runId?: string): StoredReturn[] {
    const rows = this.rows.filter(row => row.toTaskId === taskId && this.applicable(row) && returnDisposition(row) !== 'disposed');
    if (runId === undefined) return rows;
    const deliveries = rows.flatMap(row => { const delivery = activeDelivery(row); return delivery ? [delivery] : []; });
    const receipts = returnReceipts(this.db, deliveries.length ? this.records : [], deliveries);
    return rows.filter(row => {
      const delivery = activeDelivery(row);
      if (!delivery) return true;
      const receipt = receipts.get(delivery.wakeRequestId)!;
      return !receipt.received || receipt.actual?.id !== runId;
    });
  }
  /** Includes results closed before the router has written their Return; never treats absence as receipt. */
  unreceived(taskId: string, runId?: string): number {
    return this.seat(taskId).unreceivedSelected(taskId, runId);
  }
  private unreceivedSelected(taskId: string, runId?: string): number {
    return this.undelivered(taskId, runId).length + arrivingRequests(this.requests, this.facts)
      .filter(request => requesterSeat(request, this.facts) === taskId).length;
  }
  /**
   * Whether the seat awaited a return when `runId` ended at `endedAt`, as it was then, so the Run's boundary reads the
   * same at every later pass (TaskTransition boundary facts): a Request it had sent by then whose closing return, written
   * yet or not, it had not taken by then, or a notice to it made by then that was neither resolved nor taken by then.
   */
  awaiting(taskId: string, runId: string, endedAt: string): boolean {
    return this.seat(taskId).awaitingSelected(taskId, runId, endedAt);
  }
  private awaitingSelected(taskId: string, runId: string, endedAt: string): boolean {
    const end = Date.parse(endedAt), rows = pendingReturns(this.db, [taskId], endedAt);
    const closing = new Map(rows.flatMap(row => row.requestId === null ? [] : [[row.requestId, row] as const]));
    const historical = this.tx.getRequests(rows.flatMap(row => row.requestId === null ? [] : [row.requestId]));
    const sent = new Set(unclosedSent(this.db, this.root, [taskId]).get(taskId));
    const requests = [...new Map([...this.requests.filter(request => sent.has(request.id)), ...historical.values()].map(request => [request.id, request])).values()]
      .filter(request => !(Date.parse(request.submittedAt) > end) && awaitsClosure(request));
    const notices = rows.filter(row => row.requestId === null && row.toTaskId === taskId && this.applicable(row, endedAt) &&
      Date.parse(row.createdAt) <= end);
    const resolved = (row: StoredReturn) => row.resolution !== null && Date.parse(row.resolution.at) <= end;
    const candidates = [...requests.flatMap(request => {
      const row = closing.get(request.id);
      return row?.toTaskId === taskId ? [row] : [];
    }), ...notices].filter(row => !resolved(row));
    const deliveries = candidates.flatMap(row => row.deliveries);
    let receipts: Map<string, ReturnReceipt<RunRecord>> | undefined;
    // Keep the short-circuit read point: an unreceived return can answer before any Run record is needed.
    const takenBy = (delivery: ReturnDelivery) => {
      receipts ??= returnReceipts(this.db, this.routingRuns(rows), deliveries);
      const { received, actual } = receipts.get(delivery.wakeRequestId)!;
      return received && actual !== null && (actual.id === runId || ranToSuccess(actual) &&
        actual.ended_at !== null && Date.parse(actual.ended_at) <= end);
    };
    const settled = (row: StoredReturn) => resolved(row) || row.deliveries.some(takenBy);
    return requests.some(request => {
      const row = closing.get(request.id);
      // A closing return not written yet (the Request is open, or closed since the last reconcile) is still to come.
      return row === undefined ? requesterSeat(request, this.facts) === taskId : row.toTaskId === taskId && !settled(row);
    }) || notices.some(row => !settled(row));
  }

  /**
   * What a new responsible takes over: openRequests, and the returns to the seat not disposed (pending, carried or in
   * flight). The handover line draws it (return-lines).
   */
  openObligations(taskId: string): Obligations {
    return this.seat(taskId).openObligationsSelected(taskId);
  }
  private openObligationsSelected(taskId: string): Obligations {
    return openObligationsOf(taskId, this.requests, this.rows, this.facts, this.questionTasks);
  }
}
