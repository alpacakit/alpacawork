/** Browser-safe diagnostic derived from a failed Run's own machine error events. */
import { z } from 'zod';

export const runErrorCauseSchema = z.enum(['model_capacity', 'weekly_limit', 'session_limit', 'model_limit']);
export const runAvailabilitySchema = z.object({
  cause: runErrorCauseSchema,
  resetsAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type RunAvailability = z.infer<typeof runAvailabilitySchema>;
export const RUN_FAILURE_MESSAGE_LIMIT = 2000;
export const runFailureSchema = z.object({
  cause: runErrorCauseSchema.optional(),
  /** When a usage limit lifts, as the agent reported it. */
  resetsAt: z.iso.datetime({ offset: true }).optional(),
  message: z.string().min(1).max(RUN_FAILURE_MESSAGE_LIMIT),
}).strict();
export type RunFailure = z.infer<typeof runFailureSchema>;
