import { z } from 'zod';
import { automationIdSchema } from '@alpacawork/raw/automation';
import { MAX_INSTRUCTION_BYTES, MAX_TITLE_LENGTH } from '@alpacawork/raw/values';
import { automationMessages, automationStates, automationTriggerSchema, hostPressureKinds, signalSenderSchema } from './automation.js';
import { digestSchema, taskIdSchema, taskStateSchema } from './fields.js';

export const AUTOMATION_BUNDLE_LIMITS = { files: 20, fileBytes: 65_536, totalBytes: 262_144, entry: 'main.ts' } as const;
export const AUTOMATION_BUNDLE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.json'] as const;

export const AUTOMATION_SDK_CONTRACT_VERSION = 1;

const date = z.iso.datetime();
const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const name = z.string().min(1).max(128);
const text = (max: number) => z.string().trim().min(1).max(max);
const line = text(300).refine(value => !/[\r\n]/.test(value), 'Write one line');
const bytes = (max: number) => z.string().refine(value => new TextEncoder().encode(value).length <= max,
  `Use at most ${max} UTF-8 bytes`);
export const automationJson = z.json();
const jsonBytes = (max: number) => automationJson.refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= max,
  `Use at most ${max} JSON bytes`);
const state = z.enum(automationStates);
const origin = z.strictObject({ automationId: automationIdSchema, name: z.string(), runNumber: positive });
const task = z.strictObject({ id: taskIdSchema, title: z.string(), state, userRequested: z.boolean(), origin: origin.nullable() });
const taskHead = task.omit({ userRequested: true }).extend({ id: z.string() });
const eventBase = z.strictObject({ ref: text(256), at: date, manual: z.boolean() });
const words = { task, title: z.string(), description: bytes(65_536), descriptionTruncated: z.literal(true).optional() };
const taskFilter = { includeAutomated: z.boolean().optional() };
const oldEvents = automationTriggerSchema.options[1].options;
const stateWhere = oldEvents[0].shape.where.safeExtend(taskFilter);
const [humanMessage, aiMessage] = oldEvents[1].shape.where.options;
const messageWhere = z.discriminatedUnion('by', [humanMessage.extend(taskFilter), aiMessage.extend(taskFilter)]);
const pressureWhere = automationTriggerSchema.options[3].shape.where;
const messageKinds = [...automationMessages.human, ...automationMessages.ai] as const;

const anyOf = <T>(expected: T | readonly T[] | undefined, actual: T) => expected === undefined || [expected].flat().includes(actual);
const taskMatches = (where: { includeAutomated?: boolean }, event: { task: z.infer<typeof task> }) =>
  !!where.includeAutomated || event.task.origin === null;

