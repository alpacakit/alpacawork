/**
 * Browser-safe: the screen's coordinator conversation as serve shows it, and a message the screen sends to it. Serve
 * builds the one, the screen parses it; the screen builds the other, serve parses it.
 */
import { z } from 'zod';
import { aiRowSchema } from './ai-stack.js';
import { launchArgumentValuesSchema } from './agent-settings.js';
import { runAvailabilitySchema, runFailureSchema } from './run-failure.js';
import { recordedProblemSchema } from './problem.js';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { digestSchema, logIdSchema, runIdSchema, taskIdSchema } from './fields.js';
import { answerFileSchema } from './coordinator-files.js';
import { contextViewSchema } from './agent-context.js';

const COORDINATOR_ATTACHMENT_LIMIT = 20;
/** Immutable historical operation data. This is not an executable input contract. */
export const recordedOperationSchema = z.record(z.string(), z.json());
/**
 * A request on the screen (send back, continue, continue with the same AI or another), for the coordinator to carry out: the Task, the Run or question
 * it was about, and the versions the screen showed when it was pressed. The coordinator passes those to `--expected-*`
 * as they are. Its words are only the message's own; serve never makes words of an intent. A draft's choices are not a
 * press: the questions they answer go as the message's `answers`.
 */
export const coordinatorIntentSchema = z.object({
  task: taskIdSchema,
  action: z.enum(['sendback', 'continue', 'retry', 'switch']),
  aboutRun: runIdSchema.optional(), question: logIdSchema.optional(),
  expectedTaskHash: digestSchema.optional(), expectedPlacementRevision: z.number().int().positive().optional(),
}).strict();
export type CoordinatorIntent = z.infer<typeof coordinatorIntentSchema>;
/**
 * The questions referred to by a draft's choices (`T3（Title） 1-Option1`), each by Task, ID and captured versions.
 * The receiving AI decides whether to save an answer; metadata neither closes a question nor establishes sufficiency.
 * Two questions of one number stay apart.
 */
/** Live answers carry only the fixed question identity. */
export const coordinatorAnswersInputSchema = z.array(z.object({ task: taskIdSchema, question: logIdSchema }).strict()).min(1);
/** Execution history is immutable evidence; old captured guards remain readable but never become new answer input. */
export const coordinatorAnswersSchema = z.array(coordinatorAnswersInputSchema.element.extend({
  expectedTaskHash: digestSchema.optional(), expectedPlacementRevision: z.number().int().positive().nullable().optional(),
}).strict()).min(1);
export type CoordinatorAnswers = z.infer<typeof coordinatorAnswersInputSchema>;
/**
 * Frozen message metadata retained with its Run. `tasks` are the draft's target set (labels and IDs in its words); an
 * ID with no Task is kept but links nothing. Answers and reader intents name the Tasks they act on, which must exist. `context` belongs to historical Run snapshots only: new admissions write null and
 * neither the screen input nor the agent prompt accepts viewing context.
 */
export const coordinatorMessageSchema = z.object({
  context: taskIdSchema.nullable(),
  tasks: z.array(taskIdSchema).optional(),
  skills: z.array(z.string().min(1).max(256)).max(128).optional(),
  attachments: z.array(z.string()).max(COORDINATOR_ATTACHMENT_LIMIT),
  intent: recordedOperationSchema.nullable(),
  answers: coordinatorAnswersSchema.optional(),
  /** The failed message this one sends again: it stands in that message's place, which the conversation no longer shows. */
  retryOf: z.string().min(1).max(256).optional(),
}).strict();
export type CoordinatorMessage = z.infer<typeof coordinatorMessageSchema>;
/**
 * POST /api/coordinator/messages. `id` is the message's Request ID. Its size is bounded by what a Run is given.
 */
export const coordinatorMessageInputSchema = z.object({
  conversationId: z.string(), id: z.string(), text: z.string(),
  tasks: coordinatorMessageSchema.shape.tasks,
  skills: coordinatorMessageSchema.shape.skills,
  attachments: coordinatorMessageSchema.shape.attachments,
  intent: coordinatorIntentSchema.optional(),
  answers: coordinatorAnswersInputSchema.optional(),
  replyTo: z.string().min(1).max(256).nullable().optional(),
  retryOf: coordinatorMessageSchema.shape.retryOf,
}).strict().refine(input => input.text.trim() !== '' || input.attachments.length > 0,
  { message: 'A message needs words or a file', path: ['text'] });
