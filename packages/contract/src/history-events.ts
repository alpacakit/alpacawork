/**
 * Browser-safe: one row of a Task's history and time view, made from exactly one record (a log entry, a Request, a
 * failed Run, a Run's new conversation or one of its compactions, or a dialogue with the coordinator). The server projects the rows; none is made up to fill a gap.
 */
import { z } from 'zod';
import { dependencyChangeSchema, TASK_LOG_KINDS, type TaskLog } from '@alpacawork/raw/task-log-schema';
import { TASK_ID_PATTERN } from '@alpacawork/raw/task-id';
import { runIdSchema, taskIdSchema, taskStateSchema } from './fields.js';
import { NEW_CONVERSATION_REASONS, runCompactionSchema } from './run-contract.js';
import { isFinished } from './finished-branch.js';
import { RETURN_OUTCOMES } from './return-outcomes.js';
import { runErrorCauseSchema } from './run-failure.js';
import { answerFilesSchema } from './coordinator-files.js';
import { isReviewMark } from './review-target.js';

/** Launch choices come only from the linked historical Run; omitted when that Run cannot be resolved. */
const historyAgentFields = {
  profileKey: z.string().min(1),
  modelId: z.string().min(1).nullable().optional(), effort: z.string().min(1).nullable().optional(),
};

/** Authorship is historical; current placement activity never changes who wrote a record. */
export const historyAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['human', 'main', 'unknown']) }).strict(),
  z.object({ kind: z.enum(['owner', 'member']), ...historyAgentFields }).strict(),
  z.object({ kind: z.literal('parent'), taskId: taskIdSchema, ...historyAgentFields }).strict(),
]);
/** Historical participants and record links; display wording stays in the browser. */
export const historyLinksSchema = z.object({
  author: historyAuthorSchema.optional(),
  /**
   * Who received the record: a Request's recipient by the Run that accepted it, or for a log entry the Run that took it
   * in (a return delivered to it). Omitted when no Run received it.
   */
  recipient: z.object({ role: z.enum(['owner', 'member']), ...historyAgentFields }).strict().optional(),
  /** The Coordinator's Run at the record's Coordinator end (what answered a screen message); omitted when none is linked. */
  coordinator: z.object(historyAgentFields).strict().optional(),
  /** Equal dialogue words have the same key; lets the text-free time line use the same grouping rule. */
  wordsKey: z.string().min(1).optional(),
  answers: z.string().min(1).optional(), message: z.string().min(1).optional(),
  askedTo: z.union([z.literal('user'), taskIdSchema]).optional(),
  /** Membership in humanDecisionViews' userQuestions, not inferred from an open question's recipient. */
  userQuestion: z.boolean().optional(),
  /** The writing/causing Run; a review decision’s reviewed Run is not its writer. */
  runId: runIdSchema.optional(), consumedBy: z.array(runIdSchema).optional(),
});

/** How much of a member's reply a History page carries with its Request: enough for its first line. */
export const RESULT_HEAD_LENGTH = 300;
/** A reply's first characters as a result's `head`: at most RESULT_HEAD_LENGTH UTF-16 units, never cut inside a pair. */
export const resultHead = (text: string) => text.length <= RESULT_HEAD_LENGTH ? text
  : text.slice(0, RESULT_HEAD_LENGTH - (/[\uD800-\uDBFF]/.test(text[RESULT_HEAD_LENGTH - 1]!) ? 1 : 0));

/**
 * What happened to an agent's conversation (conversationChanges): started anew — why, when the Run that started it says
 * (its newConversation), with the title of the report that prepared it — or compacted, with its fill before and after.
 */
