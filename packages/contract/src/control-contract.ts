import { aiStackPrefixSchema } from './ai-stack.js';
import { agentSettingShapeSchema, selectionSchema } from './agent-settings.js';
import { runAvailabilitySchema, runErrorCauseSchema, runFailureSchema } from './run-failure.js';
import { restoreIdSchema } from './recovery.js';
import { answerFilesSchema } from './coordinator-files.js';
import { projectColorSchema, projectSettingsSchema } from '@alpacawork/raw/project-settings';
import { launchChoicesSchema } from './agent-selection.js';
import { coordinatorMarkerSchema } from './coordinator-contract.js';
import { coordinatorWorkSchema } from './work-contract.js';
/** The idle screen stream cadence; clients allow two missed beats before reconnecting. */
export const INDEX_HEARTBEAT_MS = 15_000;

/** The control wire contract. Storage records and browser projections have different lifecycles. */
import { z } from 'zod';
import { taskBaseStateSchema } from './fields.js';
import { reportMark } from './report-mark.js';
import { TASK_LIFECYCLES, TASK_STATE } from '@alpacawork/raw/task-enums';
import { taskActorSchema as actorSchema, taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { agentNameSchema, runActivityKindSchema, runActivitySchema, runCallerSchema, runReasonSchema, runResultStateSchema, runRoleSchema, runStateSchema, sessionProviderSchema, tokenCountersSchema } from './run-contract.js';
import { bodyMarkSchema, descriptionSchema, reportTitleSchema, digestSchema, estimateMinutesSchema, logIdSchema, runIdSchema, taskIdSchema, projectIdSchema, taskKindSchema, taskStateSchema } from './fields.js';
import { errorEntrySchema, problemErrorSchema } from './problem.js';
import { hostNoticeSchema } from './host-contract.js';
import { ballSchema, userTurn, type Ball } from './ball.js';
import { HOME_SECTIONS, homeCountsSchema, homeRowSchema, taskActionSchema } from './home.js';
import { historyCursorSchema, historyEventSchema, NOTICED_LOG_KINDS, STATE_LOG_KINDS } from './history-events.js';
import { isFinished } from './finished-branch.js';
import { RETURN_OUTCOMES } from './return-outcomes.js';
import { questionSchema } from './questions.js';
import { canonicalValues, fieldDefShape, fieldIdSchema, taskValuesViewSchema, type TaskValues } from './task-schema.js';

export const taskLifecycleSchema = z.enum(TASK_LIFECYCLES);
const shelfTargetSchema = z.object({ id: projectIdSchema, title: z.string(), color: projectColorSchema, hash: digestSchema }).strict();
export const projectShelfInfoSchema = z.object({ listed: z.boolean(),
  shelvedBy: z.array(shelfTargetSchema.extend({ lifecycle: taskLifecycleSchema }).strict()),
  restoreTarget: shelfTargetSchema.nullable() }).strict().refine(value => {
    const first = value.shelvedBy[0];
    return value.listed === !first && value.shelvedBy.every(item => item.lifecycle !== 'active')
      && (first?.lifecycle === 'archived' ? !!value.restoreTarget && ['id', 'title', 'color', 'hash'].every(key =>
        value.restoreTarget![key as keyof typeof value.restoreTarget] === first[key as keyof typeof first]) : value.restoreTarget === null);
  });
export type ProjectShelfInfo = z.infer<typeof projectShelfInfoSchema>;
export const projectShelfSchema = z.object({ revision: digestSchema, projects: z.array(z.object({
  id: projectIdSchema, title: z.string(), color: projectColorSchema, parentId: projectIdSchema.nullable(), lifecycle: taskLifecycleSchema,
  hash: digestSchema, shelf: projectShelfInfoSchema }).strict()) }).strict();
export type ProjectShelfDTO = z.infer<typeof projectShelfSchema>;
export const attachmentResultSchema = z.object({
  path: z.string().regex(/^attachments\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/.+$/),
  absolutePath: z.string().startsWith('/'),
  size: z.number().int().nonnegative(),
}).strict();
export type AttachmentResult = z.infer<typeof attachmentResultSchema>;
export { actorSchema, taskLogSchema };
/** Where a Task is, the same in its record and in its row. */
const taskPlaceFields = {
  id: taskIdSchema, parentId: taskIdSchema.nullable(), path: z.string().min(1), kind: taskKindSchema,
};
/** What a Task is now and may do next, the same in its record and in its row. */
const taskStateFields = {
  lifecycle: taskLifecycleSchema, title: z.string().min(1), state: z.enum(TASK_STATE),
  baseState: taskBaseStateSchema, hold: z.boolean(), allowedActions: z.array(taskActionSchema), policyVersion: z.string().min(1),
  version: z.number().int().positive(), hash: digestSchema,
};
const TASK_ROW_COPIED = [...Object.keys(taskPlaceFields), ...Object.keys(taskStateFields)] as
  readonly (keyof typeof taskPlaceFields | keyof typeof taskStateFields)[];
const controlTaskHeadFields = {
  ...taskPlaceFields,
  /** Whether the person asked for this Task (a project Task never is). */
  userRequested: z.boolean(),
  ...taskStateFields,
  /** The Task's values by field ID (task-schema); a field without a value has no key. */
  values: z.record(fieldIdSchema, z.unknown()), settings: projectSettingsSchema.optional(),
  folder: z.string().min(1).optional(),
  files: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative(),
    revision: z.string().min(1), at: z.iso.datetime({ offset: true }), readable: z.literal(false).optional() }).strict()).optional(),
};
const projectSettingsRule = (task: { kind: string; settings?: unknown }, context: z.RefinementCtx) => {
  if ((task.kind === 'project') !== (task.settings !== undefined))
    context.addIssue({ code: 'custom', path: ['settings'], message: 'Only projects have settings, and every project requires color (#rrggbb)' });
};
/** A Task as a write leaves it: everything but its History, which only the Task's reads carry. */
export const controlTaskHeadSchema = z.object(controlTaskHeadFields).strict().superRefine(projectSettingsRule);
/** A read Task: its head and its History. */
export const controlTaskSchema = z.object({ ...controlTaskHeadFields, log: z.array(taskLogSchema) }).strict().superRefine(projectSettingsRule);

/** A person's hold and its restoration pause one wait rather than begin another: the state changes with
 * each restored pause left out, so the wait reads as begun by the report that asked for it. */
export function waitStates<Log extends Pick<z.infer<typeof taskLogSchema>, 'toState'> & { actor?: Pick<z.infer<typeof actorSchema>, 'kind'> }>(log: readonly Log[]): Log[] {
  const states: Log[] = [];
  for (const entry of log) {
    if (entry.toState === null) continue;
    // Only a person leaves a hold for a wait, and only by restoring it; an owner's new report is a new wait.
    if (states.at(-1)?.toState === 'held' && entry.toState === 'waiting' && entry.actor?.kind !== 'placement') {
      states.pop(); continue;
    }
    states.push(entry);
  }
  return states;
}

