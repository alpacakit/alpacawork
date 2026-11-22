import type { ProblemReason } from '@alpacawork/core';
import { enabledAgents } from '@alpacawork/contract';
import { questionSnapshot, questionReturnApplicableBy } from './question-rules.js';
/**
 * Whether the server wakes a Task's responsible seat with the returns waiting for it (W1–W3), which of them go now,
 * and whether the seat is failed. Pure: a seat's facts are assembled here from one read point's source (seatFactsOf),
 * and nothing here reads the database. The router, the ball and the scheduler's gate read these; none decides a wake
 * or a seat's failure again.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { DEFAULT_LIMITS, type ReturnOutcome } from '@alpacawork/contract';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import type { RunId } from '@alpacawork/contract/fields';
import { compareRunIds, type ReadRunRecord, type RunState } from '@alpacawork/contract/run';
import type { TaskLifecycle, TaskState, TaskBaseState } from '@alpacawork/raw';
import type { TaskDecisionFacts } from './routing-facts.js';
import { automaticIndex, type AutomaticIndex, type ReadRunSnapshot, type RunTransaction, type StoredPlacement, type StoredRequest,
  type StoredReturn } from '@alpacawork/runs';
import type { AgentsSettingsResult } from '../agents-settings.js';
import { TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
import { takesInput } from '../runs/execution-control.js';
import { activeDelivery, returnDisposition, type ReturnLifecycle } from './return-lifecycle.js';
import { openRequestsBySeat, returnFacts, type ReturnFacts, type RunFacts } from './return-rules.js';

/** A return waiting for the seat: the one that closes a Request it sent, or a notice. */
export type SeatRow = { id: string; outcome: ReturnOutcome; holdReason: string | null; holdProblemReason?: ProblemReason | null; createdAt: string };

/** An owner Run of the seat. A joined Run did its work in the Run it joined, whose state `intoState` carries. */
type SeatRun = { state: RunState; intoState: RunState | null };

/** One responsible seat at one read point. */
export type SeatFacts = {
  lifecycle: TaskLifecycle;
  state: TaskState;
  baseState: TaskBaseState; hold: boolean;
  /**
   * The responsible placement's latest owner Run (null before its first): the previous Run `seatFailed` reads, and
   * whether, running, it takes input now (a queued Request would be fed to it).
   */
  head: (SeatRun & { inputOpen: boolean }) | null;
  /** This workspace still configures the responsible's agent profile. */
  profileAvailable: boolean;
  /** The placement's automatic wakes reached their limit, as the caller's automaticLimitReached read it. */
  automaticLimitReached: boolean;
  /** Returns delivered to the seat whose receipt is unknown, oldest first. */
  uncertain: readonly SeatRow[];
  /** How many Requests the seat sent are open (return-rules openRequests); a stored wait cycle is not read. */
  openRequests: number;
  /** The returns waiting to be delivered to the seat, oldest first. */
  pending: readonly SeatRow[];
};

/**
 * What seatFactsOf reads a seat's facts from: one read point, a snapshot's (the tree, the list) or a write
 * transaction's (TaskTransition, the router), so both give a seat the same facts. It only reads; seatFactsOf applies
 * every rule. seatSourceOf makes one of a Run snapshot (the router and RequestService read theirs inside their write);
 * TaskTransition implements its transaction's.
 */
