/** Counts only the consented half-open interval. No content or user-defined agent name leaves here. */
import { release } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openControlDatabase } from '@alpacawork/db';
import { countBucket, dayRange, sizeBucket, dayReportSchema, telemetryEventKey, telemetryEventOf, TELEMETRY_FAILURES, TELEMETRY_MAX_COUNT,
  TELEMETRY_MAX_EVENTS, TELEMETRY_TIME_BUCKETS, type DayReport, type TelemetryAgent, type TelemetryEvent, type TelemetryOp,
  type TelemetryShape, type TelemetryTime } from '@alpacawork/contract/telemetry';
import { settingAdapter } from '@alpacawork/contract';
import { readAgentsSettings } from '../agents-settings.js';
import { thisRelease } from '../release/location.js';
import { readManifest } from '../release/package-closure.js';
import type { Consent } from './consent.js';
import type { DayMarks } from './marks.js';
export type Envelope = Pick<DayReport, 'schema' | 'id' | 'day' | 'version' | 'os' | 'arch' | 'node'>;
export function envelope(day: string, id: string): Envelope {
  const root = thisRelease();
  if (!root) throw new Error('Telemetry requires a release');
  const os = process.platform === 'darwin' ? 'darwin' : /microsoft/i.test(release()) ? 'wsl' : 'linux';
  if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported telemetry platform');
  return { schema: 2, id, day, version: readManifest(root).version, os,
    arch: process.arch as 'x64' | 'arm64', node: Number(process.versions.node.split('.')[0]) };
}
/** A Run's profile as the built-in agent it runs on, by the current settings; any other name is `other`. */
export type AgentOf = (profile: string) => TelemetryAgent;
export function agentOfSettings(root: string): AgentOf {
  const settings = readAgentsSettings(root);
  return profile => settings.ok && settings.config.agents[profile] ? settingAdapter(profile, settings.config.agents[profile]!) ?? 'other' : 'other';
}
/**
 * Each size is one number from the DB as it is now; titles, bodies and names are never read. Only what the screen
 * shows counts: archiving marks the project alone, so the live tree is walked down from live root projects.
 */
const LIVE = `WITH RECURSIVE live(id,ext,kind,state,parent,up,depth) AS (
  SELECT id,external_id,kind,base_state,parent_id,NULL,0 FROM tasks WHERE kind='project' AND parent_id IS NULL AND lifecycle='active'
  UNION ALL SELECT t.id,t.external_id,t.kind,t.base_state,t.parent_id,l.kind,CASE WHEN t.kind='task' THEN l.depth+1 ELSE 0 END
  FROM tasks t JOIN live l ON t.parent_id=l.id WHERE t.lifecycle='active')`;
const widest = (up: 'project' | 'task') => `${LIVE} SELECT coalesce(max(c),0) n FROM (SELECT count(*) c FROM live WHERE kind='task' AND up='${up}' GROUP BY parent)`;
const SHAPE_SQL: Record<Exclude<TelemetryShape, 'parallel'>, string> = {
  projects: `${LIVE} SELECT count(*) n FROM live WHERE kind='project'`,
  tasks: `${LIVE} SELECT count(*) n FROM live WHERE kind='task'`,
  open: `${LIVE} SELECT count(*) n FROM live WHERE kind='task' AND state NOT IN ('done','stopped')`,
  depth: `${LIVE} SELECT coalesce(max(depth),0) n FROM live`,
  children: widest('task'),
  top: widest('project'),
  turns: `${LIVE} SELECT coalesce(max(c),0) n FROM (SELECT count(*) c FROM runs r JOIN live l ON l.ext=r.task_id WHERE l.kind='task' GROUP BY r.task_id)`,
  talk: 'SELECT coalesce(max(c),0) n FROM (SELECT count(*) c FROM runs WHERE conversation_id IS NOT NULL GROUP BY conversation_id)',
};
/** The most Runs running at one moment within [from, until): a sweep over their starts and ends. */
function mostAtOnce(db: DatabaseSync, from: string, until: string): number {
  const rows = db.prepare(`SELECT json_extract(record,'$.started_at') s, json_extract(record,'$.ended_at') e FROM runs
    WHERE json_extract(record,'$.started_at') IS NOT NULL AND julianday(json_extract(record,'$.started_at'))<julianday(?)
    AND (json_extract(record,'$.ended_at') IS NULL OR julianday(json_extract(record,'$.ended_at'))>julianday(?))`).all(until, from);
  const edges = rows.flatMap(row => [[Math.max(Date.parse(String(row.s)), Date.parse(from)), 1],
    ...row.e === null ? [] : [[Date.parse(String(row.e)), -1]]]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  let running = 0, most = 0;
  for (const [, step] of edges) most = Math.max(most, running += step!);
  return most;
}
/** The typical (median) and the slowest bucket of one measured time's counts. */
function typicalAndSlowest(counts: number[]): [string, string] | null {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return null;
  let seen = 0;
  const median = counts.findIndex(n => (seen += n) * 2 >= total), slowest = counts.length - 1 - [...counts].reverse().findIndex(n => n > 0);
  return [TELEMETRY_TIME_BUCKETS[median]!, TELEMETRY_TIME_BUCKETS[slowest]!];
}
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/**
 * The day's events in one bounded list: counts capped at TELEMETRY_MAX_COUNT, and on a day with more combinations than
 * a report carries, the most frequent ones. Ordered by name, so the same day reads the same.
 */
export function boundedEvents(counts: Record<string, number>): TelemetryEvent[] {
  return Object.entries(counts).filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, TELEMETRY_MAX_EVENTS)
    .sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, n]) => telemetryEventOf(key, Math.min(n, TELEMETRY_MAX_COUNT)));
}
/**
 * One UTC day's report, or null when nothing was used that day. Only the part of the day counted: after consent, and
 * after `from` (the last delete of what was sent).
 */