export type CoordinatorMessageInput = z.input<typeof coordinatorMessageInputSchema>;
export const coordinatorConversationInputSchema = z.object({ conversationId: z.string().min(1) }).strict();

/** Completed replies acknowledged by reading or explicitly opening history, scoped to the conversation; set union makes retries idempotent. */
export const coordinatorReadInputSchema = z.object({
  conversationId: z.string().min(1).max(256),
  seen: z.array(z.string().min(1).max(256)).min(1).max(128),
}).strict();
/** Acknowledges only this batch, rather than sending another copy of the conversation. */
export const coordinatorReadAckSchema = coordinatorReadInputSchema;
export type CoordinatorReadAck = z.infer<typeof coordinatorReadAckSchema>;

export const coordinatorErrorSchema = z.enum(['interrupted', 'timeout', 'exit', 'output', 'too_large',
  'unreadable', 'conversation_busy', 'config', 'launch', 'attachment', 'attachment_save', 'server', 'internal']);
export type CoordinatorError = z.infer<typeof coordinatorErrorSchema>;
/**
 * What the server did with a message once the turn it opened has ended: the records its writes left on Tasks (those
 * quoting its words), in order, each with the state it led to (null when it kept the state); an answer names the
 * question it closed, a review's OK the Run it approved. Then the writes it refused, with why.
 */
export const coordinatorResultSchema = z.object({
  writes: z.array(z.object({ task: taskIdSchema, record: logIdSchema, kind: taskLogSchema.shape.kind,
    toState: taskLogSchema.shape.toState, question: logIdSchema.optional(), runId: runIdSchema.optional() }).strict()),
  refused: z.array(recordedProblemSchema.extend({ task: taskIdSchema })),
}).strict();
export type CoordinatorResult = z.infer<typeof coordinatorResultSchema>;
/**
 * One message and its answer. `sending`: being handed to the agent at work; `joined`: that agent took it into its work
 * (the message it answers is `into`). `deliveryError`: handing it over did not happen; it waits its turn. `intent` and
 * `answers` are the same the coordinator was given. `answerFiles`: the copies kept of the local files its answer links to.
 * `result`: null until the Run that answers it (its own, or the one it joined) has ended.
 */
export const coordinatorTurnSchema = z.object({
  id: z.string(), at: z.string(), ask: z.string(),
  tasks: coordinatorMessageSchema.shape.tasks,
  skills: coordinatorMessageSchema.shape.skills,
  attachments: coordinatorMessageSchema.shape.attachments,
  intent: recordedOperationSchema.optional(), answers: coordinatorMessageSchema.shape.answers,
  replyTo: z.object({ id: z.string(), answeredAt: z.string(), head: z.string() }).optional(),
  status: z.enum(['queued', 'sending', 'joined', 'running', 'succeeded', 'failed']),
  /** A failed message another message was sent again for (its `retryOf`): that one stands in its place. */
  sentAgain: z.literal(true).optional(),
  /** Asked to join the work at its next input boundary; absent once handing over. */
  joinRequested: z.literal(true).optional(),
  /** Turn order or an unconfirmed handover holds this accepted message, rather than launch preparation alone. */
  waiting: z.boolean(),
  into: z.string().optional(), deliveryError: z.enum(['refused', 'closed']).optional(),
  answer: z.string().nullable(), answeredAt: z.string().nullable(), error: coordinatorErrorSchema.nullable(),
  /** Redacted diagnostic from this failed Run; absent without trustworthy error evidence. */
  failure: runFailureSchema.optional(),
  attempts: z.array(aiRowSchema.extend({ availability: runAvailabilitySchema.optional() })).optional(),
  seen: z.boolean(),
  answerFiles: z.array(answerFileSchema).optional(),
  filesExpired: z.literal(true).optional(),
  result: coordinatorResultSchema.nullable(),
  /** The Run that answered it, once ended, when that Run took steps: they open under the answer. */
  workedBy: runIdSchema.optional(),
});
/** The agent and selected values actually passed in the next message's launch arguments. */
export const coordinatorNextLaunchSchema = z.object({ agent: aiRowSchema.shape.agent, values: launchArgumentValuesSchema }).strict();
export type CoordinatorNextLaunch = z.infer<typeof coordinatorNextLaunchSchema>;
const coordinatorMessageId = z.string().min(1).max(256);
export const COORDINATOR_RECENT_TURNS = 20;
export const COORDINATOR_HISTORY_PAGE = 50;
export const COORDINATOR_MEMO_LIMIT = 2000;

