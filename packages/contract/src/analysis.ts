import { z } from 'zod';
import { projectIdSchema, taskIdSchema } from './fields.js';
import { validTimeZone } from './personal-settings.js';
import { FIX_KINDS, INSTRUCTION_KINDS } from '@alpacawork/raw/task-log-schema';

export const analysisDaySchema = z.iso.date();
export const analysisPeriodSchema = z.enum(['today', '7d', '28d', 'all']);
export const analysisBucketSchema = z.enum(['day', 'week', 'month']);
export const analysisTaskBySchema = z.enum(['model', 'agent', 'project']);
const analysisTallyBySchema = z.enum(['skill', 'tool', 'mcp']);
export const analysisUsageBySchema = z.enum([...analysisTaskBySchema.options, ...analysisTallyBySchema.options]);
export type AnalysisTallyBy = z.infer<typeof analysisTallyBySchema>;
export const isAnalysisTallyBy = (by: AnalysisUsageBy | undefined): by is AnalysisTallyBy =>
  analysisTallyBySchema.options.some(option => option === by);
export const analysisSetSchema = z.enum(['passed', 'reworked', 'stopped', 'doneUnaccepted', 'accepted', 'finished', 'unfinished', 'used']);
export const analysisTaskValues = ['lead', 'submits', 'questions', 'prs', 'you', 'ai', 'other'] as const;
export const analysisUsageValues = ['launches', 'runMs', 'newConversations', 'tokens', 'output', 'input', 'cache', 'calls'] as const;
export const analysisValueSchema = z.enum([...analysisTaskValues, ...analysisUsageValues]);