const newChange = z.object({ change: z.literal('new'), because: z.enum(NEW_CONVERSATION_REASONS).optional(), report: z.string().optional() }).strict();
const compactedChange = runCompactionSchema.omit({ at: true }).extend({ change: z.literal('compacted') }).strict();
export const conversationChangeSchema = z.discriminatedUnion('change', [newChange, compactedChange]);
/** The same, with when it happened (a Task view's list of them). */
const at = z.iso.datetime({ offset: true });
export const datedConversationChangeSchema = z.discriminatedUnion('change', [newChange.extend({ at }), compactedChange.extend({ at })]);
export const historyEventSchema = z.object({
  ...historyLinksSchema.shape,
  /** The record's ID. */
  id: z.string().min(1),
  kind: z.enum(['report', 'question', 'answer', 'withdrawn', 'expired', 'review', 'confirm', 'request',
    'urgent', 'comment', 'error', 'run_end', 'changed', 'dialogue', 'conversation']),
  /** The Task the record belongs to: a child's, when the row is a child's record in its parent's history. */
  taskId: taskIdSchema, fromChild: z.boolean(),
  at: z.iso.datetime({ offset: true }),
  /** On a question, whether it is still open. */
  open: z.boolean().optional(),
  closure: z.enum(['answered', 'withdrawn', 'expired', 'confirmed', 'invalidated', 'stopped']).optional(),
  /** The state the record set; null when it kept the state, and on a record that is not a log entry. */
  state: taskStateSchema.nullable(),
  /**
   * Who wrote the record when that was the user or the coordinator (a log entry's or a Request's author); null for a
   * placement's record, a failed Run and a dialogue.
   */
  by: z.enum(['human', 'main']).nullable(),
  /** "" when the record has none. */
  title: z.string(), summary: z.string(),
  /** Execution-order IDs, projected by the server for both current and historical records. */
  dependencies: dependencyChangeSchema.optional(),
  /** Fixed answer text, and the user's words quoted by the Coordinator. */
  answerText: z.string().optional(), quote: z.string().optional(),
  /** On a dialogue, the copies kept of the local files the coordinator's answer links to, drawn as its conversation draws them. */
  answerFiles: answerFilesSchema.optional(),
  /** Records delivered to the writing Run, one level below a child's record. */
  causes: z.array(z.object({ taskId: taskIdSchema, id: z.string().min(1), kind: z.enum(RETURN_OUTCOMES),
    title: z.string(), at: z.iso.datetime({ offset: true }) }).strict()).optional(),
  /** On a failed Run's row, the cause read in that Run's own error words (its errorCause), when one is known. */
  cause: runErrorCauseSchema.optional(),
  /** The stopped Run's recipient is the agent that took over its request. */
  carriedOn: z.literal(true).optional(),
  /** Independent Task annotation, never part of the body delivered to the agent. */
  note: z.object({ title: z.string().min(1), description: z.string().nullable() }).strict().optional(),
  /**
   * A member Request's result: the final reply of the Run that took it in and ended normally (the newest Request that
   * Run took in carries it). `head` is the reply's first characters, at most RESULT_HEAD_LENGTH, omitted when it could
   * not be read; the whole reply is read by its Run ID when the result is opened.
   */
  result: z.object({ runId: runIdSchema, at: z.iso.datetime({ offset: true }), head: z.string().max(RESULT_HEAD_LENGTH).optional() }).strict().optional(),
  /**
   * On a conversation row, what happened to the agent's conversation: a Run started it anew (newConversationStarts), or
   * it was compacted (one of a Run's compactions), with the fill before and after when the agent said it.
   */
  conversation: conversationChangeSchema.optional(),
}).strict().refine(event => (event.open !== undefined) === (event.kind === 'question' || event.kind === 'review'),
  { path: ['open'], message: 'Questions and reviews say whether they are open' }).refine(event =>
  event.note === undefined || event.kind === 'request', { path: ['note'], message: 'Only a Request row has a Task note' }).refine(event =>
  event.cause === undefined || event.kind === 'error', { path: ['cause'], message: 'Only a failed Run row has a cause' }).refine(event =>
  event.carriedOn === undefined || event.kind === 'error' && event.recipient !== undefined,
  { path: ['carriedOn'], message: 'A carried-on Run names the next agent' }).refine(event =>
  event.result === undefined || event.kind === 'request' && event.recipient?.role === 'member', { path: ['result'], message: 'Only a member Request row has a result' }).refine(event =>
  (event.conversation !== undefined) === (event.kind === 'conversation'), { path: ['conversation'], message: 'A conversation row says what happened to it' });
