import { mayCloseRequest, taskFailure } from './return-rules.js';
import { touch } from '@alpacawork/db';
import { questionSnapshot, questionApplicable } from './question-rules.js';
/**
 * The only writer of a Task (the one transition): its state through apply, every other record through
 * appendRecord, each in the caller's transaction at the Task's next revision. Who may make a change is authorize's
 * alone, so this takes the actor it decided and checks the Task's own facts with TASK_POLICY: a project never changes
 * state, finishBlocked, the responsible seat, the finished branch, and the ancestors a change reopens.
 */
import { lastStateReport } from './last-state-report.js';
import { createHash, randomUUID } from 'node:crypto';
import { Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { awaitsReview, startsEstimateRound } from '@alpacawork/contract';
import { activeBelow, type FinishedBranchIssue } from '@alpacawork/contract/branch';
import type { RunId } from '@alpacawork/contract/fields';
import { digest, openQuestions, questionsOf, speaksForUser, taskMetadata, userRequestedOf, type TaskBaseState, type ControlMetadata, type ControlTask, type ProjectSettings,
  type TaskActor, type TaskLifecycle, type TaskLog, type TaskState, type ConversationCheckpoint, type TaskValues } from '@alpacawork/raw';
import { RunStore, type RunTransaction, type StoredRequest } from '@alpacawork/runs';
import { ControlStore } from '@alpacawork/db';
import type { DatabaseSync } from 'node:sqlite';
import { PlacementStore } from './placements.js';
import { ReturnLifecycle } from './return-lifecycle.js';
import { endedOwnWork } from './return-rules.js';
import { evaluate, TASK_POLICY, terminal, type Operation, type OperationFacts } from '@alpacawork/contract/task-policy';
import { hasOpenUserQuestion } from '@alpacawork/raw/questions';
import { TaskRepository, assertActive, taskWriter } from './task-store.js';
import { startPath, startDecision } from './task-start-facts.js';

/** Translate policy outcomes at the application boundary; policy rules contain no UI words. */
const refusalReasons = {
  resume_scope_unknown: { kind: 'task_resume_scope_unknown' },
  request_invalidated_by_stop: { kind: 'task_request_invalidated_by_stop' },
  explicit_resume_scope_required: { kind: 'task_explicit_resume_scope_required' },
  resume_scope_stale_or_incomplete: { kind: 'task_resume_scope_stale_or_incomplete' },
  explicit_user_decision_required: { kind: 'task_explicit_user_decision_required' },
  stopped_requires_resume: { kind: 'stopped_task_requires_new_request' },
  only_user_requested_done_can_submit: { kind: 'review_submission_requires_user_requested_task' },
  not_current_review: { kind: 'task_not_waiting_for_review' },
  stop_facts_unknown: { kind: 'task_policy_facts_unavailable' },
  stop_operation_required: { kind: 'task_policy_facts_unavailable' },
  observed_start_fact_required: { kind: 'owner_run_start_not_observed' },
  run_end_facts_unknown: { kind: 'task_policy_facts_unavailable' },
} as const satisfies Record<string, ProblemReason>;
function policyRefusal(taskId: string, decision: { code: string; rule: string; policyVersion: string }): Problem {
  if (!(decision.code in refusalReasons)) throw new Error('Untranslated policy refusal: ' + decision.code);
  return new Problem(PROBLEM_CODE.conflict, decision.code, { task: taskId, rule: decision.rule, policyVersion: decision.policyVersion },
    { reason: refusalReasons[decision.code as keyof typeof refusalReasons] });
}

/**
 * One write's transaction, which every writer of a Task works in: the write's Run store, whose connection is the
 * write's control connection (writeOperationAsync's) and whose root is the workspace, and that store's transaction.
 * The services that open a write make it (report.ts and task-request.ts, task-commands, placement-commands,
 * ReturnRouter); TaskTransition, task-questions and task-reports take it.
 */
export type ControlTx = { store: RunStore; runs: RunTransaction };
/**
 * One control write: the Run store's transaction inside the control database's, on one connection, opened and closed
 * here alone. `db` is that connection, for the Task writes of the same transaction.
 */
export function withControlWrite<T>(root: string, execute: (tx: ControlTx, db: DatabaseSync) => T): T {
  const control = new ControlStore(root);
  try {
    return control.write(db => {
      const store = new RunStore(root, { busyTimeoutMs: 10_000 }, false, db);
      try { return store.write(runs => execute({ store, runs }, db)); }
      finally { store.close(); }
    });
  } finally { control.close(); }
}
/** The Task records of this write's transaction. */
export const tasksIn = (tx: ControlTx) => new TaskRepository(tx.store.root, tx.store.connection);
/** The return lifecycle at this write's read point of Task `taskId`: its branch and related seats, in its project. */
export function returnsAt(tx: ControlTx, taskId: string): ReturnLifecycle {
  const tasks = tasksIn(tx);
  return new ReturnLifecycle(tx.store.connection, tx.runs, tasks.related(taskId).tasks, tasks.projectFor(taskId), undefined, tx.store.root);
}
/** What a retried operation is compared by; its stored records keep this value. */
export const operationFingerprint = (input: object) => digest(Buffer.from(JSON.stringify(input)));
/**
 * What already holds an operation ID, which names one record across the workspace: a Task log (a Request's own
 * history entry among them), a Request. Each caller decides what its use refuses, in its own order.
 */
export function operationIdUse({ store, runs }: ControlTx, id: string): { logged: boolean; request: boolean } {
  return { logged: !!store.connection.prepare('SELECT 1 FROM task_log WHERE id = ?').get(id), request: !!runs.getRequest(id) };
}

/**
 * The writes of Task documents and their log (task-store's taskWriter: save, saveBatch and insertLogs), with the full
 * texts of new answers by log ID (log_texts) and each answer's or withdrawal's question
 * (task_log_question). task-store hands them to TaskTransition alone, and nothing else writes a Task
 * (tests/no-legacy-identifiers.test.ts, WRITER_PORTS);
 * TaskRepository.create, the only numbering, inserts a new Task.
 */
export type TaskWriter = {
  save(id: string, expectedHash: string | null, meta: ControlMetadata, previousLength: number, values?: TaskValues, settings?: ProjectSettings | null,
    texts?: ReadonlyMap<string, string>): string;
  saveBatch(changes: readonly { id: string; expectedHash: string; meta: ControlMetadata; previousLength: number }[]): void;
  insertLogs(taskUuid: string, previousLength: number, entries: readonly TaskLog[],
    texts?: ReadonlyMap<string, string>): void;
};

/**
 * What TaskTransition reads besides the Tasks, at the write's read point: the materials of finishBlocked,
 * each from its one owner. TaskTransition assembles it from its transaction.
 */
type TransitionFacts = {
  /** ReturnLifecycle.openRequests: the Requests the Task sent that have not closed. */
  openRequests(taskId: string): readonly StoredRequest[];
  /** ReturnLifecycle.unreceived: generated and arriving results not received by this Run. */
  unreceived(taskId: string, runId?: string): number;
  /** RunTransaction.unfinishedIn: the unfinished Runs on these Tasks but `exceptRunId`. */
  unfinishedRuns(taskIds: readonly string[], exceptRunId?: RunId): readonly RunId[];
};

/** The record a report or a decision writes with its state change: the operation's ID and its words. */
type TransitionRecord = {
  id: string; title: string | null; description: string | null; estimateMinutes?: number; operationFingerprint?: string;
  values?: TaskValues; checkpoint?: ConversationCheckpoint;
};
/**
 * One state change: who makes it, on which Task, when (now, or a Run's start or end time, which the record keeps as its
 * cause), and what its action needs. A Run's boundary writes its own record (LSTART/LEND); a report or a decision
 * brings the operation's.
 */
type Transition = { actor: TaskActor; taskId: string; at: string; record?: TransitionRecord } & (
  | { action: 'run_started' | 'run_ended'; runId: RunId }
  | { action: 'report_doing'; runId: RunId }
  /** Leads where doneTarget says; --urgent carries why it goes to the requester at once. */
  | { action: 'report_done'; runId: RunId; urgentReason?: string }
  /** The user's confirmation of the review of `aboutRun` (reviewTarget). */
  | { action: 'confirm'; aboutRun: RunId | null }
  /** Reopens a completed user-requested result for review, without manufacturing a Run. */
  | { action: 'submit_review' }
  | { action: 'hold' }
  /** A hold's return to `priorState`, checked against the current base. */
  | { action: 'unhold'; priorState: TaskState }
  /** The Task and every active unfinished Task below it; `runId` is the reporting Run's, if a Run reports it. */
  | { action: 'stop'; runId: RunId | null });

/** What a record changes of its Task besides the log: its title or values, its parent, its lifecycle, a project's settings. */
type DocumentChange = {
  title?: string; values?: TaskValues; parentId?: string; lifecycle?: TaskLifecycle; settings?: ProjectSettings | null;
};

/** What caused a linked state change: when (a Run's start or end time, for its boundary) and whose record it was. */
type Cause = { id: string; at: string; actor: TaskActor };
type BelowChange = { taskId: string; kind: 'none' | 'state' | 'values' | 'created' | 'restored' } | { taskId: string; kind: 'moved'; formerParentId: string };
type FinishRefusal = { questions: string[]; requests: number; undelivered: number; unfinished: string[]; runs: string[] };
type OwnerRunBoundary = { runState: 'running' | 'succeeded' | 'failed' | 'cancelled'; started: boolean; endedByReport: boolean; openQuestionAtEnd: boolean; awaitingAtEnd: boolean; responsibleAtEnd: boolean; baseState: TaskBaseState };

/** A Task's next document in one write, with what its record changes besides the log. */
type Change = { task: ControlTask; meta: ControlMetadata; values?: TaskValues; settings?: ProjectSettings | null;
  texts?: ReadonlyMap<string, string>; replyInput?: 'request' | 'doing' };

/**
 * One write's read point: the written branch, its ancestry and Request/return endpoints (TaskRepository.related), and the
 * facts besides them from the same transaction, each read once when first asked. No other project's Tasks, Runs,
 * Requests or returns are read.
 */
class ReadPoint implements TransitionFacts {
  readonly project: string;
  private related?: readonly ControlTask[];
  private readonly byId = new Map<string, ControlTask>();
  private readonly repository: TaskRepository;
  private lifecycle?: ReturnLifecycle;
  constructor(readonly tx: ControlTx, private readonly taskId: string, private readonly extra: readonly string[] = []) {
    this.repository = tasksIn(tx);
    this.project = this.repository.projectFor(taskId);
  }
  get tasks(): readonly ControlTask[] {
    if (!this.related) {
      this.related = this.repository.related(this.taskId, this.extra).tasks;
      for (const task of this.related) if (!this.byId.has(task.id)) this.byId.set(task.id, task);
    }
    return this.related;
  }
  task(id: string): ControlTask {
    let task = this.byId.get(id);
    if (!task) { task = this.repository.get(id); this.byId.set(id, task); }
    return task;
  }
  /** The return lifecycle over this read point's Tasks. */
  get returns(): ReturnLifecycle {
    return this.lifecycle ??= new ReturnLifecycle(this.tx.store.connection, this.tx.runs, this.tasks, this.project, undefined, this.tx.store.root);
  }
  openRequests(taskId: string): readonly StoredRequest[] { return this.returns.openRequests(taskId); }
  unreceived(taskId: string, runId?: string): number { return this.returns.unreceived(taskId, runId); }
  unfinishedRuns(taskIds: readonly string[], exceptRunId?: RunId): readonly RunId[] {
    return this.tx.runs.unfinishedIn(taskIds, exceptRunId);
  }

}

/** What TASK_POLICY.transition decides `action` of a Task on, whoever asks before the write does. */
export const operationFacts = (meta: ControlMetadata, action: Operation, actor: TaskActor): OperationFacts =>
  ({ baseState: meta.baseState, hold: meta.hold, action, explicit: speaksForUser(actor), userRequested: meta.userRequested,
    openUserQuestion: hasOpenUserQuestion(meta.log) });

export class TaskTransition {
  /** Bind the admitted instruction to this exact stopped path before its transaction commits. */
  captureStartGrant(tx: ControlTx, taskId: string, requestId: string, actor: TaskActor): void {
    const path = startPath(tx.store.connection, taskId);
    const intent = speaksForUser(actor) ? { id: requestId, targetTaskId: taskId, explicit: true,
      scope: path.filter(node => node.baseState === 'stopped').map(({ taskId, stopId }) => ({ taskId, stopId })) } : null;
    const decision = evaluate(TASK_POLICY.resumeScope, { targetTaskId: taskId, phase: 'admission', known: true, path, fence: null, intent });
    if (decision.kind === 'reject') throw policyRefusal(taskId, decision);
    tx.store.connection.prepare('INSERT INTO task_start_grants(request_id,path,intent) VALUES (?,?,?)')
      .run(requestId, JSON.stringify(path.map(({ taskId, stopId }) => ({ taskId, stopId }))), intent ? JSON.stringify(intent) : null);
    touch(tx.store.connection, { kind: 'start_grant', id: requestId });
  }
  /** One Task admission path. Explicit instructions have history references; automatic Requests remain canonical
   * in requests (the storage contract excludes their history references). Both carry the same owner work input. */
  appendRequestReference(tx: ControlTx, taskId: string, requestId: string, note: { title?: string; description?: string }): ControlTask {
    const request = tx.runs.getRequest(requestId);
    if (!request) throw new Error('An instruction reference needs its admitted Request');
    const read = new ReadPoint(tx, taskId), task = read.task(taskId), meta = taskMetadata({ ...task.meta, log: [...task.meta.log] });
    const placement = tx.runs.getPlacement(request.placementId);
    if (!placement) throw new Error('An admitted Request needs its placement');
    const role = placement.responsible ? 'owner' : 'worker';
    if (request.purpose !== 'return_continuation') meta.log.push({ id: request.id,
      kind: request.purpose === 'review_send_back' ? 'review_sent_back' : 'request_accepted', at: request.submittedAt, actor: request.author,
      title: note.title ?? null, description: note.description ?? null, fromState: task.meta.state, toState: null,
      startsEstimateRound: startsEstimateRound(request, { role }), ...(request.answersQuestion ? { answers: request.answersQuestion } : {}),
      ...(request.purpose === 'review_send_back' && request.aboutRunId ? { runId: request.aboutRunId } : {}) });
    this.write(read, [{ task, meta, ...(role === 'owner' ? { replyInput: 'request' as const } : {}) }], null, { id: request.id, at: request.submittedAt, actor: request.author }, false);
    return { ...task, meta };
  }
  /**
   * Applies one state change with TASK_POLICY and returns the Runs a stop stops, for runs/entry.stopRunsIn in the same
   * transaction. task-reports (reports, holds, stops, Run boundaries) and ReviewService (confirm) call it.
   */
  apply(tx: ControlTx, transition: Transition): { stoppedRuns: RunId[] } {
    const read = new ReadPoint(tx, transition.taskId), task = read.task(transition.taskId);
    if (task.meta.kind === 'project')
      throw new Problem(PROBLEM_CODE.invalidInput, `${task.id} is a project; a project has no working state`, { task: task.id },
        { reason: { kind: 'project_project_has_no_working_state', task: String(task.id) } });
    assertActive(task);
    const cause: Cause = { id: transition.record?.id ?? `${transition.action === 'run_started' ? 'LSTART' : 'LEND'}${'runId' in transition ? transition.runId : ''}`, at: transition.at, actor: transition.actor };
    const meta = taskMetadata({ ...task.meta, log: [...task.meta.log] }), changes: Change[] = [{ task, meta, values: transition.record?.values,
      ...(transition.action === 'report_doing' ? { replyInput: 'doing' as const } : {}) }];
    let stoppedRuns: RunId[] = [];
    const explicit = speaksForUser(transition.actor);
    const start = transition.action === 'run_started' ? this.startOf(read, transition.runId) : null;
    if (start?.kind === 'reject' && (transition.action === 'run_started')) {
      linkBoundary(read, task, meta, cause, transition.runId, start.rule, 'rejected_start');
      this.write(read, changes, null, cause, true);
      return { stoppedRuns: [transition.runId] };
    }
    const resumeAuthorized = explicit || start?.code === 'resume_scope_authorized';
    let operation: Operation = transition.action === 'run_ended' ? 'run_no_report' : transition.action;
    if (transition.action === 'run_started' || transition.action === 'run_ended') {
      const outcome = evaluate(TASK_POLICY.runEnd, boundary(read, task, transition.action, transition.runId));
      if (!outcome.baseState) {
        linkBoundary(read, task, meta, cause, transition.runId, outcome.rule, 'settled_end');
        this.write(read, changes, null, cause, true);
        return { stoppedRuns };
      }
      operation = transition.action === 'run_started' ? 'run_started' : 'run_failed';
    }
    const facts: OperationFacts = { ...operationFacts(task.meta, operation, transition.actor),
      observedStart: transition.action === 'run_started' && read.tx.runs.get(transition.runId)!.started_at !== null,
      stopFactsKnown: true, operationId: cause.id };
    const decision = evaluate(TASK_POLICY.transition, facts), hold = evaluate(TASK_POLICY.hold, facts);
    for (const result of [decision, hold]) if (result.kind === 'reject')
      throw policyRefusal(task.id, result);
    if (transition.action === 'unhold' && evaluate(TASK_POLICY.restore, { ...task.meta, requested: transition.priorState }).kind === 'reject')
      throw new Problem(PROBLEM_CODE.conflict, 'A hold returns to its current base stage', { task: task.id }, { reason: { kind: 'hold_returns_only_current_base' } });
    if (decision.needsFinish) finishable(read, task,
      transition.action === 'confirm' ? transition.aboutRun : 'runId' in transition ? transition.runId : null);
    meta.baseState = decision.baseState ?? meta.baseState;
    meta.hold = hold.hold ?? meta.hold;
    if (transition.action === 'run_started' || transition.action === 'run_ended')
      link(meta, meta.baseState, cause, { id: cause.id, runId: transition.runId, fromState: task.meta.state, ruleId: decision.rule, boundary: transition.action === 'run_started' ? 'accepted_start' : 'settled_end' });
    else report(task, meta, transition, decision.rule);
    if (decision.subtree) {
      const below = activeBelow(task.id, read.tasks.map(item => item.meta));
      for (const item of below) {
        const child = read.task(item.id);
        const target = evaluate(TASK_POLICY.stopTarget, { ...child.meta, active: child.meta.lifecycle === 'active' });
        if (!target.baseState) continue;
        const next = taskMetadata({ ...child.meta, log: [...child.meta.log] });
        link(next, target.baseState, cause, { ruleId: target.rule });
        changes.push({ task: child, meta: next });
      }
      stoppedRuns = [...read.unfinishedRuns([task.id, ...below.map(item => item.id)],
        'runId' in transition ? transition.runId ?? undefined : undefined)].filter(() => evaluate(TASK_POLICY.stopRun, { unfinished: true, reportingRun: false }).stopRuns);
    }
    const changed = meta.baseState !== task.meta.baseState ? 'state' : transition.record?.values !== undefined ? 'values' : 'none';
    this.write(read, changes, { taskId: task.id, kind: changed }, cause,
      transition.action === 'run_started' || transition.action === 'run_ended', resumeAuthorized);
    return { stoppedRuns };
  }
  private startOf(read: ReadPoint, runId: RunId) {
    const run = read.tx.runs.get(runId);
    if (!run) throw new Error('Observed start has no Run');
    return startDecision(read.tx.store.connection, run.requestId, run.task);
  }
  /**
   * Appends a record that keeps the state (a question, an answer, a withdrawal, a comment, a
   * mark, a placement change, a structure change with what it changes of the document), with a question's or an
   * answer's full text. An answer or a withdrawal preserves the current base and hold.
   * task-questions, task-reports (comments), task-commands and placement-commands call it.
   */
  appendRecord(tx: ControlTx, taskId: string, entry: TaskLog, text?: string, change?: DocumentChange): void {
    this.appendRecords(tx, taskId, [entry], text, change);
  }
  /** Related records and document fields advance the Task revision exactly once. */
  appendRecords(tx: ControlTx, taskId: string, entries: readonly TaskLog[], text?: string, change?: DocumentChange): void {
    if (!entries.length) throw new Error('A change needs a record');
    if (entries.some(entry => entry.toState !== null)) throw new Error('A record keeps the state; apply changes it');
    const entry = entries[0]!;
    const read = new ReadPoint(tx, taskId, change?.parentId ? [change.parentId] : []), task = read.task(taskId), meta = taskMetadata({ ...task.meta, log: [...task.meta.log] });
    const cause: Cause = { id: entry.id, at: entry.at, actor: entry.actor };
    meta.log.push(...entries);
    meta.userRequested = userRequestedOf(meta.log);
    if (change?.title !== undefined) meta.title = change.title;
    if (change?.parentId !== undefined) meta.parentId = change.parentId;
    if (change?.lifecycle !== undefined) meta.lifecycle = change.lifecycle;
    this.write(read, [{ task, meta, values: change?.values, settings: change?.settings,
      texts: text === undefined ? undefined : new Map([[entry.id, text]]) }], recordChange(task, meta, change),
      cause, false);
  }
  /**
   * Sends back the ancestors a change below reopens (TASK_POLICY.parentChild), for the one change written outside
   * apply and appendRecord: a Task's creation by TaskRepository.create. task-commands calls it.
   */
  reopenAncestors(tx: ControlTx, change: BelowChange): void {
    const read = new ReadPoint(tx, change.taskId), last = read.task(change.taskId).meta.log.at(-1);
    if (!last) throw new Error(`${change.taskId} has no record`);
    this.write(read, [], change, { id: last.id, at: last.at, actor: last.actor }, false);
  }
  /**
   * Writes the Tasks' next documents with the ancestors `below` sends back to doing (reopenTargets over the tree after
   * the change, nearest first), as one write: the finished-branch rule once over the whole of it, so an ancestor reopened
   * here is not refused as still finished; each Task at its next revision; and a responsible on each Task put to work,
   * unless the write records a Run's start or end (`runBoundary`): that happened whoever holds the seat now, as when
   * the responsible was released before a Run that failed to start ended.
   */
  private write(read: ReadPoint, changes: readonly Change[], below: BelowChange | null, cause: Cause,
    runBoundary: boolean, resumeAuthorized = false): void {
    const next = new Map(changes.map(change => [change.task.id, change]));
    for (const change of next.values()) closeReplyWaits(change, cause);
    const reopened = below && below.kind !== 'none' ? reopenAbove(read, next, below, cause, resumeAuthorized) : [];
    // Branch and notification rules acquire their old facts before any document is saved.
    const context = below || reopened.length || changes.some(change => change.task.meta.hold !== change.meta.hold)
      ? read.tasks : changes.map(change => change.task);
    const after = context.map(task => next.get(task.id)?.meta ?? task.meta);
    if (below) assertBranch(after, next, below);
    for (const change of next.values()) {
      if (openQuestions(change.meta.log).length + Number(change.meta.baseState === 'waiting') > 1)
        throw new Error(`Reply-wait invariant violated on ${change.task.id}`);
      change.meta.version = change.task.meta.version + 1n;
    }
    saveChanges(read, changes, next, after, cause);
    settleLoanChanges(read, next, cause);
    noticeChanges(read, changes, next, reopened, below, cause);
    if (!runBoundary) assertSeatsCovered(read, next);
  }
}

/** The next document of each Task a write changes, by its ID. */
type NextChanges = Map<string, Change>;

/** A record that answers a reply wait closes the Task's open questions and brings a waiting Task back to work. */
function closeReplyWaits(change: Change, cause: Cause): void {
  const before = change.task.meta, added = change.meta.log.slice(before.log.length);
  const input = added.some(entry => entry.kind === 'asked') ? 'question'
    : added.some(entry => entry.stage?.action === 'report_done' || entry.stage?.action === 'confirm') ? 'done'
    : change.replyInput ?? null;
  if (input === null) return;
  const closing: TaskLog[] = [];
  if (evaluate(TASK_POLICY.replyWait, { wait: 'question', input }).code === 'withdraw_question') {
    for (const question of openQuestions(before.log)) closing.push({
      id: 'LRW' + createHash('sha256').update(cause.id + ':' + question.id).digest('hex'),
      kind: 'question_withdrawn', at: cause.at, actor: cause.actor, title: null, description: null,
      fromState: null, toState: null, questionId: question.id, originCauseId: cause.id });
  }
  const decision = evaluate(TASK_POLICY.replyWait, { wait: 'review', input });
  if ((before.baseState === 'waiting' || closing.length > 0) && decision.baseState) {
    change.meta.log = [...before.log, ...closing];
    link(change.meta, decision.baseState, cause, { ruleId: decision.rule, fromState: before.state });
    change.meta.log.push(...added);
  } else change.meta.log = [...before.log, ...closing, ...added];
}

/** Adds to `next` the ancestors the change below sends back (TASK_POLICY.parentChild), nearest first, and returns them. */
function reopenAbove(read: ReadPoint, next: NextChanges, below: BelowChange, cause: Cause, resumeAuthorized: boolean): { id: string; logId: string }[] {
  const reopened: { id: string; logId: string }[] = [];
  const seen = new Set<string>();
  const changed = next.get(below.taskId)?.meta ?? read.task(below.taskId).meta;
  const climb = (parentId: string | null, childBase: TaskBaseState, direction: 'child_change' | 'structure_insert') => {
    for (let parent = parentId ? read.task(parentId) : undefined; parent?.meta.kind === 'task' && !seen.has(parent.id);
      parent = parent.meta.parentId ? read.task(parent.meta.parentId) : undefined) {
      seen.add(parent.id);
      const current = next.get(parent.id)?.meta ?? parent.meta;
      if (current.lifecycle !== 'active') break;
      let pair = evaluate(TASK_POLICY.parentChild, { parentBase: current.baseState, childBase, direction, resumeAuthorized });
      if (pair.kind === 'reject') throw branchProblem(parent.id, { kind: 'above', task: current });
      if (!pair.baseState && current.baseState === 'waiting')
        pair = evaluate(TASK_POLICY.replyWait, { wait: 'review', input: 'below' });
      if (pair.baseState) {
        const meta = taskMetadata({ ...current, log: [...current.log] });
        const logId = 'LWORK' + createHash('sha256').update(cause.id + ':' + parent.id).digest('hex');
        link(meta, pair.baseState, cause, { id: logId, ruleId: pair.rule });
        next.set(parent.id, { task: parent, meta });
        reopened.push({ id: parent.id, logId });
      }
      childBase = pair.baseState ?? current.baseState;
    }
  };
  climb(changed.parentId, changed.baseState, below.kind === 'state' || below.kind === 'values' ? 'child_change' : 'structure_insert');
  if (below.kind === 'moved') climb(below.formerParentId, changed.baseState, 'child_change');
  return reopened;
}

/** The finished-branch rule over the tree after the write: the path above the change, and everything below what changed. */
function assertBranch(after: readonly ControlMetadata[], next: NextChanges, below: BelowChange): void {
  // Validate the resulting path; an unchanged base checks it without propagating a new branch result.
  let child = after.find(item => item.id === below.taskId)!;
  const seen = new Set<string>();
  for (let parent = after.find(item => item.id === child.parentId); parent?.kind === 'task' && !seen.has(parent.id);
    parent = after.find(item => item.id === child.parentId)) {
    seen.add(parent.id);
    if (parent.lifecycle !== 'active') break;
    const check = evaluate(TASK_POLICY.parentChild, { parentBase: parent.baseState, childBase: child.baseState, direction: 'parent_operation' });
    if (check.kind === 'reject') throw branchProblem(child.id, { kind: 'above', task: parent });
    child = parent;
  }
  for (const id of new Set([...next.keys(), below.taskId])) {
    const parent = after.find(item => item.id === id)!;
    if (parent.lifecycle !== 'active') continue;
    for (const child of activeBelow(id, after)) {
      const childMeta = after.find(item => item.id === child.id)!;
      const check = evaluate(TASK_POLICY.parentChild, { parentBase: parent.baseState, childBase: childMeta.baseState, direction: 'parent_operation' });
      if (check.kind === 'reject') throw branchProblem(id, { kind: 'below', tasks: [child.id] });
    }
  }
}

/** The Tasks' next documents, and the stop epoch of each Task a stop reached. */
function saveChanges(read: ReadPoint, changes: readonly Change[], next: NextChanges, after: readonly ControlMetadata[], cause: Cause): void {
  const writer = taskWriter(read.tx.store.connection), [primary] = changes;
  if (primary) writer.save(primary.task.id, primary.task.hash, primary.meta, primary.task.meta.log.length, primary.values, primary.settings, primary.texts);
  writer.saveBatch([...next.values()].filter(change => change !== primary)
    .map(change => ({ id: change.task.id, expectedHash: change.task.hash, meta: change.meta, previousLength: change.task.meta.log.length })));
  if (changes[0]?.meta.log.at(-1)?.stage?.action === 'stop') {
    const stopped = changes[0].task.id;
    for (const id of [stopped, ...activeBelow(stopped, after).map(item => item.id)]) {
      read.tx.store.connection.prepare('INSERT INTO task_stop_epochs(task_id,stop_id) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET stop_id=excluded.stop_id').run(id, cause.id);
      touch(read.tx.store.connection, { kind: 'stop_epoch', id });
    }
  }
}

/** Close loans and borrowed instructions before any later operation can act on the new task records. */
function settleLoanChanges(read: ReadPoint, next: NextChanges, cause: Cause): void {
  const closing = [...next.values()].flatMap(change => {
    const added = change.meta.log.slice(change.task.meta.log.length);
    return added.some(mayCloseRequest) ? [{ id: change.task.id, meta: change.meta, failure: taskFailure(added) }] : [];
  });
  if (!closing.length) return;
  const db = read.tx.store.connection, closingIds = closing.map(change => change.id);
  const affected = db.prepare(`SELECT 1 FROM requests WHERE task_id IN (SELECT value FROM json_each(?))
    AND (lent_task_id IS NOT NULL AND loan_ended_at IS NULL OR loan_request_id IS NOT NULL) LIMIT 1`).get(JSON.stringify(closingIds));
  if (!affected) return;
  const tasks = tasksIn(read.tx), context = new Map<string, ControlTask>();
  for (const id of closingIds) for (const task of tasks.related(id).tasks) context.set(task.id, task);
  const lifecycle = new ReturnLifecycle(db, read.tx.runs, [...context.values()], read.project, undefined, read.tx.store.root);
  lifecycle.settleLoans(closingIds, cause.at);
  for (const change of closing) if (change.failure) lifecycle.notifyMovedLoanFailure(change, change.failure);
}

/** What the seats that still wait are told of this write: an ancestor it reopened, and a hold's change. */
function noticeChanges(read: ReadPoint, changes: readonly Change[], next: NextChanges, reopened: readonly { id: string; logId: string }[],
  below: BelowChange | null, cause: Cause): void {
  const lifecycle = reopened.length ? new ReturnLifecycle(read.tx.store.connection, read.tx.runs,
    read.tasks.map(task => ({ ...task, meta: next.get(task.id)?.meta ?? task.meta })), read.project, undefined, read.tx.store.root) : undefined;
  for (const item of reopened) {
    const decision = evaluate(TASK_POLICY.reopen, { changed: true, causeKnown: !!cause.id, deliveryKnown: true,
      recorded: false, closing: read.openRequests(item.id).some(request => request.taskId === below?.taskId && !lifecycle!.openRequests(item.id).some(open => open.id === request.id)), progressing: read.unfinishedRuns([item.id]).length > 0 });
    if (decision.kind === 'reject') throw new Error(decision.code);
    if (decision.continuation) lifecycle!.notice('work_changed', item.id, item.logId);
  }
  // Hold changes do not close the child's Requests. Notify the seats that still await them atomically.
  for (const change of changes) {
    if (change.task.meta.hold === change.meta.hold) continue;
    const held = change.meta.log.slice(change.task.meta.log.length)
      .find(entry => entry.stage?.action === 'hold' || entry.stage?.action === 'unhold');
    if (!held) continue;
    read.returns.workChanged(change.task.id, held.id);
  }
}

/** Each Task this write put to work has a responsible. A Run's boundary does not ask: it happened whoever holds the seat now. */
function assertSeatsCovered(read: ReadPoint, next: NextChanges): void {
  const changedStates = [...next.values()].filter(change =>
    change.meta.log.slice(change.task.meta.log.length).some(entry => entry.toState !== null)).map(change => change.task.id);
  // The placement owner distinguishes a snapshot leaf from a Task that still needs its seat for children.
  const uncovered = changedStates.length === 0 ? [] : new PlacementStore(read.tx.store.root, false, read.tx.store.connection)
    .uncoveredTasks(changedStates).map(item => item.taskId);
  if (uncovered.length) throw new Problem(PROBLEM_CODE.responsibleMissing, `Put a responsible on ${uncovered.join(', ')} before it works`, { tasks: uncovered },
    { reason: { kind: 'put_responsible_on_before_it_works', tasks: String(uncovered.join(', ')) } });
}

/**
 * Refuses to finish the Task while TASK_POLICY.finish says it cannot, read at this write's read point:
 * `runId` is the Run whose work finishes it (the reporting Run, or the Run the user's confirmation names), whose own
 * receipts count and which is not counted as unfinished.
 */
function finishable(read: ReadPoint, task: ControlTask, runId: RunId | null): void {
  const below = activeBelow(task.id, read.tasks.map(item => item.meta));
  const questionTasks = questionSnapshot(read.tasks);
  const questions = [...questionTasks.values()].flatMap(node => openQuestions(node.log).filter(q =>
    (node.id !== task.id && q.askedTo === task.id) && questionApplicable(node.id, q, questionTasks)).map(q => q.id));
  const requests = read.openRequests(task.id).length, undelivered = read.unreceived(task.id, runId ?? undefined);
  const unfinished = below.filter(item => !terminal(read.task(item.id).meta.baseState)).map(item => item.id);
  const runs = [...read.unfinishedRuns([task.id, ...below.map(item => item.id)], runId ?? undefined)];
  const decision = evaluate(TASK_POLICY.finish, { known: true, questions: questions.length, requests, undelivered,
    unfinishedBelow: unfinished.length, otherRuns: runs.length, needsReview: false, reviewFresh: true, reviewRunEnded: true });
  if (decision.kind === 'reject') throw finishProblem(task.id, decision.code, { questions, requests, undelivered, unfinished, runs });
}
/** A report's or a decision's record, under the operation's ID and words, with the state it leads to. */
function report(task: ControlTask, meta: ControlMetadata, transition: Transition, ruleId: string): void {
  const toState = transition.action === 'hold' ? 'held' : meta.baseState;
  const record = transition.record;
  const runId = transition.action === 'confirm' ? transition.aboutRun : 'runId' in transition ? transition.runId : null;
  meta.log.push({ id: record?.id ?? `L${randomUUID()}`, kind: transition.action === 'confirm' ? 'review_approved' : 'reported',
    at: transition.at, title: record?.title ?? null, description: record?.description ?? null, actor: transition.actor,
    stage: { version: 1, baseState: meta.baseState, hold: meta.hold, policyVersion: TASK_POLICY.version, ruleId, action: transition.action as 'report_doing' | 'report_done' | 'submit_review' | 'confirm' | 'stop' | 'hold' | 'unhold' },
    fromState: task.meta.state, toState: task.meta.state === 'held' && toState === 'held' ? null : toState, ...(runId === null ? {} : { runId }),
    ...(record?.estimateMinutes === undefined ? {} : { estimateMinutes: record.estimateMinutes }),
    ...(record?.operationFingerprint === undefined ? {} : { operationFingerprint: record.operationFingerprint }),
    ...(record?.checkpoint === undefined ? {} : { checkpoint: record.checkpoint }),
    ...(transition.action === 'report_done' && transition.urgentReason !== undefined
      ? { urgentReason: transition.urgentReason } : {}) });
}
/** A state change another record caused: a Run's boundary, a change below, a stop above, or a closed question. */
function link(meta: ControlMetadata, toState: TaskBaseState, cause: Cause,
  options: { ruleId: string; id?: string; runId?: RunId; fromState?: TaskState; boundary?: 'accepted_start' | 'settled_end' }): void {
  const { id = `L${randomUUID()}`, runId, fromState = meta.state, ruleId } = options;
  meta.baseState = toState;
  meta.log.push({ id, kind: 'linked', at: linkedAt(meta.log, cause.at), title: null, description: null, actor: cause.actor,
    stage: { version: 1, baseState: meta.baseState, hold: meta.hold, action: 'link', policyVersion: TASK_POLICY.version, ruleId, ...(options.boundary ? { boundary: options.boundary } : {}) },
    originCauseId: cause.id, fromState, toState, causeAt: cause.at, ...(runId === undefined ? {} : { runId }) });
}
/** A Run's boundary that leaves the Task's state as it is: the record says only why, under its Request as the cause. */
function linkBoundary(read: ReadPoint, task: ControlTask, meta: ControlMetadata, cause: Cause, runId: RunId, ruleId: string,
  boundary: 'rejected_start' | 'settled_end'): void {
  meta.log.push({ id: cause.id, kind: 'linked', at: linkedAt(meta.log, cause.at), title: null, description: null,
    actor: cause.actor, fromState: task.meta.state, toState: null, runId, causeAt: cause.at,
    originCauseId: read.tx.runs.get(runId)!.requestId,
    stage: { version: 1, baseState: meta.baseState, hold: meta.hold, action: 'link', policyVersion: TASK_POLICY.version, ruleId, boundary } });
}
/** After its cause and the Task's last record, so the log keeps its order while causeAt keeps the event's time. */
const linkedAt = (log: readonly TaskLog[], cause: string) => new Date(Math.max(Date.now(), Date.parse(cause) + 1,
  Date.parse(log.at(-1)?.at ?? cause) + 1)).toISOString();

/**
 * A responsible Run's start, or its end with the facts as they were then, for TASK_POLICY.runEnd: its last
 * state report, the questions open at its end, whether the seat awaited a return then, and whether its placement was
 * still the responsible when it ended (a handover's stop is not a person's).
 */
function boundary(read: ReadPoint, task: ControlTask, action: 'run_started' | 'run_ended', runId: RunId): OwnerRunBoundary {
  const run = read.tx.runs.get(runId), baseState = task.meta.baseState;
  if (!run || run.task !== task.id || run.role !== 'owner')
    throw new Problem(PROBLEM_CODE.notFound, 'Owner Run of the Task does not exist', { task: task.id, run: runId }, { reason: { kind: 'owner_run_task_does_not_exist' } });
  if (action === 'run_started') return { runState: 'running', started: true, endedByReport: false, openQuestionAtEnd: false,
    awaitingAtEnd: false, responsibleAtEnd: true, baseState };
  if (run.ended_at === null || !endedOwnWork(run.state))
    throw new Problem(PROBLEM_CODE.conflict, 'Run has not ended', { run: runId }, { reason: { kind: 'run_has_not_ended' } });
  const endedAt = run.ended_at, end = Date.parse(endedAt);
  const last = lastStateReport(task.meta.log, run.id, end);
  const lastDecision = [...task.meta.log].reverse().find(entry => entry.runId === run.id && Date.parse(entry.at) <= end &&
    (entry.kind === 'asked' || entry.kind === 'reported' && entry.toState !== null));
  const placement = read.tx.runs.getPlacement(run.placementId);
  return { runState: run.state, started: run.started_at !== null,
    endedByReport: last?.toState === 'done' || last?.toState === 'waiting',
    // An instruction still waiting for a different invocation cannot retroactively erase this Run's wait.
    // Joined input belongs to this invocation instead, so its missing replacement report remains an error.
    openQuestionAtEnd: questionsOf(task.meta.log).some(({ asked, closing }) => {
      if (Date.parse(asked.at) > end) return false;
      if (!closing || Date.parse(closing.at) > end) return true;
      if (asked.id !== lastDecision?.id || closing.kind !== 'question_withdrawn' || !closing.originCauseId) return false;
      const request = read.tx.runs.getRequest(closing.originCauseId);
      const receiver = request?.runId ? read.tx.runs.get(request.runId) : null;
      return request?.purpose === 'instruction' && request.taskId === task.id && receiver?.role === 'owner' &&
        receiver.id !== run.id && receiver.into !== run.id;
    }),
    awaitingAtEnd: read.returns.awaiting(task.id, run.id, endedAt),
    responsibleAtEnd: placement !== null && placement.responsible &&
      (placement.endedAt === null || Date.parse(placement.endedAt) > end),
    baseState };
}
/** How a record changed its Task for the ancestors above it (the change facts), or null when it did not. */
function recordChange(task: ControlTask, meta: ControlMetadata, change: DocumentChange | undefined): BelowChange | null {
  if (task.meta.parentId !== null && meta.parentId !== task.meta.parentId)
    return { taskId: task.id, kind: 'moved', formerParentId: task.meta.parentId };
  if (meta.lifecycle === 'active' && task.meta.lifecycle !== 'active') return { taskId: task.id, kind: 'restored' };
  return change?.values === undefined ? null : { taskId: task.id, kind: 'values' };
}

/** The finished-branch rule's refusal, as it reads for the Task written. */
function branchProblem(taskId: string, issue: FinishedBranchIssue): Problem {
  return issue.kind === 'below'
    ? new Problem(PROBLEM_CODE.finishedBranch, `Unfinished Tasks below ${taskId} (${issue.tasks.join(', ')}): make them done or stopped first`, { tasks: issue.tasks },
      { reason: { kind: 'unfinished_tasks_below_make_them_done_or_stopped_first', taskId: String(taskId), issueTasks: String(issue.tasks.join(', ')) } })
    : new Problem(PROBLEM_CODE.finishedBranch, `${issue.task.id} is ${issue.task.state}: nothing unfinished goes below a finished Task`, { task: issue.task.id },
      { reason: { kind: 'nothing_unfinished_goes_below_finished_task', task: String(issue.task.id), state: String(issue.task.state) } });
}
/** Why the Task cannot finish (TASK_POLICY.finish), as the reporting Run reads it. */
function finishProblem(taskId: string, code: string, facts: FinishRefusal): Problem {
  switch (code) {
    case 'open_question': return new Problem(PROBLEM_CODE.conflict, `${taskId} has open questions (${facts.questions.join(', ')}): withdraw them before finishing`, { questions: facts.questions },
      { reason: { kind: 'has_open_questions_withdraw_them_before_finishing', taskId: String(taskId), ids: String(facts.questions.join(', ')) } });
    case 'open_request': return new Problem(PROBLEM_CODE.conflict, `${taskId} has ${facts.requests} open Requests: finish after their returns`, { requests: facts.requests },
      { reason: { kind: 'has_open_requests_finish_after_their_returns', taskId: String(taskId), count: String(facts.requests) } });
    case 'undelivered_result': return new Problem(PROBLEM_CODE.conflict, `${facts.undelivered} returns to ${taskId} are not taken yet: finish after taking them`, { returns: facts.undelivered },
      { reason: { kind: 'returns_not_taken_yet_finish_after_taking_them', count: String(facts.undelivered), taskId: String(taskId) } });
    case 'unfinished_below': return branchProblem(taskId, { kind: 'below', tasks: facts.unfinished });
    case 'other_run_unfinished': return new Problem(PROBLEM_CODE.handoffPending, `Runs on ${taskId} or below are unfinished (${facts.runs.join(', ')})`, { runs: facts.runs },
      { reason: { kind: 'runs_on_or_below_unfinished', taskId: String(taskId), ids: String(facts.runs.join(', ')) } });
    default: throw new Error(code);
  }
}