type ClockLog = Pick<z.infer<typeof taskLogSchema>, 'toState'> & {
  actor?: Pick<z.infer<typeof actorSchema>, 'kind'>;
  stage?: Pick<NonNullable<z.infer<typeof taskLogSchema>['stage']>, 'action' | 'hold'>;
};
/** Select the existing source record for the visible clock. Hold edges and base changes have separate lifetimes. */
export function currentTransition<Log extends ClockLog>(task: { state: string; stateLog: readonly Log[] }): Log | null {
  if (task.stateLog.some(entry => entry.stage !== undefined)) {
    if (task.state === 'held') {
      for (const entry of [...task.stateLog].reverse()) {
        if (entry.stage) {
          if (!entry.stage.hold) return null;
          if (entry.stage.action === 'hold' && entry.toState === 'held') return entry;
        } else if (entry.toState !== null) return entry.toState === 'held' ? entry : null;
      }
      return null;
    }
    const entry = waitStates(task.stateLog).filter(entry => entry.toState !== 'held' &&
      !['hold', 'unhold'].includes(entry.stage?.action ?? '')).at(-1);
    return entry?.toState === task.state ? entry : null;
  }
  const entry = waitStates(task.stateLog).at(-1);
  return entry?.toState === task.state ? entry : null;
}
export const finishedBy = <Log extends Pick<z.infer<typeof taskLogSchema>, 'toState'> & { actor?: Pick<z.infer<typeof actorSchema>, 'kind'> }>(task: { state: string; stateLog: readonly Log[] }): Log | null =>
  task.state === 'done' ? currentTransition(task) : null;
/** The record the user's turn waits on, as the Task's ball says: the question asked of them, or the report under review. */
export const turnRecord = (task: { ball: Ball | null } | undefined): string | null => {
  const turn = userTurn(task?.ball ?? null);
  return turn?.reason === 'question' ? turn.questionId : turn?.reason === 'review' ? turn.key : null;
};
export type Standing = 'finished' | 'yours' | 'stopped';
/**
 * What a list row's line marks: the records its Task stands on now, each only while it does. A person is to know these:
 * it finished, it waits on them, or it stopped. A stop's record is its Run's when the Run is what failed (recordEvents).
 * A turn waiting on them is what they act on, so a stop beside it has no mark of its own: the line's red says it.
 * Everything else that happened is read in the History, and a press on the line goes there.
 */
export function standingRecord(task: { state: string; ball: Ball | null; stateLog: readonly (Parameters<typeof currentTransition>[0]['stateLog'][number] & { id: string; runId?: string })[] }): (id: string) => Standing | null {
  const finished = finishedBy(task)?.id, yours = turnRecord(task);
  const stopped = task.state === 'error' && !yours ? currentTransition(task) : null;
  return id => id === finished ? 'finished' : id === yours ? 'yours'
    : stopped && (id === stopped.id || id === stopped.runId) ? 'stopped' : null;
}

/** One lifetime for an unresolved Run failure in both current attention and historical red. */
export function failureAttentionWindow(
  failure: { endedAt?: string | null; startedAt?: string | null; createdAt: string },
  resolvedBy: { startedAt?: string | null } | null,
  placement: { endedAt?: string | null } | null | undefined,
  task: { state: string; stateLog: readonly { at: string; toState: string | null }[] } | null | undefined,
): { startAt: string; endAt: string | null; ongoing: boolean } {
  const startAt = failure.endedAt ?? failure.startedAt ?? failure.createdAt;
  const taskEnd = task?.stateLog.find((entry) => isFinished(entry.toState) &&
    Date.parse(entry.at) >= Date.parse(startAt))?.at ?? null;
  const taskIsTerminal = isFinished(task?.state);
  const endAt = [resolvedBy?.startedAt, placement?.endedAt, taskEnd]
    .filter((at): at is string => !!at).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return { startAt, endAt, ongoing: !resolvedBy && !placement?.endedAt && !taskEnd && !taskIsTerminal };
}

/** Unknown is reserved for a failed run-store read. */
export const displayStateSchema = z.enum(['attention', 'running', 'idle', 'unknown']);
export const placementRuntimeSchema = z.object({
  displayState: displayStateSchema,
  reason: z.string().nullable(),
  sourceRunIds: z.array(runIdSchema), runningCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(), since: z.iso.datetime({ offset: true }).nullable(),
  lastOutputAt: z.iso.datetime({ offset: true }).nullable(),
  activityKind: runActivityKindSchema.nullable(), toolName: z.string().nullable(),
}).strict();
const placementRecordFields = {
  id: z.string().min(1), taskId: taskIdSchema, agentId: z.string().min(1),
  profileKey: z.string().min(1),
  responsible: z.boolean(), active: z.boolean(), revision: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }).nullable(),
};
export const placementRecordSchema = z.object(placementRecordFields).strict();
/** A placement's lifecycle is the same on the live list and in a durable Task read. */
function checkPlacement(placement: Pick<z.infer<typeof placementRecordSchema>, 'responsible' | 'active' | 'endedAt'>, ctx: z.RefinementCtx): void {
  if (placement.responsible && !placement.active)
    ctx.addIssue({ code: 'custom', path: ['responsible'], message: 'Only an active placement can be responsible' });
  if (placement.active === (placement.endedAt !== null))
    ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'Active and endedAt disagree' });
}
export const placementSchema = z.object({
  ...placementRecordFields,
  headRunId: runIdSchema.nullable(),
  /** The head Run's values when its session can be continued; null when none can, absent if unreadable. */
  previousValues: selectionSchema.nullable().optional(),
  runtime: placementRuntimeSchema,
}).strict().superRefine(checkPlacement);
export const controlRunSchema = z.object({
  id: runIdSchema, taskId: taskIdSchema, placementId: z.string().min(1),
  agent: agentNameSchema, modelId: z.string().min(1).nullable(), effort: z.string().min(1).nullable(),
  /** This Run's immutable admission values, not the placement creation selection. */
  launchValues: selectionSchema,
  requestId: z.string().min(1).nullable(), caller: runCallerSchema,
  /** The Run record's launch directory, when supplied by the backend. Never derive it from Task.path. */
  cwd: z.string().startsWith('/'),
  resumes: runIdSchema.nullable(), continues: z.boolean(),
  session: z.object({ provider: agentNameSchema.nullable(), id: z.string().min(1) }).strict().nullable(),
  state: runStateSchema, reason: runReasonSchema.nullable(),
  /** Recognized failure text from this Run's stdout; absent when evidence is insufficient. */
  errorCause: runErrorCauseSchema.optional(),
  availability: runAvailabilitySchema.optional(),
  supersededBy: runIdSchema.optional(),
  /** A joined Run names the Run whose work took its instruction in. */
  into: runIdSchema.nullable(),
  /** Whether the agent takes further instructions on its input while it works. */
  takesInput: z.boolean(),
  activity: runActivitySchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }), startedAt: z.iso.datetime({ offset: true }).nullable(),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  usage: z.object({ run: tokenCountersSchema.nullable(), includesEarlier: z.boolean() }).strict().nullable(),
}).strict();
export const requestPurposeSchema = z.enum(['instruction', 'review_send_back', 'return_continuation']);
export const requestModeSchema = z.enum(['continue', 'new']);
export const deliveryStateSchema = z.enum(['queued', 'waiting_for_run', 'waiting_for_session', 'recorded_unconfirmed', 'aborted']);
export const DELIVERY_STATE = deliveryStateSchema.enum;
export type RequestPurpose = z.infer<typeof requestPurposeSchema>;
export type RequestMode = z.infer<typeof requestModeSchema>;
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
/** The original submitted text is stored once here; the Run prompt is frozen delivered context. */
export const controlRequestSchema = z.object({
  id: z.string().min(1), taskId: taskIdSchema, placementId: z.string().min(1),
  runId: runIdSchema.nullable(), aboutRunId: runIdSchema.nullable(), purpose: requestPurposeSchema, author: actorSchema,
  /** The recipient's role when this Request created its Run, unaffected by later handovers. */
  recipientRole: runRoleSchema.nullable(),
  mode: requestModeSchema, body: z.string().min(1),
  submittedAt: z.iso.datetime({ offset: true }), deliveryState: deliveryStateSchema,
}).strict();
/** Status of each Task's latest final owner Run; fetch its text by Run ID when opened. */
export const controlReplySchema = z.object({
  runId: runIdSchema, state: runResultStateSchema.exclude(['pending']),
}).strict();
/**
 * A Task's start order (dependencies.ts): the Tasks that must finish before its first start, each as it is now,
 * whether it still waits for them, and whether it has started. Absent for a Task with no such Tasks.
 */
