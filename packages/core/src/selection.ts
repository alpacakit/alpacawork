import { z } from 'zod';
/** A selected value is a candidate or explicit omission. */
export const selectedValueSchema = z.union([
  z.string().refine(value => value.trim().length > 0 && value !== '-', 'Use null for unspecified, never empty or -'), z.null(),
]);
export const selectedValuesSchema = z.record(z.string(), selectedValueSchema);
const fields = { key: z.string(), previous: z.string().nullable(), candidates: z.array(z.string().nullable()) };
export const selectionProblemSchema = z.discriminatedUnion('reason', [
  z.object({ ...fields, reason: z.enum(['removed', 'unused']), recovery: z.literal('new_conversation') }).strict(),
  z.object({ ...fields, reason: z.enum(['invalid_value', 'null_required']), recovery: z.literal('select_value') }).strict(),
]);
export type SelectionProblem = z.infer<typeof selectionProblemSchema>;
export const selectionRequiredReasonSchema = z.object({
  kind: z.literal('selection_required'), problems: z.array(selectionProblemSchema).min(1),
}).strict();
