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
export const analysisSetSchema = z.enum(['passed', 'reworked', 'stopped', 'unaccepted', 'accepted', 'finished', 'used']);
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

/** `unaccepted`: done by its owner without the user's acceptance; not among the finished (accepted or stopped). */
export const analysisTaskCountsSchema = z.strictObject({
  passed: count, reworked: count, stopped: count, unaccepted: count, accepted: count, finished: count, share,
});
/** The time the user was waited on (time.review and time.answer), by where the user was: away, on other tasks, or free for this one. */
const waits = z.strictObject({ away: count, otherTasks: count, thisTask: count });
/**
 * The answered items of the user's questions, by how each was answered (the answer's recorded parts): one of its
 * choices (and of those, the recommended one), or none of them; `unread`, answered questions with no parts recorded.
 */
const answerItems = z.strictObject({ total: count, choice: count, recommended: count, other: count, unread: count });
/**
 * The user's instructions after the request, by what their senders said each was (`kinds`; `unlabeled`, those sent
 * with no label) and, for the fixes, what kind of fix (`fixes`, an instruction may name several).
 */
const instructions = z.strictObject({
  total: count, unlabeled: count,
  kinds: z.array(z.strictObject({ kind: z.enum(INSTRUCTION_KINDS), count })),
  fixes: z.array(z.strictObject({ kind: z.enum(FIX_KINDS as [typeof FIX_KINDS[number], ...typeof FIX_KINDS]), count })),
});
const clues = {
  waits, answerItems, instructions,
  /** Questions to the user withdrawn by an instruction that came in place of an answer. */
  replaced: count,
};
export const analysisAcceptedTotalsSchema = z.strictObject({
  leadMedianMs: measurement.nullable(), submits: count, questions: count, prs: count, time: times, ...clues,
  /** Accepted without rework and without a question to the user. */
  passedUnasked: count,
  /** Accepted tasks whose review rounds were read from a question's words (asked before its kind was recorded). */
  estimated: count,
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
  finishedAt: z.iso.datetime({ offset: true }).nullable(), value: measurement.nullable(),
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
  /** Whether its review rounds were read from a question's words (asked before its kind was recorded). */
  estimated: z.boolean(),
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