const scope = {
  project: projectIdSchema.optional(),
  timeZone: z.string().refine(validTimeZone, 'Expected an IANA time zone').optional(),
};
const dates = z.strictObject({
  period: analysisPeriodSchema.optional(), end: analysisDaySchema.optional(),
  from: analysisDaySchema.optional(), to: analysisDaySchema.optional(),
});
function validateDates(input: z.infer<typeof dates>, ctx: z.RefinementCtx) {
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (input.period ? input.from || input.to : !input.from || !input.to)
    issue('period', 'Choose a period or both from and to dates');
  if (!input.period && input.end) issue('end', 'End requires a period');
  if (input.from && input.to && input.from > input.to) issue('to', 'To must be on or after from');
}
export const analysisTasksInput = z.strictObject({
  ...scope, ...dates.shape, bucket: analysisBucketSchema, by: analysisTaskBySchema.optional(),
}).superRefine(validateDates);
export const analysisUsageInput = z.strictObject({
  ...scope, ...dates.shape, bucket: analysisBucketSchema, by: analysisUsageBySchema.optional(),
}).superRefine(validateDates);
/** One look's breakdown alone, for a reader that already holds that look's numbers and charts (the screen). */
export const analysisBreakdownInput = z.strictObject({
  ...scope, ...dates.shape, bucket: analysisBucketSchema, look: z.enum(['tasks', 'usage']), by: analysisUsageBySchema,
}).superRefine(validateDates).superRefine((input, ctx) => {
  if (input.look === 'tasks' && !analysisTaskBySchema.safeParse(input.by).success)
    ctx.addIssue({ code: 'custom', path: ['by'], message: 'This breakdown applies to AI usage' });
});
export const analysisListInput = z.strictObject({
  ...scope, ...dates.shape,
  set: analysisSetSchema, by: analysisUsageBySchema.optional(), key: z.string().min(1).max(512).optional(),
  value: analysisValueSchema.optional(), cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).superRefine(validateDates).superRefine((input, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (!input.by && input.key) issue('key', 'A key requires a breakdown');
  if (input.by && !input.key && !isAnalysisTallyBy(input.by))
    issue('key', 'Model, agent and project breakdowns require a row key');
  if (input.set !== 'used' && input.by && !analysisTaskBySchema.safeParse(input.by).success)
    issue('by', 'This breakdown applies to AI usage');
  if (input.value && !(input.set === 'used' ? analysisUsageValues : analysisTaskValues).some(value => value === input.value))
    issue('value', 'Choose a value for this set');
  if (input.value === 'calls' && input.by !== 'tool' && input.by !== 'mcp') issue('value', 'Calls require a tool or MCP breakdown');
});
export const analysisTaskInput = z.strictObject({ ...scope, task: taskIdSchema });

const count = z.number().int().nonnegative();
const measurement = z.number().nonnegative();
const share = z.number().min(0).max(1).nullable();
const days = z.strictObject({ from: analysisDaySchema, to: analysisDaySchema });
export const analysisHeadSchema = z.strictObject({
  timeZone: z.string(), today: analysisDaySchema, firstDay: analysisDaySchema.nullable(), project: projectIdSchema.nullable(),
  period: days.nullable(), previous: days.nullable(),
});
const pair = <T extends z.ZodType>(value: T) => z.strictObject({ value, previous: value.nullable() });
const point = days.extend({ complete: z.boolean() });
const series = <T extends z.ZodType>(point: T) => z.strictObject({
  bucket: analysisBucketSchema,
  points: z.array(point),
});
const model = z.strictObject({ name: z.string(), effort: z.string().nullable() });
const group = { key: z.string(), label: z.string() };
const breakdownRow = { ...group, model: model.optional() };
const times = z.strictObject({ review: count, answer: count, ai: count, other: count });
const tallied = z.strictObject({ runs: count, of: count, since: analysisDaySchema });
const tallyTool = z.strictObject({ name: z.string(), calls: count });
const counted = z.strictObject({ calls: count, launches: count });

/** `doneUnaccepted`: done by its owner without the user's acceptance; not among the finished (accepted or stopped). */
export const analysisTaskCountsSchema = z.strictObject({
  passed: count, reworked: count, stopped: count, doneUnaccepted: count, accepted: count, finished: count, share,
});
/**
 * The time the user was waited on (time.review and time.answer, the `--value you` of a list), by where the user was:
 * treated as away, on other tasks, or free for this one.
 */
const waits = z.strictObject({ away: count, otherTasks: count, thisTask: count });
/**
 * The answered items of the user's questions, by how each was answered (the kinds of the answer's recorded parts):
 * one of its choices (`choice`; `recommended`, the recommended one), none of them with words of the user's own
 * (`other`), stop the task (`stop`), or no choice named (`unmatched`). `recommendable`: items whose asker recommended
 * one of the choices. Answered questions with no parts recorded are counted apart (`answersWithoutParts`).
 */
const answerItems = z.strictObject({ total: count, choice: count, recommended: count, recommendable: count,
  other: count, stop: count, unmatched: count });
/**
 * The user's instructions and send-backs after the request, by what their senders said each was (`kinds`; `unlabeled`, those sent
 * with no label) and, for the fixes, what kind of fix (`fixes`, an instruction may name several).
 */
const instructions = z.strictObject({
  total: count, unlabeled: count,
  kinds: z.array(z.strictObject({ kind: z.enum(INSTRUCTION_KINDS), count })),
  fixes: z.array(z.strictObject({ kind: z.enum(FIX_KINDS as [typeof FIX_KINDS[number], ...typeof FIX_KINDS]), count })),
});
const clues = {
  waits, answerItems, answersWithoutParts: count, instructions,
  /** Questions to the user withdrawn by an instruction that came in place of an answer. */
  questionsReplaced: count,
};
export const analysisAcceptedTotalsSchema = z.strictObject({
  leadMedianMs: measurement.nullable(), submits: count, questions: count, prs: count, time: times, ...clues,
  /**
   * Accepted tasks with no question to the user besides those asking to take a result (`noQuestions`), and of those,
   * the ones accepted without rework (`passedNoQuestions`).
   */
  noQuestions: count, passedNoQuestions: count,
  /** Accepted tasks whose count of review rounds rests on reading a question's words (asked before its kind was recorded). */
  submitsEstimated: count,
});
const taskTotals = { counts: analysisTaskCountsSchema, accepted: analysisAcceptedTotalsSchema };
const tasksBreakdown = z.strictObject({
  by: analysisTaskBySchema,
  rows: z.array(z.strictObject({ ...breakdownRow, noOwnerRun: z.literal(true).optional(), finished: count, accepted: count, passed: count, share,
    leadMedianMs: measurement.nullable(), submitsPerAccepted: measurement.nullable() })),
});
export const analysisTasksViewSchema = z.strictObject({
  head: analysisHeadSchema, counts: pair(analysisTaskCountsSchema), accepted: pair(analysisAcceptedTotalsSchema),
  ever: z.strictObject(taskTotals).nullable(),
  series: series(point.extend(taskTotals)), grass: z.strictObject({ from: analysisDaySchema, finished: z.array(count) }),
  breakdown: tasksBreakdown.nullable(),
  /**
   * As of the read, whatever the period: the requested tasks open now (with no acceptance, stop or owner's done yet, or
   * reopened after one, counted from that end), and the time they have waited for the user
   * so far (review and answer, as `time` counts them, a wait still open running to now) with where the user was.
   */
  unfinished: z.strictObject({ tasks: count, time: z.strictObject({ review: count, answer: count }), waits }),
});
export const analysisUsageCountsSchema = z.strictObject({
  launches: count, runMs: count, live: count, newConversations: count,
  tokens: z.strictObject({ output: count, input: count, cache: count }), tokensUnknown: count, tasks: count,
});
const usageBreakdown = z.strictObject({
  by: analysisUsageBySchema, since: analysisDaySchema.nullable(),
  counted: pair(counted).nullable(), series: z.array(counted.nullable()).nullable(),
  rows: z.array(z.strictObject({ ...breakdownRow, counts: analysisUsageCountsSchema, calls: count.nullable() })),
});
export const analysisUsageViewSchema = z.strictObject({
  head: analysisHeadSchema, counts: pair(analysisUsageCountsSchema), ever: analysisUsageCountsSchema.nullable(),
  series: series(point.extend({ counts: analysisUsageCountsSchema })),
  breakdown: usageBreakdown.nullable(),
});
/** `analysis breakdown`: the head (its days) and the one breakdown, as `analysis tasks` or `analysis usage` gives it. */
export const analysisBreakdownViewSchema = z.strictObject({
  head: analysisHeadSchema,
  breakdown: z.union([z.strictObject({ look: z.literal('tasks'), ...tasksBreakdown.shape }), z.strictObject({ look: z.literal('usage'), ...usageBreakdown.shape })]),
});

export const analysisListRowSchema = z.strictObject({
  id: taskIdSchema, title: z.string(), project: projectIdSchema, outcome: z.enum(['passed', 'reworked', 'stopped']).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** When its owner reported it done, for a task done without the user's acceptance (its outcome and finishedAt are null). */
  doneAt: z.iso.datetime({ offset: true }).optional(),
  value: measurement.nullable(),
});
export const analysisUnitListSchema = z.strictObject({
  head: analysisHeadSchema, total: count, rows: z.array(analysisListRowSchema), cursor: z.string().nullable(),
});
export const analysisUnitValuesSchema = z.strictObject({
  head: analysisHeadSchema, unit: analysisListRowSchema.extend({ requestedAt: z.iso.datetime({ offset: true }), asked: taskIdSchema }),
  band: z.array(z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
    kind: z.enum(['doing', 'yours', 'paused']) })),
  marks: z.array(z.strictObject({ at: z.iso.datetime({ offset: true }), kind: z.enum(['instruction', 'sendBack']) })),
  time: times, submits: count, questions: count,
  sendBacks: count, instructionsAtReview: count, instructionsAfterAccept: count, instructionsDuringWork: count,
  answers: count, workers: count, children: count, usage: analysisUsageCountsSchema, ...clues,
  /** Whether its count of review rounds rests on reading a question's words (asked before its kind was recorded). */
  submitsEstimated: z.boolean(),
  models: z.array(z.strictObject({ ...group, model, launches: count, runMs: count, output: count })),
  prs: z.array(z.string()), skills: z.array(z.string()), tools: z.array(tallyTool), tallied,
});

