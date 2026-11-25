/** Public Task events. Request events are assembled at the repository boundary, never stored as logs. */
import { z } from 'zod';
import { conversationCheckpointSchema } from './conversation-context.js';
import { LOG_KIND, TASK_STATE, TASK_BASE_STATES } from './task-enums.js';
import { TASK_SEGMENT, MAX_TASK_ID_LENGTH } from './task-id.js';
import { DIGEST_PATTERN, ESTIMATE_MINUTES, MAX_DETAIL_LENGTH, RUN_ID_PATTERN, selectedValuesSchema } from './values.js';

const nonempty = (limit: number) => z.string().refine(value =>
  !!value.trim() && (value.length <= limit || [...value].length <= limit), `must be nonempty and at most ${limit} characters`);
const timestamp = z.iso.datetime({ offset: true }).refine(value => !Number.isNaN(Date.parse(value)));
const taskId = z.string().max(MAX_TASK_ID_LENGTH).regex(TASK_SEGMENT);
const positiveInteger = z.preprocess(value => typeof value === 'bigint' ? Number(value) : value,
  z.number().int().positive());
const digest = z.string().regex(new RegExp(`^${DIGEST_PATTERN}$`));
export const TASK_LOG_KINDS = [
  ...Object.values(LOG_KIND), 'linked', 'moved', 'archived', 'deleted', 'restored',
  'responsible_changed', 'placement_changed', 'review_approved', 'review_sent_back',
  'request_accepted', 'body_updated', 'run_stop_requested',
  'asked', 'answered', 'question_withdrawn', 'question_expired', 'user_request_changed', 'dependencies_changed',
  'request_labeled',
] as const;
/**
 * What an instruction is, said by whoever passes it on: a fix of what was made (`fix`, with what kind of fix), an
 * addition to the work, a new request, or an answer. The kinds of fix are fixed so they can be counted: the look and
 * feel, wrong behaviour, how a result was shown or asked about (`presentation`), more scope, speed, wording, a misread
 * intent, or other.
 */
export const INSTRUCTION_KINDS = ['fix', 'addition', 'new_request', 'answer'] as const;
export const FIX_KINDS = ['look', 'behavior', 'presentation', 'scope', 'speed', 'wording', 'intent', 'other'] as const;
export const instructionLabelSchema = z.object({ request: nonempty(128), kind: z.enum(INSTRUCTION_KINDS),
  fixes: z.array(z.enum(FIX_KINDS)).max(FIX_KINDS.length) }).strict()
  .refine(label => (label.kind === 'fix') === (label.fixes.length > 0), 'A fix names its kinds of fix, and only a fix does')
  .refine(label => new Set(label.fixes).size === label.fixes.length, 'Each kind of fix once');
export type InstructionLabel = z.infer<typeof instructionLabelSchema>;
/** The IDs fixed by one execution-order change, independent of a reader's language. */
export const dependencyChangeSchema = z.object({
  after: z.array(taskId), previous: z.array(taskId),
}).strict().refine(change => [change.after, change.previous].every(ids => new Set(ids).size === ids.length),
  'Dependency IDs must be unique');
/** Characters (code points) of the user's words a main actor may quote; the contract's quote input reads it too. */
export const MAX_QUOTE_LENGTH = 1000;
export const taskActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }).strict(),
  z.object({ kind: z.literal('main'), provider: z.enum(['claude', 'codex', 'mcp']),
    conversationId: nonempty(200), quote: nonempty(MAX_QUOTE_LENGTH).optional(), message: nonempty(128).optional() }).strict(),
  z.object({ kind: z.literal('placement'), placementId: nonempty(128) }).strict(),
]);
export type TaskActor = z.infer<typeof taskActorSchema>;
/** Acting for the user is a person or coordinator; recorded words confer no authority. */
export const speaksForUser = (actor: TaskActor) =>
  actor.kind === 'human' || actor.kind === 'main';
/** Whether a log of this kind closes the question it names: its answer, its withdrawal or its expiry. */
export const closesQuestion = (kind: string) => kind === 'answered' || kind === 'question_withdrawn' || kind === 'question_expired';
/**
 * How one item of a question was answered, read from the answer's words when it came: `choice` (one of its choices,
 * `choice` its number from 1, `recommended` whether it was the one the asker recommended), `other` (none of them, with
 * the person's own words), `stop` (stop the task), or `unread` (no `<n>-<word>` names this item in the words).
 * `words`: words follow the item's label.
 */