export interface SeatSource {
  /** A Task of the read point (a snapshot's may come without its body), or undefined when it holds none. */
  task(taskId: string): TaskDecisionFacts | undefined;
  /** The Task's active responsible placement, or null. */
  responsible(taskId: string): StoredPlacement | null;
  /** The latest owner Run of a placement's conversation (ownerHead), or null before its first. */
  head(placementId: string): ReadRunRecord | null;
  /** A Run by ID: the one a joined Run joined. */
  run(id: RunId): ReadRunRecord | null;
  /** The Runs of Requests fed to a placement's working Run as input whose receipt is unknown (run_inputs uncertain). */
  uncertain(placementId: string): ReadonlySet<RunId>;
  /**
   * A Run's attempt takes no input now: it has a diagnostic, or an input to it is not settled (taken, not sent or
   * resolved). planInputs reads the same fact of the Run it would feed.
   */
  inputClosed(runId: RunId): boolean;
  /** The returns to a seat, oldest first, whatever their disposition. */
  returnsTo(taskId: string): readonly StoredReturn[];
  /** The read point's Requests; rows remain mutable, while automatic captures its own primitive facts eagerly. */
  readonly requests: readonly StoredRequest[];
  /** Automatic-limit facts fixed at source creation, independent of later changes to the original Request rows. */
  readonly automatic: AutomaticIndex;
  /** The return rules' facts of the read point, indexed once. */
  readonly facts: ReturnFacts;
  /** The open Requests a seat sent (return-rules openRequestsBySeat), every seat's judged once when first asked. */
  openSent(taskId: string): readonly StoredRequest[];
  /** The agent profiles the workspace configures, and how many automatic wakes a placement takes. */
  readonly profiles: ReadonlySet<string>;
  readonly automaticLimit: number;
}

/**
 * The seat's latest owner Run out of a placement's conversation (its Runs but those of aborted Requests, in Run-number
 * order), as the scheduler's gate reads the Run before a queued one: a worker Run the placement ran before it became
 * the responsible is not the seat's turn. Null before its first.
 */
export const ownerHead = <Run extends ReadRunRecord>(conversation: readonly Run[]): Run | null =>
  conversation.filter(run => run.role === 'owner' && run.state !== 'joined').at(-1) ?? null;

/**
 * The seat's owner Run before `run` in its placement's conversation (ownerHead of the Runs before it), as seatFailed
 * reads it for the seat a queued Run would wake. ownerHead is never a joined Run, so it names no Run it joined. The
 * scheduler's gate and ReturnLifecycle's withdrawal of failed continuations call it.
 */
export function seatRunBefore(conversation: readonly ReadRunRecord[], run: ReadRunRecord): SeatRun | null {
  const prior = ownerHead(conversation.filter(other => other.supersededBy === undefined && compareRunIds(other, run) < 0));
  return prior && { state: prior.state, intoState: null };
}

/** Each placement's ownerHead in a Run snapshot's records (in Run-number order) and Requests; none before its first. */
export function ownerHeadsOf<Run extends ReadRunRecord>(records: readonly Run[],
  requests: readonly Pick<StoredRequest, 'id' | 'deliveryState'>[]): ReadonlyMap<string, Run> {
  const aborted = new Set(requests.filter(request => request.deliveryState === DELIVERY_STATE.aborted).map(request => request.id));
  const conversations = new Map<string, Run[]>();
  for (const run of records) {
    if (aborted.has(run.requestId)) continue;
    const conversation = conversations.get(run.placementId);
    if (conversation) conversation.push(run); else conversations.set(run.placementId, [run]);
  }
  const heads = new Map<string, Run>();
  for (const [placementId, conversation] of conversations) {
    const head = ownerHead(conversation);
    if (head) heads.set(placementId, head);
  }
  return heads;
}

/** `rows` by the Task each is to, in the order given: a read point's returns or Requests, indexed once. */
export function rowsByTask<Row>(rows: readonly Row[], taskOf: (row: Row) => string): ReadonlyMap<string, readonly Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(taskOf(row));
    if (group) group.push(row); else groups.set(taskOf(row), [row]);
  }
  return groups;
}

type SeatSettings = Pick<SeatSource, 'profiles' | 'automaticLimit'>;
/**
 * What the workspace's agents settings give every seat: the profiles it configures and the automatic limit. A broken
 * config.yaml configures no profile and keeps the default limit, so a snapshot's seats and a write's agree.
 */
export const seatSettings = (settings: AgentsSettingsResult): SeatSettings => ({
  profiles: new Set(settings.ok ? enabledAgents(settings.config.agents).map(([key]) => key) : []),
  automaticLimit: (settings.ok ? settings.config.limits : DEFAULT_LIMITS).automatic_per_placement,
});

