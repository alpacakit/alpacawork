/** Machine facts that explain a failure more precisely than its HTTP/retry category. */
import { z } from 'zod';
import { businessReasonOptions } from './business-reasons.js';
export { businessReasonSchema } from './business-reasons.js';

const diagnosticIssue = z.object({ code: z.string(), path: z.string().optional(), line: z.number().optional(),
  column: z.number().optional(), diagnostic: z.string() }).strict();
/** Technical values supplied by libraries/OS are retained separately from application wording. */
const atomicReasonSchema = z.discriminatedUnion('kind', [
  ...businessReasonOptions,
  z.object({ kind: z.literal('authorization_required'), action: z.string(), grants: z.array(z.tuple([z.enum(['own', 'parent', 'placement', 'asked', 'responsible', 'run', 'user', 'human'])]).rest(z.enum(['held', 'same_project', 'project_above', 'within'])).readonly()).readonly() }).strict(),
  z.object({ kind: z.literal('file_missing'), path: z.string() }).strict(),
  z.object({ kind: z.literal('config_section_missing'), path: z.string(), section: z.string() }).strict(),
  z.object({ kind: z.literal('config_invalid'), path: z.string(), issues: z.array(diagnosticIssue) }).strict(),
  z.object({ kind: z.literal('validation_error'), issues: z.array(diagnosticIssue) }).strict(),
  z.object({ kind: z.literal('system_error'), code: z.string(), syscall: z.string().optional(), path: z.string().optional(),
    dest: z.string().optional(), diagnostic: z.string() }).strict(),
  z.object({ kind: z.literal('unexpected_error'), name: z.string(), diagnostic: z.string() }).strict(),
  z.object({ kind: z.enum(['database_busy', 'database_migration_required', 'scope_lookup_unavailable', 'task_lookup_unavailable', 'history_past_unavailable',
    'history_revalidation_unavailable']) }).strict(),
  z.object({ kind: z.literal('voice_key_missing'), env: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('voice_token_request_failed'), provider: z.enum(['soniox', 'deepgram']),
    status: z.number().int().min(100).max(599) }).strict(),
  z.object({ kind: z.literal('voice_stream_failed'), provider: z.enum(['soniox', 'deepgram']), code: z.string(), diagnostic: z.string().optional() }).strict(),
  z.object({ kind: z.literal('voice_token_response_invalid'), provider: z.enum(['soniox', 'deepgram']) }).strict(),
]);


const hostFailure = z.object({ kind: z.literal('host_failure'), operation: z.enum(['sample', 'record_unavailable', 'record']) });
const runStoreFailure = z.object({ kind: z.literal('run_store_unavailable') });
const pushFailure = z.object({ kind: z.literal('push_unavailable') });
const installationFailure = z.object({ kind: z.literal('installation_record_unavailable'), path: z.string() });
const updateRefusal = z.object({ kind: z.literal('update_refused'), reason: z.string().min(1) });

/** Keep every source reason intact when a higher owner adds operation context. */
export type FaultReason = z.infer<typeof atomicReasonSchema>
  | ((z.infer<typeof hostFailure> | z.infer<typeof runStoreFailure> | z.infer<typeof pushFailure>
    | z.infer<typeof installationFailure>) & { cause: FaultReason })
  | (z.infer<typeof updateRefusal> & { cause?: FaultReason });
export const faultReasonSchema: z.ZodType<FaultReason> = z.lazy(() => z.discriminatedUnion('kind', [
  ...atomicReasonSchema.options,
  hostFailure.extend({ cause: faultReasonSchema }).strict(),
  runStoreFailure.extend({ cause: faultReasonSchema }).strict(),
  pushFailure.extend({ cause: faultReasonSchema }).strict(),
  installationFailure.extend({ cause: faultReasonSchema }).strict(),
  updateRefusal.extend({ cause: faultReasonSchema.optional() }).strict(),
]));
export const problemReasonSchema = faultReasonSchema;
export type ProblemReason = FaultReason;
