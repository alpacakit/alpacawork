import type { ProblemReason } from '@alpacawork/core/reasons';
/** The versioned meaning of Task state, relationships, responsibilities and delivery.
 * Facts are supplied by their owners. This module has no database, process, clock or UI vocabulary. */
import type { Ball } from './ball.js';
import type { TaskBaseState, TaskStage, TaskState } from '@alpacawork/raw';

export type Decision = { kind: 'reject' | 'cochange' | 'keep'; code: string;
  baseState?: TaskBaseState; hold?: boolean;
  needsFinish?: boolean; needsReview?: boolean; continuation?: boolean;
  seat?: string | null; subtree?: boolean; stopRuns?: boolean; invalidateRequest?: boolean };
type Rule<F> = { id: string; priority: number; when: (facts: F) => boolean; out: (facts: F) => Decision };
type Entries<F> = readonly (readonly [string, (facts: F) => boolean, Decision | ((facts: F) => Decision)])[];
const table = <F>(entries: Entries<F>): readonly Rule<F>[] => entries.map(([id, when, result], priority) =>
  ({ id, priority, when, out: typeof result === 'function' ? result : () => result }));
const reject = (code: string): Decision => ({ kind: 'reject', code });
const keep = (code: string, fields: Omit<Partial<Decision>, 'code' | 'kind'> = {}): Decision => ({ kind: 'keep', code, ...fields });
const change = (code: string, fields: Omit<Partial<Decision>, 'code' | 'kind'>): Decision => ({ kind: 'cochange', code, ...fields });
type Evaluation = Decision & { rule: string; policyVersion: string; all: (Decision & { rule: string; priority: number })[] };
export function evaluate<F>(rules: readonly Rule<F>[], facts: F, cumulative = false): Evaluation {
  const first = cumulative ? undefined : rules.find(row => row.when(facts));
  const rows = cumulative ? rules.filter(row => row.when(facts)) : first ? [first] : [];
  if (!rows[0]) throw new Error('Unlisted Task policy facts');
  const selected = cumulative ? rows : [rows[0]];
  return { ...rows[0].out(facts), rule: rows[0].id, policyVersion: TASK_POLICY.version,
    all: selected.map(row => ({ ...row.out(facts), rule: row.id, priority: row.priority })) };
}
export const terminal = (state: string | null | undefined) => state === 'done' || state === 'stopped';
export type Operation = 'report_doing' | 'report_done' | 'submit_review' | 'confirm' | 'stop' | 'resume' |
  'run_started' | 'run_failed' | 'run_no_report' | 'answer' | 'withdraw' | 'hold' | 'unhold';
type UserQuestionFacts = { openUserQuestion?: boolean };
export type OperationFacts = TaskStage & UserQuestionFacts & { action: Operation; explicit: boolean; userRequested: boolean;
  observedStart?: boolean; stopFactsKnown?: boolean; operationId?: string;
  end?: { known: boolean; reported: boolean; questions: number; requests: number; awaitingAtEnd: boolean } };
/** Whether the policy can record the base-state change for some admitted task operation. */
export function mayChangeTaskBaseState(from: TaskBaseState, to: TaskBaseState, userRequestedOnly = false): boolean {
  if (from === to) return false;
  const actions = ['report_doing', 'report_done', 'submit_review', 'confirm', 'stop', 'resume',
    'run_started', 'run_failed', 'run_no_report'] as const satisfies readonly Operation[];
  return (userRequestedOnly ? [true] : [true, false]).some(userRequested => (from !== 'waiting' || userRequested) && actions.some(action =>
    evaluate(TASK_POLICY.transition, { baseState: from, hold: false, action, userRequested, explicit: true,
      openUserQuestion: true, observedStart: true, stopFactsKnown: true, operationId: 'operation',
      end: { known: true, reported: false, questions: 0, requests: 0, awaitingAtEnd: false } }).baseState === to));
}
type ReportIntentFacts = TaskStage & UserQuestionFacts & { state: TaskState; reporter: 'outside' | 'own' | 'other'; confirmation: boolean };
type RowStatusFacts = { state: TaskState; running: boolean; troubled: boolean; queued: boolean; below: number; since: boolean; reason: boolean };
type PairFacts = { parentBase: TaskBaseState; childBase: TaskBaseState;
  direction: 'parent_operation' | 'child_change' | 'structure_insert'; resumeAuthorized?: boolean };