export const startOrderSchema = z.object({
  after: z.array(z.object({ task: taskIdSchema, title: z.string(), state: z.string().min(1), lifecycle: z.string().min(1),
    finished: z.boolean() }).strict()),
  waiting: z.boolean(), started: z.boolean(),
}).strict();
export type StartOrderDTO = z.infer<typeof startOrderSchema>;
export const controlTreeSchema = z.object({
  root: z.string(), tasks: z.array(controlTaskSchema), placements: z.array(placementSchema),
  runs: z.array(controlRunSchema), requests: z.array(controlRequestSchema),
  replies: z.record(taskIdSchema, controlReplySchema),
  /** Each Task's ball as the server derives it; absent when nobody's move is awaited. */
  balls: z.record(taskIdSchema, ballSchema),
  working: z.array(taskIdSchema).nullable(),
  /** Read-only History facts captured with the tree; no second per-event database reads. */
  historyFacts: z.object({
    answerTexts: z.record(logIdSchema, z.string()),
    placementRoles: z.record(z.string(), z.enum(['owner', 'member'])),
    runRoles: z.record(runIdSchema, z.enum(['owner', 'member'])),
    /** Each return's wakes. `consumed`: the Run it woke took it in and finished its turn (return_deliveries.consumed_at). */
    deliveries: z.array(z.object({ logId: logIdSchema, toTaskId: taskIdSchema, requestId: z.string().min(1), outcome: z.enum(RETURN_OUTCOMES),
      consumed: z.boolean() }).strict()),
    /** The Coordinator Run that took each screen message these records name, with what it ran with. */
    coordinatorRuns: z.record(z.string().min(1), z.object({ agent: z.string().min(1), modelId: z.string().min(1).nullable(),
      effort: z.string().min(1).nullable() }).strict()),
  }).strict(),
  /**
   * The Tasks' dialogues with a coordinator (task_dialogues), oldest first: what the user said and when, and the
   * coordinator's answer (null until it answered), with the copies kept of the local files it links to while its
   * conversation still holds them.
   */
  dialogues: z.array(z.object({ taskId: taskIdSchema, messageId: z.string().min(1), at: z.iso.datetime({ offset: true }),
    words: z.string(), answer: z.string().nullable(), answerFiles: answerFilesSchema.optional() }).strict()),
  /** When the user asked for each Task they asked for (its mark's utterance, else its mark's record). */
  requestedByUser: z.record(taskIdSchema, z.object({ at: z.iso.datetime({ offset: true }) }).strict()),
  profiles: z.array(z.object({ key: z.string().min(1), choices: launchChoicesSchema, initialValues: selectionSchema.optional(),
    without: agentSettingShapeSchema.shape.without.unwrap() }).strict()),
  /** The workspace's fields (task-schema fieldCatalog: the defaults with the stored definitions over them). */
  fieldCatalog: z.array(fieldDefShape),
  /** Each project Task's fields in order as its Tasks use them, and the project they come from (null: the default). */
  projectSchemas: z.record(taskIdSchema, z.object({ fields: z.array(fieldIdSchema), from: taskIdSchema.nullable() }).strict()),
  /** Each Task's values by field ID; a Task without values has `{}`. */
  taskValues: z.record(taskIdSchema, z.record(fieldIdSchema, z.unknown())),
  /** limits.attachment_mib in bytes: the screen checks a file before sending it and opens files up to it. */
  attachmentBytes: z.number().int().positive(),
  errors: z.array(errorEntrySchema),
  writable: z.boolean(),
  /** Each Task's start order, only for Tasks that have one. */
  startOrder: z.record(taskIdSchema, startOrderSchema).optional(),
}).strict().superRefine((tree, ctx) => {
  // A damaged root deliberately carries only its readable fragments and errors.
  // Cross-record references cannot be checked when one source is unavailable.
  if (tree.errors.length) return;
  const ids = new Set(tree.tasks.map(task => task.id));
  const responsible = new Set<string>();
  for (const [index, task] of tree.tasks.entries()) {
    if (task.parentId !== null && !ids.has(task.parentId))
      ctx.addIssue({ code: 'custom', path: ['tasks', index, 'parentId'], message: 'Parent is absent' });
  }
  for (const [index, placement] of tree.placements.entries()) {
    if (!ids.has(placement.taskId))
      ctx.addIssue({ code: 'custom', path: ['placements', index, 'taskId'], message: 'Task is absent' });
    if (placement.responsible) {
      if (responsible.has(placement.taskId))
        ctx.addIssue({ code: 'custom', path: ['placements', index, 'responsible'], message: 'Task has multiple active responsible placements' });
      responsible.add(placement.taskId);
    }
  }
  const runs = new Map(tree.runs.map(run => [run.id, run]));
  for (const [taskId, reply] of Object.entries(tree.replies)) {
    if (!ids.has(taskId) || runs.get(reply.runId)?.taskId !== taskId)
      ctx.addIssue({ code: 'custom', path: ['replies', taskId], message: 'Reply must belong to a listed Task and Run' });
  }
  for (const taskId of Object.keys(tree.balls)) if (!ids.has(taskId))
    ctx.addIssue({ code: 'custom', path: ['balls', taskId], message: 'Ball must belong to a listed Task' });
  for (const [index, dialogue] of tree.dialogues.entries()) if (!ids.has(dialogue.taskId))
    ctx.addIssue({ code: 'custom', path: ['dialogues', index, 'taskId'], message: 'Dialogue must belong to a listed Task' });
  for (const taskId of Object.keys(tree.requestedByUser)) if (!ids.has(taskId))
    ctx.addIssue({ code: 'custom', path: ['requestedByUser', taskId], message: 'Request mark must belong to a listed Task' });
});

/**
 * The screen's index: one row per Task with what the tree, the cards, the time view and the
 * unread marks read. The body, latest report, files, request headings and replies are read per Task
 * when it is opened (`GET /api/task/view`).
 */