export const automationEvents = {
  schedule: {
    where: automationTriggerSchema.options[0].shape.where,
    event: eventBase.extend({ kind: z.literal('schedule'), scheduledAt: date }),
    textKey: 'trigger.schedule', source: 'schedule', coalesce: false, candidates: 'next',
    matches: () => true,
    manual: (at: string) => ({ kind: 'schedule' as const, ref: at, at, manual: true, scheduledAt: at }),
  },
  'task.state_changed': {
    where: stateWhere,
    event: eventBase.extend({ kind: z.literal('task.state_changed'), ...words, from: state, to: state }),
    textKey: 'trigger.state', source: 'task_event', coalesce: false, candidates: 'task',
    matches: (where: z.infer<typeof stateWhere>, event: { task: z.infer<typeof task>; from: z.infer<typeof state>; to: z.infer<typeof state> }) =>
      taskMatches(where, event) && anyOf(where.from, event.from) && anyOf(where.to, event.to)
      && (!where.userRequestedOnly || event.task.userRequested),
  },
  'task.message': {
    where: messageWhere,
    event: eventBase.extend({ kind: z.literal('task.message'), ...words, by: z.enum(['human', 'ai']), type: z.enum(messageKinds) })
      .refine(({ by, type }) => (automationMessages[by] as readonly string[]).includes(type), { path: ['type'], message: 'Choose a message kind for the sender' }),
    textKey: 'trigger.message', source: 'task_event', coalesce: false, candidates: 'task',
    matches: (where: z.infer<typeof messageWhere>, event: { task: z.infer<typeof task>; by: 'human' | 'ai'; type: string; title: string; description: string }) =>
      taskMatches(where, event) && where.by === event.by && anyOf<string>(where.type, event.type) &&
      (!where.contains || event.title.includes(where.contains) || event.description.includes(where.contains)),
  },
  signal: {
    where: z.undefined().optional(),
    event: eventBase.extend({ kind: z.literal('signal'), count: positive, firstAt: date, lastAt: date,
      items: z.array(z.strictObject({ at: date, by: signalSenderSchema, key: z.string().max(512).nullable(), data: jsonBytes(65_536) })).max(20) }),
    textKey: 'trigger.signal', source: 'signal', coalesce: true, candidates: 'retained',
    matches: () => true,
  },
  'host.pressure': {
    where: pressureWhere,
    event: eventBase.extend({ kind: z.literal('host.pressure'), kinds: z.array(z.enum(hostPressureKinds)).min(1),
      phase: z.enum(['entered', 'continuing']), episodeStartedAt: date }),
    textKey: 'trigger.hostPressure', source: 'host_pressure', coalesce: false, candidates: 'retained',
    matches: (where: z.infer<typeof pressureWhere>, event: { kinds: (typeof hostPressureKinds[number])[] }) =>
      event.kinds.some(kind => where.kinds.includes(kind)),
  },
} as const;

function onSchema<const K extends keyof typeof automationEvents, W extends (typeof automationEvents)[K]['where']>(event: K, where: W) {
  return z.strictObject({ event: z.literal(event), where });
}

export const automationOnSchema = z.discriminatedUnion('event', [
  onSchema('schedule', automationEvents.schedule.where), onSchema('task.state_changed', automationEvents['task.state_changed'].where),
  onSchema('task.message', automationEvents['task.message'].where), onSchema('signal', automationEvents.signal.where),
  onSchema('host.pressure', automationEvents['host.pressure'].where),
]);
export const automationEventSchema = z.discriminatedUnion('kind', [
  automationEvents.schedule.event, automationEvents['task.state_changed'].event, automationEvents['task.message'].event,
  automationEvents.signal.event, automationEvents['host.pressure'].event,
]);
export type ProgramAutomationEvent = z.infer<typeof automationEventSchema>;
export type ProgramAutomationOn = z.infer<typeof automationOnSchema>;

const ai = z.strictObject({ agent: name, model: name, effort: name });
export const automationConfigSchema = z.strictObject({
  on: automationOnSchema,
  timezone: text(128).optional(),
  limits: z.strictObject({
    perDay: z.number().int().min(1).max(200),
    cooldownMinutes: z.number().int().min(0).max(1440).optional(),
    waitForPrevious: z.boolean().optional(),
    until: z.iso.date().optional(),
    timeoutMinutes: z.number().int().min(1).max(60).optional(),
    aiCallsPerDay: z.number().int().min(1).max(200).optional(),
    tasksPerRun: z.number().int().min(0).max(5).optional(),
  }),
  uses: z.strictObject({
    ai: z.record(name, ai).optional(),
    send: z.array(name).refine(names => new Set(names).size === names.length, 'Use each destination once').optional(),
  }).optional(),
}).refine(({ on, limits }) => !(on.where && 'includeAutomated' in on.where && on.where.includeAutomated && (limits.tasksPerRun ?? 0) > 0),
  { path: ['limits', 'tasksPerRun'], message: 'Automations triggered by automated tasks cannot create tasks' });
export type AutomationConfig = z.infer<typeof automationConfigSchema>;

