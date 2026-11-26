/**
 * The screen's picture of one coordinator conversation: read from its Requests, its coordinator Runs and their inputs,
 * with no second copy. What the screen draws changes here; what a message may do changes in conversation.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { coordinatorRunRecordSchema, runFolder, runNumber, tookSteps, type CoordinatorRunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { inputUnsettled } from '@alpacawork/contract/run-protocol';
import { COORDINATOR_RECENT_TURNS, COORDINATOR_HISTORY_PAGE, type CoordinatorConversation as ConversationView,
  type CoordinatorError, type CoordinatorMessageStatus, type CoordinatorResult, type CoordinatorTurn,
  type CoordinatorTurnsPage } from '@alpacawork/contract/coordinator';
import { currentRequestRun, isEnded, laneAhead, type RunStore } from '@alpacawork/runs';
import { blockedInvocations, queuedInputReservations } from '../runs/execution-control.js';
import { readRunFailure } from '../runs/error-cause.js';
import { readRunActivity } from '../runs/activity.js';
import { deliveredMessages, messageCarrier, resultsOf } from './messages.js';
import { replyView } from './reply.js';
import { activeCoordinatorRuns } from './continuation.js';
import { coordinatorResetsFor, pendingCoordinatorReset } from './resets.js';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';

export type Conversation = { id: string };
/** The last time a queued message was handed to the agent at work: how far it got, and into whose Run. */
type Handover = { state: string; refused: boolean; into: string };
/** How a coordinator Run that did not answer says why; any other end is an interruption. */
const ERRORS: Partial<Record<NonNullable<CoordinatorRunRecord['reason']>, CoordinatorError>> = { exit: 'exit',
  output: 'output', timeout: 'timeout', launch: 'launch', conversation_busy: 'conversation_busy', attachment_save: 'attachment_save' };