const isoSchema = z.iso.datetime({ offset: true });
/** List facts for state, estimates and progress; full report text belongs to detail. */
export const stateLogEntrySchema = z.object({
  id: z.string().min(1), kind: taskLogSchema.shape.kind, at: isoSchema,
  actor: z.object({ kind: z.enum(['human', 'main', 'placement']) }).strict(),
  causeAt: isoSchema.optional(),
  stage: taskLogSchema.shape.stage,
  startsEstimateRound: z.boolean().optional(),
  fromState: taskStateSchema.nullable(), toState: taskStateSchema.nullable(),
  estimateMinutes: estimateMinutesSchema.optional(), title: z.string().nullable(),
  runId: runIdSchema.optional(),
}).strict();
/** Language-independent row facts, made by the server projection for live and closed rows. */
export const rowFactsSchema = z.object({
  status: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('running'), since: z.number().finite().nullable() }).strict(),
    z.object({ kind: z.enum(['queued', 'unclear']) }).strict(),
    z.object({ kind: z.literal('since'), at: z.number().finite() }).strict(),
  ]).nullable(),
  /** Descendant Tasks actually running. */
  childrenRunning: z.number().int().nonnegative(),
  /** Runs actually running on this Task and on every logical descendant, whoever's they are; a queued Run is not one. */
  runningRuns: z.number().int().nonnegative(),
  /** Current execution uncertainty; an ended failure alone is not a row warning. */
  warning: z.enum(['unknown', 'manager_lost', 'conversation_busy', 'output']).nullable(),
  kind: z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['question', 'review']) }).strict(),
    z.object({ kind: z.literal('followup'), turn: ballSchema.options[0] }).strict(),
    z.object({ kind: z.literal('stopped'), failure: z.string() }).strict(),
  ]).nullable(),
  /** The active Task's position (home's taskPosition), which every screen says it by; null for any other row. */
  position: z.enum(HOME_SECTIONS).nullable(),
}).strict();
export type RowFacts = z.infer<typeof rowFactsSchema>;
const usageTotalSchema = z.object({ runs: z.number().int().nonnegative(), runMs: z.number().nonnegative(),
  tokens: z.object({ input: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }).nullable(),
  tokensUnknown: z.number().int().nonnegative() }).nullable();
export const taskRowSchema = z.object({
  ...taskPlaceFields,
  /** The project Task it belongs to: its nearest project (a project Task's own row names itself). */
  projectId: projectIdSchema,
  ...taskStateFields,
  /** Whose move the Task waits on, as the server derives it; null when nobody's. */
  ball: ballSchema.nullable(),
  rowFacts: rowFactsSchema,
  /** Its start order; null when it has none. */
  startOrder: startOrderSchema.nullable(),
  /** The first and the latest log time; null for a Task without log entries. */
  createdAt: isoSchema.nullable(), updatedAt: isoSchema.nullable(),
  /** Latest durable change or Run start/end in the entire subtree, projected before any paging. */
  movedAt: z.number().finite(),
  /**
   * Log entries that change the state, declare an estimate, report, decide a review, ask or close a question or
   * instruct the responsible person, in log order: what waits, estimates and the time view read.
   */
  stateLog: z.array(stateLogEntrySchema),
  /** Completed Run usage on this Task only; moving Runs are sent separately. */
  usage: usageTotalSchema,
  /** Completed Run usage on every logical descendant, regardless of lifecycle or list membership, excluding this Task. */
  usageBelow: usageTotalSchema,
  /** Running, open Runs on every logical descendant, each with its start; independent of Task state, lifecycle and loaded rows. */
  runsBelow: z.array(z.tuple([runIdSchema, z.number().finite()])),
  /**
   * Enough for the unread baseline: the log length, the body's hash, the key of the user's turn (userTurn(ball)?.key)
   * and the latest noticed entry.
   */
  notice: z.object({ logCount: z.number().int().nonnegative(), bodyHash: bodyMarkSchema,
    turnKey: z.string().nullable(),
    lastNoticed: z.object({ position: z.number().int().nonnegative(), kind: taskLogSchema.shape.kind,
      title: z.string().nullable(), at: isoSchema }).strict().nullable() }).strict(),
  /** The title of the Task's oldest open question (its `asked` record's), so a list shows what it asks; "" when none. */
  question: z.string(),
}).strict();
/** A closed Task's list row. Chronology is fetched for the visible time range. */
export const taskPageRowSchema = taskRowSchema.omit({ stateLog: true, ball: true, question: true, startOrder: true }).extend({
  startOrder: startOrderSchema.nullable().optional(),
  ball: ballSchema.nullable().optional(),
  question: z.string().optional(),
  stateMark: stateLogEntrySchema.nullable(),
  latestReport: stateLogEntrySchema.nullable(),
  childCounts: z.object({ live: z.number().int().nonnegative(), finished: z.number().int().nonnegative() }).strict(),
}).strict();
export const taskPageSchema = z.object({
  rows: z.array(taskPageRowSchema), total: z.number().int().nonnegative(),
  nextAfter: z.string().nullable(), scopeVersion: z.string().min(1),
}).strict();
/**
 * The resource key of a page of closed Tasks: a parent's finished children, or the top
 * level's finished or shelved Tasks, of every project or of one project Task's subtree (nested projects included).
 */
export const closedPageScope = (kind: 'finished' | 'shelved', parent: string | null, project: string | null) =>
  kind === 'shelved' ? project === null ? 'shelved' : `shelved@${project}`
    : parent !== null ? `finished:${parent}` : project === null ? 'finished:root' : `finished:root@${project}`;
/** A time mark carries identity and its glyph, never report text. */
export const timelineNoteSchema = z.object({
  /** A compact, derived layout decision; no causal/authorship/answer links cross this boundary. */
  displayed: z.boolean().optional(),
  id: historyEventSchema.shape.id, kind: historyEventSchema.shape.kind, taskId: taskIdSchema, at: isoSchema,
  state: taskStateSchema.nullable(),
  mark: z.object({ kind: z.enum(['report', 'held']), tone: z.enum(['done', 'quiet', 'working']) }).strict().nullable(),
}).strict();
export const timelineLogSchema = stateLogEntrySchema.omit({ title: true, estimateMinutes: true }).strict();
/** Run facts used to draw the work intervals and match their history keys. */
export const timelineRunSchema = controlRunSchema.pick({ id: true, taskId: true, placementId: true, state: true,
  createdAt: true, startedAt: true, endedAt: true }).strict();
export const timelinePlacementSchema = z.object({ id: placementSchema.shape.id, taskId: taskIdSchema, responsible: z.boolean() }).strict();
/** Project explicitly so detail-only fields never cross the timeline boundary. */
export function timelineNoteOf(event: z.infer<typeof historyEventSchema>): z.infer<typeof timelineNoteSchema> {
  return { id: event.id, taskId: event.taskId, kind: event.kind, at: event.at, state: event.state,
    mark: event.state === 'held' ? { kind: 'held', tone: 'quiet' } : event.by ? null : reportMark(event) };
}
export function timelineLogOf(entry: StateLogEntryDTO): z.infer<typeof timelineLogSchema> {
  const { title: _title, estimateMinutes: _estimate, ...timing } = entry;
  return timing;
}
export function timelineRunOf({ id, taskId, placementId, state, createdAt, startedAt, endedAt }: ControlRunDTO): z.infer<typeof timelineRunSchema> {
  return { id, taskId, placementId, state, createdAt, startedAt, endedAt };
}
export function timelinePlacementOf({ id, taskId, responsible }: PlacementDTO): z.infer<typeof timelinePlacementSchema> {
  return { id, taskId, responsible };
}
/**
 * The visible range, bounded: the facts the work line is drawn from (log entries and Runs) and its notes. A note is a
 * history event (one record each, as History makes them: a Task below a folded one has those its parent sees), and a
 * note made from a log entry comes with that entry. Dense ranges carry exact Run facts for the work line.
 */
/** Full-lifetime axis activity for the requested lanes and their folded descendants. */
export const taskTimelineAxisSchema = z.object({
  busy: z.array(z.tuple([z.number().int(), z.number().int().nullable()])),
  earliest: z.number().int().nullable(), version: z.string().min(1),
}).strict();
export type TaskTimelineAxisDTO = z.infer<typeof taskTimelineAxisSchema>;