export const automationTaskRecordSchema = z.strictObject({
  at: date, by: z.enum(['human', 'ai', 'automation']),
  kind: z.enum(['report', 'question', 'answer', 'send_back', 'accept', 'comment']),
  title: z.string(), description: bytes(16_384), truncated: z.literal(true).optional(),
});
const sdkTask = task.extend({ id: z.string(), records: z.array(automationTaskRecordSchema).max(50),
  skills: z.strictObject({ names: z.array(z.string()), complete: z.boolean() }).nullable(), preview: z.literal(true).optional() });
const previewFlag = { preview: z.literal(true).optional() };
const destination = { to: name, path: z.string().max(8192).optional() };
const response = z.strictObject({ status: z.number().int().min(100).max(599).nullable(), body: z.string().nullable(), ...previewFlag });
const instruction = bytes(MAX_INSTRUCTION_BYTES);
const taskTitle = text(MAX_TITLE_LENGTH);

export const automationOperations = {
  'tasks.get': {
    input: z.strictObject({ task: name }), output: sdkTask, phase: 'both', write: false, grant: 'project',
    description: 'Read one task and its recent records in this project.',
  },
  'tasks.list': {
    input: z.strictObject({ createdByThis: z.boolean().optional(), title: taskTitle.optional(),
      state: z.union([state, z.array(state).min(1)]).optional(), since: date.optional(), limit: positive.max(100).optional() }),
    output: z.strictObject({ tasks: z.array(taskHead) }), phase: 'both', write: false, grant: 'project',
    description: 'Read recent tasks in this project, newest first. The default limit is 20.',
  },
  'ai.ask': {
    input: z.strictObject({ ai: name, prompt: bytes(4096), data: jsonBytes(16_384).optional(), schema: automationJson.optional() }),
    output: automationJson, phase: 'both', write: false, grant: 'ai',
    description: 'Ask the declared AI once without tools. Supply a Zod schema for a validated JSON reply.',
  },
  fetch: {
    input: z.strictObject(destination), output: response, phase: 'both', write: false, grant: 'send',
    description: 'Read from a declared destination with an optional relative path.',
  },
  'tasks.create': {
    input: z.strictObject({ title: taskTitle, instruction: instruction.optional(), ai: name.optional(),
      request: z.boolean().optional(), awaitReview: z.boolean().optional(), urgent: z.boolean().optional(), data: jsonBytes(65_536).optional() })
      .refine(input => input.request === false || (input.ai !== undefined && !!input.instruction?.trim()),
        { path: ['instruction'], message: 'Provide a declared AI and an instruction when making a request' }),
    output: z.strictObject({ id: z.string(), ...previewFlag }), phase: 'run', write: true, grant: 'create',
    description: 'Create a task in this project. Set request: false to make a task without starting an AI.',
  },
  'tasks.comment': {
    input: z.strictObject({ task: name, title: taskTitle, description: bytes(16_384) }),
    output: z.strictObject({ at: date, ...previewFlag }), phase: 'run', write: true, grant: 'comment',
    description: 'Record a comment on the trigger task or a task created by this automation.',
  },
  send: {
    input: z.strictObject({ ...destination, method: z.enum(['POST', 'PUT', 'PATCH']).optional(), body: jsonBytes(65_536).optional() }),
    output: response, phase: 'run', write: true, grant: 'send',
    description: 'Send JSON to a declared destination. Preview records the intended request.',
  },
  disable: {
    input: z.strictObject({}), output: z.strictObject(previewFlag), phase: 'run', write: true, grant: 'self',
    description: 'Turn off this automation and stop its active run.',
  },
} as const;

export type AutomationOperation = keyof typeof automationOperations;
export type AutomationOperationInput<N extends AutomationOperation> = z.infer<typeof automationOperations[N]['input']>;
export const automationOperationErrorCodes = ['limit', 'forbidden', 'invalid', 'temporary', 'unknown_result'] as const;
export const automationTriggerResultSchema = z.strictObject({ run: z.boolean(), reason: line, context: jsonBytes(16_384).optional() });
export const automationRunResultSchema = z.strictObject({ summary: line, report: bytes(16_384).optional(), notify: z.literal(true).optional() });

