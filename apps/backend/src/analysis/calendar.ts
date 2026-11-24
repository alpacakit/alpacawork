import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { AnalysisBucket, AnalysisDays, AnalysisHead, AnalysisPeriod } from '@alpacawork/contract/analysis';

const DAY_MS = 86_400_000;
const periodLength = { today: 1, '7d': 7, '28d': 28 } as const;
export const dayKey = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (day: string, count: number) => dayKey(new Date(Date.parse(day) + count * DAY_MS));
export const monday = (day: string) => addDays(day, -((new Date(day).getUTCDay() + 6) % 7));
export const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function calendar(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (time: number) => formatter.format(time);
}

export function makeHead(project: string | null, timeZone: string, today: string, firstDay: string | null,
  input: { period?: AnalysisPeriod; end?: string; range?: AnalysisDays }): AnalysisHead {
  const end = input.range?.to ?? input.end ?? today;
  if (end > today || input.end && firstDay !== null && end < firstDay || input.period === 'all' && input.end && end !== today)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Choose an end day within the available history. All time ends today.');
  const empty = { timeZone, today, firstDay, project, period: null, previous: null };
  if (firstDay === null) return empty;
  if (input.range) return { ...empty, period: input.range };
  if (!input.period || input.period === 'all') return { ...empty, period: { from: firstDay, to: today } };
  const size = periodLength[input.period], from = addDays(end, 1 - size), before = addDays(from, -size);
  return { ...empty, period: { from, to: end }, previous: before < firstDay ? null : { from: before, to: addDays(from, -1) } };
}

export const inDays = (day: string, range: AnalysisDays | null) => range !== null && range.from <= day && day <= range.to;

export function bucketStart(day: string, bucket: AnalysisBucket): string {
  if (bucket === 'day') return day;
  return bucket === 'week' ? monday(day) : day.slice(0, 7) + '-01';
}

export function buckets(first: string | null, today: string, bucket: AnalysisBucket) {
  const result: (AnalysisDays & { complete: boolean })[] = [];
  if (!first) return result;
  for (let start = bucketStart(first, bucket); start <= today;) {
    const next = bucket === 'month' ? dayKey(new Date(Date.parse(start) + 32 * DAY_MS)).slice(0, 7) + '-01'
      : addDays(start, bucket === 'day' ? 1 : 7);
    const end = addDays(next, -1);
    result.push({ from: start < first ? first : start, to: end > today ? today : end, complete: first <= start && end <= today });
    start = next;
  }
  return result;
}
