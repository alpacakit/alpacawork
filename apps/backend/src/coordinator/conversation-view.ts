/**
 * The screen's picture of one coordinator conversation: read from its Requests, its coordinator Runs and their inputs,
 * with no second copy. What the screen draws changes here; what a message may do changes in conversation.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { isRunMoving, type CoordinatorRunRecord } from '@alpacawork/contract/run';
import { inputUnsettled } from '@alpacawork/contract/run-protocol';
import type { CoordinatorConversation as ConversationView, CoordinatorError, CoordinatorResult, CoordinatorTurn } from '@alpacawork/contract/coordinator';
import { isEnded, laneAhead, type RunStore } from '@alpacawork/runs';
import { blockedInvocations, queuedInputReservations } from '../runs/execution-control.js';
import { readRunFailure } from '../runs/error-cause.js';
import { resultsOf } from './messages.js';
import { replyView } from './reply.js';
import { continuation } from './continuation.js';

export type Conversation = { id: string; warmRequestId: string | null };
/** The last time a queued message was handed to the agent at work: how far it got, and into whose Run. */
type Handover = { state: string; refused: boolean; into: string };
/** How a coordinator Run that did not answer says why; any other end is an interruption. */
const ERRORS: Partial<Record<NonNullable<CoordinatorRunRecord['reason']>, CoordinatorError>> = { exit: 'exit',
  output: 'output', timeout: 'timeout', launch: 'launch', conversation_busy: 'conversation_busy', attachment_save: 'attachment_save' };
/** An answer that could not be read is told apart from one the agent did not give (`missing`, an `output` error). */
const UNREAD_ANSWERS = ['too_large', 'unreadable'] as const satisfies readonly CoordinatorError[];
/** Each queued message's last handover, by its Run. */
export function handovers(db: DatabaseSync, conversation: string): Map<string, Handover> {
  const rows = db.prepare(`SELECT i.instruction_run_no, i.state, json_extract(i.receipt_json, '$.evidence') AS evidence,
    a.run_no FROM run_inputs i JOIN run_attempts a USING(attempt_id) JOIN runs r ON r.id = i.instruction_run_no
    WHERE i.initial = 0 AND r.conversation_id = ? ORDER BY i.rowid`).all(conversation);
  return new Map(rows.map(row => [`R${row.instruction_run_no}`, { state: String(row.state),
    refused: row.evidence === 'transfer_not_started', into: `R${row.run_no}` }]));
}
/**
 * One message as the screen draws it, from its Request, its Run, that Run's stored answer and its last handover.
 * `into` is a message ID: the one whose Run took this message in, or is taking it.
 */
function drawnTurn(request: Record<string, unknown>, run: CoordinatorRunRecord, result: { text: string | null; state: string } | undefined,
  handover: Handover | undefined, messageOf: ReadonlyMap<string, string>, done: CoordinatorResult | null, waiting: boolean): CoordinatorTurn {
  const into = (runId: string | null) => {
    const message = runId === null ? undefined : messageOf.get(runId);
    return message === undefined ? {} : { into: message };
  };
  const turn = { id: String(request.id), at: String(request.submitted_at), ask: String(request.body),
    attachments: run.message.attachments,
    ...run.message.skills === undefined ? {} : { skills: run.message.skills },
    ...run.message.intent === null ? {} : { intent: run.message.intent },
    ...run.message.answers === undefined ? {} : { answers: run.message.answers }, answer: null, answeredAt: null, error: null,
    ...run.message.tasks === undefined ? {} : { tasks: run.message.tasks }, result: done, seen: false, waiting };
  if (run.state === 'queued') {
    if (handover && inputUnsettled(handover.state)) return { ...turn, status: 'sending', ...into(handover.into) };
    const deliveryError: CoordinatorTurn['deliveryError'] = handover?.state !== 'not_sent' ? undefined
      : handover.refused ? 'refused' : 'closed';
    return { ...turn, status: 'queued', ...run.joinRequested ? { joinRequested: true as const } : {}, ...deliveryError ? { deliveryError } : {} };
  }
  if (run.state === 'running') return { ...turn, status: 'running' };
  if (run.state === 'joined') return { ...turn, status: 'joined', ...into(run.into) };
  if (run.state === 'succeeded') return { ...turn, status: 'succeeded', answer: result?.text ?? null, answeredAt: run.ended_at,
    ...run.answerFiles ? { answerFiles: run.answerFiles } : {} };
  const unread = run.reason === 'output' ? UNREAD_ANSWERS.find(state => state === result?.state) : undefined;
  return { ...turn, status: 'failed', answeredAt: isEnded(run) ? run.ended_at : null,
    error: unread ?? (run.reason === null ? undefined : ERRORS[run.reason]) ?? 'interrupted' };
}
/** A message the screen draws as failed, which may be sent again: its Run did not answer and moves no more. */
export function failedRun(run: CoordinatorRunRecord): boolean {
  return !(['queued', 'running', 'joined', 'succeeded'] as const).some(state => state === run.state);
}
/**
 * Whether the Run that answers a message has ended (its own, or the one it joined, `into`): its turn lives no longer,
 * so what it did is final.
 */
