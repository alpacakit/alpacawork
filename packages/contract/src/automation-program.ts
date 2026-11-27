import { z } from 'zod';
import { automationIdSchema } from '@alpacawork/raw/automation';
import { MAX_INSTRUCTION_BYTES, MAX_TITLE_LENGTH } from '@alpacawork/raw/values';
import { TASK_BASE_STATES } from '@alpacawork/raw/task-enums';
import { AUTOMATION_SIGNAL_DATA_BYTES, signalSenderSchema } from './automation.js';
import { hostKindSchema } from './host-contract.js';
import { mayChangeTaskBaseState } from './task-policy.js';
import { runUsageNameSchema } from './usage-name.js';
import { digestSchema, taskIdSchema, taskStateSchema } from './fields.js';

export const AUTOMATION_BUNDLE_LIMITS = { files: 20, fileBytes: 65_536, totalBytes: 262_144, entry: 'main.ts' } as const;
export const AUTOMATION_BUNDLE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.json'] as const;

export const AUTOMATION_SDK_CONTRACT_VERSION = 1;
export const AUTOMATION_DESTINATION_MAX_CHARS = 8192;

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
const state = z.enum(TASK_BASE_STATES);
const nonblank = (max: number) => z.string().min(1).max(max).regex(/\S/);
const origin = z.strictObject({ automationId: automationIdSchema, name: z.string(), runNumber: positive });
const task = z.strictObject({ id: taskIdSchema, title: z.string(), state, userRequested: z.boolean(), origin: origin.nullable() });
const taskHead = task.omit({ userRequested: true }).extend({ id: z.string() });
const eventBase = z.strictObject({ ref: text(256), at: date, manual: z.boolean() });
const words = { task, title: z.string(), description: bytes(65_536), descriptionTruncated: z.literal(true).optional() };
const taskFilter = { includeAutomated: z.boolean().optional() };
const states = oneOrMore(TASK_BASE_STATES);
const stateWhere = z.strictObject({ from: states.optional(), to: states, userRequestedOnly: z.boolean().optional(),
  skills: z.array(runUsageNameSchema).min(1).refine(values => new Set(values).size === values.length, 'Choose each skill once').optional(),
  ...taskFilter,
}).refine(({ from, to, userRequestedOnly }) => (from === undefined ? TASK_BASE_STATES : [from].flat())
  .some(before => [to].flat().some(after => mayChangeTaskBaseState(before, after, userRequestedOnly))),
  { path: ['to'], error: 'Choose at least one state change the task can make' });
export const automationMessages = { human: ['answer', 'send_back', 'accept'], ai: ['report', 'question'] } as const;
const messageWhere = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('human'), type: oneOrMore(automationMessages.human, 'Choose an answer, send-back, or acceptance for a person').optional(),
    contains: nonblank(500).optional(), ...taskFilter }),
  z.strictObject({ by: z.literal('ai'), type: oneOrMore(automationMessages.ai, 'Choose a report or question for AI').optional(),
    contains: nonblank(500).optional(), ...taskFilter }),
]);
const pressureWhere = z.strictObject({ kinds: z.array(hostKindSchema).min(1).max(hostKindSchema.options.length)
  .refine(kinds => new Set(kinds).size === kinds.length, 'Choose each pressure kind once') });
const messageKinds = [...automationMessages.human, ...automationMessages.ai] as const;

function oneOrMore<const T extends readonly [string, ...string[]]>(choices: T, error?: string) {
  const item = z.enum(choices);
  return z.union([item, z.array(item).min(1).max(choices.length)
    .refine(values => new Set(values).size === values.length, 'Choose each value once')], { error });
}
const anyOf = <T>(expected: T | readonly T[] | undefined, actual: T) => expected === undefined || [expected].flat().includes(actual);
type MatchEvidence = { automated?: boolean; description?: string };
const taskMatches = (where: { includeAutomated?: boolean }, event: { task: z.infer<typeof task> }, evidence?: MatchEvidence) =>
  !!where.includeAutomated || !evidence?.automated && event.task.origin === null;