export const taskTimelineSchema = z.object({
  rows: z.array(taskPageRowSchema),
  /** Exact Run facts for the visible interval when its notes take more than one page. */
  runs: z.array(timelineRunSchema),
  /**
   * The ended Runs of the Tasks under each visible row in the interval, on the first page: [Run, from, to]. A row's line
   * counts them as its running count does; those running now are on the row itself (runsBelow).
   */
  belowRuns: z.record(taskIdSchema, z.array(z.tuple([runIdSchema, z.number().int(), z.number().int()]))),
  events: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('log'), taskId: taskIdSchema, entry: timelineLogSchema }).strict(),
    z.object({ kind: z.literal('run'), taskId: taskIdSchema, run: timelineRunSchema }).strict(),
    z.object({ kind: z.literal('note'), taskId: taskIdSchema, event: timelineNoteSchema }).strict(),
  ])),
  anchors: z.record(taskIdSchema, timelineLogSchema),
  placements: z.array(timelinePlacementSchema),
  nextAfter: z.string().nullable(), scopeVersion: z.string().min(1),
}).strict();
/**
 * The numbers the project menu shows for a scope: the Tasks whose turn is the user's and neither held nor failed (its Awaiting review rows of
 * the home list, counted as they are) and the Tasks a Run works on.
 */
const menuCountsSchema = z.object({ turn: z.number().int().nonnegative(), running: z.number().int().nonnegative() }).strict();
/** A count's scope: a listed project Task's subtree, nested projects included, or `root` for every project. */
const countScopeSchema = z.union([taskIdSchema, z.literal('root')]);
const indexFields = {
  root: z.string(),
  /**
   * The active project Tasks the screen lists, each followed by the ones nested in it (`depth` counts the projects
   * above it), with its subtree's menu numbers.
   */
  projectShelfVersion: digestSchema,
  projects: z.array(z.object({ id: projectIdSchema, title: z.string().min(1), parentId: projectIdSchema.nullable(),
    color: projectColorSchema, cwd: z.string().nullable(), depth: z.number().int().nonnegative(), counts: menuCountsSchema }).strict()),
  profiles: controlTreeSchema.shape.profiles,
  attachmentBytes: controlTreeSchema.shape.attachmentBytes,
  errors: controlTreeSchema.shape.errors, writable: z.boolean(),
  /** Tasks the latest scan could not read, kept as they were last read. */
  staleIds: z.array(taskIdSchema),
  /** Revisions of the person's settings, read marks and coordinator conversation: a screen rereads one when it moves. */
  person: z.object({ settings: z.string().nullable(), notices: z.string().nullable(), coordinator: coordinatorMarkerSchema.nullable() }).strict(),
  /** Ephemeral work from stdout; changing it does not invalidate the conversation's persistent read. */
  coordinatorWork: coordinatorWorkSchema,
  /** Where the person's next new coordinator conversation starts (a small record, carried whole). */
  presence: z.object({ state: z.enum(['present', 'away', 'muted']), until: z.string().nullable() }).strict(),
  /** Set while this machine is tight (Machine status); null otherwise and where it is not measured. */
  host: hostNoticeSchema.nullable(),
};
/** The bounded live workspace read and SSE `index` event. `rev` counts published changes within one server `generation`. */
export const controlIndexSchema = z.object({
  restoreId: restoreIdSchema, generation: z.string().min(1), rev: z.number().int().nonnegative(),
  tasks: z.array(taskRowSchema), placements: z.array(placementSchema), runs: z.array(controlRunSchema),
  /** The home list's rows of the listed Tasks, one per Task it lists, in the list's order (index-feed's homeRows). */
  home: z.array(homeRowSchema), ...indexFields,
  counts: z.object({
    /**
     * The top-level closed Tasks each scope lists: finished and shelved.
     * The screen adds none up.
     */
    closed: z.record(countScopeSchema, z.object({ finished: z.number().int().nonnegative(),
      shelved: z.number().int().nonnegative() }).strict()),
    /** The home list's rows each scope lists, by section; the screen adds none up. */
    home: z.record(countScopeSchema, homeCountsSchema),
    /**
     * Every Task each scope holds at any depth, whoever asked for it, live, finished or shelved (project Tasks not
     * counted): a scope with none is empty, and its list says how work starts.
     */
    tasks: z.record(countScopeSchema, z.number().int().nonnegative()),
    /** The project menu's numbers of every project (its All). */
    all: menuCountsSchema,
    /**
     * Each Task's active children, live and finished, by state; `runningBelow`, the Tasks under it at any depth
     * (through active Tasks) that someone placed on runs now, so a row says whether the work under it runs without walking
     * the tree; and `below`, every active Task under it at any depth (through active Tasks), live or finished, so a
     * task's family can say its size before its finished pages are read. A Task with no active child has none.
     */
    children: z.record(taskIdSchema, z.object({ live: z.number().int().nonnegative(), finished: z.number().int().nonnegative(),
      states: z.object({ todo: z.number().int().nonnegative(), doing: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        waiting: z.number().int().nonnegative(), held: z.number().int().nonnegative(), done: z.number().int().nonnegative(),
        stopped: z.number().int().nonnegative() }).strict(), runningBelow: z.number().int().nonnegative(),
      below: z.number().int().nonnegative() }).strict()),
  }).strict(),
}).strict();
const upserts = <T extends z.ZodType>(item: T) => z.object({ upsert: z.array(item), remove: z.array(z.string().min(1)) }).strict();
/** A request's identity and heading; History carries its full text when detail is opened. */
export const requestHeadSchema = controlRequestSchema.omit({ body: true }).extend({
  headline: z.string(), bodyBytes: z.number().int().nonnegative(),
});
/** What the reader adds to a row when a Task is opened. */
export const taskShelvedDetailSchema = z.object({
  task: z.object({ id: taskIdSchema, title: z.string(), kind: z.enum(['project', 'task']),
    projectId: taskIdSchema, lifecycle: taskLifecycleSchema }).strict(), shelf: projectShelfInfoSchema,
}).strict().refine(value => !value.shelf.listed && value.shelf.shelvedBy.length > 0
  && (value.task.kind !== 'project' || value.task.id === value.task.projectId));
export const taskViewSchema = z.object({
  task: controlTaskSchema, requestHeads: z.array(requestHeadSchema),
  placements: z.array(placementSchema), runs: z.array(controlRunSchema),
  /** The Task's values, the fields its schema uses and `context`, what its launches carry (task-schema renderContext). */
  values: taskValuesViewSchema, reply: controlReplySchema.nullable(),
  /**
   * The Task's own questions, including closed ones, oldest first, each with what it asks as fixed when it was asked
   * (`decide`: the screen draws its choices from it).
   */
  questions: z.array(questionSchema),
  /** This Task's open human questions, with original Task/log identities; null on read failure. */
  userQuestions: z.array(questionSchema.extend({ destination: z.object({ kind: z.literal('user') }).strict(), taskTitle: z.string() })).nullable(),
  /** This Task's current review submissions, with their original log identities. */
  userReviews: z.array(z.object({ id: logIdSchema, taskId: taskIdSchema, taskTitle: z.string(), title: z.string(),
    summary: z.string().nullable(), submittedAt: z.iso.datetime({ offset: true }) }).strict()).nullable(),
  /** When the user asked for this Task; null when the user did not. */
  requestedByUser: z.object({ at: isoSchema }).strict().nullable(),
}).strict();
/** Who stood at a Task over a History page's time: its placements and their Runs, as an end of a row names its agent. */
export const historyCrewSchema = z.object({
  placements: z.array(z.object({ id: z.string().min(1), profileKey: z.string().min(1), responsible: z.boolean(),
    startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }).nullable() }).strict()),
  runs: z.array(z.object({ id: runIdSchema, placementId: z.string().min(1), agent: agentNameSchema, modelId: z.string().min(1).nullable(),
    effort: z.string().min(1).nullable(), at: z.iso.datetime({ offset: true }) }).strict()),
}).strict();
export type HistoryCrewDTO = z.infer<typeof historyCrewSchema>;
/**
 * One bounded page of a Task's chronology, newest first: one event per record, its children's among them only where a
 * parent sees them (PARENT_VISIBLE_EVENTS).
 */
