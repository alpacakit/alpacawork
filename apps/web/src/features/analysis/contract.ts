import { analysisTasksViewSchema, analysisUnitListSchema, analysisUnitValuesSchema, analysisUsageViewSchema,
  type AnalysisBucket, type AnalysisHead, type AnalysisListRow, type AnalysisTaskCounts, type AnalysisTasksView,
  type AnalysisUnitList, type AnalysisUnitValues, type AnalysisUsageCounts, type AnalysisUsageView } from "@alpacawork/contract/analysis";

/*
 * What the analysis commands answer (`analysis tasks`, `analysis usage`, `analysis list`, `analysis task`), as the
 * screen reads them. The screen writes these numbers as they come and never counts them again.
 */
export const tasksViewSchema = analysisTasksViewSchema;
export const usageViewSchema = analysisUsageViewSchema;
export const unitListSchema = analysisUnitListSchema;
export const unitValuesSchema = analysisUnitValuesSchema;
export type TasksView = AnalysisTasksView;
export type UsageView = AnalysisUsageView;
export type UnitList = AnalysisUnitList;
export type ListRow = AnalysisListRow;
export type UnitValues = AnalysisUnitValues;
export type TaskCounts = AnalysisTaskCounts;
export type UsageCounts = AnalysisUsageCounts;
export type Head = AnalysisHead;
export type Bucket = AnalysisBucket;

export const PERIODS = ["today", "7d", "28d", "all"] as const;
export type Period = typeof PERIODS[number];
export const TASK_GROUPS = ["model", "agent", "project"] as const;
export const USAGE_GROUPS = ["model", "agent", "skill", "tool", "mcp"] as const;
export type Group = typeof TASK_GROUPS[number] | typeof USAGE_GROUPS[number];
export const LIST_SETS = ["passed", "reworked", "stopped", "accepted", "finished", "used"] as const;
export type ListSet = typeof LIST_SETS[number];
export const TASK_VALUES = ["lead", "submits", "questions", "prs", "you", "ai", "other"] as const;
export const USAGE_VALUES = ["launches", "runMs", "newConversations", "tokens", "output", "input", "cache", "calls"] as const;
export type ListValue = typeof TASK_VALUES[number] | typeof USAGE_VALUES[number];