type EventDisplay = { title: string | null; fields: [string, string][] };
const taskDisplay = (event: { task: { id: string }; title: string }, fields: EventDisplay['fields']): EventDisplay =>
  ({ title: `${event.task.id} ${event.title}`, fields: [['task', event.task.id], ...fields] });
const taskExample = { task: { id: 'T1', title: '', state: 'waiting', userRequested: true, origin: null }, title: '', description: '' };

function eventDefinition<const K extends string, const Source extends string, W extends z.ZodType, E extends z.ZodObject>(kind: K, where: W, event: E,
  definition: {
    textKey: string; textFormat?: 'schedule' | 'state' | 'message' | 'pressure';
    source: Source; coalesce?: boolean; candidates: 'next' | 'task' | 'retained';
    taskRecord?: { event: 'state_changed' | 'message_received'; fields: readonly string[] };
    matches: (where: z.output<W>, event: z.output<E>, evidence?: MatchEvidence) => boolean;
    example: (at: string) => object;
    written?: (at: string, input: unknown) => object;
    manual?: (at: string) => z.output<E>;
    display: (event: z.output<E>) => EventDisplay;
  }) {
  return { ...definition, kind, on: z.strictObject({ event: z.literal(kind), where }), where, event };
}

const signalItem = z.strictObject({ at: date, by: signalSenderSchema, key: z.string().max(512).nullable(),
  data: jsonBytes(AUTOMATION_SIGNAL_DATA_BYTES) });

export const automationEvents = {
  schedule: eventDefinition('schedule', z.strictObject({ cron: nonblank(160).describe('Five cron fields: minute, hour, day of month, month, day of week') }),
    eventBase.extend({ kind: z.literal('schedule'), scheduledAt: date }), {
      textKey: 'trigger.schedule', textFormat: 'schedule', source: 'schedule', candidates: 'next',
      matches: () => true, example: at => ({ scheduledAt: at }),
      manual: at => ({ kind: 'schedule' as const, ref: at, at, manual: true, scheduledAt: at }),
      display: event => ({ title: null, fields: [['scheduledAt', event.scheduledAt]] }),
    }),
  'task.state_changed': eventDefinition('task.state_changed', stateWhere,
    eventBase.extend({ kind: z.literal('task.state_changed'), ...words, from: state, to: state }), {
      textKey: 'trigger.state', textFormat: 'state', source: 'task_event', candidates: 'task',
      taskRecord: { event: 'state_changed', fields: ['from', 'to'] },
      matches: (where, event, evidence) => taskMatches(where, event, evidence) && anyOf(where.from, event.from) && anyOf(where.to, event.to)
        && (!where.userRequestedOnly || event.task.userRequested),
      example: () => ({ ...taskExample, from: 'doing', to: 'waiting' }),
      display: event => taskDisplay(event, [['from', event.from], ['to', event.to]]),
    }),
  'task.message': eventDefinition('task.message', messageWhere,
    eventBase.extend({ kind: z.literal('task.message'), ...words, by: z.enum(['human', 'ai']), type: z.enum(messageKinds) })
      .refine(({ by, type }) => (automationMessages[by] as readonly string[]).includes(type), { path: ['type'], message: 'Choose a message kind for the sender' }), {
      textKey: 'trigger.message', textFormat: 'message', source: 'task_event', candidates: 'task',
      taskRecord: { event: 'message_received', fields: ['by', 'type'] },
      matches: (where, event, evidence) => taskMatches(where, event, evidence) && where.by === event.by && anyOf<string>(where.type, event.type)
        && (!where.contains || event.title.includes(where.contains) || (evidence?.description ?? event.description).includes(where.contains)),
      example: () => ({ ...taskExample, by: 'human', type: 'send_back' }),
      display: event => taskDisplay(event, [['by', event.by], ['type', event.type]]),
    }),
  signal: eventDefinition('signal', z.undefined().optional(),
    eventBase.extend({ kind: z.literal('signal'), count: positive, firstAt: date, lastAt: date, items: z.array(signalItem).max(20) }), {
      textKey: 'trigger.signal', source: 'signal', coalesce: true, candidates: 'retained',
      matches: () => true, example: () => ({}),
      written: (at, data) => ({ count: 1, firstAt: at, lastAt: at, items: [{ at, by: { kind: 'human' }, key: null, data }] }),
      display: event => {
        const value = event.items[0]?.data;
        const data = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const fields = Object.entries(data).map(([name, item]): [string, string] => [name, typeof item === 'string' ? item : JSON.stringify(item)]);
        const words = ['text', 'message', 'title', 'summary', 'name'].map(name => data[name]).find(item => typeof item === 'string');
        return { title: words ?? (fields[0] ? `${fields[0][0]}: ${fields[0][1]}` : null), fields };
      },
    }),
  'host.pressure': eventDefinition('host.pressure', pressureWhere,
    eventBase.extend({ kind: z.literal('host.pressure'), kinds: z.array(hostKindSchema).min(1),
      phase: z.enum(['entered', 'continuing']), episodeStartedAt: date }), {
      textKey: 'trigger.hostPressure', textFormat: 'pressure', source: 'host_pressure', candidates: 'retained',
      matches: (where, event) => event.kinds.some(kind => where.kinds.includes(kind)),
      example: at => ({ kinds: ['disk'], phase: 'entered', episodeStartedAt: at }),
      display: event => ({ title: event.kinds.join(' · '), fields: [['kinds', event.kinds.join(', ')], ['phase', event.phase]] }),
    }),
} as const;

