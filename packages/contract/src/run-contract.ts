/** Browser-safe persisted run records and their state vocabulary. */
import { z } from 'zod';
import { conversationContextSchema } from '@alpacawork/raw/conversation-context';
import { runIdSchema, taskIdSchema, type RunId } from './fields.js';
import { agentLaunchSchema, coordinatorRestartSchema } from './agent-launch.js';
import { coordinatorMessageSchema } from './coordinator-contract.js';
import { runAvailabilitySchema } from './run-failure.js';
import { answerFileSchema } from './coordinator-files.js';

/** Run IDs are numbered in creation order; every list of runs sorts by this number. */
export const runNumber = (id: RunId): number => Number(id.slice(1));
export const compareRunIds = (a: { id: RunId }, b: { id: RunId }): number => runNumber(a.id) - runNumber(b.id);
/** Raw logs and temporary launch files belonging to one Run. */
export const RUN_FILES = {
  promptTemp: 'prompt.tmp', resultTemp: 'result.tmp', stdout: 'stdout.log', stderr: 'stderr.log', activity: 'activity.json', recentWork: 'recent-work.json', managerLog: 'manager.log', managerLock: 'manager.lock',
} as const;
export const RUN_RESULT_LIMIT = 1024 * 1024;
/** What became of a Run's final reply: `pending` until it ends, `present` with the text, otherwise why there is none. */
export const runResultStateSchema = z.enum(['present', 'pending', 'missing', 'too_large', 'unreadable']);
export type RunResultState = z.infer<typeof runResultStateSchema>;
/** A bounded display projection of the last complete agent stdout event. */
export const runActivityKindSchema = z.enum(['output', 'tool_start', 'tool_end', 'message', 'result', 'error']);
export { workCommandSchema, runWorkSchema, type WorkCommand } from './work-contract.js';
export { workNameSchema, workLabelSchema, type WorkName, type WorkLabel } from './work-contract.js';
export { runStepSchema, runStepsSchema, RUN_STEP_LIMIT, RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT,
  RUN_TOOL_NAME_LIMIT, RUN_NOTE_LIMIT, type RunStep } from './work-contract.js';
import { runWorkSchema, runStepsSchema, RUN_NOTE_LIMIT, RUN_TOOL_NAME_LIMIT } from './work-contract.js';
export const runActivitySchema = z.object({
  at: z.iso.datetime({ offset: true }), kind: runActivityKindSchema,
  toolName: z.string().max(RUN_TOOL_NAME_LIMIT).nullable(),
  doing: runWorkSchema.nullable(),
  note: z.object({ at: z.iso.datetime({ offset: true }), text: z.string().min(1).max(RUN_NOTE_LIMIT) }).strict().nullable(),
  steps: runStepsSchema,
}).strict();
export type RunActivity = z.infer<typeof runActivitySchema>;
/** Where run folders live, relative to the workspace root. */
const RUNS_DIRECTORY = '.alpacawork/runs';
/** The run's output folder under a normalized absolute workspace root. */
export const runFolder = (root: string, id: RunId): string => `${root.replace(/\/$/, '')}/${RUNS_DIRECTORY}/${id}`;
export const agentNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$(?![\s\S])/);
/** `joined`: the agent already working in the conversation took this Run's instruction into its work (`into`). */
export const runStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_review', 'joined']);
export const RUN_STATE = runStateSchema.enum;
/** States a run never leaves. */
export const RUN_ENDED_STATES = ['succeeded', 'failed', 'cancelled', 'joined'] as const satisfies readonly z.infer<typeof runStateSchema>[];
export type RunState = z.infer<typeof runStateSchema>;
export const isRunEnded = (state: RunState): boolean => (RUN_ENDED_STATES as readonly RunState[]).includes(state);
/** A finished Run with no session cannot be the head of a continued conversation. */
export const hasContinuableSession = (run: Pick<RunRecord, 'state' | 'session'>): boolean =>
  !isRunEnded(run.state) || run.session !== null;