export const taskHistorySchema = z.object({
  events: z.array(historyEventSchema),
  nextBefore: z.string().nullable(),
  /**
   * Every Task the page's events name, finished ones too, so a reader can say who each is without holding them: and who
   * stood at it over the page's time (`crew`: its placements, and their Runs from the last one begun before the page's
   * oldest event to the first one begun after its newest), so each end of a row can say its agent.
   */
  tasks: z.record(z.string(), z.object({ title: z.string(), parentId: z.string().nullable(), crew: historyCrewSchema.optional() }).strict()).optional(),
}).strict();
/**
 * The tasks a search finds, and for each one found only in its values the line of a value with the words (cut around
 * them), so a list can say why the task is there.
 */
export const taskSearchSchema = z.object({ rows: z.array(taskPageRowSchema), ancestors: z.array(taskPageRowSchema),
  lines: z.record(taskIdSchema, z.string()),
  total: z.number().int().nonnegative(), nextAfter: z.string().min(1).nullable() }).strict();

/**
 * FNV-1a over UTF-16 code units: the unread baseline's mark of a Task's values (of their canonicalValues text), the same
 * on the server and in the browser.
 */
export function bodyHash(body: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < body.length; index++) hash = Math.imul(hash ^ body.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
type TaskLog = ControlTaskDTO['log'][number];
/** The reader can show the latest person's words, and the card needs the current responsible person's report. */
export function viewReportLog(log: readonly TaskLog[], responsible: ReadonlySet<string>): TaskLog[] {
  let personal: TaskLog | undefined, owner: TaskLog | undefined;
  for (let at = log.length - 1; at >= 0 && (!personal || !owner); at--) {
    const entry = log[at]!;
    if (entry.kind !== 'reported' || !entry.title?.trim() || entry.estimateMinutes !== undefined) continue;
    if (entry.actor.kind === 'placement') {
      if (!owner && responsible.has(entry.actor.placementId)) owner = entry;
    } else if (!personal) personal = entry;
  }
  return log.filter(entry => entry === personal || entry === owner);
}
/**
 * Row fields from the repository's assembled Task events, including the shared estimate classification.
 */
export function taskRowFields(task: ControlTaskDTO) {
  let lastNoticed: TaskRowDTO['notice']['lastNoticed'] = null;
  task.log.forEach((entry, position) => {
    if (NOTICED_LOG_KINDS.has(entry.kind)) lastNoticed = { position, kind: entry.kind, title: entry.title, at: entry.at };
  });
  return {
    ...(Object.fromEntries(TASK_ROW_COPIED.map(key => [key, task[key]])) as Pick<ControlTaskDTO, typeof TASK_ROW_COPIED[number]>),
    createdAt: task.log[0]?.at ?? null, updatedAt: task.log.at(-1)?.at ?? null,
    stateLog: task.log.filter(entry => entry.toState !== null || entry.estimateMinutes !== undefined ||
      STATE_LOG_KINDS.has(entry.kind) || entry.startsEstimateRound === true).map(entry => ({
      id: entry.id, kind: entry.kind, at: entry.at, actor: { kind: entry.actor.kind }, fromState: entry.fromState, toState: entry.toState,
      ...(entry.startsEstimateRound === undefined ? {} : { startsEstimateRound: entry.startsEstimateRound }),
      ...(entry.stage === undefined ? {} : { stage: entry.stage }),
      ...(entry.causeAt === undefined ? {} : { causeAt: entry.causeAt }),
      ...(entry.estimateMinutes === undefined ? {} : { estimateMinutes: entry.estimateMinutes }),
      ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      title: entry.title })),
    usage: null, usageBelow: null, runsBelow: [],
    notice: { logCount: task.log.length, bodyHash: bodyHash(canonicalValues(task.values as TaskValues)), lastNoticed },
  };
}

export const requestInputSchema = z.object({
  taskId: taskIdSchema, mode: requestModeSchema.optional(), body: z.string().min(1),
  title: reportTitleSchema.optional(), description: descriptionSchema.optional(),
  cwd: z.string().min(1).optional(),
  requestId: z.string().min(1), expectedTaskHash: digestSchema,
  expectedPlacementRevision: z.number().int().positive(), expectedHeadRunId: runIdSchema.nullable().optional(),
  targetPlacementId: z.string().min(1).optional(),
  selected: selectionSchema.optional(), aiStack: aiStackPrefixSchema.optional(),
}).strict().refine(input => input.description === undefined || input.title !== undefined,
  { path: ['title'], message: 'A request description requires a title' });
export const requestReceiptSchema = z.object({
  requestId: z.string().min(1), placementId: z.string().min(1), runId: runIdSchema,
  deliveryState: deliveryStateSchema,
  conversationRef: z.object({ provider: sessionProviderSchema.nullable(), sessionId: z.string().nullable(), headRunId: runIdSchema.nullable() }).strict(),
  acceptedAt: z.iso.datetime({ offset: true }),
}).strict();
/** Every Task write returns the committed Task's head; report, request and placement add their own receipt. */
export const taskWriteResultSchema = z.object({
  task: controlTaskHeadSchema, shelf: projectShelfInfoSchema.optional(),
});
/** field use answers as a project write does: the project Task's new head (its hash for the next write). */
export const fieldUseResultSchema = taskWriteResultSchema;
/** `task new --plan-file` returns the heads of the sibling Tasks it created. */
export const taskPlanResultSchema = z.object({ tasks: z.array(controlTaskHeadSchema).min(1) }).strict();
export const taskReportResultSchema = taskWriteResultSchema.extend({
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('recorded'), opId: z.string().min(1).optional() }).strict(),
    z.object({ kind: z.enum(['accepted', 'stopped']), opId: z.string().min(1) }).strict(),
  ]),
}).strict();
/** `task request` sends a Request (an instruction or a send-back) or records an answer to the Task's question. */
export const taskRequestResultSchema = taskWriteResultSchema.extend({
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('request_accepted'), opId: z.string().min(1), request: requestReceiptSchema, answers: logIdSchema.optional() }).strict(),
    z.object({ kind: z.literal('answered'), opId: z.string().min(1) }).strict(),
  ]),
}).strict();
export const requestRejectionDetailSchema = z.object({
  currentTaskHash: digestSchema.nullable(),
  currentPlacementRevision: z.number().int().positive().nullable(), currentHeadRunId: runIdSchema.nullable(),
  preserveDraft: z.literal(true),
}).strict();
/** Same Problem envelope used by every HTTP endpoint; detail is present when a current version is known. */
export const requestRejectionSchema = z.object({ error: problemErrorSchema.extend({
  detail: requestRejectionDetailSchema.optional(),
}).strict() }).strict();
export const agentRecordSchema = z.object({
  id: z.string().min(1), createdAt: z.iso.datetime({ offset: true }),
}).strict();
export const placeAgentInputSchema = z.object({
  taskId: taskIdSchema, selected: selectionSchema.optional(), aiStack: aiStackPrefixSchema.optional(), profileKey: z.string().min(1).optional(),
  expectedTaskHash: digestSchema,
  replacePlacementId: z.string().min(1).optional(), expectedPlacementRevision: z.number().int().positive().optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.replacePlacementId === undefined) !== (input.expectedPlacementRevision === undefined))
    ctx.addIssue({ code: 'custom', message: 'A replacement requires both current placement ID and revision' });
});
export const placeAgentReceiptSchema = z.object({ agent: agentRecordSchema,
  placement: placementRecordSchema, previousPlacement: placementRecordSchema.nullable() }).strict();
