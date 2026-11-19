import { z } from 'zod';
import { historyCursorSchema, taskIdSchema } from '@alpacawork/contract';
import { HISTORY_WINDOW_MAX, HISTORY_WINDOW_SIZE, type HistoryWindowRequest } from '@alpacawork/contract/control';

/** Exactly one window operation; the wire query cannot silently combine refresh and pagination. */
export const historyWindowInput = z.discriminatedUnion('mode', [
  z.object({ task: taskIdSchema, mode: z.literal('latest') }).strict(),
  z.object({ task: taskIdSchema, mode: z.literal('since'), since: historyCursorSchema,
    keep: z.coerce.number().int().min(1).max(HISTORY_WINDOW_MAX) }).strict(),
  z.object({ task: taskIdSchema, mode: z.literal('protect'), since: historyCursorSchema, protect: historyCursorSchema }).strict(),
  z.object({ task: taskIdSchema, mode: z.literal('older'), before: historyCursorSchema,
    limit: z.coerce.number().int().min(1).max(HISTORY_WINDOW_SIZE).default(HISTORY_WINDOW_SIZE) }).strict(),
]).superRefine((value, ctx) => {
  if (value.mode === 'protect' && value.protect < value.since)
    ctx.addIssue({ code: 'custom', path: ['protect'], message: 'Protected event is outside the held window' });
}).transform(({ task, ...window }): { task: string; window: HistoryWindowRequest } => ({ task, window }));
