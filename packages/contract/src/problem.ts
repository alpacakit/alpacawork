import { problemReasonSchema } from '@alpacawork/core/reasons';
export { problemReasonSchema, type ProblemReason } from '@alpacawork/core/reasons';
/** The failure envelope every HTTP endpoint and the CLI's stderr answer with (`errorBody`). */
import { z } from 'zod';
import { PROBLEM_CODE, RETRY } from '@alpacawork/core/codes';
import type { Issue } from '@alpacawork/core/issues';
export type { Issue };
export { toIssues } from '@alpacawork/core/issues';

export const issueSchema = z.object({
  path: z.string(), code: z.string().min(1), message: z.string(),
  params: z.record(z.string(), z.number()).optional(),
}).strict() satisfies z.ZodType<Issue>;
export const problemErrorSchema = z.object({
  code: z.enum(Object.values(PROBLEM_CODE)), message: z.string(), retry: z.enum(Object.values(RETRY)),
  reason: problemReasonSchema.optional(), issues: z.array(issueSchema).optional(), detail: z.unknown().optional(),
}).strict();
export const problemSchema = z.object({ error: problemErrorSchema }).strict();
/** One part of a read that could not be read, where the rest still answers. */
export const errorEntrySchema = z.object({ code: z.string(), message: z.string(), path: z.string(), reason: problemReasonSchema.optional() }).strict();
export type ProblemBody = z.infer<typeof problemSchema>;

/** Frozen historical refusal data. Never validate this as a new executable Problem or authorization. */
export const recordedProblemSchema = z.object({
  code: z.string().min(1), message: z.string(), retry: z.enum(Object.values(RETRY)),
  reason: z.json().optional(), issues: z.array(issueSchema).optional(), detail: z.json().optional(),
}).catchall(z.json());