export function automationEventSchemas<const Row extends { on: z.ZodObject; event: z.ZodObject }>(rows: readonly [Row, ...Row[]]) {
  return {
    on: z.discriminatedUnion('event', rows.map(row => row.on) as [Row['on'], ...Row['on'][]]),
    event: z.discriminatedUnion('kind', rows.map(row => row.event) as [Row['event'], ...Row['event'][]]),
  };
}
type AutomationEventRow = (typeof automationEvents)[keyof typeof automationEvents];
const eventSchemas = automationEventSchemas(Object.values(automationEvents) as [AutomationEventRow, ...AutomationEventRow[]]);
export const automationOnSchema = eventSchemas.on;
export const automationEventSchema = eventSchemas.event;
export type ProgramAutomationEvent = z.infer<typeof automationEventSchema>;
export type ProgramAutomationOn = z.infer<typeof automationOnSchema>;
export const automationEventKindSchema = z.enum(Object.keys(automationEvents) as (keyof typeof automationEvents)[]);
export type AutomationEventKind = z.infer<typeof automationEventKindSchema>;
export function automationEventSource(kind: unknown) {
  const result = automationEventKindSchema.safeParse(kind);
  return result.success ? automationEvents[result.data].source : undefined;
}
export const automationEventReferenceSchema = eventBase.pick({ ref: true, manual: true }).extend({ kind: automationEventKindSchema });

export function automationEventMatches(on: ProgramAutomationOn, event: ProgramAutomationEvent, evidence?: MatchEvidence): boolean {
  // The shared discriminator ties each event's shape to that row's where filter.
  return on.event === event.kind && automationEvents[on.event].matches(on.where as never, event as never, evidence);
}

export function automationEventDisplay(event: ProgramAutomationEvent): EventDisplay {
  return automationEvents[event.kind].display(event as never);
}

export function automationWrittenEvent(kind: AutomationEventKind, at: string, value: unknown) {
  const { written } = automationEvents[kind];
  const fields = written ? written(at, value)
    : value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { kind, ref: `written-${at}`, at, manual: true, ...fields };
}

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

