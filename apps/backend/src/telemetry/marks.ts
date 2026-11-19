/** What only the running server sees: screen events, server writes, times and activity. Deltas stay in memory until a monitor pass. */
import { join } from 'node:path';
import { telemetryEventKey, timeBucketIndex, utcDay, TELEMETRY_NONE, TELEMETRY_TIME_BUCKETS, type TelemetryAttributeValues, type TelemetryOp,
  type TelemetryTime } from '@alpacawork/contract/telemetry';
import { readJson, writeJson, jsonFiles } from './files.js';
/** An event's attributes left out are `-`: the server sets only the way it came (`via`). */
export type Mark = { kind: 'activity' } | { kind: 'event'; op: TelemetryOp; attributes: Partial<TelemetryAttributeValues> }
  | { kind: 'time'; time: TelemetryTime; ms: number };
/**
 * One UTC day's marks. `events` counts by telemetryEventKey; `times`: per measured time, how many fell in each
 * TELEMETRY_TIME_BUCKETS bucket; `active`: a screen was used that day.
 */
export type DayMarks = { since: string; active: boolean; events: Record<string, number>; times: Partial<Record<TelemetryTime, number[]>> };
export const emptyMarks = (since: string): DayMarks => ({ since, active: false, events: {}, times: {} });
function merged(a: DayMarks, b: DayMarks): DayMarks {
  const events = { ...a.events };
  for (const [key, count] of Object.entries(b.events)) events[key] = (events[key] ?? 0) + count;
  const times = { ...a.times };
  for (const [time, counts] of Object.entries(b.times) as [TelemetryTime, number[]][])
    times[time] = TELEMETRY_TIME_BUCKETS.map((_, at) => (times[time]?.[at] ?? 0) + (counts[at] ?? 0));
  return { since: a.since, active: a.active || b.active, events, times };
}
export class TelemetryMarks {
  private pending = new Map<string, DayMarks>();
  constructor(private readonly state: string) {}
  clear(): void { this.pending.clear(); }
  mark(fact: Mark, now: number, since: string): void {
    const day = utcDay(now), previous = this.pending.get(day), marks = previous?.since === since ? previous : emptyMarks(since);
    if (fact.kind !== 'event' || (fact.attributes.device ?? TELEMETRY_NONE) !== TELEMETRY_NONE) marks.active = true;
    if (fact.kind === 'event') { const key = telemetryEventKey(fact.op, fact.attributes); marks.events[key] = (marks.events[key] ?? 0) + 1; }
    if (fact.kind === 'time') (marks.times[fact.time] ??= TELEMETRY_TIME_BUCKETS.map(() => 0))[timeBucketIndex(fact.ms)]!++;
    this.pending.set(day, marks);
  }
  flush(since: string): void {
    for (const [day, delta] of this.pending) {
      if (delta.since === since) writeJson(join(this.state, 'marks', `${day}.json`), merged(this.read(day, since), delta));
      this.pending.delete(day);
    }
  }
  snapshot(day: string, since: string): DayMarks {
    const stored = this.read(day, since), delta = this.pending.get(day);
    return delta?.since === since ? merged(stored, delta) : stored;
  }
  read(day: string, since: string): DayMarks {
    const marks = readJson(join(this.state, 'marks', `${day}.json`)) as DayMarks | null;
    return marks?.since === since && marks.events && marks.times ? marks : emptyMarks(since);
  }
  /** Each day's marks file; marks of an earlier format (a week's) are left out. */
  files(): string[] { return jsonFiles(join(this.state, 'marks')).filter(path => /\/\d{4}-\d{2}-\d{2}\.json$/u.test(path)); }
}