export type FinishFacts = { known: boolean; questions: number; requests: number; undelivered: number;
  unfinishedBelow: number; otherRuns: number; needsReview: boolean; reviewFresh: boolean; reviewRunEnded: boolean };
type WakeFacts = TaskStage & { active: boolean; failed: boolean; serverRequest: boolean; workChanged: boolean;
  hasRows: boolean; profile: boolean; limit: boolean; uncertain: boolean; refused: boolean; needsReview: boolean; busy: boolean };
type StartNode = TaskStage & { taskId: string; stopId: string | null };
export type StartFacts = { targetTaskId: string; known: boolean; phase: 'admission' | 'queued_start'; path: readonly StartNode[];
  fence: readonly Pick<StartNode, 'taskId' | 'stopId'>[] | null;
  intent: { id: string; targetTaskId: string; explicit: boolean; scope: readonly Pick<StartNode, 'taskId' | 'stopId'>[] } | null };
/** A failure the user decides: work they asked for, or work whose requester waits on their answer. */
const userDecidesFailure = (f: BallFacts) => f.baseState === 'error' && (f.requester === 'user' || f.requesterAskedUser);
const BALL_RULES = table<BallFacts & { result?: Ball }>([
  ['B01', f => f.lifecycle !== 'active' || ['todo', 'done', 'stopped'].includes(f.baseState), keep('none')],
  ['B02', f => f.baseState === 'waiting' && !!f.review && (f.review.taskSnapshot || f.review.runId !== null), keep('review')],
  ['B03', f => !!f.block?.human, keep('gate')],
  ['B04', f => f.openQuestions.some(q => q.askedTo === null), keep('question')],
  ['B05', f => userDecidesFailure(f), keep('failed_user')],
  ['B06', f => f.openQuestions.some(q => q.askedTo !== null), keep('parent_question')],
  ['B07', f => f.baseState === 'error', keep('failed_parent')],
  ['B08', f => f.openRequests > 0, keep('child')],
  ['B09', () => true, keep('owner')],
]);
export const TASK_POLICY = {
  version: 'question-done-1',
  actionCandidates: table<TaskStage & UserQuestionFacts & { userRequested: boolean }>([
    ['AC01', f => f.baseState !== 'stopped', keep('report_doing')],
    ['AC02', f => f.baseState !== 'stopped', keep('report_done')],
    ['AC03', f => f.baseState === 'done' && f.userRequested, keep('submit_review')],
    ['AC04', f => f.baseState === 'waiting' || f.baseState === 'doing' && !!f.openUserQuestion, keep('confirm')],
    ['AC05', f => f.hold || !terminal(f.baseState), keep('stop')],
    ['AC06', f => f.baseState === 'stopped', keep('resume')],
    ['AC07', f => !f.hold, keep('hold')],
    ['AC08', f => f.hold, keep('unhold')],
  ]),
  seat: table<{ baseState: TaskBaseState; snapshotReview: boolean }>([
    ['SE01', f => ['doing', 'waiting', 'error'].includes(f.baseState) && !f.snapshotReview, keep('required')],
    ['SE02', () => true, keep('not_required')],
  ]),
  rowStatus: table<RowStatusFacts>([
    ['RD01', f => f.running, keep('own_running')],
    ['RD02', f => ['doing', 'todo'].includes(f.state) && f.troubled, keep('runtime_unclear')],
    ['RD02b', f => f.reason && f.since, keep('state_since')],
    ['RD03', f => ['doing', 'todo'].includes(f.state) && f.queued, keep('queued')],
    ['RD04', f => f.state === 'todo', keep('not_started')],
    ['RD05', f => f.state === 'doing' && f.below > 0, keep('no_status')],
    ['RD07', f => f.since, keep('state_since')],
    ['RD08', () => true, keep('no_status')],
  ]),
  rowWarning: table<{ unknown: boolean; reviewing: boolean; reason: string | null }>([
    ['RW01', f => f.unknown, keep('unknown')],
    ['RW02', f => f.reviewing && f.reason === 'manager_lost', keep('manager_lost')],
    ['RW03', f => f.reviewing && f.reason === 'conversation_busy', keep('conversation_busy')],
    ['RW04', f => f.reviewing, keep('output')],
    ['RW05', () => true, keep('none')],
  ]),
  rowMeaning: table<{ state: TaskState; turn: Extract<Ball, { holder: 'user' }> | null }>([
    ['RM02', f => f.turn?.reason === 'question', keep('question')],
    ['RM04', f => f.turn?.reason === 'review', keep('review')],
    ['RM01', f => f.state === 'error' || f.turn?.reason === 'failed', keep('failure')],
    ['RM05', f => !!f.turn, keep('user_followup')],
    ['RM06', () => true, keep('none')],
  ]),
  restore: table<TaskStage & { requested: TaskState }>([
    ['HR01', f => !f.hold || f.requested !== f.baseState, reject('hold_returns_only_current_base')],
    ['HR02', () => true, keep('restore_current_base')],
  ]),
  questionAdmission: table<TaskStage>([
    ['QA01', f => f.baseState === 'stopped', reject('question_stopped')],
    ['QA02', () => true, keep('question_allowed')],
  ]),
  clearReturn: table<{ seatBase: TaskBaseState | null; originBase: TaskBaseState | null; question: boolean; closed: boolean }>([
    ['CR01', f => f.seatBase !== null && terminal(f.seatBase), keep('seat_finished')],
    ['CR02', f => f.originBase === 'stopped', keep('origin_stopped')],
    ['CR03', f => f.question && f.closed, keep('question_closed')],
    ['CR04', () => true, keep('open')],
  ]),
  requestAuthority: table<TaskStage & { userRequested: boolean; purpose: 'instruction' | 'stop' }>([
    ['RA01', f => (f.purpose === 'stop' && f.baseState === 'waiting') || (f.userRequested && f.baseState === 'error'), keep('user_decides')],
    ['RA02', () => true, keep('owner_decides')],
  ]),
  intent: table<ReportIntentFacts>([
    ['I01', f => f.reporter !== 'own' && !f.confirmation && f.hold && f.state === f.baseState, keep('unhold')],
    ['I02', f => f.state === 'done' && (f.confirmation || f.reporter === 'outside' &&
      (f.baseState === 'waiting' || f.baseState === 'doing' && !!f.openUserQuestion)), keep('confirm')],
    ['I03', f => f.state === 'waiting' && f.reporter !== 'outside', keep('ask')],
    ['I04', f => f.state === 'waiting' && f.reporter === 'outside', keep('submit_review')],
    ['I05', f => f.state === 'held', keep('hold')],
    ['I06', f => f.state === 'stopped', keep('stop')],
    ['I07', f => f.state === 'doing' && f.reporter !== 'outside', keep('report_doing')],
    ['I08', f => f.state === 'done' && f.reporter !== 'outside', keep('report_done')],
    ['I09', () => true, reject('invalid_report_intent')],
  ]),
  ball: BALL_RULES,
  delivery: { serverRequests: ['handover'] as readonly string[] },
  deliveryFailure: table<Pick<WakeFacts, 'failed' | 'serverRequest' | 'workChanged'>>([
    ['DF01', f => f.failed && (f.workChanged || !f.serverRequest), keep('failure')],
    ['DF02', () => true, keep('admissible')],
  ]),
  seatFailure: table<{ baseState: TaskBaseState; previousFailed: boolean }>([
    ['SF01', f => f.baseState === 'error' || f.previousFailed, keep('failed')],
    ['SF02', () => true, keep('not_failed')],
  ]),
  resumeScope: table<StartFacts>([
    ['RS01', f => !f.known || !f.path.length || new Set(f.path.map(n => n.taskId)).size !== f.path.length || f.path[0]?.taskId !== f.targetTaskId || f.path.some(n => n.baseState === 'stopped' && !n.stopId), reject('resume_scope_unknown')],
    ['RS02', f => f.phase === 'queued_start' && (!f.fence || f.fence.length !== f.path.length || f.path.some(n => !f.fence!.some(old => old.taskId === n.taskId && old.stopId === n.stopId))), { ...reject('request_invalidated_by_stop'), invalidateRequest: true }],
    ['RS03', f => !f.path.some(n => n.baseState === 'stopped'), keep('no_stopped_scope')],
    ['RS04', f => !f.intent?.id || !f.intent.explicit || f.intent.targetTaskId !== f.targetTaskId, reject('explicit_resume_scope_required')],
    ['RS05', f => f.path.some(n => n.baseState === 'stopped' && !f.intent!.scope.some(g => g.taskId === n.taskId && g.stopId === n.stopId)), reject('resume_scope_stale_or_incomplete')],
    ['RS06', () => true, keep('resume_scope_authorized')],
  ]),
  runEnd: table<{ runState: 'running' | 'succeeded' | 'failed' | 'cancelled'; started: boolean; endedByReport: boolean;
    openQuestionAtEnd: boolean; awaitingAtEnd: boolean; responsibleAtEnd: boolean; baseState: TaskBaseState }>([
    ['RE01', f => f.runState === 'running', change('run_started', { baseState: 'doing' })],
    ['RE02', f => f.baseState === 'stopped', keep('stopped_boundary_retained')],
    ['RE03', f => f.runState === 'failed', change('run_failed', { baseState: 'error' })],
    ['RE04', f => f.endedByReport || f.openQuestionAtEnd || f.awaitingAtEnd || !['todo', 'doing'].includes(f.baseState), keep('end_preserved')],
    ['RE05', f => f.runState === 'succeeded', change('no_report', { baseState: 'error' })],
    ['RE06', f => f.started && f.responsibleAtEnd, change('run_stopped', { baseState: 'error' })],
    ['RE07', () => true, keep('not_started_or_reassigned')],
  ]),
  transition: table<OperationFacts>([
    ['T01', f => f.action === 'report_doing' && f.baseState === 'stopped', reject('stopped_requires_resume')],
    ['T02', f => f.action === 'report_doing', change('working', { baseState: 'doing' })],
    ['T03', f => f.action === 'report_done' && f.baseState === 'stopped', reject('stopped_requires_resume')],
    ['T04', f => f.action === 'report_done', f => change('done_report', { baseState: f.userRequested ? 'waiting' : 'done', needsFinish: true })],
    ['T05', f => f.action === 'submit_review' && f.baseState === 'done' && f.userRequested, change('submit_review', { baseState: 'waiting', needsFinish: true })],
    ['T06', f => f.action === 'submit_review', reject('only_user_requested_done_can_submit')],
    ['T07', f => f.action === 'confirm' && f.baseState === 'waiting', change('confirmed', { baseState: 'done', needsFinish: true, needsReview: true })],
    ['T07a', f => f.action === 'confirm' && f.explicit && f.baseState === 'doing' && !!f.openUserQuestion,
      change('question_completed', { baseState: 'done', needsFinish: true, needsReview: false })],
    ['T08', f => f.action === 'confirm', reject('not_current_review')],
    ['T08a', f => f.action === 'stop' && (!f.stopFactsKnown || !f.operationId), reject('stop_facts_unknown')],
    ['T09', f => f.action === 'stop' && !terminal(f.baseState), change('stop_subtree', { baseState: 'stopped', subtree: true, stopRuns: true })],
    ['T10', f => f.action === 'stop', keep('already_terminal', { subtree: true, stopRuns: true })],
    ['T11', f => f.action === 'resume', change('explicit_resume', { baseState: 'doing' })],
    ['T11b', f => f.action === 'run_started' && !f.observedStart, reject('observed_start_fact_required')],
    ['T12', f => f.action === 'run_started', change('owner_started', { baseState: 'doing' })],
    ['T12b', f => f.action === 'run_failed' && f.baseState === 'stopped', keep('stopped_boundary_retained')],
    ['T13', f => f.action === 'run_failed', change('owner_failed', { baseState: 'error' })],
    ['T13b', f => f.action === 'run_no_report' && !f.end?.known, reject('run_end_facts_unknown')],
    ['T14', f => f.action === 'run_no_report' && ['todo', 'doing'].includes(f.baseState) && f.end!.reported === false &&
      f.end!.questions === 0 && f.end!.requests === 0 && !f.end!.awaitingAtEnd, change('no_report', { baseState: 'error' })],
    ['T15', f => ['run_no_report', 'answer', 'withdraw', 'hold', 'unhold'].includes(f.action), keep('base_unchanged')],
  ]),
  // Unhold authority belongs to command-access's restore grant; explicit still protects user-only decisions.
  hold: table<OperationFacts>([
    ['H01', f => (['hold', 'resume'].includes(f.action) || f.hold && ['confirm', 'stop'].includes(f.action)) && !f.explicit, reject('explicit_user_decision_required')],
    ['H02', f => f.action === 'hold', change('hold', { hold: true })],
    ['H03', f => f.action === 'unhold', change('unhold', { hold: false })],
    ['H04', f => ['resume', 'confirm', 'stop'].includes(f.action), change('explicit_release', { hold: false })],
    ['H05', () => true, keep('preserve_hold')],
  ]),
  replyWait: table<{ wait: 'question' | 'review'; input: 'question' | 'done' | 'request' | 'doing' | 'below' }>([
    ['RW01', f => f.wait === 'question' && f.input !== 'below', change('withdraw_question', {})],
    ['RW02', f => f.wait === 'review' && f.input !== 'done', change('invalidate_review', { baseState: 'doing', continuation: true })],
    ['RW03', () => true, keep('wait_kept')],
  ]),
  parentChild: table<PairFacts>([
    ['P00', f => f.parentBase === 'stopped' && !terminal(f.childBase) && f.direction === 'child_change' && !f.resumeAuthorized, reject('stopped_scope_not_authorized')],
    ['P01', f => terminal(f.parentBase) && !terminal(f.childBase) && f.direction !== 'child_change', reject('unfinished_under_terminal')],
    ['P02', f => terminal(f.parentBase) && !terminal(f.childBase) && f.direction === 'child_change', change('reopen_terminal', { baseState: 'doing', continuation: true })],
    ['P03', f => f.parentBase === 'waiting' && f.direction === 'parent_operation' && !terminal(f.childBase), reject('review_with_unfinished_child')],
    ['P05', () => true, keep('pair_valid')],
  ]),
  stopTarget: table<TaskStage & { active: boolean }>([
    ['ST01', f => !f.active, keep('inactive_branch')],
    ['ST02', f => terminal(f.baseState), keep('terminal_task_unchanged')],
    ['ST03', () => true, change('stop_target', { baseState: 'stopped' })],
  ]),
  stopRun: table<{ unfinished: boolean; reportingRun: boolean }>([
    ['SR01', f => !f.unfinished, keep('run_ended')],
    ['SR02', f => f.reportingRun, keep('reporting_run_ends_itself')],
    ['SR03', () => true, change('stop_reservation', { stopRuns: true })],
  ]),
  finish: table<FinishFacts>([
    ['F01', f => !f.known || [f.questions, f.requests, f.undelivered, f.unfinishedBelow, f.otherRuns].some(n => !Number.isSafeInteger(n) || n < 0), reject('finish_facts_unknown')],
    ['F02', f => f.questions > 0, reject('open_question')],
    ['F03', f => f.requests > 0, reject('open_request')],
    ['F04', f => f.undelivered > 0, reject('undelivered_result')],
    ['F05', f => f.unfinishedBelow > 0, reject('unfinished_below')],
    ['F06', f => f.otherRuns > 0, reject('other_run_unfinished')],
    ['F07', f => f.needsReview && (!f.reviewFresh || !f.reviewRunEnded), reject('review_not_ready')],
    ['F08', () => true, keep('finish_clear')],
  ]),
  reopen: table<{ changed: boolean; causeKnown: boolean; deliveryKnown: boolean; recorded: boolean; closing: boolean; progressing: boolean }>([
    ['N00', f => f.changed && !f.causeKnown, reject('continuation_cause_required')],
    ['N00b', f => f.changed && !f.deliveryKnown, reject('continuation_facts_unknown')],
    ['N01', f => !f.changed, keep('no_new_change')],
    ['N02', f => f.recorded, keep('continuation_already_recorded')],
    ['N02b', f => f.closing, keep('fulfilled_by_close_return')],
    ['N03', f => f.progressing, change('reopen_attach_current', { continuation: true })],
    ['N04', () => true, change('reopen_responsibility', { continuation: true })],
  ]),
  requester: table<{ userRequested: boolean; openHuman: boolean; latestSeat: string | null; parentId: string | null }>([
    ['Q01', f => f.userRequested || f.openHuman, keep('user', { seat: null })],
    ['Q02', f => f.latestSeat !== null, f => keep('latest_open_owner_request', { seat: f.latestSeat })],
    ['Q03', f => f.parentId !== null, f => keep('parent', { seat: f.parentId })],
    ['Q04', () => true, keep('user_fallback', { seat: null })],
  ]),
  wake: table<WakeFacts>([
    ['W01', f => !f.active || terminal(f.baseState), keep('finished')],
    ['W02', f => f.hold, keep('held')],
    ['W03', (f): boolean => evaluate(TASK_POLICY.deliveryFailure, f).code === 'failure', keep('failure')],
    ['W04', f => f.hasRows && !f.profile, keep('no_profile')],
    ['W05', f => f.hasRows && f.limit, keep('automatic_limit')],
    ['W06', f => f.uncertain, keep('uncertain')],
    ['W07', f => f.hasRows && f.refused, keep('refused')],
    ['W08', f => f.needsReview, keep('run_review')],
    ['W09', f => f.busy, keep('active')],
    ['W10', f => !f.hasRows, keep('nothing_deliverable')],
    ['W11', () => true, keep('deliver')],
  ]),
};