export const coordinatorResetReasonSchema = z.object({
  kind: z.enum(['asked', 'context', 'another_ai', 'fallback', 'recovered', 'unresumable']),
  over: z.union([z.object({ tokens: z.number().int().nonnegative() }).strict(),
    z.object({ percent: z.number().nonnegative() }).strict()]).optional(),
  from: aiRowSchema.optional(), to: aiRowSchema.optional(),
}).strict();
export type CoordinatorResetReason = z.infer<typeof coordinatorResetReasonSchema>;
export const coordinatorResetSchema = z.object({
  id: z.string().uuid(), beforeRequestId: coordinatorMessageId.nullable(), at: z.iso.datetime({ offset: true }),
  reason: coordinatorResetReasonSchema,
}).strict();
export type CoordinatorReset = z.infer<typeof coordinatorResetSchema>;
export const coordinatorResetInputSchema = coordinatorConversationInputSchema.extend({ opId: z.uuid() });
export const coordinatorMemoSchema = z.object({ text: z.string(), updatedAt: z.iso.datetime({ offset: true }) }).strict().nullable();
export const coordinatorMemoSetInputSchema = z.object({
  text: z.string().refine(text => Array.from(text).length <= COORDINATOR_MEMO_LIMIT,
    { message: 'Coordinator memo is limited to 2,000 characters' }),
}).strict();

/** A page can seek an older reply directly, or continue backwards from an exclusive cursor. */
export const coordinatorTurnsInputSchema = coordinatorConversationInputSchema.extend({
  before: coordinatorMessageId.optional(), around: coordinatorMessageId.optional(),
}).refine(input => (input.before === undefined) !== (input.around === undefined),
  { message: 'Provide either before or around' });
export const coordinatorTurnsPageSchema = z.object({
  turns: z.array(coordinatorTurnSchema).max(COORDINATOR_HISTORY_PAGE),
  resets: z.array(coordinatorResetSchema), more: coordinatorMessageId.nullable(),
}).strict();
export type CoordinatorTurnsPage = z.infer<typeof coordinatorTurnsPageSchema>;

export const coordinatorMessageStatusSchema = z.object({
  id: coordinatorMessageId,
  status: z.enum([...coordinatorTurnSchema.shape.status.options, 'withdrawn', 'missing']),
}).strict();
export type CoordinatorMessageStatus = z.infer<typeof coordinatorMessageStatusSchema>;

/** The bounded snapshot, including any active turns and the usage of the current session. */
export const coordinatorConversationSchema = z.object({
  id: z.string().min(1), nextLaunch: coordinatorNextLaunchSchema.nullable(), busy: z.boolean(),
  turns: z.array(coordinatorTurnSchema),
  earlier: z.object({ count: z.number().int().positive(), before: coordinatorMessageId }).strict().nullable(),
  resets: z.array(coordinatorResetSchema), context: contextViewSchema.nullable(),
  autoReset: z.object({ tokens: z.number().int().nonnegative(), percent: z.number().int().min(0).max(100) }).strict(),
});
/** One server snapshot, with the scope and digest of that exact conversation object. */
export const coordinatorSnapshotSchema = z.object({ root: z.string().min(1), generation: z.string().min(1),
  revision: digestSchema, conversation: coordinatorConversationSchema }).strict();
export const coordinatorResetConversationSchema = coordinatorConversationSchema;
export const coordinatorResetSnapshotSchema = coordinatorSnapshotSchema;
export const coordinatorMessageResponseSchema = coordinatorResetSnapshotSchema.extend({ message: coordinatorMessageStatusSchema });
export const coordinatorResetResponseSchema = coordinatorResetSnapshotSchema.extend({ reset: coordinatorResetSchema });
export const coordinatorMarkerSchema = z.object({ id: z.string().min(1), revision: digestSchema }).strict();
export type CoordinatorSnapshot = z.infer<typeof coordinatorSnapshotSchema>;
export type CoordinatorTurn = z.infer<typeof coordinatorTurnSchema>;
export type CoordinatorConversation = z.infer<typeof coordinatorConversationSchema>;

export { taskTokens, firstTaskToken, formatTask, taskStatement } from './task-tokens.js';
/** Read no more than 1,200 characters from a delivered Request's referenced reply. */
export const coordinatorReplyGetInput = z.object({ message: z.string().min(1).max(256), from: z.number().int().positive().safe().default(1) }).strict();