export type AnalysisDay = z.infer<typeof analysisDaySchema>;
export type AnalysisPeriod = z.infer<typeof analysisPeriodSchema>;
export type AnalysisBucket = z.infer<typeof analysisBucketSchema>;
export type AnalysisDays = z.infer<typeof days>;
export type AnalysisHead = z.infer<typeof analysisHeadSchema>;
export type AnalysisTaskBy = z.infer<typeof analysisTaskBySchema>;
export type AnalysisModel = z.infer<typeof model>;
export type AnalysisUsageBy = z.infer<typeof analysisUsageBySchema>;
export type AnalysisTasksInput = z.infer<typeof analysisTasksInput>;
export type AnalysisUsageInput = z.infer<typeof analysisUsageInput>;
export type AnalysisListInput = z.infer<typeof analysisListInput>;
export type AnalysisBreakdownInput = z.infer<typeof analysisBreakdownInput>;
export type AnalysisBreakdownView = z.infer<typeof analysisBreakdownViewSchema>;
export type AnalysisTaskInput = z.infer<typeof analysisTaskInput>;
export type AnalysisTaskCounts = z.infer<typeof analysisTaskCountsSchema>;
export type AnalysisAcceptedTotals = z.infer<typeof analysisAcceptedTotalsSchema>;
export type AnalysisUsageCounts = z.infer<typeof analysisUsageCountsSchema>;
export type AnalysisTasksView = z.infer<typeof analysisTasksViewSchema>;
export type AnalysisUsageView = z.infer<typeof analysisUsageViewSchema>;
export type AnalysisListRow = z.infer<typeof analysisListRowSchema>;
export type AnalysisUnitList = z.infer<typeof analysisUnitListSchema>;
export type AnalysisUnitValues = z.infer<typeof analysisUnitValuesSchema>;