export const automationBundleFileSchema = z.strictObject({ path: z.string().min(1).max(1024), source: z.string() });
export const automationBundleSchema = z.array(automationBundleFileSchema).min(1).max(AUTOMATION_BUNDLE_LIMITS.files);
export type AutomationBundle = z.infer<typeof automationBundleSchema>;

export const automationProgramDocSchema = z.strictObject({
  summary: text(80), body: z.string(), params: z.array(z.strictObject({ name: z.string(), text: z.string() })),
  returns: z.string().nullable(), throws: z.array(z.string()),
});
export const automationProgramDocsSchema = z.strictObject({ run: automationProgramDocSchema, trigger: automationProgramDocSchema.nullable() });
export const automationOutsideEffectKindSchema = z.enum(['file', 'network', 'process', 'other']);
export const automationAiUseSchema = z.enum(['ai.ask', 'tasks.create']);
export const automationReviewResultSchema = z.strictObject({
  state: z.enum(['ok', 'fix', 'unavailable', 'running']),
  findings: z.array(z.strictObject({ level: z.enum(['must', 'note']), file: z.string(), line: positive, text: z.string(),
    outsideEffect: automationOutsideEffectKindSchema.optional() })),
  summary: z.string(), model: z.string().nullable(), at: date,
  acknowledged: z.strictObject({ by: z.unknown(), at: date }).nullable(),
});
export const automationProgramLimitsSchema = z.strictObject({
  perDay: positive, cooldownMinutes: count, waitForPrevious: z.boolean(), until: z.iso.date().nullable(),
  timeoutMinutes: positive, aiCallsPerDay: positive, tasksPerRun: count, timezone: z.string(),
});
export const automationProgramFactsSchema = z.strictObject({
  when: z.strictObject({ event: z.string(), where: automationJson.nullable(), textKey: z.string(), filter: z.string().nullable() }),
  limits: automationProgramLimitsSchema,
  ai: z.array(ai.extend({ name, uses: z.array(automationAiUseSchema).min(1).nullable(), costHint: z.strictObject({ perCallUsd: z.number().nonnegative() }).nullable() })),
  outside: z.array(z.strictObject({ name, host: z.string().nullable(), ready: z.boolean() })),
});
const operationUsage = z.strictObject({ model: z.string().nullable(), costUsd: z.number().nonnegative().nullable() });
export const automationPreviewOperationSchema = z.strictObject({
  name, target: automationJson.nullable(), input: automationJson, replaced: z.boolean(), result: automationJson.nullable(),
  code: z.enum(automationOperationErrorCodes).nullable(), usage: operationUsage.nullable(),
});
const programError = z.strictObject({ message: z.string(), file: z.string().nullable(), line: positive.nullable() });
export const automationProgramOutcomeSchema = z.strictObject({
  state: z.enum(['done', 'skipped', 'stopped', 'failed']), summary: z.string().nullable(), report: z.string().nullable(),
  notify: z.boolean(), error: programError.nullable(),
});
export const automationProgramPreviewSchema = z.strictObject({
  hash: digestSchema, at: date, by: z.unknown(),
  event: eventBase.pick({ ref: true, manual: true }).extend({ kind: z.string() }),
  trigger: automationTriggerResultSchema.omit({ context: true }).nullable(),
  operations: z.array(automationPreviewOperationSchema), outcome: automationProgramOutcomeSchema,
});
export const automationVersionSchema = z.strictObject({
  digest: digestSchema, contractVersion: positive, savedAt: date, savedBy: z.unknown(),
  files: z.array(z.strictObject({ path: z.string(), bytes: count })),
  facts: automationProgramFactsSchema, docs: automationProgramDocsSchema, parts: z.array(z.string()),
  outsideEffects: z.array(z.strictObject({ kind: automationOutsideEffectKindSchema, text: z.string() })),
  sourceRequest: z.strictObject({ id: z.string(), text: z.string() }).nullable(),
  review: automationReviewResultSchema, preview: automationProgramPreviewSchema.nullable(),
});
export type AutomationVersion = z.infer<typeof automationVersionSchema>;
export type AutomationProgramFacts = z.infer<typeof automationProgramFactsSchema>;