type RecordedInput = Record<string, unknown>;
const recordInput = (input: RecordedInput) => ({ target: null, input });
const recordTaskInput = (input: RecordedInput) => ({ target: { task: input.task }, input });
const recordNamedInput = (name: unknown, input: RecordedInput) => ({ target: { name }, input });

export const automationOperations = {
  'tasks.get': {
    input: z.strictObject({ task: name }), output: sdkTask, phase: 'both', write: false, grant: 'project',
    record: recordTaskInput,
    description: 'Read one task and its recent records in this project.',
  },
  'tasks.list': {
    input: z.strictObject({ createdByThis: z.boolean().optional(), title: taskTitle.optional(),
      state: z.union([state, z.array(state).min(1)]).optional(), since: date.optional(), limit: positive.max(100).optional() }),
    output: z.strictObject({ tasks: z.array(taskHead) }), phase: 'both', write: false, grant: 'project',
    record: recordInput,
    description: 'Read recent tasks in this project, newest first. The default limit is 20.',
  },
  'ai.ask': {
    input: z.strictObject({ ai: name, prompt: bytes(4096), data: jsonBytes(16_384).optional(), schema: automationJson.optional() }),
    output: automationJson, phase: 'both', write: false, grant: 'ai',
    record: ({ ai }: RecordedInput) => recordNamedInput(ai, { ai }),
    description: 'Ask the declared AI once without tools. Supply a Zod schema for a validated JSON reply.',
  },
  fetch: {
    input: z.strictObject(destination), output: response, phase: 'both', write: false, grant: 'send',
    record: ({ to }: RecordedInput) => recordNamedInput(to, { to }),
    description: 'Read from a declared destination with an optional relative path.',
  },
  'tasks.create': {
    input: z.strictObject({ title: taskTitle, instruction: instruction.optional(), ai: name.optional(),
      request: z.boolean().optional(), awaitReview: z.boolean().optional(), urgent: z.boolean().optional(), data: jsonBytes(65_536).optional() })
      .refine(input => input.request === false || (input.ai !== undefined && !!input.instruction?.trim()),
        { path: ['instruction'], message: 'Provide a declared AI and an instruction when making a request' }),
    output: z.strictObject({ id: z.string(), ...previewFlag }), phase: 'run', write: true, grant: 'create',
    record: ({ data: _data, ...input }: RecordedInput) => recordInput(input),
    description: 'Create a task in this project. Set request: false to make a task without starting an AI.',
  },
  'tasks.comment': {
    input: z.strictObject({ task: name, title: taskTitle, description: bytes(16_384) }),
    output: z.strictObject({ at: date, ...previewFlag }), phase: 'run', write: true, grant: 'comment',
    record: recordTaskInput,
    description: 'Record a comment on the trigger task or a task created by this automation.',
  },
  send: {
    input: z.strictObject({ ...destination, method: z.enum(['POST', 'PUT', 'PATCH']).optional(), body: jsonBytes(65_536).optional() }),
    output: response, phase: 'run', write: true, grant: 'send',
    record: ({ to, method, body }: RecordedInput) => recordNamedInput(to, { to, method: method ?? 'POST', body: body ?? null }),
    description: 'Send JSON to a declared destination. Preview records the intended request.',
  },
  disable: {
    input: z.strictObject({}), output: z.strictObject(previewFlag), phase: 'run', write: true, grant: 'self',
    record: recordInput,
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
  event: automationEventReferenceSchema, ran: z.boolean(),
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
  event: automationEventReferenceSchema,
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
    awaitingEnable: true, everEnabled: true, nextAt: true, week: true, lastRun: true, attention: true }).extend({ latest: automationVersionSchema.pick({ facts: true, docs: true, review: true }) })),
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
  destination: z.strictObject({ under: project, name,
    url: text(AUTOMATION_DESTINATION_MAX_CHARS).optional(), header: text(AUTOMATION_DESTINATION_MAX_CHARS).optional(),
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