/** An answer that could not be read is told apart from one the agent did not give (`missing`, an `output` error). */
const UNREAD_ANSWERS = ['too_large', 'unreadable'] as const satisfies readonly CoordinatorError[];
/** Whether an ended Run took any steps, by its ID: an ended Run's activity no longer changes. */
const worked = new Map<string, boolean>();
const WORKED_LIMIT = 1024;
function endedRunTookSteps(root: string, id: RunId): boolean {
  const key = `${root}\0${id}`, known = worked.get(key);
  if (known !== undefined) return known;
  const value = tookSteps(readRunActivity(runFolder(root, id)));
  worked.set(key, value);
  if (worked.size > WORKED_LIMIT) worked.delete(worked.keys().next().value!);
  return value;
}
/** Each queued message's last handover, by its Run. */
export function handovers(db: DatabaseSync, runs: readonly RunId[]): Map<string, Handover> {
  const rows = db.prepare(`SELECT i.instruction_run_no, i.state, json_extract(i.receipt_json, '$.evidence') AS evidence,
    a.run_no FROM run_inputs i JOIN run_attempts a USING(attempt_id)
    WHERE i.initial = 0 AND i.instruction_run_no IN (SELECT value FROM json_each(?)) ORDER BY i.rowid`)
    .all(JSON.stringify(runs.map(runNumber)));
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
    ...(request.coordinator_files_expired_at !== null ? { filesExpired: true as const } : {}),
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
/** An answer the person can have read. */
export function readable(turn: CoordinatorTurn): boolean {
  return (turn.status === 'succeeded' || turn.status === 'failed') && turn.answeredAt !== null;
}

const visible = "q.coordinator_turn_no IS NOT NULL AND q.delivery_state <> 'aborted'";
const requestColumns = 'q.id,q.body,q.submitted_at,q.reply_to,q.coordinator_turn_no,q.coordinator_files_expired_at';
type Row = Record<string, unknown>;
type TurnRow = Row & { id: string; coordinator_turn_no: number };
function turnRows(rows: Row[]): TurnRow[] { return rows as TurnRow[]; }

function coordinatorLane(db: DatabaseSync, store: RunStore, conversation: string, active: readonly CoordinatorRunRecord[]) {
  const sessions = active.flatMap(run => run.session ? [run.session.id] : []);
  const candidates = db.prepare(`SELECT r.id FROM (
    SELECT run_no FROM run_attempts WHERE diagnostic IS NOT NULL
    UNION
    SELECT a.run_no FROM run_inputs i INDEXED BY coordinator_delivery_inputs CROSS JOIN run_attempts a
      WHERE i.state IN ('reserved','attempted','uncertain') AND a.attempt_id=i.attempt_id
  ) pending CROSS JOIN runs r
  WHERE r.id=pending.run_no AND (r.conversation_id=? OR r.session_id IN (SELECT value FROM json_each(?)))`)
    .all(conversation, JSON.stringify(sessions)).map(row => `R${row.id}`);
  const activeIds = active.map(run => run.id);
  const blocked = blockedInvocations(store, candidates);
  const lane: RuntimeRunRecord[] = [...active];
  for (const id of blocked) {
    if (!activeIds.includes(`R${id}`)) {
      const run = store.runtimeGet(`R${id}`);
      if (run) lane.push(run);
    }
  }
  return { lane, blocked, reservations: queuedInputReservations(store, activeIds) };
}

function recent(db: DatabaseSync, conversation: string): TurnRow[] {
  return turnRows(db.prepare(`SELECT ${requestColumns} FROM requests q
    JOIN runs r ON r.id=(${currentRequestRun('q.id')})
    WHERE q.conversation_id=? AND ${visible}
      AND r.state IN ('succeeded','failed','cancelled','joined')
      AND (r.state <> 'joined' OR EXISTS (SELECT 1 FROM runs carrier WHERE carrier.id=(${messageCarrier('q.id')})
        AND carrier.state IN ('succeeded','failed','cancelled')))
    ORDER BY q.coordinator_turn_no DESC LIMIT ?`)
    .all(conversation, COORDINATOR_RECENT_TURNS)).reverse();
}

function trialRows(db: DatabaseSync, ids: readonly string[]) {
  return db.prepare(`SELECT trial.record,trial.result,trial.result_state,
    (SELECT carrier.state FROM runs carrier WHERE carrier.id=(${messageCarrier('trial.request_id')})) AS carrier_state,
    EXISTS(SELECT 1 FROM runs retry
      WHERE retry.conversation_id=trial.conversation_id AND retry.conversation_id IS NOT NULL AND json_extract(retry.record,'$.message.retryOf')=trial.request_id
      AND EXISTS (SELECT 1 FROM requests rq WHERE rq.id=retry.request_id AND rq.delivery_state <> 'aborted')) AS sent_again
    FROM json_each(?) scope JOIN runs trial ON trial.request_id=scope.value ORDER BY trial.id`).all(JSON.stringify(ids));
}

function draw(db: DatabaseSync, store: RunStore, conversation: string, requests: readonly TurnRow[],
  seen: ReadonlySet<string>, active: readonly CoordinatorRunRecord[],
  { lane, blocked, reservations }: ReturnType<typeof coordinatorLane>): CoordinatorTurn[] {
  const trials = new Map<string, { run: CoordinatorRunRecord; row: Row }[]>();
  for (const row of trialRows(db, requests.map(request => request.id))) {
    const run = coordinatorRunRecordSchema.parse(JSON.parse(String(row.record)));
    const group = trials.get(run.requestId);
    if (group) group.push({ run, row }); else trials.set(run.requestId, [{ run, row }]);
  }
  const unfinished = active.map(run => run.id);
  const inputs = handovers(db, unfinished);
  const last = requests.flatMap(request => {
    const latest = trials.get(request.id)?.at(-1);
    return latest ? [{ request, ...latest }] : [];
  });
  const done = resultsOf(db, last.filter(({ run, row }) => isEnded(run) &&
    (run.state !== 'joined' || !['queued', 'running', 'needs_review'].includes(String(row.carrier_state)))).map(({ run }) => run.requestId));
  const messageOf = new Map<string, string>();
  const carrier = db.prepare('SELECT request_id FROM runs WHERE id=?');
  for (const { run } of last) {
    const handover = inputs.get(run.id);
    const id = run.into ?? handover?.into;
    if (id && !messageOf.has(id)) {
      const row = carrier.get(Number(id.slice(1)));
      if (row) messageOf.set(id, String(row.request_id));
    }
  }
  return last.map(({ request, run, row }) => {
    const handover = inputs.get(run.id);
    const waiting = run.state === 'queued' && (!!handover && inputUnsettled(handover.state) || !!laneAhead(lane, run, blocked, reservations));
    const turn = drawnTurn(request, run, { text: row.result as string | null, state: String(row.result_state) },
      handover, messageOf, done.get(run.requestId) ?? null, waiting);
    const attempts = trials.get(run.requestId)!;
    const failed = turn.status === 'failed';
    const failure = failed ? readRunFailure(store.root, run) : undefined;
    const again = failed && !!row.sent_again;
    const workedBy = readable(turn) && isEnded(run) && endedRunTookSteps(store.root, run.id) ? run.id : undefined;
    return { ...turn,
      ...(attempts.length < 2 && !run.availability ? {} : { attempts: attempts.map(({ run: trial }) => ({
        agent: trial.agent, values: trial.launch.values, ...(trial.availability ? { availability: trial.availability } : {}),
      })) }),
      ...(failure ? { failure } : {}),
      ...(typeof request.reply_to === 'string' ? { replyTo: replyView(db, conversation, request.reply_to) } : {}),
      ...(again ? { sentAgain: true as const } : {}), ...(workedBy ? { workedBy } : {}),
      seen: readable(turn) && (again || seen.has(run.requestId)) };
  });
}

export function coordinatorBusy(db: DatabaseSync, store: RunStore, id: string): boolean {
  const active = activeCoordinatorRuns(db, id);
  const { lane, blocked, reservations } = coordinatorLane(db, store, id, active);
  return !!laneAhead(lane, { role: 'coordinator', conversationId: id }, blocked, reservations);
}

export function view(db: DatabaseSync, store: RunStore, conversation: Conversation, seen: ReadonlySet<string>,
  active: readonly CoordinatorRunRecord[]): Pick<ConversationView, 'id' | 'busy' | 'turns' | 'earlier' | 'resets'> {
  const id = conversation.id, window = recent(db, id);
  const inWindow = new Set(window.map(turn => turn.id));
  const readRequest = db.prepare(`SELECT ${requestColumns} FROM requests q WHERE q.id=? AND ${visible}`);
  const activeRequests = new Set(active.flatMap(run => run.state === 'queued' && !run.attempt
    ? [run.requestId] : deliveredMessages(db, run.id)));
  const olderActive = [...activeRequests].flatMap(request => {
    if (inWindow.has(request)) return [];
    const row = readRequest.get(request);
    return row ? [row as TurnRow] : [];
  });
  const requests = [...olderActive, ...window].sort((a, b) => a.coordinator_turn_no - b.coordinator_turn_no);
  const remaining = Number(db.prepare('SELECT visible_turns FROM coordinator_conversations WHERE id=?').get(id)?.visible_turns) - requests.length;
  const earlier = remaining > 0 && window.length ? { count: remaining, before: window[0]!.id } : null;
  const resets = coordinatorResetsFor(db, id, requests.map(turn => turn.id));
  const pending = pendingCoordinatorReset(db, id);
  if (pending) resets.push(pending);
  const lane = coordinatorLane(db, store, id, active);
  return { id, busy: !!laneAhead(lane.lane, { role: 'coordinator', conversationId: id }, lane.blocked, lane.reservations),
    turns: draw(db, store, id, requests, seen, active, lane), earlier, resets };
}

export function historyPage(db: DatabaseSync, store: RunStore, conversation: string,
  cursor: { before?: string; around?: string }, seen: ReadonlySet<string>): CoordinatorTurnsPage {
  const anchor = db.prepare(`SELECT coordinator_turn_no FROM requests q WHERE q.id=? AND q.conversation_id=?
    AND coordinator_turn_no IS NOT NULL`).get(cursor.before ?? cursor.around!, conversation);
  if (!anchor) throw new Problem(PROBLEM_CODE.notFound, 'History cursor is not in this conversation');
  const requests = turnRows(db.prepare(`SELECT ${requestColumns} FROM requests q WHERE q.conversation_id=? AND ${visible}
    AND q.coordinator_turn_no <= ? ORDER BY q.coordinator_turn_no DESC LIMIT ?`)
    .all(conversation, Number(anchor.coordinator_turn_no) - (cursor.before ? 1 : 0), COORDINATOR_HISTORY_PAGE + 1));
  const more = requests.length > COORDINATOR_HISTORY_PAGE;
  const page = requests.slice(0, COORDINATOR_HISTORY_PAGE).reverse();
  const active = activeCoordinatorRuns(db, conversation);
  return { turns: draw(db, store, conversation, page, seen, active, coordinatorLane(db, store, conversation, active)),
    resets: coordinatorResetsFor(db, conversation, page.map(turn => turn.id)), more: more ? page[0]!.id : null };
}

export function messageStatus(db: DatabaseSync, conversation: string, id: string): CoordinatorMessageStatus {
  const row = db.prepare(`SELECT q.delivery_state,q.coordinator_turn_no,r.state,
    EXISTS (SELECT 1 FROM run_inputs i WHERE i.instruction_run_no=r.id AND i.initial=0
      AND i.state IN ('reserved','attempted','uncertain')) AS sending
    FROM requests q LEFT JOIN runs r ON r.id=(${currentRequestRun('q.id')}) WHERE q.id=? AND q.conversation_id=?`).get(id, conversation);
  if (!row) return { id, status: 'missing' };
  if (row.delivery_state === DELIVERY_STATE.aborted) return { id, status: 'withdrawn' };
  if (row.coordinator_turn_no === null) return { id, status: 'missing' };
  switch (row.state) {
    case 'queued': return { id, status: row.sending ? 'sending' : 'queued' };
    case 'running': case 'joined': case 'succeeded': return { id, status: row.state };
    default: return { id, status: 'failed' };
  }
}

export function recentReadableIds(db: DatabaseSync, conversation: string): string[] {
  return recent(db, conversation).map(row => row.id).filter(id => completedAnswer(db, conversation, id));
}

export function completedAnswer(db: DatabaseSync, conversation: string, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM requests q JOIN runs r ON r.id=(${currentRequestRun('q.id')})
    WHERE q.id=? AND q.conversation_id=? AND ${visible} AND r.state IN ('succeeded','failed','cancelled')
    AND json_extract(r.record,'$.ended_at') IS NOT NULL`).get(id, conversation);
}