export const setResponsibleInputSchema = z.object({
  taskId: taskIdSchema, placementId: z.string().min(1), expectedTaskHash: digestSchema,
  expectedPlacementRevision: z.number().int().positive(),
}).strict();
export const setResponsibleReceiptSchema = z.object({ placement: placementRecordSchema,
  previousPlacement: placementRecordSchema.nullable() }).strict();
export const releaseAgentInputSchema = setResponsibleInputSchema;
export const releaseAgentReceiptSchema = z.object({ placement: placementRecordSchema }).strict();
export const placeMemberInputSchema = z.object({ taskId: taskIdSchema, selected: selectionSchema.optional(), aiStack: aiStackPrefixSchema.optional(),
  agentId: z.string().min(1).optional(),
  profileKey: z.string().min(1).optional(), expectedTaskHash: digestSchema,
  expectedResponsibleRevision: z.number().int().positive(),
}).strict();
export const placeMemberReceiptSchema = z.object({ agent: agentRecordSchema,
  placement: placementRecordSchema }).strict();
export const releaseMemberInputSchema = z.object({ taskId: taskIdSchema,
  placementId: z.string().min(1), expectedTaskHash: digestSchema,
  expectedResponsibleRevision: z.number().int().positive(),
  expectedPlacementRevision: z.number().int().positive(),
}).strict();
export const releaseMemberReceiptSchema = z.object({ placement: placementRecordSchema }).strict();
export const taskPlacementResultSchema = taskWriteResultSchema.extend({ agent: z.union([
  placeAgentReceiptSchema, setResponsibleReceiptSchema, placeMemberReceiptSchema, releaseAgentReceiptSchema,
]) }).strict();
/**
 * One review decision ID is also the send-back Request ID and Task log ID. Either decision names the Run it decides on
 * (reviewTarget) and the responsible placement's revision it was made against.
 */
const reviewDecision = {
  taskId: taskIdSchema, operationId: z.string().min(1), expectedTaskHash: digestSchema,
  expectedPlacementRevision: z.number().int().positive().optional(), aboutRunId: runIdSchema.optional(),
  title: reportTitleSchema.optional(), description: descriptionSchema.optional(),
};
export const reviewInputSchema = z.object({ action: z.literal('approve'), ...reviewDecision }).strict();

export const runFileKindSchema = z.enum(['prompt', 'result']);
export const runFileSchema = z.object({
  kind: runFileKindSchema, state: runResultStateSchema,
  source: z.literal('alpacawork.sqlite'), bytes: z.number().int().nonnegative().nullable(),
  text: z.string().nullable(),
}).strict().superRefine((file, ctx) => {
  if ((file.state === 'present') !== (file.text !== null))
    ctx.addIssue({ code: 'custom', path: ['text'], message: 'Only present files carry text' });
});
export const controlRunFilesSchema = z.object({ run: runIdSchema, taskId: taskIdSchema, files: z.array(runFileSchema),
  failure: runFailureSchema.optional() }).strict();

/** A parent Request links to its exact durable source set, independent of prompt size. */

export type ControlTaskDTO = z.infer<typeof controlTaskSchema>;
export type ControlTaskHeadDTO = z.infer<typeof controlTaskHeadSchema>;
export type PlacementDTO = z.infer<typeof placementSchema>;
export type ControlRunDTO = z.infer<typeof controlRunSchema>;
export type ControlRequestDTO = z.infer<typeof controlRequestSchema>;
export type ControlReplyDTO = z.infer<typeof controlReplySchema>;
export type ControlTreeDTO = z.infer<typeof controlTreeSchema>;
export type TaskRowDTO = z.infer<typeof taskRowSchema>;
export type TaskPageRowDTO = z.infer<typeof taskPageRowSchema>;
export type TaskTimelineDTO = z.infer<typeof taskTimelineSchema>;
export type StateLogEntryDTO = z.infer<typeof stateLogEntrySchema>;
export type ControlIndexDTO = z.infer<typeof controlIndexSchema>;
export type TaskViewDTO = z.infer<typeof taskViewSchema>;
export type RequestHeadDTO = z.infer<typeof requestHeadSchema>;
export type TaskHistoryDTO = z.infer<typeof taskHistorySchema>;
export type RequestInput = z.infer<typeof requestInputSchema>;
export type RequestReceipt = z.infer<typeof requestReceiptSchema>;
export type RequestRejection = z.infer<typeof requestRejectionSchema>;
export type PlaceAgentInput = z.infer<typeof placeAgentInputSchema>;
export type PlaceAgentReceipt = z.infer<typeof placeAgentReceiptSchema>;
export type SetResponsibleInput = z.infer<typeof setResponsibleInputSchema>;
export type ReleaseAgentInput = z.infer<typeof releaseAgentInputSchema>;
export type PlaceMemberInput = z.infer<typeof placeMemberInputSchema>;
export type ReleaseMemberInput = z.infer<typeof releaseMemberInputSchema>;
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type ControlRunFilesDTO = z.infer<typeof controlRunFilesSchema>;

/*
 * The incremental projection's contract. These types are added beside the current index, view and History shapes,
 * which keep working until the readers move to these.
 */

/**
 * A version of serve's published projection: it rises by one each time a batch of changes is applied and published,
 * within one server `generation`. It is not a position in the change log (that is the change log's own number).
 */
export const projectionVersionSchema = z.number().int().nonnegative().brand<'ProjectionVersion'>();
export type ProjectionVersion = z.infer<typeof projectionVersionSchema>;
/** The server lifetime a projection version counts within; versions of different generations are never compared. */
export const projectionGenerationSchema = z.string().min(1);
/** Who made a read: the projection it was made from. A read is current when its `sourcePv` reaches its resource's `requiredPv`. */
export const projectionSourceFields = { generation: projectionGenerationSchema, sourcePv: projectionVersionSchema };
/** A page, search or timeline scope as the projection names it: a listed project Task, or `root` for every project. */
export const projectionScopeSchema = z.union([taskIdSchema, z.literal('root')]);
/**
 * For each resource, the projection version that last changed what it returns. A resource absent from its record has
 * not changed since the generation began: any read of this generation is current for it.
 * `page` is keyed by the closed page's scope name (closedPageScope).
 */
export const requiredPvSchema = z.object({
  view: z.record(taskIdSchema, projectionVersionSchema),
  history: z.record(taskIdSchema, projectionVersionSchema),
  page: z.record(z.string().min(1), projectionVersionSchema),
  timeline: z.record(projectionScopeSchema, projectionVersionSchema),
  search: z.record(projectionScopeSchema, projectionVersionSchema),
}).strict();
export type RequiredPvDTO = z.infer<typeof requiredPvSchema>;
/** The kinds of resource a `requiredPv` names; timeline and its axis share their scope's version. */
export type ProjectionResourceKind = keyof RequiredPvDTO;