export type HistoryEventKind = z.infer<typeof historyEventSchema>['kind'];
type HistoryEvent = z.infer<typeof historyEventSchema>;

/**
 * A history event's place, newest last (at|taskId|id|kind): a page's `before` edge is the one the server handed out
 * (`nextBefore`). Instructions, including review send-backs, are the Request's row; their operational log has no row.
 */
export const historyCursor = (event: Pick<HistoryEvent, 'at' | 'taskId' | 'id' | 'kind'>) =>
  `${event.at}|${event.taskId}|${event.id}|${event.kind}`;
/** One newest-first total order for pages and their rendered/merged events; identities never define another order. */
export function compareHistoryEvents(a: Parameters<typeof historyCursor>[0], b: Parameters<typeof historyCursor>[0]) {
  const x = historyCursor(a), y = historyCursor(b);
  return x < y ? 1 : x > y ? -1 : 0;
}
/** The input of a page's `before`: a cursor as historyCursor makes it, its time a real one. */
export const historyCursorSchema = z.string().regex(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[^|]+\\|(?:${TASK_ID_PATTERN})\\|[^|]+\\|` +
  `(?:${historyEventSchema.shape.kind.options.join('|')})$`))
  .refine(value => Number.isFinite(Date.parse(value.split('|')[0]!)), 'Invalid History cursor');
/**
 * Whether an event is on the page a reader asks for: older than `before` (a historyCursor, the previous page's edge),
 * and at `after` or later (the newest time the reader holds: records of that same time come again, so one recorded at
 * that time after the reader's read is not missed).
 */
export const onHistoryPage = (event: Pick<HistoryEvent, 'at' | 'taskId' | 'id' | 'kind'>, before?: string, after?: string) =>
  (before === undefined || historyCursor(event) < before) && (after === undefined || Date.parse(event.at) >= Date.parse(after));

type LogKind = TaskLog['kind'];
/**
 * The one table of what a log entry is to a reader: its event in a history (null: no row of its own; a report's is
 * refined by what it reports, see eventOf), whether it is news (NOTICED_LOG_KINDS), and whether a row's stateLog keeps
 * it even when it leaves the state alone (STATE_LOG_KINDS). A retitle is listed, not noticed.
 */
const LOG_EVENTS: { readonly [Kind in LogKind]: { event: HistoryEventKind | null; noticed: boolean; stateLog: boolean } } = {
  created: { event: null, noticed: false, stateLog: false },
  reported: { event: 'report', noticed: true, stateLog: true },
  retitled: { event: 'changed', noticed: false, stateLog: false },
  // A state set by the Task's Run starting or ending, or by a change below it: the time view draws it from the stateLog;
  // an entry into error is the failure's row (eventOf).
  linked: { event: null, noticed: false, stateLog: false },
  moved: { event: 'changed', noticed: true, stateLog: false },
  archived: { event: 'changed', noticed: true, stateLog: false },
  deleted: { event: 'changed', noticed: true, stateLog: false },
  restored: { event: 'changed', noticed: true, stateLog: false },
  responsible_changed: { event: 'changed', noticed: true, stateLog: false },
  placement_changed: { event: 'changed', noticed: false, stateLog: false },
  review_approved: { event: 'confirm', noticed: true, stateLog: true },
  // The Request owns the instruction's words and row, including a review's send-back. The decision is still news.
  review_sent_back: { event: null, noticed: true, stateLog: true },
  request_accepted: { event: null, noticed: false, stateLog: false },
  body_updated: { event: 'changed', noticed: false, stateLog: false },
  // The stop it asked for is the row.
  run_stop_requested: { event: null, noticed: false, stateLog: false },
  asked: { event: 'question', noticed: true, stateLog: true },
  answered: { event: 'answer', noticed: true, stateLog: true },
  question_withdrawn: { event: 'withdrawn', noticed: false, stateLog: true },
  question_expired: { event: 'expired', noticed: true, stateLog: true },
  user_request_changed: { event: 'changed', noticed: false, stateLog: false },
  dependencies_changed: { event: 'changed', noticed: true, stateLog: false },
  // What an instruction is, kept for analysis: the instruction's own row is the news.
};

/** Log kinds that are news to a reader: the row's latest noticed entry (taskRowFields) is of these. */
export const NOTICED_LOG_KINDS: ReadonlySet<LogKind> = new Set(TASK_LOG_KINDS.filter(kind => LOG_EVENTS[kind].noticed));
/** The records a row's stateLog keeps whether or not they change the state: reports, review decisions and questions. */
export const STATE_LOG_KINDS: ReadonlySet<LogKind> = new Set(TASK_LOG_KINDS.filter(kind => LOG_EVENTS[kind].stateLog));

/**
 * The event a log entry is in a history, or null when it is no row of its own. A Task's entry into error (its Run
 * failed, or ended with no report, or a person stopped it at work) is an error. A report is urgent when it says why
 * it goes to its requester at once, a review when it put the Task into waiting for one, the end of the work when it
 * finished the Task, a change when it set the work aside or took it up again, and a comment otherwise.
 */
export function eventOf(entry: Pick<TaskLog, 'kind' | 'fromState' | 'toState' | 'urgentReason'>): HistoryEventKind | null {
  if (entry.kind === 'linked') return entry.toState === 'error' ? 'error' : null;
  if (entry.kind !== 'reported') return LOG_EVENTS[entry.kind].event;
  if (entry.urgentReason !== undefined) return 'urgent';
  if (isReviewMark(entry)) return 'review';
  if (entry.toState !== null && isFinished(entry.toState)) return 'report';
  if (entry.toState === 'held' || entry.fromState === 'held') return 'changed';
  return 'comment';
}

/**
 * A child's events that its parent's history and its parent's start text (what changed since the last time) show:
 * its questions, their answers, the end of its work, its review, its urgent reports and its failures. Its other records
 * are read in the child's own history.
 */
export const PARENT_VISIBLE_EVENTS: ReadonlySet<HistoryEventKind> = new Set(
  ['question', 'answer', 'report', 'review', 'urgent', 'error', 'run_end']);

/** One log identity across the index line, History list and review target. */
export const logKey = (taskId: string, logId: string): string => `log:${taskId}:${logId}`;
/** One identity for each phase of a Run, in both the line and the reports. */
export const runPhaseKey = (runId: string, phase: 'accepted' | 'started' | 'finished') => `run:${runId}:${phase}`;
/** Kept only for tests on a pending branch that import it; goes once that branch is in. */
export const runFinishedKey = (runId: string) => runPhaseKey(runId, 'finished');
/** A Request's row, wherever it is read from: its History event, or its log line. */
export const requestKey = (requestId: string) => `request:${requestId}`;
/**
 * A History event's identity, the same as the line's for the same record: a Request's (which its accepting log entry
 * shares), a failed or scope-invalidated Run's end, a dialogue, a conversation's change, or a log entry's. A failure is a Run's when it set no state (a record that
 * is not a log entry), and otherwise the log entry's that put the Task into error (no report, a person's stop).
 */
export const historyEventKey = (event: Pick<HistoryEvent, "kind" | "taskId" | "id" | "state">): string =>
  event.kind === "request" ? requestKey(event.id) : event.kind === "run_end" || event.kind === "error" && event.state === null ? runPhaseKey(event.id, 'finished')
    : event.kind === "dialogue" ? `dialogue:${event.taskId}:${event.id}` : event.kind === "conversation" ? `conversation:${event.taskId}:${event.id}`
    : logKey(event.taskId, event.id);