/*
 * The timeline of one task (`analysis trace`), the findings read from it (`analysis findings`) and the situation at one
 * instant (`analysis at`). The screen draws its timeline from these same answers, so a person and an AI name the same
 * spans, findings and instants; `url` (a path relative to the screen) opens the same scene there.
 */
const instant = z.iso.datetime({ offset: true });
const runId = z.string().regex(/^R[1-9]\d*$/);
const taskOnly = taskIdSchema.refine(id => /^T[1-9]\d*$/.test(id), 'Expected a task ID (T<number>)');
/**
 * Which lanes, spans and marks a trace lists: `self` the task's own, `subtree` with every task under it. The breakdown,
 * the waits and the findings always read the whole subtree.
 */
export const analysisTraceScopeSchema = z.enum(['self', 'subtree']);
export const analysisSpanKinds = ['task-state', 'question', 'queued', 'run', 'thinking', 'step'] as const;
export const analysisMarkKinds = ['instruction', 'answer', 'question-withdrawn', 'report', 'assigned', 'moved', 'values-changed',
  'compacted', 'command-stopped', 'change'] as const;
/** Non-overlapping parts of the wall time, in the order an instant is given to the first that holds (they sum to `wall`). */
export const analysisBreakdownKeys = ['owner-working', 'member-working', 'child-working', 'held', 'waiting-answer', 'waiting-review',
  'queued', 'idle'] as const;
export const analysisFindingRules = ['long-wait', 'repeated-question', 'long-step', 'limit-hit', 'repeated-command', 'same-result',
  'fan-out', 'queue-wait', 'failed-run', 'rework', 'idle'] as const;
export type AnalysisFindingRule = typeof analysisFindingRules[number];
/**
 * What each rule finds, and what its finding's `at`, `durationMs` and `count` are: the one wording the command help and
 * the reference give.
 */
export const ANALYSIS_FINDING_RULE_MEANINGS: Readonly<Record<AnalysisFindingRule, string>> = {
  'long-wait': 'a question (to anyone) open while no AI of the task or under it ran; at: when it was asked, durationMs: that time',
  'repeated-question': 'one task asking about the same pull request (with its repository when a link names one), or with the same choices, ' +
    'again and again; at: the first, durationMs: the time they were open, count: how many',
  'long-step': 'a step this long, or 3 times the median of its fingerprint and at least 30 seconds (a sub-agent judged by its own steps); ' +
    'at: its start, durationMs: its length',
  'limit-hit': 'a command the Run\'s manager stopped at the command time limit; at: when it started, durationMs: the limit',
  'repeated-command': 'one command failing with the same output again and again in a row (edits between allowed); ' +
    'at: the first, durationMs: their time together, count: how many',
  'same-result': 'one read or command (not an edit) again with the same output and no edit between, without failing (a repeated ' +
    'task get or git status included); at: the first, durationMs: their time, count: how many',
  'fan-out': 'one fingerprint with differing arguments many times in one Run (one by one where one read could do); at: the first, ' +
    'durationMs: their time, count: how many',
  'queue-wait': 'a Run that waited this long before it started; at: when it was made, durationMs: the wait',
  'failed-run': 'a Run that failed or was stopped, with the Run that took its place; at: its start, durationMs: its length',
  rework: 'work done again by the counts\' rule (a send-back, an instruction at review or after acceptance, one in place of answering a ' +
    'question asking to take a result); at: the record, durationMs: until that task next waits for review or is done',
  idle: 'a stretch this long with nothing running, queued, asked or in review in the task or under it; at: its start, durationMs: its length',
};
/**
 * Why a Run has no step times: it started before they were kept (`before-step-times`), its agent's output names no steps
 * alpacawork reads (`provider-unsupported`), or its output has steps whose times were not kept (`missing-step-times`).
 */
