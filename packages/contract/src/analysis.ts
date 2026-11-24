import { z } from 'zod';
import { projectIdSchema, taskIdSchema } from './fields.js';
import { validTimeZone } from './personal-settings.js';

export const analysisDaySchema = z.iso.date();
export const analysisPeriodSchema = z.enum(['today', '7d', '28d', 'all']);
export const analysisBucketSchema = z.enum(['day', 'week', 'month']);
export const analysisTaskBySchema = z.enum(['model', 'agent', 'project']);
export const analysisUsageBySchema = z.enum(['model', 'agent', 'project', 'skill', 'tool', 'mcp']);
export const analysisSetSchema = z.enum(['passed', 'reworked', 'stopped', 'accepted', 'finished', 'used']);
const taskValues = ['lead', 'submits', 'questions', 'prs', 'you', 'ai', 'other'] as const;
const usageValues = ['launches', 'runMs', 'newConversations', 'output', 'input', 'cache', 'calls'] as const;
export const analysisValueSchema = z.enum([...taskValues, ...usageValues]);

const scope = {
  project: projectIdSchema.optional(),
  timeZone: z.string().refine(validTimeZone, 'Expected an IANA time zone').optional(),
};
const period = { period: analysisPeriodSchema, end: analysisDaySchema.optional() };
export const analysisTasksInput = z.strictObject({ ...scope, ...period, bucket: analysisBucketSchema, by: analysisTaskBySchema.optional() });
export const analysisUsageInput = z.strictObject({ ...scope, ...period, bucket: analysisBucketSchema, by: analysisUsageBySchema.optional() });
export const analysisListInput = z.strictObject({
  ...scope, period: period.period.optional(), end: period.end,
  from: analysisDaySchema.optional(), to: analysisDaySchema.optional(),
  set: analysisSetSchema, by: analysisUsageBySchema.optional(), key: z.string().min(1).max(512).optional(),
  value: analysisValueSchema.optional(), cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).superRefine((input, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (input.period && (input.from || input.to) || !input.period && (!input.from || !input.to))
    issue('period', 'Choose a period or both from and to dates');
  if (!input.period && input.end) issue('end', 'End requires a period');
  if (input.from && input.to && input.from > input.to) issue('to', 'To must be on or after from');
  if (!!input.by !== !!input.key) issue('key', 'A breakdown needs both by and key');
  if (input.set !== 'used' && input.by && !analysisTaskBySchema.safeParse(input.by).success)
    issue('by', 'This breakdown applies to AI usage');
  if (input.value && !(input.set === 'used' ? usageValues : taskValues).some(value => value === input.value))
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
const series = <T extends z.ZodType>(counts: T) => z.strictObject({
  bucket: analysisBucketSchema,
  points: z.array(days.extend({ complete: z.boolean(), counts })),
});
const group = { key: z.string(), label: z.string() };
const times = z.strictObject({ review: count, answer: count, ai: count, other: count });
const tallied = z.strictObject({ runs: count, of: count });
const tallyTool = z.strictObject({ name: z.string(), calls: count });

export const analysisTaskCountsSchema = z.strictObject({
  passed: count, reworked: count, stopped: count, accepted: count, finished: count, share,
});
export const analysisAcceptedTotalsSchema = z.strictObject({
  leadMedianMs: measurement.nullable(), submits: count, questions: count, prs: count, time: times,
});
export const analysisTasksViewSchema = z.strictObject({
  head: analysisHeadSchema, counts: pair(analysisTaskCountsSchema), accepted: pair(analysisAcceptedTotalsSchema),
  series: series(analysisTaskCountsSchema), grass: z.strictObject({ from: analysisDaySchema, finished: z.array(count) }),
  breakdown: z.strictObject({
    by: analysisTaskBySchema,
    rows: z.array(z.strictObject({ ...group, finished: count, accepted: count, passed: count, share,
      leadMedianMs: measurement.nullable(), submitsPerAccepted: measurement.nullable() })),
  }).nullable(),
});
export const analysisUsageCountsSchema = z.strictObject({
  launches: count, runMs: count, live: count, newConversations: count,
  tokens: z.strictObject({ output: count, input: count, cache: count }), tokensUnknown: count, tasks: count,
});
export const analysisUsageViewSchema = z.strictObject({
  head: analysisHeadSchema, counts: pair(analysisUsageCountsSchema), series: series(analysisUsageCountsSchema),
  breakdown: z.strictObject({
    by: analysisUsageBySchema, tallied: tallied.nullable(),
    rows: z.array(z.strictObject({ ...group, counts: analysisUsageCountsSchema, calls: count.nullable() })),
  }).nullable(),
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
  time: times, submits: count, questions: count, usage: analysisUsageCountsSchema,
  models: z.array(z.strictObject({ label: z.string(), launches: count, runMs: count, output: count })),
  prs: z.array(z.string()), skills: z.array(z.string()), tools: z.array(tallyTool), tallied,
});

export type AnalysisDay = z.infer<typeof analysisDaySchema>;
export type AnalysisPeriod = z.infer<typeof analysisPeriodSchema>;
export type AnalysisBucket = z.infer<typeof analysisBucketSchema>;
export type AnalysisDays = z.infer<typeof days>;
export type AnalysisHead = z.infer<typeof analysisHeadSchema>;
export type AnalysisTaskBy = z.infer<typeof analysisTaskBySchema>;
export type AnalysisUsageBy = z.infer<typeof analysisUsageBySchema>;
export type AnalysisTasksInput = z.infer<typeof analysisTasksInput>;
export type AnalysisUsageInput = z.infer<typeof analysisUsageInput>;
export type AnalysisListInput = z.infer<typeof analysisListInput>;
export type AnalysisTaskInput = z.infer<typeof analysisTaskInput>;
export type AnalysisTaskCounts = z.infer<typeof analysisTaskCountsSchema>;
export type AnalysisAcceptedTotals = z.infer<typeof analysisAcceptedTotalsSchema>;
export type AnalysisUsageCounts = z.infer<typeof analysisUsageCountsSchema>;
export type AnalysisTasksView = z.infer<typeof analysisTasksViewSchema>;
export type AnalysisUsageView = z.infer<typeof analysisUsageViewSchema>;
export type AnalysisListRow = z.infer<typeof analysisListRowSchema>;
export type AnalysisUnitList = z.infer<typeof analysisUnitListSchema>;
export type AnalysisUnitValues = z.infer<typeof analysisUnitValuesSchema>;