/**
 * The seat source of one read point's Tasks (with every project Task) and Run snapshot, each indexed once: a Task is
 * responsible while an active responsible placement holds it. ReturnRouter and RequestService read seats through it.
 */
export function seatSourceOf(tasks: readonly TaskDecisionFacts[], runs: ReadRunSnapshot,
  settings: SeatSettings): SeatSource {
  const records = runs.records;
  if (!records) throw runs.runError;
  const byRun = new Map(records.map(run => [run.id, run]));
  const responsible = new Map(runs.placements.filter(placement => placement.active && placement.responsible)
    .map(placement => [placement.taskId, placement]));
  const heads = ownerHeadsOf(records, runs.requests);
  const none: ReadonlySet<RunId> = new Set();
  return seatSource(tasks, responsible, records, runs.returns, runs.requests, settings, {
    head: placementId => heads.get(placementId) ?? null,
    run: id => byRun.get(id) ?? null,
    uncertain: placementId => runs.uncertainInputs.get(placementId) ?? none,
    inputClosed: id => runs.inputClosed.has(id),
  });
}

/**
 * The seat source of a write's read point: `tasks`, of `project`, with their placements, Runs, Requests and returns
 * read from `runs`, the write's transaction. A seat's latest owner Run and input facts are read from the transaction
 * when asked. TaskTransition's read point and ReturnRouter read seats through it; the source is used only while that
 * transaction lasts.
 */
export function seatSourceIn(runs: RunTransaction, project: string, tasks: readonly TaskDecisionFacts[], settings: SeatSettings,
  held?: ReturnLifecycle['current']): SeatSource {
  const ids = tasks.map(task => task.id);
  const responsible = new Map((held?.responsible ?? runs.responsiblePlacements(project, ids)).map(placement => [placement.taskId, placement]));
  const returns = held?.returns ?? runs.returns(project, ids), requests = held?.requests ?? runs.requests(project, ids);
  return seatSource(tasks, responsible, held?.facts ?? runs.returnRuns(project, ids), returns, requests, settings, {
    head: placementId => ownerHead(runs.conversationRuns(placementId)),
    run: id => runs.get(id),
    uncertain: placementId => runs.uncertain(placementId),
    inputClosed: id => runs.inputClosed(id),
  });
}

/** What every read point gives a seat source alike: the returns to each Task and the return rules' facts, indexed once. */
function seatSource(tasks: readonly TaskDecisionFacts[], responsible: ReadonlyMap<string, StoredPlacement>,
  factRuns: Iterable<RunFacts> | ReturnFacts, returns: readonly StoredReturn[], requests: readonly StoredRequest[], settings: SeatSettings,
  runReads: Pick<SeatSource, 'head' | 'run' | 'uncertain' | 'inputClosed'>): SeatSource {
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const questionTasks = questionSnapshot(tasks);
  // Which Task holds a log entry: indexed when a question's return first asks, so a source with none never builds it.
  let askers: ReadonlyMap<string, string> | undefined;
  const asker = (logId: string) => (askers ??= new Map(tasks.flatMap(task => task.meta.log.map(entry => [entry.id, task.id] as const)))).get(logId);
  const returnsTo = rowsByTask(returns.filter(row => questionReturnApplicableBy(row, asker, questionTasks)), row => row.toTaskId);
  // A read point that already holds the return rules' facts passes them; any other passes the Runs they come from.
  const facts = Symbol.iterator in factRuns
    ? returnFacts(tasks.map(task => ({ ...task.meta, responsible: responsible.has(task.id) })), factRuns, returns) : factRuns;
  let sent: ReadonlyMap<string, readonly StoredRequest[]> | undefined;
  return {
    ...runReads,
    task: id => byTask.get(id),
    responsible: id => responsible.get(id) ?? null,
    returnsTo: id => returnsTo.get(id) ?? [],
    requests, automatic: automaticIndex(requests), facts,
    openSent: taskId => (sent ??= openRequestsBySeat(requests, facts)).get(taskId) ?? [],
    profiles: settings.profiles, automaticLimit: settings.automaticLimit,
  };
}

