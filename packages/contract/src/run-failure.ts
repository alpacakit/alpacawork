/** Browser-safe diagnostic derived from a failed Run's own machine error events. */
import { z } from 'zod';

export const runErrorCauseSchema = z.enum(['model_capacity', 'weekly_limit']);
export const RUN_FAILURE_MESSAGE_LIMIT = 2000;
export const runFailureSchema = z.object({
  cause: runErrorCauseSchema.optional(),
  message: z.string().min(1).max(RUN_FAILURE_MESSAGE_LIMIT),
}).strict();
export type RunFailure = z.infer<typeof runFailureSchema>;
