/**
 * Browser-safe: whose move a Task waits on (its ball). The server derives it in one place (control/ball.ts) and
 * sends it; the tree, the list, unread marks and push read it as sent and never derive it again.
 */
import { z } from 'zod';
import { problemReasonSchema } from './problem.js';
import { logIdSchema, runIdSchema } from './fields.js';

/**
 * Why the user holds the ball: a review, a question asked of them, automatic wakes stopped at their limit, a delivery
 * whose receipt is unknown, a wake refused for another reason, or a failure of work they asked for.
 */
export const userTurnReasonSchema = z.enum(['review', 'question', 'limit', 'unconfirmed', 'blocked', 'failed']);
/** Each detail of the user's ball belongs to one reason, and that reason always carries it. */
const USER_TURN_DETAILS = [['questionId', 'question'], ['count', 'limit'], ['code', 'blocked']] as const;
export const ballSchema = z.discriminatedUnion('holder', [
  z.object({
    holder: z.literal('user'), reason: userTurnReasonSchema,
    /** When the turn began, and what tells it from another turn: unchanged by a hold and its return. */
    at: z.iso.datetime({ offset: true }), key: z.string().min(1),
    /** The question to answer. */
    questionId: logIdSchema.nullable(),
    /** The Run a review confirms; null for a Task snapshot submitted without a Run. */
    aboutRunId: runIdSchema.nullable(),
    /** How many deliveries wait behind the limit. */
    count: z.number().int().positive().nullable(),
    /** What refused the wake. */
    code: z.string().min(1).nullable(),
    /** The immutable business reason that caused a refused automatic wake. */
    problemReason: problemReasonSchema.optional(),
    /** A failure the user also decides while their question is open: the record that put the Task in error. */
    failure: z.object({ at: z.iso.datetime({ offset: true }), key: z.string().min(1) }).strict().nullable(),
  }).strict(),
  /** The parent's responsible answers the child's question, or decides on its failure. */
  z.object({ holder: z.literal('parent'), reason: z.enum(['question', 'failed']) }).strict(),
  /** A Request the Task sent below is still open. */
  z.object({ holder: z.literal('child') }).strict(),
  /** The Task's own responsible is at work. */
  z.object({ holder: z.literal('owner') }).strict(),
]).superRefine((ball, context) => {
  if (ball.holder !== 'user') return;
  if (ball.problemReason && ball.reason !== 'blocked')
    context.addIssue({ code: 'custom', path: ['problemReason'], message: 'Only a blocked turn can carry a wake refusal' });
  if (ball.aboutRunId !== null && ball.reason !== 'review')
    context.addIssue({ code: 'custom', path: ['aboutRunId'], message: 'aboutRunId belongs only to a review' });
  for (const [detail, reason] of USER_TURN_DETAILS) {
    if ((ball[detail] !== null) !== (ball.reason === reason))
      context.addIssue({ code: 'custom', path: [detail], message: `${detail} is given when, and only when, the reason is ${reason}` });
  }
  if (ball.failure !== null && ball.reason !== 'question')
    context.addIssue({ code: 'custom', path: ['failure'], message: 'failure is given only beneath a question' });
});
/** A Task whose move nobody awaits (not started, finished, or no longer active) has no ball: null where one is read. */
export type Ball = z.infer<typeof ballSchema>;

/** The ball when it is the user's move, else null. */
export const userTurn = (ball: Ball | null) => ball?.holder === 'user' ? ball : null;