/** The Task and the Tasks above it, nearest first, as far as the source holds them. */
function ancestry(source: SeatSource, taskId: string): string[] {
  const ids: string[] = [];
  for (let task = source.task(taskId); task; task = task.meta.parentId === null ? undefined : source.task(task.meta.parentId))
    ids.push(task.id);
  return ids;
}

/**
 * The head as seatFailed and the busy rule read it. It takes input now when the Run doing its work (a joined head's
 * `into`) is one planInputs would feed a queued Request to, by planInputs' own predicate (takesInput).
 */
function headOf(source: SeatSource, head: ReadRunRecord): NonNullable<SeatFacts['head']> {
  const into = head.state === 'joined' && head.into !== null ? source.run(head.into) : null;
  const working = head.state === 'joined' ? into : head;
  return { state: head.state, intoState: into?.state ?? null,
    inputOpen: working !== null && takesInput(working, source.inputClosed(working.id)) };
}

/**
 * A seat's facts at the source's read point: the only assembly of SeatFacts (the automatic limit by
 * AutomaticIndex.reached, receipts unknown by the source's uncertain, open Requests by the source's openSent).
 * ReturnRouter, RequestService, TaskTransition and ballFactsOf call it. A seat without a responsible is not stopped
 * here: admission refuses it (responsible_missing), which its returns then hold.
 */
export function seatFactsOf(source: SeatSource, taskId: string): SeatFacts {
  const task = source.task(taskId);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  const placement = source.responsible(taskId);
  const head = placement && source.head(placement.id);
  // A delivery's receipt is unknown while the input that fed its wake Request's Run to a working Run is uncertain.
  const unknown = (row: StoredReturn) => {
    const delivery = activeDelivery(row);
    const wake = delivery && source.facts.runOf.get(delivery.wakeRequestId);
    const run = wake && source.run(wake.id);
    return !!run && source.uncertain(run.placementId).has(run.id);
  };
  const rows = source.returnsTo(taskId);
  return {
    lifecycle: task.meta.lifecycle, state: task.meta.state, baseState: task.meta.baseState, hold: task.meta.hold,
    head: head ? headOf(source, head) : null,
    profileAvailable: !placement || source.profiles.has(head?.agent ?? placement.profileKey),
    automaticLimitReached: !!placement &&
      source.automatic.reached(placement.id, ancestry(source, taskId), source.automaticLimit),
    uncertain: rows.filter(row => returnDisposition(row) === 'in_flight' && unknown(row)),
    openRequests: source.openSent(taskId).length,
    pending: rows.filter(row => returnDisposition(row) === 'pending'),
  };
}

/** Why a wake waits on the seat's own facts; nobody is asked. */
export type SeatWait = 'finished' | 'held' | 'failed' | 'needs_review' | 'busy' | 'outstanding' | 'nothing';
/**
 * Why the seat is not woken now. A human block is the user's turn: the automatic limit, a delivery whose receipt is
 * unknown, a missing agent profile, or an admission refusal named by the Problem code it was held with (too_deep,
 * too_many_children, not_resumable, responsible_missing, ...). It dates from the first return it stops, and its key
 * names that return, so the turn stays the same until the return is delivered or carried.
 */
export type WakeBlock =
  | { code: SeatWait; human: false; key: null; at: null; count: null }
  | { code: string; human: true; key: string; at: string; count: number | null; problemReason?: ProblemReason };

/** The state a Run's work ended in: a joined Run's is the Run it joined. */
const workState = (run: SeatRun) => run.state === 'joined' ? run.intoState : run.state;

/**
 * The returns that make a seat's continuation the server's own Request (W0), not a W1–W3 wake: a handover
 * to a new responsible and a child added. A Request is admitted, and wakes, a seat W1–W3 would not (failed, or
 * waiting for the user's review); its Run's start brings the Task back to work.
 */
