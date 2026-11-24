/** Stable execution contract. It intentionally does not contain a persisted Run record or SQL schema. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { agentInvocationSchema } from './agent-launch.js';
import { runAvailabilitySchema } from './run-failure.js';
import { CLI_CONTRACT } from './client-contract.js';

export const PROTOCOL = 1;
export const PROTOCOL_LIMITS = { launch: 512 * 1024, command: 512 * 1024, event: 64 * 1024, result: 1024 * 1024, prompt: 256 * 1024 } as const;
const runId = z.string().regex(/^R[1-9][0-9]*$/), uuid = z.uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const identitySchema = z.object({ protocol: z.literal(PROTOCOL), workspaceId: uuid, runId, attemptId: uuid }).strict();
export type ExecutionIdentity = z.infer<typeof identitySchema>;
const session = z.object({ provider: z.string().nullable(), id: z.string().min(1) }).strict().nullable();
export const invocationSchema = agentInvocationSchema.extend({ session }).strict();
export const compactionLaunchSchema = z.object({ id: uuid, instructions: z.string().nullable() }).strict();
export type CompactionLaunch = z.infer<typeof compactionLaunchSchema>;
/** What the agent said of the compaction its launch asked for; null when it said nothing. */
export const compactionOutcomeSchema = z.object({ state: z.enum(['compacted', 'failed']), message: z.string().max(2000).nullable() }).strict();
export type CompactionOutcome = z.infer<typeof compactionOutcomeSchema>;
/**
 * `credential` is null for a coordinator Run: it calls alpacawork as the user's direct caller, never as a Run.
 * `commandSeconds` is absent only in a launch recorded before command limits existed; every new launch writes it.
 */
export const launchSchema = identitySchema.extend({ cwd: z.string().startsWith('/'), invocation: invocationSchema,
  prompt: z.string().refine(v => Buffer.byteLength(v) <= PROTOCOL_LIMITS.prompt), initialInputId: uuid,
  format: z.string().regex(/^[a-f0-9]{64}$/), runMinutes: z.number().nonnegative(), commandSeconds: z.number().int().positive().nullable().optional(), credential: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  entry: z.string().startsWith('/'), version: z.string().min(1), server: z.string().url().nullable(), ancestors: z.array(runId), release: z.string().nullable(),
  /** The conversation is compacted before the initial input (agent compact); `instructions` only for an agent that takes them.
   * Absent or null: no compaction. */
  compaction: compactionLaunchSchema.nullable().optional(),
}).strict().refine(value => value.commandSeconds === undefined || (value.credential === null) === (value.commandSeconds !== null),
  'Only a coordinator launch has command seconds');
export type LaunchSnapshot = z.infer<typeof launchSchema>;
export const commandSchema = identitySchema.extend({ seq: z.number().int().positive().safe(), commandId: uuid,
  type: z.enum(['input', 'cancel-input', 'stop']), inputId: uuid.nullable(), instructionRunId: runId.nullable(),
  text: z.string().nullable(), contentDigest: digest.nullable(), operationId: z.string().min(1).nullable(),
}).strict().superRefine((c, ctx) => {
  if (c.type === 'input' && (!c.inputId || !c.instructionRunId || c.text === null || !c.contentDigest))
    ctx.addIssue({ code: 'custom', message: 'Input requires identity, text and digest' });
});
export type RunCommand = z.infer<typeof commandSchema>;
/**
 * Where an input to a running agent stands. `uncertain` is a send whose receipt is not known and is never resent by
 * itself; `resolved` is one a person's proxy has since dealt with.
 */
export const RUN_INPUT_STATES = ['reserved', 'attempted', 'taken', 'not_sent', 'uncertain', 'resolved'] as const;
type RunInputState = (typeof RUN_INPUT_STATES)[number];
/** Inputs whose outcome is not yet known. The rest are settled: taken, never sent, or dealt with by a person's proxy. */
export const UNSETTLED_INPUT_STATES = ['reserved', 'attempted', 'uncertain'] as const satisfies readonly RunInputState[];
/** Inputs handed to their agent whose receipt is not in. */
export const AWAITING_RECEIPT_STATES = ['attempted', 'uncertain'] as const satisfies readonly RunInputState[];
export const inputUnsettled = (state: unknown): boolean => (UNSETTLED_INPUT_STATES as readonly unknown[]).includes(state);
export const inputAwaitsReceipt = (state: unknown): boolean => (AWAITING_RECEIPT_STATES as readonly unknown[]).includes(state);
const counters = z.object({ input: z.number().int().nonnegative().safe(), cacheRead: z.number().int().nonnegative().safe(),
  cacheWrite: z.number().int().nonnegative().safe(), output: z.number().int().nonnegative().safe() }).strict();
