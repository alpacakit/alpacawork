import { z } from 'zod';
import { runIdSchema } from './fields.js';
import { runCompactionSchema, newConversationSchema } from './run-contract.js';
import { checkoutDirSource, rawDigestSchema, stepFingerprintSchema } from './work-contract.js';

const count = z.number().int().nonnegative();
const name = z.string().regex(/^[A-Za-z0-9_.:/@+ -]{1,160}$/);
export const RUN_SUMMARY_LIMITS = { largest: 5, tests: 100, commits: 50, prs: 20, files: 200, basis: 3, repeats: 100 } as const;
export const runOutputSummarySchema = z.strictObject({
  chars: count,
  largest: z.array(z.strictObject({ step: count, chars: count })).max(RUN_SUMMARY_LIMITS.largest),
});
const outputRef = z.string().min(1).max(300);
export const runProducedSchema = z.strictObject({
  commits: z.array(z.strictObject({ step: count, sha: z.string().regex(/^[a-f0-9]{7,64}$/), branch: outputRef.nullable() })).max(RUN_SUMMARY_LIMITS.commits),
  prs: z.array(z.strictObject({ step: count, url: outputRef, action: z.enum(['created', 'merged']) })).max(RUN_SUMMARY_LIMITS.prs),
  files: z.array(z.strictObject({ step: count, path: outputRef })).max(RUN_SUMMARY_LIMITS.files),
});
export const runBasisSchema = z.array(outputRef).max(RUN_SUMMARY_LIMITS.basis);
export const runUsageSummarySchema = z.strictObject({
  tools: z.record(name, count), mcp: z.record(name, count),
  skills: z.record(name, z.strictObject({ call: count, read: count })), subagentTools: count,
  outputs: runOutputSummarySchema, produced: runProducedSchema, basis: runBasisSchema,
});
export const runTestSchema = z.strictObject({
  step: count, line: z.string(), state: z.enum(['done', 'failed', 'unknown']),
  commit: z.string().nullable(), dirty: z.boolean().nullable(), diffDigest: rawDigestSchema.optional(),
  dir: z.string().startsWith('/').optional(), dirSource: checkoutDirSource.optional(),
  commitSource: z.enum(['observed', 'inferred']).nullable(),
});
const repeatSchema = z.strictObject({
  fingerprint: stepFingerprintSchema, rawDigest: rawDigestSchema.optional(),
  count: count.min(2), sameOutput: z.boolean(), steps: z.array(count).max(RUN_SUMMARY_LIMITS.repeats),
});
export const runSummarySchema = runUsageSummarySchema.extend({
  run: runIdSchema, state: z.enum(['complete', 'partial', 'unsupported', 'pending']),
  tests: z.array(runTestSchema).max(RUN_SUMMARY_LIMITS.tests),
  compactions: z.array(runCompactionSchema), newConversation: newConversationSchema.nullable(),
  repeats: z.strictObject({ exact: z.array(repeatSchema).max(RUN_SUMMARY_LIMITS.repeats),
    approximate: z.array(repeatSchema).max(RUN_SUMMARY_LIMITS.repeats) }),
});
export type RunOutputSummary = z.infer<typeof runOutputSummarySchema>;
export type RunProduced = z.infer<typeof runProducedSchema>;
export type RunTest = z.infer<typeof runTestSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