export const analysisStepsMissingSchema = z.enum(['before-step-times', 'provider-unsupported', 'missing-step-times']);
export const ANALYSIS_STEPS_MISSING_MEANINGS: Readonly<Record<z.infer<typeof analysisStepsMissingSchema>, string>> = {
  'before-step-times': 'the Run started before step times were kept',
  'provider-unsupported': 'the Run\'s agent output names no steps alpacawork reads',
  'missing-step-times': 'the Run\'s output has steps whose times were not kept',
};

const timelineScope = { timeZone: scope.timeZone, task: taskOnly, scope: analysisTraceScopeSchema.optional() };
export const analysisTraceInput = z.strictObject({
  ...timelineScope, from: instant.optional(), to: instant.optional(),
  kinds: z.array(z.enum([...analysisSpanKinds, ...analysisMarkKinds])).min(1).optional(),
  lanes: z.array(z.string().min(1).max(256)).min(1).optional(),
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(500).optional(),
});
/** `rule=value`: minutes for a time, a count for a repeat. */
const thresholdText = z.string().regex(new RegExp(`^(${analysisFindingRules.join('|')})=\\d+(\\.\\d+)?$`), 'Expected rule=value');
export const analysisFindingsInput = z.strictObject({
  ...timelineScope, rules: z.array(z.enum(analysisFindingRules)).min(1).optional(),
  threshold: z.array(thresholdText).optional(), limit: z.number().int().min(1).max(100).optional(),
});
export const analysisAtInput = z.strictObject({ ...timelineScope, at: instant });

/**
 * A record a span, mark or finding stands on; each is read again by its own command (run get, run steps --step, task
 * get --question). A log record carries its first line (an instruction's words, or a record's title), as no command reads
 * one record by its ID.
 */