export const answerPartSchema = z.discriminatedUnion('kind', [
  z.object({ n: z.number().int().positive(), kind: z.literal('choice'), choice: z.number().int().positive(), recommended: z.boolean(),
    words: z.boolean() }).strict(),
  z.object({ n: z.number().int().positive(), kind: z.enum(['other', 'stop', 'unread']), words: z.boolean() }).strict(),
]);
export type AnswerPart = z.infer<typeof answerPartSchema>;
/**
 * What an answer said, item by item, and whose words it was read from: `user`, the person's own (their answer on the
 * screen, or a person answering); `relay`, the words a coordinator or a Task sent as the answer. `words`: the answer
 * holds words beyond its `<n>-<word>` labels.
 */
export const answerPartsSchema = z.object({ from: z.enum(['user', 'relay']), items: z.array(answerPartSchema).min(1), words: z.boolean() }).strict();
export type AnswerParts = z.infer<typeof answerPartsSchema>;

export const taskLogSchema = z.object({
  id: nonempty(128), kind: z.enum(TASK_LOG_KINDS), at: timestamp,
  title: z.string().min(1).nullable(), description: nonempty(MAX_DETAIL_LENGTH).nullable(),
  actor: taskActorSchema,
  fromState: z.enum(TASK_STATE).nullable(), toState: z.enum(TASK_STATE).nullable(),
  /** Versioned current-stage snapshot. Absent on immutable historical seven-state records. */
  stage: z.object({ version: z.literal(1), baseState: z.enum(TASK_BASE_STATES), hold: z.boolean(),
    policyVersion: nonempty(128), ruleId: nonempty(128),
    boundary: z.enum(['accepted_start', 'rejected_start', 'settled_end']).optional(),
    action: z.enum(['report_doing', 'report_done', 'submit_review', 'confirm', 'stop', 'hold', 'unhold', 'link']) }).strict().optional(),
  originCauseId: nonempty(128).optional(),
  estimateMinutes: z.preprocess(value => typeof value === 'bigint' ? Number(value) : value,
    z.number().int().min(ESTIMATE_MINUTES.min).max(ESTIMATE_MINUTES.max)).optional(),
  operationFingerprint: digest.optional(),
  /** Fields supplied by this body/settings update; null extracts removes only that key. */
  changedFields: z.array(z.enum(['body', 'values', 'color', 'extracts', 'schema'])).min(1).optional(),
  /** Derived solely from the Request and its admitted Run role. */
  startsEstimateRound: z.boolean().optional(),
  /** Canonical Request's closed question, projected on its history reference. */
  answers: nonempty(128).optional(),
  checkpoint: conversationCheckpointSchema.optional(),
  /** Original event time, retained when a linked state causes another ancestor link. */
  causeAt: timestamp.optional(),
  /** The Run that wrote a report, or the Run a review decided on. */
  runId: z.string().regex(new RegExp(`^${RUN_ID_PATTERN}$`)).optional(),
  /** Every Run targeted by a stop request. */
  runIds: z.array(z.string().regex(new RegExp(`^${RUN_ID_PATTERN}$`))).min(1).optional(),
  /** The old path is needed to repair a move after its Task save. */
  formerAncestors: z.array(taskId).max(32).optional(),
  /** The placement operation whose commit was verified before this log was published. */
  placementId: nonempty(128).optional(),
  placementRevision: positiveInteger.optional(),
  placementEffect: z.enum(['responsible', 'member', 'released']).optional(),
  /** Explicit launch choices fixed when this placement was created; defaults remain settings policy. */
  launchValues: selectedValuesSchema.optional(),
  /** Who must answer a question, fixed when it is asked: the asking Task's requester, or null for the user. */
  askedTo: taskId.nullable().optional(),
  /** The question as it was asked: the asking Task's `decide` value, fixed here when it asked. */
  decide: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
  /**
   * What an instruction of this Task is (request_labeled). A later label of the same instruction replaces an earlier
   * one, and a person's any AI's.
   */
  label: instructionLabelSchema.optional(),
  /** An answer's items as read from its words when it came (contract readAnswerParts). */
  answerParts: answerPartsSchema.optional(),
  /** The 'asked' log an answer or a withdrawal closes. */
  questionId: nonempty(128).optional(),
  closureReason: z.literal('destination_invalid').optional(),
  /** Why a placement's comment or done report goes to its requester at once (one line, like a report title). */
  urgentReason: z.string().min(1).optional(),
  /** Whether the user asked for this Task; the stored mark is derived from the last log that sets it. */
  userRequested: z.boolean().optional(),
  dependencies: dependencyChangeSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if ((entry.kind === 'dependencies_changed') !== (entry.dependencies !== undefined))
    issue('dependencies', 'Only a dependency change carries after and previous IDs');
  if (entry.kind === 'dependencies_changed' && (entry.fromState !== null || entry.toState !== null))
    issue('toState', 'A dependency change keeps the state');
  if (entry.changedFields && entry.kind !== 'body_updated') issue('changedFields', 'Only body_updated records changed fields');
  if ((entry.kind === 'request_labeled') !== (entry.label !== undefined)) issue('label', 'Only an instruction label carries one, and it must');
  if (entry.answerParts && entry.kind !== 'answered') issue('answerParts', 'Only an answer carries its parts');
  if (entry.answers !== undefined && entry.kind !== 'request_accepted') issue('answers', 'Only an instruction answers a closed question');
  if (entry.checkpoint && (!['reported', 'asked'].includes(entry.kind) || !entry.runId || entry.actor.kind !== 'placement'))
    issue('checkpoint', 'A checkpoint belongs to an owner report or question');
  if (entry.estimateMinutes !== undefined &&
      (entry.kind !== 'reported' || !['human', 'placement'].includes(entry.actor.kind)))
    issue('estimateMinutes', 'estimateMinutes requires a human or placement report');
  if (entry.causeAt && entry.kind !== 'linked') issue('causeAt', 'causeAt requires a linked log');
  if (entry.runId && !['linked', 'reported', 'review_sent_back', 'review_approved',
    'asked', 'question_withdrawn'].includes(entry.kind))
    issue('runId', 'runId requires a report, a question or a review decision');
  if ((entry.kind === 'asked') !== (entry.askedTo !== undefined))
    issue('askedTo', 'askedTo is required by, and only valid for, a question');
  if ((entry.kind === 'asked') !== (entry.decide !== undefined))
    issue('decide', 'decide is required by, and only valid for, a question');
  if (entry.kind === 'asked' && (entry.fromState !== null || entry.toState !== null ||
      entry.actor.kind !== 'placement' || entry.description === null))
    issue('kind', 'A question keeps the state, comes from a placement and carries a summary');
  const closes = closesQuestion(entry.kind);
  if ((entry.kind === 'question_expired') !== (entry.closureReason !== undefined))
    issue('closureReason', 'Only structural question expiry carries destination_invalid');
  if (closes !== (entry.questionId !== undefined))
    issue('questionId', 'questionId is required by, and only valid for, an answer or a withdrawal');
  if (closes && entry.toState !== null) issue('toState', 'An answer or a withdrawal keeps the state');
  if (entry.urgentReason !== undefined && (entry.kind !== 'reported' ||
      entry.toState !== null && entry.toState !== 'done' || entry.actor.kind !== 'placement'))
    issue('urgentReason', 'urgentReason requires a placement comment or done report');
  if ((entry.kind === 'created' || entry.kind === 'user_request_changed') !== (entry.userRequested !== undefined))
    issue('userRequested', 'userRequested is required by, and only valid for, a creation or a mark change');
  if (entry.runIds && (entry.kind !== 'run_stop_requested' ||
      new Set(entry.runIds).size !== entry.runIds.length))
    issue('runIds', 'runIds requires a stop request without duplicates');
  if (entry.formerAncestors && (entry.kind !== 'moved' ||
      new Set(entry.formerAncestors).size !== entry.formerAncestors.length))
    issue('formerAncestors', 'formerAncestors requires a moved log without duplicates');
  if ((entry.placementId === undefined) !== (entry.placementRevision === undefined) ||
      (entry.placementId === undefined) !== (entry.placementEffect === undefined) ||
      entry.placementId !== undefined && entry.kind !== 'responsible_changed' && entry.kind !== 'placement_changed')
    issue('placementId', 'A placement cause requires its ID and revision');
  if ((entry.kind === 'placement_changed' &&
        (entry.placementId === undefined || entry.placementEffect === 'responsible')) ||
      (entry.kind === 'responsible_changed' && entry.placementEffect === 'member'))
    issue('placementEffect', 'Placement log kind and effect disagree');
  if (entry.launchValues !== undefined && (entry.placementRevision !== 1 ||
      entry.placementId === undefined || !['responsible_changed', 'placement_changed'].includes(entry.kind) ||
      entry.placementEffect !== 'responsible' && entry.placementEffect !== 'member'))
    issue('launchValues', 'Launch choices belong only to a placement creation record');
});
export type TaskLog = z.infer<typeof taskLogSchema>;

/** Ordinary stored records cannot carry a Request's header or its derived estimate classification. */
export const storedTaskLogSchema = taskLogSchema.refine(entry =>
  entry.kind !== 'request_accepted' && entry.kind !== 'review_sent_back' && entry.startsEstimateRound === undefined,
  'A Request is stored by reference, never as a log header');