export function buildDayReport(input: { db: DatabaseSync; consent: Consent; day: string; marks: DayMarks; envelope: Envelope; agentOf: AgentOf; from?: number }): DayReport | null {
  const { db, consent, day, marks } = input;
  if (consent.choice !== 'on' || !consent.id) return null;
  const range = dayRange(day), since = Math.max(range.start, Date.parse(consent.decidedAt), input.from ?? 0);
  if (since >= range.end) return null;
  const from = new Date(since).toISOString(), until = new Date(range.end).toISOString();
  const runs = db.prepare(`SELECT json_extract(record,'$.agent') agent, state, json_extract(record,'$.reason') reason,
    json_extract(record,'$.launch.values.effort') effort FROM runs WHERE julianday(json_extract(record,'$.created_at'))>=julianday(?)
    AND julianday(json_extract(record,'$.created_at'))<julianday(?)`).all(from, until);
  const own = marks.since === consent.decidedAt ? marks : null;
  const counts: Record<string, number> = { ...own?.events };
  // The effort chosen for each Run created that day, under the agent it runs on.
  for (const { agent, effort } of runs) if (typeof effort === 'string') {
    const key = telemetryEventKey(`effort.${EFFORTS.has(effort) ? effort : 'other'}` as TelemetryOp, { via: `run.${input.agentOf(String(agent))}` });
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const events = boundedEvents(counts);
  if (!events.length && !runs.length && !own?.active) return null;
  const failures: DayReport['failures'] = {};
  for (const reason of TELEMETRY_FAILURES) {
    const count = runs.filter(row => ['failed', 'needs_review'].includes(String(row.state)) && row.reason === reason).length;
    if (count) failures[reason] = countBucket(count) as Exclude<ReturnType<typeof countBucket>, '0'>;
  }
  const n = (sql: string) => Number(db.prepare(sql).get()!.n);
  const shape = { ...Object.fromEntries(Object.entries(SHAPE_SQL).map(([name, sql]) => [name, sizeBucket(n(sql))])),
    parallel: sizeBucket(mostAtOnce(db, from, until)) } as DayReport['shape'];
  const times: DayReport['times'] = {};
  for (const [time, timeCounts] of Object.entries(own?.times ?? {}) as [TelemetryTime, number[]][]) {
    const pair = typicalAndSlowest(timeCounts);
    if (pair) times[time] = pair as NonNullable<DayReport['times'][TelemetryTime]>;
  }
  return dayReportSchema.parse({ ...input.envelope, events, failures, shape, times,
    agents: [...new Set(runs.map(row => input.agentOf(String(row.agent))))] });
}
export function reportFromWorkspace(root: string, consent: Consent, day: string, marks: DayMarks, makeEnvelope = envelope, from?: number): DayReport | null {
  if (!consent.id) return null;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, true);
  try { return buildDayReport({ db, consent, day, marks, envelope: makeEnvelope(day, consent.id), agentOf: agentOfSettings(root), from }); }
  finally { db.close(); }
}
/** The agent a placement's Run runs on, for a server write's way (`run.<agent>`). */
export function placementAgent(root: string, placementId: string): TelemetryAgent {
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, true);
  try {
    const row = db.prepare('SELECT profile_key FROM placements WHERE id=?').get(placementId);
    return row ? agentOfSettings(root)(String(row.profile_key)) : 'other';
  } finally { db.close(); }
}
