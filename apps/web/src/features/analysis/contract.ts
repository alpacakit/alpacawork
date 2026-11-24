import { z } from "zod";

/*
 * What the analysis commands answer (`analysis tasks`, `analysis usage`, `analysis list`, `analysis task`), as the
 * screen reads them. The screen writes these numbers as they come and never counts them again.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const days = z.object({ from: day, to: day });
const head = z.object({
  timeZone: z.string(), today: day, firstDay: day.nullable(), project: z.string().nullable(),
  period: days.nullable(), previous: days.nullable(),
});
const pair = <T extends z.ZodTypeAny>(value: T) => z.object({ value, previous: value.nullable() });
const count = z.number().int().nonnegative();
const ms = z.number().nonnegative();

const taskCounts = z.object({ passed: count, reworked: count, stopped: count, accepted: count, finished: count,
  share: z.number().nullable() });
const time = z.object({ review: ms, answer: ms, ai: ms, other: ms });
const acceptedTotals = z.object({ leadMedianMs: ms.nullable(), submits: count, questions: count, prs: count, time });
const bucket = z.enum(["day", "week", "month"]);
const point = <T extends z.ZodTypeAny>(counts: T) => z.object({ from: day, to: day, complete: z.boolean(), counts });

export const tasksViewSchema = z.object({
  head, counts: pair(taskCounts), accepted: pair(acceptedTotals),
  series: z.object({ bucket, points: z.array(point(taskCounts)) }),
  grass: z.object({ from: day, finished: z.array(count) }),
  breakdown: z.object({ by: z.string(), rows: z.array(z.object({ key: z.string(), label: z.string(), finished: count,
    accepted: count, passed: count, share: z.number().nullable(), leadMedianMs: ms.nullable(),
    submitsPerAccepted: z.number().nullable() })) }).nullable(),
});

const usageCounts = z.object({ launches: count, runMs: ms, live: count, newConversations: count,
  tokens: z.object({ output: count, input: count, cache: count }), tokensUnknown: count, tasks: count });
const tallied = z.object({ runs: count, of: count });

export const usageViewSchema = z.object({
  head, counts: pair(usageCounts),
  series: z.object({ bucket, points: z.array(point(usageCounts)) }),
  breakdown: z.object({ by: z.string(), tallied: tallied.nullable(),
    rows: z.array(z.object({ key: z.string(), label: z.string(), counts: usageCounts, calls: count.nullable() })) }).nullable(),
});

const outcome = z.enum(["passed", "reworked", "stopped"]).nullable();
const listRow = z.object({ id: z.string(), title: z.string(), project: z.string(), outcome,
  finishedAt: z.string().nullable(), value: z.number().nullable() });
export const unitListSchema = z.object({ head, total: count, rows: z.array(listRow), cursor: z.string().nullable() });

export const unitValuesSchema = z.object({
  head, unit: listRow.extend({ requestedAt: z.string(), asked: z.string() }),
  band: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(["doing", "yours", "paused"]) })),
  marks: z.array(z.object({ at: z.string(), kind: z.enum(["instruction", "sendBack"]) })),
  time, submits: count, questions: count, usage: usageCounts,
  models: z.array(z.object({ label: z.string(), launches: count, runMs: ms, output: count })),
  prs: z.array(z.string()), skills: z.array(z.string()), tools: z.array(z.object({ name: z.string(), calls: count })),
  tallied,
});

export type TasksView = z.infer<typeof tasksViewSchema>;
export type UsageView = z.infer<typeof usageViewSchema>;
export type UnitList = z.infer<typeof unitListSchema>;
export type ListRow = UnitList["rows"][number];
export type UnitValues = z.infer<typeof unitValuesSchema>;
export type TaskCounts = z.infer<typeof taskCounts>;
export type UsageCounts = z.infer<typeof usageCounts>;
export type Head = z.infer<typeof head>;
export type Bucket = z.infer<typeof bucket>;

export const PERIODS = ["today", "7d", "28d", "all"] as const;
export type Period = typeof PERIODS[number];
export const TASK_GROUPS = ["model", "agent", "project"] as const;
export const USAGE_GROUPS = ["model", "agent", "skill", "tool", "mcp"] as const;
export type Group = typeof TASK_GROUPS[number] | typeof USAGE_GROUPS[number];
export const LIST_SETS = ["passed", "reworked", "stopped", "accepted", "finished", "used"] as const;
export type ListSet = typeof LIST_SETS[number];
export const TASK_VALUES = ["lead", "submits", "questions", "prs", "you", "ai", "other"] as const;
export const USAGE_VALUES = ["launches", "runMs", "newConversations", "output", "input", "cache", "calls"] as const;
export type ListValue = typeof TASK_VALUES[number] | typeof USAGE_VALUES[number];