type CarrierRun = Pick<RuntimeRunRecord, 'id' | 'state' | 'into' | 'supersededBy'>;
/** A joined input and a continued attempt both take their result from the Run doing the same work. */
export function carrierOf<Run extends CarrierRun>(run: Run, find: (id: RunId) => Run | undefined): Run | undefined {
  const seen = new Set<RunId>();
  let current: Run | undefined = run;
  while (current && !seen.has(current.id)) {
    const next: RunId | null = current.supersededBy ?? (current.state === 'joined' ? current.into : null);
    if (next === null) return current;
    seen.add(current.id);
    current = find(next);
  }
  return undefined;
}
export const isRunMoving = (state: RunState): boolean => state === RUN_STATE.queued || state === RUN_STATE.running;
export const isRunInTrouble = (state: RunState): boolean => state === RUN_STATE.failed || state === RUN_STATE.needs_review;
/** A failure is current until a later Run in its resumed chain actually starts. */
export function runFailureResolution<T extends { id: RunId; resumes?: RunId | null; supersededBy?: RunId; state: RunState; startedAt?: string | null }>(runs: readonly T[]): { run: T; resolvedBy: T | null }[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const priorAttempt = new Map<RunId, RunId>();
  for (const run of runs) if (run.supersededBy) priorAttempt.set(run.supersededBy, run.id);
  const previous = (run: T) => run.resumes ?? priorAttempt.get(run.id);
  const roots = new Map<RunId, T[]>();
  for (const run of runs) {
    let root = run;
    const seen = new Set<RunId>();
    for (let parent = previous(root); parent && byId.has(parent) && !seen.has(root.id); parent = previous(root)) {
      seen.add(root.id);
      root = byId.get(parent)!;
    }
    const chain = roots.get(root.id) ?? [];
    chain.push(run);
    roots.set(root.id, chain);
  }
  const failures: { run: T; resolvedBy: T | null }[] = [];
  for (const chain of roots.values()) {
    let pending: { run: T; resolvedBy: T | null }[] = [];
    for (const run of chain.sort(compareRunIds)) {
      if (run.startedAt) {
        for (const failure of pending) failure.resolvedBy = run;
        pending = [];
      }
      if (isRunInTrouble(run.state)) {
        const failure = { run, resolvedBy: null };
        failures.push(failure);
        pending.push(failure);
      }
    }
  }
  return failures.sort((a, b) => compareRunIds(a.run, b.run));
}
/** `attachment_save`: a coordinator's answer linked to local files whose copies could not be kept with it. */
export const runReasonSchema = z.enum(['exit', 'output', 'timeout', 'launch', 'conversation_busy', 'attachment_save', 'stopped', 'scope_invalidated', 'manager_lost']);
/** A Task's Run is its owner's or a worker's; a coordinator Run answers the screen's coordinator conversation. */
export const runRoleSchema = z.enum(['owner', 'worker', 'coordinator']);
export const RUN_ROLE = runRoleSchema.enum;
/** Conversation hosts alpacawork reads: run sessions and agent readers share them. */
export const sessionProviderSchema = agentNameSchema;
export const runCallerSchema = z.object({ run: runIdSchema }).strict().nullable();

/** Valid reasons are shared with the transition predicate. */
export const RUN_STATE_REASONS = {
  queued: [null], running: [null], succeeded: [null],
  failed: ['exit', 'output', 'timeout', 'launch', 'conversation_busy', 'attachment_save'],
  cancelled: ['stopped', 'scope_invalidated'], needs_review: [null, 'manager_lost', 'conversation_busy'], joined: [null],
} as const satisfies Record<z.infer<typeof runStateSchema>, readonly (z.infer<typeof runReasonSchema> | null)[]>;