/** An ancestor as an opened Task names it: enough to draw its path without its list row. */
export const taskAncestorHeadSchema = z.object({ id: taskIdSchema, title: z.string(), parentId: taskIdSchema.nullable(),
  kind: taskKindSchema, lifecycle: taskLifecycleSchema }).strict();
export type TaskAncestorHeadDTO = z.infer<typeof taskAncestorHeadSchema>;
/**
 * An opened Task's own row without what its descendants decide (movedAt, usageBelow, runsBelow, rowFacts and the
 * detail mark): those belong to the list alone, so a child's or a member's write does not make its parent's view old.
 */
export const taskViewRowSchema = taskRowSchema.omit({ movedAt: true, usageBelow: true, runsBelow: true, rowFacts: true }).strict();
export type TaskViewRowDTO = z.infer<typeof taskViewRowSchema>;
/** Activity files reach the screen through the live index alone, independently of opened Task freshness. */
export const taskViewPlacementSchema = z.object({ ...placementSchema.shape,
  runtime: placementRuntimeSchema.omit({ lastOutputAt: true, activityKind: true, toolName: true }),
}).strict().superRefine(checkPlacement);
export type TaskViewPlacementDTO = z.infer<typeof taskViewPlacementSchema>;
export const taskViewRunSchema = controlRunSchema.omit({ activity: true, errorCause: true }).strict();
export type TaskViewRunDTO = z.infer<typeof taskViewRunSchema>;
/** `GET /api/task/view` as the projection answers it: its own row, its ancestors' heads, and no home section. */
export const taskProjectedViewSchema = taskViewSchema.extend({
  ...projectionSourceFields,
  row: taskViewRowSchema,
  placements: z.array(taskViewPlacementSchema), runs: z.array(taskViewRunSchema),
  /** From the top project down to the parent. */
  ancestors: z.array(taskAncestorHeadSchema),
}).strict();
export type TaskProjectedViewDTO = z.infer<typeof taskProjectedViewSchema>;

/** How many History events a window starts with, and how many the server returns at most while a position is protected. */
export const HISTORY_WINDOW_SIZE = 80;
export const HISTORY_WINDOW_MAX = 2000;
/**
 * The three ways to read a Task's History window (one continuous range from `oldestKey` to the newest event):
 * the newest events (`latest`); everything from `since` on again, the newest `keep` of it (`since`), or that with the
 * newest HISTORY_WINDOW_SIZE kept and widened to reach the protected key (`protect`, refused with
 * history_window_too_large past HISTORY_WINDOW_MAX); the `limit` events before `before` (`older`).
 */
export const historyWindowRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('latest') }).strict(),
  z.object({ mode: z.literal('since'), since: historyCursorSchema, keep: z.number().int().min(1).max(HISTORY_WINDOW_MAX) }).strict(),
  z.object({ mode: z.literal('protect'), since: historyCursorSchema, protect: historyCursorSchema }).strict(),
  z.object({ mode: z.literal('older'), before: historyCursorSchema, limit: z.number().int().min(1).max(HISTORY_WINDOW_SIZE) }).strict(),
]);
export type HistoryWindowRequest = z.infer<typeof historyWindowRequestSchema>;
/**
 * A Task's History window, newest first: its own events and its direct children's that a parent sees. `oldestKey` is the
 * position of the oldest event returned (null when none); `hasOlder` says whether events older than it exist.
 */
export const taskHistoryWindowSchema = z.object({
  ...projectionSourceFields,
  events: z.array(historyEventSchema),
  oldestKey: historyCursorSchema.nullable(),
  hasOlder: z.boolean(),
  tasks: taskHistorySchema.shape.tasks,
}).strict();
export type TaskHistoryWindowDTO = z.infer<typeof taskHistoryWindowSchema>;

/** Changed entries of a keyed record, and the keys that left it. */
const keyedPatch = <K extends z.ZodType<string>, V extends z.ZodType>(key: K, value: V) =>
  z.object({ upsert: z.record(key, value), remove: z.array(key) }).strict();
/**
 * The SSE `patch` event: what changed since `rev - 1`, key by key. Rows, placements and Runs as the delta sends them;
 * the home list's changed rows with the row each now follows (`after`: null for the first), not its whole order; the
 * counts and `requiredPv` entries that changed; the index's small fields only when they changed.
 */
export const indexPatchSchema = z.object({
  rev: z.number().int().positive(),
  ...projectionSourceFields,
  tasks: upserts(taskRowSchema).extend({ remove: z.array(taskIdSchema) }), placements: upserts(placementSchema), runs: upserts(controlRunSchema),
  home: z.object({ upsert: z.array(z.object({ row: homeRowSchema, after: taskIdSchema.nullable() }).strict()),
    remove: z.array(taskIdSchema) }).strict(),
  counts: z.object({
    closed: keyedPatch(countScopeSchema, controlIndexSchema.shape.counts.shape.closed.valueType),
    home: keyedPatch(countScopeSchema, homeCountsSchema),
    tasks: keyedPatch(countScopeSchema, z.number().int().nonnegative()),
    children: keyedPatch(taskIdSchema, controlIndexSchema.shape.counts.shape.children.valueType),
    all: menuCountsSchema.optional(),
  }).strict(),
  requiredPv: z.object({
    view: keyedPatch(taskIdSchema, projectionVersionSchema), history: keyedPatch(taskIdSchema, projectionVersionSchema),
    page: keyedPatch(z.string().min(1), projectionVersionSchema), timeline: keyedPatch(projectionScopeSchema, projectionVersionSchema),
    search: keyedPatch(projectionScopeSchema, projectionVersionSchema),
  }).strict(),
  meta: z.object(indexFields).partial().strict(),
}).strict();
export type IndexPatchDTO = z.infer<typeof indexPatchSchema>;
/** The whole index of the projection: the current one with its generation's versions and every resource's requiredPv. */
export const projectedIndexSchema = controlIndexSchema.omit({ counts: true }).extend({
  sourcePv: projectionVersionSchema,
  counts: controlIndexSchema.shape.counts,
  requiredPv: requiredPvSchema,
}).strict();
export type ProjectedIndexDTO = z.infer<typeof projectedIndexSchema>;

/** Read resources use the same projection proof as an opened Task; cursors stay opaque pagination positions. */
export const taskProjectedPageSchema = taskPageSchema.omit({ scopeVersion: true }).extend(projectionSourceFields).strict();
export type TaskProjectedPageDTO = z.infer<typeof taskProjectedPageSchema>;
export const taskProjectedSearchSchema = taskSearchSchema.extend(projectionSourceFields).strict();
export type TaskProjectedSearchDTO = z.infer<typeof taskProjectedSearchSchema>;
export const taskProjectedTimelineSchema = taskTimelineSchema.omit({ scopeVersion: true }).extend(projectionSourceFields).strict();
export type TaskProjectedTimelineDTO = z.infer<typeof taskProjectedTimelineSchema>;
export const taskProjectedTimelineAxisSchema = taskTimelineAxisSchema.omit({ version: true }).extend(projectionSourceFields).strict();
export type TaskProjectedTimelineAxisDTO = z.infer<typeof taskProjectedTimelineAxisSchema>;