export const analysisEvidenceSchema = z.union([
  z.strictObject({ run: runId, step: count.optional() }),
  z.strictObject({ question: z.string(), task: taskIdSchema }),
  z.strictObject({ log: z.string(), task: taskIdSchema, firstLine: z.string().nullable() }),
]);
const timelineHead = z.strictObject({
  task: taskIdSchema, project: projectIdSchema, scope: analysisTraceScopeSchema, timeZone: z.string(), generatedAt: instant,
  /** The version of the records read: the same version and inputs give the same answer, and a cursor holds to one version. */
  version: z.string(),
});
const recipient = z.union([z.literal('user'), taskIdSchema]);
/** Who sent an instruction: the user (or the coordinator for them), the parent task, or the task's own owner (to a member, or going on after a return). */
const instructionBy = z.enum(['user', 'parent', 'owner']);
const instructionPurpose = z.enum(['instruction', 'send-back', 'return']);
export const analysisLaneSchema = z.strictObject({
  id: z.string(), kind: z.enum(['task', 'agent']), task: taskIdSchema, parent: z.string().nullable(),
  placement: z.string().nullable(), role: z.enum(['owner', 'member']).nullable(), agent: z.string().nullable(), label: z.string(),
});
const questionKindShape = { accept: z.boolean(), estimated: z.boolean() };
const spanBase = { id: z.string(), lane: z.string(), from: instant, to: instant.nullable() };
export const analysisSpanSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...spanBase, kind: z.literal('task-state'), task: taskIdSchema, state: z.string() }),
  z.strictObject({ ...spanBase, kind: z.literal('question'), task: taskIdSchema, question: z.string(), askedTo: recipient,
    ...questionKindShape, closed: z.enum(['answered', 'withdrawn', 'expired']).nullable() }),
  z.strictObject({ ...spanBase, kind: z.literal('queued'), run: runId, behind: runId.nullable() }),
  z.strictObject({ ...spanBase, kind: z.literal('run'), run: runId, state: z.string(), reason: z.string().nullable(),
    model: z.string().nullable(), effort: z.string().nullable(), steps: z.enum(['recorded', 'not-recorded']) }),
  z.strictObject({ ...spanBase, kind: z.literal('thinking'), run: runId }),
  z.strictObject({ ...spanBase, kind: z.literal('step'), run: runId, step: count, tool: z.string(), line: z.string(),
    state: z.string(), source: z.string().nullable(), inside: z.string().nullable(), subagentSteps: count }),
]);
const markBase = { id: z.string(), lane: z.string(), at: instant };
const changeSchema = z.strictObject({
  what: z.enum(['agent', 'model', 'effort', 'version', 'skill', 'instruction-file']), name: z.string().nullable(),
  from: z.string().nullable(), to: z.string().nullable(),
});
export const analysisMarkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...markBase, kind: z.literal('instruction'), task: taskIdSchema, request: z.string(), by: instructionBy,
    purpose: instructionPurpose, label: z.string().nullable(), answers: z.string().nullable(), firstLine: z.string().nullable() }),
  z.strictObject({ ...markBase, kind: z.literal('answer'), task: taskIdSchema, question: z.string(), by: recipient }),
  z.strictObject({ ...markBase, kind: z.literal('question-withdrawn'), task: taskIdSchema, question: z.string(), log: z.string() }),
  z.strictObject({ ...markBase, kind: z.literal('report'), task: taskIdSchema, log: z.string(), state: z.string().nullable(), title: z.string().nullable() }),
  z.strictObject({ ...markBase, kind: z.enum(['assigned', 'moved', 'values-changed']), task: taskIdSchema, log: z.string() }),
  z.strictObject({ ...markBase, kind: z.literal('compacted'), run: runId, beforeTokens: count.nullable(), afterTokens: count.nullable() }),
  z.strictObject({ ...markBase, kind: z.literal('command-stopped'), run: runId, seconds: count, signal: z.string() }),
  z.strictObject({ ...markBase, kind: z.literal('change'), run: runId, previous: runId, changes: z.array(changeSchema).min(1) }),
]);
export const analysisTraceViewSchema = z.strictObject({
  /** `settled`: the numbers no longer change with the time of the read (the task is done or stopped and no wait runs to now). */
  head: timelineHead.extend({ from: instant, to: instant, settled: z.boolean() }),
  coverage: z.strictObject({
    steps: z.strictObject({ known: z.array(runId),
      unknown: z.array(z.strictObject({ reason: analysisStepsMissingSchema, runs: z.array(runId).min(1) })) }),
    conditions: z.strictObject({ known: z.array(runId), unknown: z.array(runId) }),
    values: z.strictObject({ recordedFrom: instant.nullable() }),
  }),
  lanes: z.array(analysisLaneSchema), spans: z.array(analysisSpanSchema), marks: z.array(analysisMarkSchema),
  breakdown: z.strictObject({
    wall: count, categories: z.array(z.strictObject({ key: z.enum(analysisBreakdownKeys), ms: count })),
    answerTo: z.strictObject({ user: count, task: count }),
    aiBusyMs: count, aiWorkMs: count, toolMs: count.nullable(), thinkingMs: count.nullable(), stepWorkMs: count.nullable(),
  }),
  /**
   * The time the user was waited on and where the user was meanwhile: the same rule as `time.review` + `time.answer` and
   * `waits` of `analysis task` (an open question counts even while an AI works); for a top-level task, the same numbers.
   */
  time: z.strictObject({ review: count, answer: count }), waits,
  total: count, cursor: z.string().nullable(), url: z.string(),
});
const thresholdSchema = z.strictObject({ value: measurement, unit: z.enum(['minutes', 'count']) }).nullable();
export const analysisFindingSchema = z.strictObject({
  id: z.string(), rule: z.enum(analysisFindingRules), at: instant, durationMs: count, lane: z.string().nullable(),
  count: count.nullable(), threshold: thresholdSchema, source: z.enum(['recorded', 'inferred']),
  evidence: z.array(analysisEvidenceSchema).min(1), url: z.string(),
});
export const analysisFindingsViewSchema = z.strictObject({
  head: timelineHead.extend({ from: instant, to: instant }),
  rules: z.strictObject({
    set: z.literal('experimental'),
    used: z.array(z.strictObject({ rule: z.enum(analysisFindingRules), threshold: thresholdSchema })),
    /** A rule that reads step times, when no Run of the task has them. */
    skipped: z.array(z.strictObject({ rule: z.enum(analysisFindingRules), reason: z.literal('no-step-times') })),
  }),
  findings: z.array(analysisFindingSchema), total: count, url: z.string(),
});
const stepAt = z.strictObject({ step: count, tool: z.string(), line: z.string(), from: instant.nullable(), to: instant.nullable() });
export const analysisAtViewSchema = z.strictObject({
  head: timelineHead.extend({ at: instant }),
  tasks: z.array(z.strictObject({ task: taskIdSchema, title: z.string(), state: z.string() })),
  runs: z.array(z.strictObject({
    run: runId, task: taskIdSchema, role: z.enum(['owner', 'member']), agent: z.string(), model: z.string().nullable(),
    effort: z.string().nullable(), since: instant,
    request: z.strictObject({ id: z.string(), by: instructionBy, purpose: instructionPurpose, at: instant, firstLine: z.string() }).nullable(),
    steps: z.enum(['recorded', 'not-recorded']), current: z.array(stepAt), before: stepAt.nullable(), after: stepAt.nullable(),
  })),
  queued: z.array(z.strictObject({ run: runId, task: taskIdSchema, since: instant })),
  questions: z.array(z.strictObject({ question: z.string(), task: taskIdSchema, askedTo: recipient, since: instant, title: z.string().nullable(),
    /** Whether it asks to take a result as it is; `estimated` when read from its words (asked before its kind was recorded). */
    ...questionKindShape })),
  history: z.array(z.strictObject({ log: z.string(), task: taskIdSchema, kind: z.string(), at: instant, title: z.string().nullable() })),
  values: z.null(), valuesReason: z.literal('not-recorded'), url: z.string(),
});