function answered(run: CoordinatorRunRecord, byId: ReadonlyMap<string, CoordinatorRunRecord>): boolean {
  const seen = new Set<string>();
  let head: CoordinatorRunRecord | undefined = run;
  while (head?.state === 'joined' && head.into !== null && !seen.has(head.id)) { seen.add(head.id); head = byId.get(head.into); }
  return head === undefined || isEnded(head);
}
/** An answer the person can have read. */
export function readable(turn: CoordinatorTurn): boolean {
  return (turn.status === 'succeeded' || turn.status === 'failed') && turn.answeredAt !== null;
}
/**
 * The conversation as the screen shows it, from its Requests, their coordinator Runs and those Runs' inputs: the
 * messages in the order they were sent, the warm-up apart.
 */
export function view(db: DatabaseSync, store: RunStore, conversation: Conversation, seen: ReadonlySet<string> = new Set(),
  running: (run: CoordinatorRunRecord | null) => void = () => {}): ConversationView {
  const runs = store.coordinatorRuns(conversation.id), inputs = handovers(db, conversation.id);
  running(runs.filter(run => run.state === 'running' && run.requestId !== conversation.warmRequestId).at(-1) ?? null);
  // The same decision snapshot and turn-order rule as the scheduler, including hidden warm-up and delivery holds.
  const decisions = store.readForSettle(conversation.id);
  const runIds = decisions.map(run => run.id);
  const blocked = blockedInvocations(store, runIds), reservations = queuedInputReservations(store, runIds);
  const byRequest = new Map(runs.map(run => [run.requestId, run])), messageOf = new Map(runs.map(run => [run.id, run.requestId]));
  const results = new Map(db.prepare('SELECT id, result, result_state FROM runs WHERE conversation_id = ?').all(conversation.id)
    .map(row => [`R${row.id}`, { text: row.result === null ? null : String(row.result), state: String(row.result_state) }]));
  const warm = conversation.warmRequestId === null ? undefined : byRequest.get(conversation.warmRequestId);
  const byId = new Map(runs.map(run => [run.id, run]));
  const done = resultsOf(db, runs.filter(run => run.requestId !== conversation.warmRequestId && answered(run, byId))
    .map(run => run.requestId));
  // A failed message sent again stays readable by its ID (an unconfirmed send, a read mark, what joined it), marked so.
  const sentAgain = new Set(runs.flatMap(run => run.message.retryOf ?? []));
  const cancelled: string[] = [], turns: CoordinatorTurn[] = [];
  const replies = new Map<string, ReturnType<typeof replyView>>();
  const reply = (id: string) => {
    if (!replies.has(id)) replies.set(id, replyView(db, conversation.id, id));
    return replies.get(id)!;
  };
  for (const request of db.prepare(`SELECT q.id, q.body, q.submitted_at, q.delivery_state, q.reply_to FROM requests q
    LEFT JOIN runs r ON r.request_id = q.id WHERE q.conversation_id = ? ORDER BY r.id, q.rowid`).all(conversation.id)) {
    const id = String(request.id), run = byRequest.get(id);
    if (id === conversation.warmRequestId) continue;
    if (request.delivery_state === DELIVERY_STATE.aborted) cancelled.push(id);
    else if (run) {
      const handover = inputs.get(run.id);
      const waiting = run.state === 'queued' && (!!handover && inputUnsettled(handover.state) || !!laneAhead(decisions, run, blocked, reservations));
      const turn = drawnTurn(request, run, results.get(run.id), handover, messageOf, done.get(id) ?? null, waiting);
      const failure = turn.status === 'failed' ? readRunFailure(store.root, run) : undefined;
      // The message sent in its place carries what is left to read, while this one stays failed: one that answers after
      // all (a Run back from review) is shown with its answer.
      const again = sentAgain.has(id) && turn.status === 'failed';
      turns.push({ ...turn, ...failure ? { failure } : {}, ...(typeof request.reply_to === 'string' ? { replyTo: reply(request.reply_to) } : {}),
        ...again ? { sentAgain: true as const } : {}, seen: readable(turn) && (again || seen.has(id)) });
    }
  }
  // The values an omitted choice in the next message keeps: null when it would start a new session (or none exists).
  const agent = store.coordinatorHead(conversation.id)?.agent ?? null;
  const previousValues = agent === null ? null : continuation(runs, agent)?.previous.values ?? null;
  return { id: conversation.id, agent, previousValues,
    warm: !warm ? 'none' : isRunMoving(warm.state) ? 'preparing' : warm.state === 'succeeded' ? 'ready' : 'failed',
    busy: !!laneAhead(decisions, { role: 'coordinator', conversationId: conversation.id }, blocked, reservations), cancelled, turns };
}