/** Status words and unread identity consume these facts; the policy alone selects the ball. */
export type BallFacts = { lifecycle: string; state: TaskState; baseState: TaskBaseState;
  review: { logId: string; at: string; runId: string | null; taskSnapshot: boolean } | null;
  failure: { logId: string; at: string } | null; openQuestions: readonly { id: string; askedTo: string | null; at: string }[];
  requester: 'user' | 'parent'; requesterAskedUser: boolean; block: { code: string; human: boolean; at: string | null; key: string | null; count: number | null; problemReason?: ProblemReason } | null;
  openRequests: number };
type UserBall = Extract<Ball, { holder: 'user' }>;
const user = (reason: UserBall['reason'], at: string, key: string, fields: Partial<UserBall> = {}): Ball =>
  ({ holder: 'user', reason, at, key, questionId: null, aboutRunId: null, count: null, code: null, failure: null, ...fields });

export function policyBall(facts: BallFacts): Ball | null {
  const selected = evaluate(TASK_POLICY.ball, facts).code;
  switch (selected) {
    case 'none': return null;
    case 'review': return user('review', facts.review!.at, facts.review!.logId, { aboutRunId: facts.review!.runId });
    case 'gate': {
      const block = facts.block!;
      return block.code === 'automatic_limit' ? user('limit', block.at!, block.key!, { count: block.count }) :
        block.code === 'uncertain' ? user('unconfirmed', block.at!, block.key!) : user('blocked', block.at!, block.key!, { code: block.code, ...(block.problemReason ? { problemReason: block.problemReason } : {}) });
    }
    case 'question': {
      const q = facts.openQuestions.find(q => q.askedTo === null)!;
      const failure = userDecidesFailure(facts) && facts.failure ? { at: facts.failure.at, key: facts.failure.logId } : null;
      return user('question', q.at, q.id, { questionId: q.id, failure });
    }
    case 'failed_user': return facts.failure ? user('failed', facts.failure.at, facts.failure.logId) : null;
    case 'parent_question': return { holder: 'parent', reason: 'question' };
    case 'failed_parent': return { holder: 'parent', reason: 'failed' };
    case 'child': return { holder: 'child' };
    case 'owner': return { holder: 'owner' };
    default: throw new Error('Unlisted ball result');
  }
}

/** Candidates remain visible; authoritative transition and finish guards decide on submission. */
export function taskActionsOf(facts: TaskStage & UserQuestionFacts & { userRequested: boolean }):
  ('report_doing' | 'report_done' | 'submit_review' | 'confirm' | 'stop' | 'resume' | 'hold' | 'unhold')[] {
  return evaluate(TASK_POLICY.actionCandidates, facts, true).all.map(row => row.code as ReturnType<typeof taskActionsOf>[number]);
}