/** Paths are portable and relative to the bundle root. The generated declaration is not source. */
export function isAutomationBundlePath(path: string): boolean {
  if (path.length > 1024 || path === 'alpacawork.d.ts' || /[\\\x00-\x1f\x7f:%?#]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === 'package.json')) return false;
  const filename = segments.at(-1)!;
  const dot = filename.lastIndexOf('.');
  return dot > 0 && (AUTOMATION_BUNDLE_EXTENSIONS as readonly string[]).includes(filename.slice(dot));
}

export const automationProgramRunSchema = z.strictObject({
  number: positive, version: positive, digest: digestSchema, activationRevision: positive.nullable(),
  event: z.strictObject({ kind: z.string(), ref: z.string(), manual: z.boolean() }),
  mode: z.enum(['live','trial','preview']),
  state: z.enum(['waiting','running','done','skipped','failed','stopped']),
  phase: z.enum(['trigger','run','stopping']).nullable(), at: date, lastAt: date, startedAt: date.nullable(),
  phaseStartedAt: date.nullable(), runStartedAt: date.nullable(), finishedAt: date.nullable(), count: positive,
  reasonKind: z.string().nullable(), reason: z.string().nullable(),
  trigger: automationTriggerResultSchema.omit({ context: true }).nullable(),
  summary: z.string().nullable(), report: z.string().nullable(), notify: z.boolean(), error: programError.nullable(),
  operations: z.array(automationPreviewOperationSchema.extend({
    ordinal: positive, at: date, durationMs: count.nullable(),
    taskState: taskStateSchema.nullable(),
    outcome: z.enum(['running','done','failed']),
    usage: z.strictObject({ model: z.string().nullable(), costUsd: z.number().nonnegative().nullable(),
      inputTokens: count.nullable(), outputTokens: count.nullable() }).nullable(),
  })),
  output: z.array(z.strictObject({ stream: z.enum(['stdout','stderr']), text: z.string() })),
});
export type AutomationProgramRun = z.infer<typeof automationProgramRunSchema>;
export const automationAttentionSchema = z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('failed'), at: date, run: positive, reason: z.string().nullable(), reasonKind: z.string().nullable() }),
  z.strictObject({ kind: z.enum(['disabled','awaiting_enable','stopping']), at: date }),
]));
export const automationWeekSchema = z.strictObject({
  matched: count, started: count, skipped: count, failed: count, busiestDay: count,
  skippedBy: z.array(z.strictObject({ reason: z.string(), count })),
});
export const automationProgramViewSchema = z.strictObject({
  id: automationIdSchema, project: taskIdSchema, name, hash: digestSchema, enabled: z.boolean(), disabledReason: z.string().nullable(),
  latest: automationVersionSchema, live: automationVersionSchema.nullable(), awaitingEnable: z.boolean(),
  everEnabled: z.boolean(), nextAt: date.nullable(), week: automationWeekSchema,
  hook: z.strictObject({ exists: z.boolean() }), pendingSignal: z.strictObject({ count: positive, firstAt: date, lastAt: date }).nullable(),
  lastRun: automationProgramRunSchema.nullable(), attention: automationAttentionSchema,
});
export type AutomationProgramView = z.infer<typeof automationProgramViewSchema>;
export const automationProgramViewResultSchema = z.strictObject({ automation: automationProgramViewSchema });
export const automationProgramSaveResultSchema = automationProgramViewResultSchema.extend({ saved: automationVersionSchema });
export const automationProgramListResultSchema = z.strictObject({
  automations: z.array(automationProgramViewSchema.pick({ id: true, project: true, name: true, hash: true, enabled: true,
    awaitingEnable: true, everEnabled: true, nextAt: true, week: true, lastRun: true, attention: true }).extend({ latest: automationVersionSchema.pick({ facts: true, docs: true }) })),
  counts: z.strictObject({ enabled: count, draft: count, stopped: count }),
  today: z.strictObject({ aiCalls: count, outside: count }),
});
export const automationProgramEventInput = z.strictObject({ event: text(256).optional(), syntheticEvent: automationJson.optional() })
  .refine(input => input.event === undefined || input.syntheticEvent === undefined, 'Select an event or supply an event file');

