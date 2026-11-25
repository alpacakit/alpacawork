import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { AnalysisBucket, AnalysisDays, AnalysisHead, AnalysisPeriod } from '@alpacawork/contract/analysis';

const DAY_MS = 86_400_000;
const periodLength = { today: 1, '7d': 7, '28d': 28 } as const;
export const dayKey = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (day: string, count: number) => dayKey(new Date(Date.parse(day) + count * DAY_MS));
export const monday = (day: string) => addDays(day, -((new Date(day).getUTCDay() + 6) % 7));
export const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * The local day of an instant in a zone. A zone's day turns only at a quarter hour (every offset in use is whole
 * quarters), so the day of each quarter hour whose start and end fall on one day is kept and shared by every read: the
 * days of a long record are worked out once, not once per Run and read. Few zones are kept; the one least used goes.
 */
const QUARTER = 900_000;
const ZONES_KEPT = 8;
const zones = new Map<string, { format: (time: number) => string; days: Map<number, string> }>();
export function calendar(timeZone: string) {
  let zone = zones.get(timeZone);
  if (zone) zones.delete(timeZone);
  else {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    zone = { format: time => formatter.format(time), days: new Map() };
    if (zones.size >= ZONES_KEPT) zones.delete(zones.keys().next().value!);
  }
  zones.set(timeZone, zone);
  const { format, days } = zone;
  return (time: number) => {
    const quarter = Math.floor(time / QUARTER);
    const kept = days.get(quarter);
    if (kept !== undefined) return kept;
    const day = format(time);
    if (day === format(quarter * QUARTER) && day === format(quarter * QUARTER + QUARTER - 1)) days.set(quarter, day);
    return day;
  };
}

export function makeHead(project: string | null, timeZone: string, today: string, firstDay: string | null,
  input: { period?: AnalysisPeriod; end?: string; from?: string; to?: string }): AnalysisHead {
  const end = input.to ?? input.end ?? today;
  if (end > today || input.end && firstDay !== null && end < firstDay || input.period === 'all' && input.end && end !== today)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Choose an end day within the available history. All time ends today.');
  const empty = { timeZone, today, firstDay, project, period: null, previous: null };
  if (firstDay === null) return empty;
  let from = input.from;
  if (!from) {
    if (!input.period || input.period === 'all') return { ...empty, period: { from: firstDay, to: today } };
    from = addDays(end, 1 - periodLength[input.period]);
  }
  const size = (Date.parse(end) - Date.parse(from)) / DAY_MS + 1;
  const before = addDays(from, -size);
  return { ...empty, period: { from, to: end }, previous: before < firstDay ? null : { from: before, to: addDays(from, -1) } };
}

export const inDays = (day: string, range: AnalysisDays | null) => range !== null && range.from <= day && day <= range.to;

const mondays = new Map<string, string>();
export function bucketStart(day: string, bucket: AnalysisBucket): string {
  if (bucket === 'day') return day;
  if (bucket === 'month') return day.slice(0, 7) + '-01';
  // Days are few and asked for again and again (each launch's): each Monday is worked out once.
  let start = mondays.get(day);
  if (start === undefined) mondays.set(day, start = monday(day));
  return start;
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