const SERVER_REQUESTS = TASK_POLICY.delivery.serverRequests;
/** Whether `rows`, the returns a continuation carries, make it the server's Request (W0). */
export const isServerRequest = (rows: readonly Pick<SeatRow, 'outcome'>[]): boolean =>
  rows.some(row => SERVER_REQUESTS.includes(row.outcome));

/**
 * The seat is failed: its Task is in error, or its responsible's previous owner Run failed. A stop is not a failure
 * here; whether a stopped Run puts the Task in error is the Task state's rule.
 */
export function seatFailed(task: { baseState: TaskBaseState }, priorRun: SeatRun | null): boolean {
  return evaluate(TASK_POLICY.seatFailure, { baseState: task.baseState, previousFailed: priorRun !== null && workState(priorRun) === 'failed' }).code === 'failed';
}
export const failedDeliveryBlocked = (failed: boolean, rows: readonly Pick<SeatRow, 'outcome'>[]): boolean =>
  evaluate(TASK_POLICY.deliveryFailure, { failed, serverRequest: isServerRequest(rows), workChanged: rows.some(row => row.outcome === 'work_changed') }).code === 'failure';

/** Why the seat is not woken with its pending returns now; null when it is. */
export const wakeBlock = (seat: SeatFacts): WakeBlock | null => deliverable(seat, seat.pending).block;

/**
 * The returns that wake the seat now, out of its pending ones as the caller holds them, and what stops them. Requests
 * the seat sent may still be open: every pending result and notice at this read point goes together. Request
 * completion is independent of delivery selection. The wake's Request carries these alone
 * (ReturnLifecycle.reserve); a carried return waits for a Request to the seat.
 */
export function deliverable<Row extends SeatRow>(seat: SeatFacts,
  pendingRows: readonly Row[]): { rows: Row[]; block: WakeBlock | null } {
  const rows = [...pendingRows];
  return { rows, block: blockOf(seat, rows) };
}

/** The first rule that stops delivering `rows`, in order. The user is asked only when something is to go. */
function blockOf(seat: SeatFacts, rows: readonly SeatRow[]): WakeBlock | null {
  const wait = (code: SeatWait): WakeBlock => ({ code, human: false, key: null, at: null, count: null });
  const ask = (code: string, row: SeatRow, problemReason?: ProblemReason | null): WakeBlock =>
    ({ code, human: true, key: `${code}:${row.id}`, at: row.createdAt, count: null,
      ...(problemReason ? { problemReason } : {}) });
  const first = rows[0], unknown = seat.uncertain[0], refused = rows.find(row => row.holdReason !== null);
  const headState = seat.head && workState(seat.head);
  const result = evaluate(TASK_POLICY.wake, { baseState: seat.baseState, hold: seat.hold, active: seat.lifecycle === 'active',
    failed: seatFailed(seat, seat.head), serverRequest: isServerRequest(rows), workChanged: rows.some(row => row.outcome === 'work_changed'),
    hasRows: !!first, profile: seat.profileAvailable, limit: seat.automaticLimitReached, uncertain: !!unknown,
    refused: !!refused, needsReview: headState === 'needs_review', busy: headState === 'queued' || headState === 'running' && !seat.head?.inputOpen });
  switch (result.code) {
    case 'finished': case 'held': return wait(result.code);
    case 'failure': return wait('failed');
    case 'no_profile': return ask('no_profile', first!);
    case 'automatic_limit': return { code: 'automatic_limit', human: true, key: `limit:${first!.id}`, at: first!.createdAt, count: rows.length };
    case 'uncertain': return ask('uncertain', unknown!);
    case 'refused': return ask(refused!.holdReason!, refused!, refused!.holdProblemReason);
    case 'run_review': return wait('needs_review');
    case 'active': return wait('busy');
    case 'nothing_deliverable': return wait(seat.openRequests > 0 ? 'outstanding' : 'nothing');
    case 'deliver': return null;
    default: throw new Error('Unlisted delivery result');
  }
}