/** `analysis changes`: when what Runs ran under changed, over the same scope and days as `analysis tasks`. */
export const analysisChangesInput = z.strictObject({
  ...scope, ...dates.shape, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional(),
}).superRefine(validateDates);
export const analysisChangesViewSchema = z.strictObject({
  head: analysisHeadSchema,
  /** The Runs of the period's days, and how many of them kept their conditions (a Run from before they were kept has none). */
  runs: z.strictObject({ launched: count, recorded: count }),
  changes: z.array(z.strictObject({ id: z.string(), at: instant, run: runId, task: taskIdSchema, agent: z.string(),
    changes: z.array(changeSchema).min(1) })),
  total: count, cursor: z.string().nullable(),
});
export type AnalysisChangesInput = z.infer<typeof analysisChangesInput>;
export type AnalysisChangesView = z.infer<typeof analysisChangesViewSchema>;
export type AnalysisTraceInput = z.infer<typeof analysisTraceInput>;
export type AnalysisFindingsInput = z.infer<typeof analysisFindingsInput>;
export type AnalysisAtInput = z.infer<typeof analysisAtInput>;
export type AnalysisTraceScope = z.infer<typeof analysisTraceScopeSchema>;
export type AnalysisStepsMissing = z.infer<typeof analysisStepsMissingSchema>;
export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;
export type AnalysisLane = z.infer<typeof analysisLaneSchema>;
export type AnalysisSpan = z.infer<typeof analysisSpanSchema>;
export type AnalysisMark = z.infer<typeof analysisMarkSchema>;
export type AnalysisChange = z.infer<typeof changeSchema>;
export type AnalysisTraceView = z.infer<typeof analysisTraceViewSchema>;
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>;
export type AnalysisFindingsView = z.infer<typeof analysisFindingsViewSchema>;
export type AnalysisAtView = z.infer<typeof analysisAtViewSchema>;