/** Four disjoint token classes, normalized at each agent reader. */
export const tokenCountersSchema = z.object({
  input: z.number().int().nonnegative().safe(),
  cacheRead: z.number().int().nonnegative().safe(),
  cacheWrite: z.number().int().nonnegative().safe(),
  output: z.number().int().nonnegative().safe(),
}).strict();
export type TokenCounters = z.infer<typeof tokenCountersSchema>;
export const TOKEN_COUNTER_KEYS = tokenCountersSchema.keyof().options;
export const runUsageSchema = z.object({
  conversation: tokenCountersSchema.nullable(),
  run: tokenCountersSchema.nullable(),
  includesEarlier: z.boolean(),
}).strict();
export type RunUsage = z.infer<typeof runUsageSchema>;
/** A Task's Run (its owner's or a worker's, at a placement of the Task), apart from its checks so a coordinator Run extends it. */
const taskRunObject = z.object({
  id: runIdSchema,
  task: taskIdSchema,
  placementId: z.string().min(1),
  requestId: z.string().min(1),
  /** The first Run uses index zero; retries have the index of their frozen candidate. */
  attempt: z.number().int().positive().safe().optional(),
  firstRunId: runIdSchema.optional(),
  /** A failed attempt reserved this next Run in its completion transaction. */
  supersededBy: runIdSchema.optional(),
  availability: runAvailabilitySchema.optional(),
  context: conversationContextSchema.optional(),
  agent: agentNameSchema,
  role: runRoleSchema.exclude([RUN_ROLE.coordinator]),
  resumes: runIdSchema.nullable(),
  continues: z.literal(false),
  session: z.object({ provider: sessionProviderSchema.nullable(), id: z.string().min(1) }).strict().nullable(),
  caller: runCallerSchema,
  cwd: z.string().startsWith('/'),
  launch: agentLaunchSchema,
  state: runStateSchema,
  reason: runReasonSchema.nullable(),
  into: runIdSchema.nullable(),
  stop_requested: z.boolean(),
  exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }).strict().nullable(),
  usage: runUsageSchema.nullable(),
  created_at: z.iso.datetime({ offset: true }),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  ended_at: z.iso.datetime({ offset: true }).nullable(),
  pids: z.object({ manager: z.number().int().nullable(), agent: z.number().int().nullable() }).strict(),
}).strict();
/** What every Run record keeps, whoever it answers. */
function checkRunRecord(record: Pick<z.infer<typeof taskRunObject>, 'state' | 'reason' | 'ended_at' | 'into' | 'started_at' | 'supersededBy' | 'availability' | 'attempt' | 'firstRunId'>,
  ctx: z.RefinementCtx): void {
  const reasons: readonly (string | null)[] = RUN_STATE_REASONS[record.state];
  if (!reasons.includes(record.reason)) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reason does not match state' });
  if (isRunEnded(record.state) && record.ended_at === null)
    ctx.addIssue({ code: 'custom', path: ['ended_at'], message: 'Ended run requires an end time' });
  if ((record.state === 'joined') !== (record.into !== null))
    ctx.addIssue({ code: 'custom', path: ['into'], message: 'Only a joined run names the run it joined' });
  if ((record.attempt === undefined) !== (record.firstRunId === undefined))
    ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'A retry must name its request’s first Run' });
  if (record.supersededBy !== undefined && (record.state !== 'failed' || record.availability === undefined))
    ctx.addIssue({ code: 'custom', path: ['supersededBy'], message: 'A superseded run requires a failed availability observation' });
  if (record.state === 'queued' && record.started_at !== null)
    ctx.addIssue({ code: 'custom', path: ['started_at'], message: 'Queued run cannot have a start time' });
}
/** A Task's Run, the only Run the Task side (control, tree, views, credentials) reads. */
export const runRecordSchema = taskRunObject.superRefine(checkRunRecord);
export type RunRecord = z.infer<typeof runRecordSchema>;
/** A pure reader's view of the schema-owned JSON record, including nested arrays and objects. */
export type DeepReadonly<T> = T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[] :
  T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
export type ReadRunRecord = DeepReadonly<RunRecord>;
/**
 * A coordinator Run answers one Request to the screen's coordinator conversation. It has no Task, placement or caller
 * and gets no Run credential. `message` is what the screen sent with the Request's words, fixed when it was admitted.
 * `joinRequested` asks that its queued Request go to the coordinator Run already working in the conversation (send now).
 * `answerFiles`: the copies kept, when it ended, of the local files its answer links to; absent when it links to none.
 */
export const coordinatorRunRecordSchema = taskRunObject.extend({
  task: z.null(), placementId: z.null(), role: z.literal(RUN_ROLE.coordinator), caller: z.null(),
  ...coordinatorRestartSchema.shape,
  conversationId: z.uuid(), message: coordinatorMessageSchema, joinRequested: z.literal(true).optional(),
  answerFiles: z.array(answerFileSchema).min(1).optional(),
}).superRefine(checkRunRecord);
export type CoordinatorRunRecord = z.infer<typeof coordinatorRunRecordSchema>;
/** Every Run, as only the execution layer (scheduling, launching, importing, recovering) reads it. */
export const runtimeRunRecordSchema = z.discriminatedUnion('role', [runRecordSchema, coordinatorRunRecordSchema]);
export type RuntimeRunRecord = z.infer<typeof runtimeRunRecordSchema>;

/** The HTTP response to stopping Runs. */
export const stopResponseSchema = z.object({
  cancelled: z.array(runIdSchema),
  stop_requested: z.array(runIdSchema),
});