const project = taskIdSchema.regex(/^P/, 'Use a project ID');
const selection = z.strictObject({ automation: automationIdSchema });
const expected = selection.extend({ expectedHash: digestSchema });
const versionReference = selection.extend({ version: digestSchema });
const sourceRequest = text(256).optional();
const optionalEvent = automationProgramEventInput.shape;
const eventChoice = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...optionalEvent, ...shape })
  .refine(input => !('event' in input && input.event !== undefined && 'syntheticEvent' in input && input.syntheticEvent !== undefined),
    'Select an event or supply an event file');
const runCursor = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const automationProgramRunCursorSchema = z.tuple([date, positive.max(Number.MAX_SAFE_INTEGER), positive.max(Number.MAX_SAFE_INTEGER)]);
export const automationProgramInputs = {
  runs: z.strictObject({ automation: automationIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), cursor: runCursor.optional() })
    .refine(input => input.before === undefined || input.automation !== undefined && input.cursor === undefined,
      'Use before only with one automation and without a cursor'),
  operate: z.strictObject({ operation: z.enum(Object.keys(automationOperations) as [keyof typeof automationOperations, ...Array<keyof typeof automationOperations>]), input: automationJson }),
  new: z.strictObject({ under: project, name, files: automationBundleSchema, sourceRequest }),
  save: expected.extend({ files: automationBundleSchema, sourceRequest }),
  pull: selection.extend({ version: digestSchema.optional() }),
  review: versionReference,
  enable: expected.extend({ acknowledgeReview: z.boolean().optional() }),
  rename: expected.extend({ name }),
  restore: expected.extend({ version: digestSchema }),
  version: expected,
  preview: eventChoice({ automation: automationIdSchema.optional(), under: project.optional(), files: automationBundleSchema.optional(),
    run: z.boolean().optional() }).refine(value => value.automation ? value.under === undefined : !!value.under && !!value.files,
    'Choose an automation or provide a project and files'),
  try: eventChoice({ ...selection.shape, previewHash: digestSchema }),
  runNow: eventChoice(selection.shape),
  destination: z.strictObject({ under: project, name, url: text(8192).optional(), header: text(8192).optional(),
    signingKey: text(128).optional(), sourceRequest }).refine(value => (value.url === undefined) !== (value.sourceRequest === undefined),
    'Provide a URL or a delivered message'),
  destinations: z.strictObject({ under: project }),
};
export const automationProgramRunViewSchema = z.strictObject({ run: automationProgramRunSchema, event: automationEventSchema.nullable() });
export const automationProgramRunsViewSchema = z.strictObject({
  runs: z.array(automationProgramRunSchema.extend({ automationId: automationIdSchema })),
  nextCursor: runCursor.nullable(),
});
export const automationProgramRunReceiptSchema = z.strictObject({ automation: z.strictObject({ id: automationIdSchema, project }),
  run: automationProgramRunSchema });
export const automationDestinationListSchema = z.strictObject({
  destinations: z.array(z.strictObject({ name, host: z.string(), ready: z.boolean(), usedBy: z.array(z.strictObject({ id: automationIdSchema, name })) })),
});
export const automationProgramPreviewResultSchema = z.strictObject({ preview: automationProgramPreviewSchema.nullable(),
  events: z.array(automationEventSchema) });