export const observationSchema = z.object({
  outcome: z.object({ state: z.enum(['succeeded', 'failed', 'cancelled', 'needs_review']), reason: z.string().nullable() }).strict(),
  session: z.string().nullable(), measuredUsage: z.object({ scope: z.enum(['conversation', 'run']), counters }).strict().nullable(),
  availability: runAvailabilitySchema.optional(),
  handoffSafe: z.literal(true).optional(),
  exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }).strict().nullable(),
  result: z.object({ state: z.enum(['present', 'missing', 'too_large', 'unreadable']), digest: digest.nullable(), size: z.number().int().nonnegative() }).strict(),
  /** Absent or null: the launch asked for no compaction, or the agent said nothing of it. */
  compaction: compactionOutcomeSchema.nullable().optional(),
}).strict();
export type ResultObservation = z.infer<typeof observationSchema>;
const payloads = {
  claimed: z.object({ managerPid: z.number().int().positive(), managerStarted: z.string().nullable(), bootId: z.string() }).strict(),
  spawn_intent: z.object({ initialInputId: uuid }).strict(),
  started: z.object({ pid: z.number().int().positive(), started: z.string().nullable(), bootId: z.string(), group: z.number().int().positive(), scope: z.string().nullable() }).strict(),
  session: z.object({ id: z.string().min(1) }).strict(),
  input_attempt: z.object({ inputId: uuid, instructionRunId: runId, contentDigest: digest }).strict(),
  input_taken: z.object({ inputId: uuid, receipt: z.unknown() }).strict(),
  input_not_sent: z.object({ inputId: uuid, evidence: z.enum(['write_not_called', 'transfer_not_started']), receipt: z.unknown() }).strict(),
  input_uncertain: z.object({ inputId: uuid, receipt: z.unknown() }).strict(),
  stop_observed: z.object({ reason: z.enum(['stopped', 'timeout']), commandId: z.string().nullable() }).strict(),
  termination_started: z.object({ pid: z.number().int().positive() }).strict(),
  command_stopped: z.object({ session: z.number().int().positive(), started: z.string(), signal: z.enum(['SIGTERM', 'SIGKILL']), seconds: z.number().int().positive(), pids: z.array(z.number().int().positive()),
    failed: z.array(z.object({ pid: z.number().int().positive(), code: z.enum(['EPERM', 'ESRCH']) }).strict()) }).strict(),
  exited: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }).strict(),
  completed: observationSchema,
};
export const eventSchema = z.discriminatedUnion('type', Object.entries(payloads).map(([type, payload]) =>
  identitySchema.extend({ seq: z.number().int().positive().safe(), occurredAt: z.iso.datetime({ offset: true }),
    previousDigest: digest.nullable(), type: z.literal(type), payload }).strict()) as any);
export type EventType = keyof typeof payloads;
export type RunEvent = ExecutionIdentity & { seq: number; occurredAt: string; previousDigest: string | null } &
  { [K in EventType]: { type: K; payload: z.infer<(typeof payloads)[K]> } }[EventType];
export const ackSchema = identitySchema.extend({ throughSeq: z.number().int().positive().safe(), eventDigest: digest }).strict();
export const localStopSchema = z.object({ protocol: z.literal(PROTOCOL), workspaceId: uuid, operationId: uuid, targetRunId: runId,
  scope: z.literal('run-descendants'), requestedAt: z.iso.datetime({ offset: true }), actor: z.literal('local-human') }).strict();

/** DB schema is deliberately excluded from the execution fingerprint. */
export function protocolFingerprint(): string {
  const shape = (schema: z.ZodType) => z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  return createHash('sha256').update(JSON.stringify({ protocol: PROTOCOL, cliContract: CLI_CONTRACT, limits: PROTOCOL_LIMITS,
    launch: shape(launchSchema), command: shape(commandSchema), event: shape(eventSchema), ack: shape(ackSchema), localStop: shape(localStopSchema),
    manager: { args: ['root','run','attempt'], managerLockFd: 3 },
    receipts: { taken: 'provider_started_same_id', notSent: 'transfer_not_started_or_write_not_called', uncertain: 'retain_reservation_allow_delayed_taken' },
    publication: 'exclusive_rename_file_fsync_directory_fsync_private_nofollow_nlink1_utf8_unique_keys',
    paths: ['launch.json','claim.json','commands/12digit.json','events/12digit.json','results/sha256.bin','acks/seq-digest.json'],
    activity: 1, connection: 1, runtime: 'installed-release-direct-v1',
    responsibleReport: { generation: 4, operationId: 'required', checkpoint: 'body-and-child-versions', nextConversation: 'prepared-owner-intent' },
  })).digest('hex');
}
