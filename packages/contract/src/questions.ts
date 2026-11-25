/**
 * Browser-safe: a question a responsible asked, as a reader receives it. `decide` is what it asks, fixed when it was
 * asked: the screen draws its choices from it, and an agent reads it as text (task-schema questionText).
 */
import { z } from 'zod';
import { logIdSchema, taskIdSchema } from './fields.js';

export const questionSchema = z.object({
  /** The asking log entry: what an answer names. */
  id: logIdSchema, taskId: taskIdSchema,
  /** Who was asked, fixed when asked: the user, or the chosen ancestor Task's responsible. */
  destination: z.discriminatedUnion('kind', [z.object({ kind: z.literal('user') }).strict(),
    z.object({ kind: z.literal('task'), taskId: taskIdSchema }).strict()]),
  applicable: z.boolean(),
  closedAt: z.iso.datetime({ offset: true }).optional(),
  closureReason: z.literal('destination_invalid').optional(),
  title: z.string().min(1), summary: z.string().min(1),
  askedAt: z.iso.datetime({ offset: true }),
  /** Open until answered, withdrawn by the asker, or expired when the Task stopped or its fixed destination became invalid. */
  state: z.enum(['open', 'answered', 'withdrawn', 'expired']),
  /** What it asks, fixed when asked: the asking Task's `decide` items (task-schema DEFAULT_FIELDS). */
  decide: z.array(z.record(z.string(), z.unknown())).min(1),
}).strict();

export { answerPartSchema, answerPartsSchema, type AnswerPart, type AnswerParts } from '@alpacawork/raw';
