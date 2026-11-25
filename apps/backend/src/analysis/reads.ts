import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { sumRunUsage } from '@alpacawork/contract';
import type { ChangeLog } from '@alpacawork/db';
import { isAnalysisTallyBy, type AnalysisAcceptedTotals, type AnalysisBucket, type AnalysisDays, type AnalysisHead,
  type AnalysisBreakdownInput, type AnalysisBreakdownView, type AnalysisListInput, type AnalysisListRow, type AnalysisModel, type AnalysisTallyBy, type AnalysisTaskInput, type AnalysisTaskBy,
  type AnalysisTaskCounts, type AnalysisTasksInput, type AnalysisTasksView, type AnalysisUnitList,
  type AnalysisUnitValues, type AnalysisUsageBy, type AnalysisUsageCounts, type AnalysisUsageInput, type AnalysisUsageView } from '@alpacawork/contract/analysis';
import { authorize, type Caller } from '../control/authorize.js';
import { ControlStore } from '@alpacawork/db';
import { Kept, Slices } from './slices.js';
import type { Tally } from '../agents/adapters/tally.js';
import { FactsCache, type AnalysisFacts, type FactLaunch, type Unit } from './facts.js';
import { addDays, bucketStart, buckets, calendar, inDays, makeHead, monday, serverZone } from './calendar.js';
import { clocks, emptyClock, shareOf, unitMarks, type ModelRun } from './rules.js';

type DatedUnit = { day: string; unit: Unit };
type CountedUnit = DatedUnit & { prCount: number };
/** A launch with its local day, its unit (`root`, and `slot`, the unit's number in its scope) and whether it began its conversation. */
type DatedLaunch = { day: string; root: string; slot: number; first: boolean; run: FactLaunch };
type TalliedLaunch = DatedLaunch & { tally: Tally };
const tallyFields = { skill: 'skills', tool: 'tools', mcp: 'mcp' } as const;
type DimensionValue = { key: string; label: string; model?: AnalysisModel };
type TaskDimensionValue = DimensionValue & { noOwnerRun?: true };
const group = <T, D extends DimensionValue>(items: Iterable<T>, keys: (item: T) => readonly D[]) => {
  const result = new Map<string, D & { items: T[] }>();
  for (const item of items) for (const dimension of keys(item)) {
    const found = result.get(dimension.key);
    if (found) found.items.push(item);
    else result.set(dimension.key, { ...dimension, items: [item] });
  }
  return result;
};
const single = (key: string, label = key) => [{ key, label }];
const compareKey = (a: { label: string; key: string }, b: { label: string; key: string }) =>
  a.label.localeCompare(b.label, 'en') || a.key.localeCompare(b.key, 'en');
const compareTask = (a: Unit, b: Unit) => Number(a.node.id.slice(1)) - Number(b.node.id.slice(1));

function taskCounts(units: readonly DatedUnit[]): AnalysisTaskCounts {
  let passed = 0, accepted = 0, stopped = 0;
  for (const { unit: { outcome } } of units) {
    if (outcome.passed) passed++;
    if (outcome.acceptedAt) accepted++;
    else if (outcome.stoppedAt) stopped++;
  }
  return { passed, reworked: accepted - passed, stopped, accepted, finished: accepted + stopped, share: shareOf(passed, accepted) };
}
function median(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const index = Math.floor(values.length / 2);
  return values.length % 2 ? values[index]! : (values[index - 1]! + values[index]!) / 2;
}
function creditAcceptedPrs(units: readonly DatedUnit[]): Map<Unit, number> {
  // Attribute a PR in the project scope before selecting dates or task groups.
  const first = new Map<string, { unit: Unit; acceptedAt: string }>();
  for (const { unit } of units) {
    const { acceptedAt } = unit.outcome;
    if (!acceptedAt) continue;
    for (const link of unit.prs) {
      const earlier = first.get(link);
      if (!earlier || acceptedAt < earlier.acceptedAt ||
        acceptedAt === earlier.acceptedAt && compareTask(unit, earlier.unit) < 0) {
        first.set(link, { unit, acceptedAt });
      }
    }
  }
  const counts = new Map<Unit, number>();
  for (const { unit } of first.values()) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  return counts;
}
function acceptedTotals(units: readonly CountedUnit[]): AnalysisAcceptedTotals {
  let submits = 0, questions = 0, prs = 0;
  const leads: number[] = [], time = emptyClock();
  for (const { unit, prCount } of units) {
    if (!unit.outcome.acceptedAt) continue;
    leads.push(unit.outcome.leadMs!);
    submits += unit.outcome.submits; questions += unit.questions;
    prs += prCount;
    const clock = unit.clock!.time;
    time.review += clock.review; time.answer += clock.answer; time.ai += clock.ai; time.other += clock.other;
  }
  return { leadMedianMs: median(leads), submits, questions, prs, time };
}
const taskTotals = (units: readonly CountedUnit[]) => ({ counts: taskCounts(units), accepted: acceptedTotals(units) });

/** Counts distinct units (by slot) again and again, each count in one pass, without a set per count. */
const seen = { marks: new Uint32Array(0), round: 0 };
function newCount() {
  if (++seen.round === 0xffffffff) { seen.marks.fill(0); seen.round = 1; }
}
function firstSeen(slot: number) {
  if (slot >= seen.marks.length) { const grown = new Uint32Array(Math.max(slot + 1, seen.marks.length * 2)); grown.set(seen.marks); seen.marks = grown; }
  if (seen.marks[slot] === seen.round) return false;
  seen.marks[slot] = seen.round;
  return true;
}
function distinctSlots(items: readonly DatedLaunch[]) {
  newCount();
  let count = 0;
  for (const { slot } of items) if (firstSeen(slot)) count++;
  return count;
}

function usageCounts(items: readonly DatedLaunch[], now: number): AnalysisUsageCounts {
  let newConversations = 0;
  for (const item of items) if (item.first) newConversations++;
  const { runs, runMs, tokens, tokensUnknown, live } = sumRunUsage(items.map(item => item.run), now);
  return { launches: runs, runMs, live, newConversations, tokensUnknown, tasks: distinctSlots(items),
    tokens: { output: tokens?.output ?? 0, input: tokens?.input ?? 0, cache: tokens ? tokens.cacheRead + tokens.cacheWrite : 0 } };
}

/**
 * A scope's launches summed day by day: the usage of any whole days is the sum of their days (by the one Run rule,
 * sumRunUsage), with the launches still running counted to now and each unit once. Made once per reading of the facts
 * (giving the loop back as it goes), so a span, the span before, the whole record and every bin of a chart each read
 * only their days; it also holds each day's launches, so a span's launches are read without going through the others.
 */
class DailyUsage {
  private readonly days: string[] = [];
  private readonly ended: { runs: number; runMs: number; tokensUnknown: number; newConversations: number;
    output: number; input: number; cache: number }[] = [];
  private readonly running: FactLaunch[][] = [];
  private readonly slots: Int32Array[] = [];
  private readonly items: DatedLaunch[][] = [];
  static async of(launches: readonly DatedLaunch[], slices: Slices) {
    const daily = new DailyUsage(), byDay = new Map<string, DatedLaunch[]>();
    for (const item of launches) {
      const found = byDay.get(item.day);
      if (found) found.push(item);
      else byDay.set(item.day, [item]);
      if (slices.due) await slices.pause();
    }
    for (const day of [...byDay.keys()].sort()) {
      const items = byDay.get(day)!, still = items.filter(({ run }) => !run.live);
      const { runs, runMs, tokens, tokensUnknown } = sumRunUsage(still.map(item => item.run), null);
      daily.days.push(day);
      daily.ended.push({ runs, runMs, tokensUnknown, newConversations: items.filter(item => item.first).length,
        output: tokens?.output ?? 0, input: tokens?.input ?? 0, cache: tokens ? tokens.cacheRead + tokens.cacheWrite : 0 });
      daily.running.push(items.filter(({ run }) => run.live).map(item => item.run));
      daily.slots.push(Int32Array.from(new Set(items.map(item => item.slot))));
      daily.items.push(items);
      if (slices.due) await slices.pause();
    }
    return daily;
  }

  private index(day: string) {
    let low = 0, high = this.days.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.days[mid]! < day) low = mid + 1; else high = mid; }
    return low;
  }

  /** The launches of the days (none for none). */
  within(range: AnalysisDays | null): DatedLaunch[] {
    const found: DatedLaunch[] = [];
    for (let at = range ? this.index(range.from) : 0; range && at < this.days.length && this.days[at]! <= range.to; at++)
      for (const item of this.items[at]!) found.push(item);
    return found;
  }

  count(range: AnalysisDays | null, now: number): AnalysisUsageCounts {
    let launches = 0, runMs = 0, live = 0, newConversations = 0, tokensUnknown = 0, output = 0, input = 0, cache = 0, tasks = 0;
    newCount();
    for (let at = range ? this.index(range.from) : 0; range && at < this.days.length && this.days[at]! <= range.to; at++) {
      const day = this.ended[at]!;
      launches += day.runs; runMs += day.runMs; tokensUnknown += day.tokensUnknown; newConversations += day.newConversations;
      output += day.output; input += day.input; cache += day.cache;
      if (this.running[at]!.length) {
        const running = sumRunUsage(this.running[at]!, now);
        launches += running.runs; runMs += running.runMs; live += running.live;
      }
      for (const slot of this.slots[at]!) if (firstSeen(slot)) tasks++;
    }
    return { launches, runMs, live, newConversations, tokensUnknown, tasks, tokens: { output, input, cache } };
  }
}

function tallyCalls(tally: Tally, by: Exclude<AnalysisTallyBy, 'skill'>, name?: string) {
  const counts = tally[tallyFields[by]];
  return name === undefined ? Object.values(counts).reduce((sum, count) => sum + count, 0) : counts[name] ?? 0;
}

function countedTotals(items: readonly TalliedLaunch[], by: AnalysisTallyBy) {
  let calls = 0, launches = 0;
  for (const { tally } of items) {
    if (Object.keys(tally[tallyFields[by]]).length) launches++;
    if (by !== 'skill') calls += tallyCalls(tally, by);
  }
  return { calls, launches };
}

const byBucket = <T extends { day: string }>(records: readonly T[], bucket: AnalysisBucket) =>
  group(records, record => single(bucketStart(record.day, bucket)));

function makeSeries<T extends { day: string }, C extends object>(bucket: AnalysisBucket, head: AnalysisHead,
  records: readonly T[], values: (items: T[]) => C) {
  const indexed = byBucket(records, bucket);
  const points = buckets(head.firstDay, head.today, bucket).map(point => ({ ...point,
    ...values(within(indexed.get(bucketStart(point.from, bucket))?.items ?? [], point)),
  }));
  return { bucket, points };
}
const within = <T extends { day: string }>(items: readonly T[], range: AnalysisDays | null) =>
  items.filter(({ day }) => inDays(day, range));

function row(unit: Unit, value: number | null): AnalysisListRow {
  return { id: unit.node.id, project: unit.node.project!, title: unit.node.title, outcome: unit.outcome.outcome,
    finishedAt: unit.outcome.finishedAt, value };
}

function matchingProject(facts: AnalysisFacts, project: string | null, ownProject: string | null) {
  if (project && (facts.nodes.get(project)?.kind !== 'project' || facts.nodes.get(project)?.lifecycle === 'deleted'))
    throw new Problem(PROBLEM_CODE.notFound, 'Project does not exist');
  return (id: string) => {
    if (ownProject !== null) return id === ownProject;
    for (let node = facts.nodes.get(id); node?.kind === 'project'; node = facts.nodes.get(node.parent ?? '')) {
      if (node.lifecycle === 'deleted') return false;
      if (node.id === project) return true;
    }
    return project === null;
  };
}


/**
 * What the reads keep between them, apart from the facts (kept once, FactsCache): for a few zones, every unit's and
 * launch's local day (`ZoneDays`, one per zone whatever the project); for a few scopes (a project in a zone), their
 * share of those days and their day sums (`ScopeView`, references and sums only, kept with their zone). The least used
 * goes past the bounds; all of it goes when the facts change. Each is made once, giving the loop back as it goes.
 */
const ZONES_KEPT = 3, SCOPES_KEPT = 4;
type ZoneDays = { units: { project: string; dated: DatedUnit | null; first: number }[]; launches: (DatedLaunch & { project: string })[] };
type ScopeView = { units: DatedUnit[]; launches: DatedLaunch[]; first: number; daily: DailyUsage;
  byDimension: Map<string, Promise<DimensionDays[]>> };
type DimensionDays = DimensionValue & { daily: DailyUsage };
/** A zone's days and, with them, its scopes' (a zone let go takes its scopes with it). */
type ZoneKept = { days: Promise<ZoneDays>; scopes: Kept<string, Promise<ScopeView>> };
const kept = { facts: undefined as AnalysisFacts | undefined, zones: new Kept<string, ZoneKept>(ZONES_KEPT) };
/** How many zones and scopes the analysis keeps now (they stay within their bounds however many are read). */
export const analysisKept = () => {
  let scopes = 0;
  for (const zone of kept.zones.values()) scopes += zone.scopes.count;
  return { zones: kept.zones.count, scopes };
};

async function zoneDays(facts: AnalysisFacts, date: (time: number) => string, slices: Slices): Promise<ZoneDays> {
  const zone: ZoneDays = { units: [], launches: [] };
  let slot = -1;
  for (const unit of facts.units.values()) {
    slot++;
    const project = unit.node.project!;
    let first = Infinity, dated: DatedUnit | null = null;
    if (unit.node.requested) {
      first = Date.parse(unit.outcome.requestedAt);
      if (unit.outcome.finishedAt) dated = { unit, day: date(Date.parse(unit.outcome.finishedAt)) };
    }
    for (const run of unit.launches) {
      first = Math.min(first, run.started);
      zone.launches.push({ root: unit.node.id, slot, first: facts.first.has(run.id), run, day: date(run.started), project });
    }
    zone.units.push({ project, dated, first });
    if (slices.due) await slices.pause();
  }
  return zone;
}

async function scopeView(zone: ZoneDays, allows: (project: string) => boolean, slices: Slices): Promise<ScopeView> {
  const allowed = new Map<string, boolean>(), inScope = (project: string) => {
    let found = allowed.get(project);
    if (found === undefined) allowed.set(project, found = allows(project));
    return found;
  };
  const view = { units: [] as DatedUnit[], launches: [] as DatedLaunch[], first: Infinity };
  for (const unit of zone.units) {
    if (!inScope(unit.project)) continue;
    view.first = Math.min(view.first, unit.first);
    if (unit.dated) view.units.push(unit.dated);
  }
  for (const launch of zone.launches) {
    if (inScope(launch.project)) view.launches.push(launch);
    if (slices.due) await slices.pause();
  }
  return { ...view, daily: await DailyUsage.of(view.launches, slices), byDimension: new Map() };
}

/** A model's key and label: one per name and effort however many launches name it. */
const modelKeys = new Kept<string, { key: string; label: string; model: AnalysisModel }>(256);
function modelKeyOf(name: string, effort: string | null) {
  const id = `${name}\u0000${effort ?? ''}`;
  let found = modelKeys.get(id);
  if (!found) {
    const label = effort === null ? name : `${name}(${effort})`;
    // Custom launch values can contain parentheses or exceed the list key length limit.
    const key = createHash('sha256').update(JSON.stringify([name, effort])).digest('base64url');
    modelKeys.set(id, found = { key, label, model: { name, effort } });
  }
  return found;
}

class ScopedAnalysis {
  readonly today: string;
  readonly firstDay: string | null;
  readonly datedUnits: readonly DatedUnit[];
  readonly datedLaunches: readonly DatedLaunch[];
  private readonly tallyDay: string;

  constructor(private readonly facts: AnalysisFacts, private readonly view: ScopeView, readonly project: string | null,
    private readonly allows: (project: string) => boolean, private readonly timeZone: string, readonly now: number,
    tallySince: number, private readonly tallies: ReadonlyMap<string, Tally>, readonly date: ReturnType<typeof calendar>) {
    this.today = date(now);
    this.tallyDay = date(tallySince);
    this.datedUnits = view.units;
    this.datedLaunches = view.launches;
    this.firstDay = Number.isFinite(view.first) ? date(Math.min(view.first, now)) : null;
  }

  head(input: Parameters<typeof makeHead>[4]) {
    return makeHead(this.project, this.timeZone, this.today, this.firstDay, input);
  }

  private taskKeys(unit: Unit, by: AnalysisTaskBy): TaskDimensionValue[] {
    if (by === 'project') return this.projectKey(unit);
    const run = unit.firstOwner;
    // The colon keeps this key distinct from agent names and hashed model keys.
    if (!run) return [{ key: 'owner:none', label: 'No owner Run', noOwnerRun: true }];
    return by === 'agent' ? single(run.agent) : [this.modelKey(run)];
  }

  private projectKey(unit: Unit) {
    const id = unit.node.project!;
    return single(id, this.facts.nodes.get(id)?.title ?? id);
  }

  private modelKey(run: ModelRun) {
    // Tallies can arrive after the Run facts have been cached.
    const model = this.tallies.get(run.id)?.model ?? run.model;
    return modelKeyOf(model ?? run.agent, model === null ? null : run.effort);
  }

  private usageKeys(item: DatedLaunch, by: AnalysisUsageBy): DimensionValue[] {
    const { run } = item;
    if (by === 'project') return this.projectKey(this.facts.units.get(item.root)!);
    if (by === 'agent') return single(run.agent);
    if (by === 'model') return [this.modelKey(run)];
    const tally = this.tallies.get(run.id);
    if (!tally) return [];
    const names = Object.keys(tally[tallyFields[by]]);
    return names.map(name => by === 'skill' ? { key: name, label: name }
      : { key: JSON.stringify([tally.provider, name]), label: `${name} · ${tally.provider}` });
  }

  private calls(run: FactLaunch, by: AnalysisUsageBy | undefined, key: string | undefined): number {
    const tally = this.tallies.get(run.id);
    if (!tally || by !== 'tool' && by !== 'mcp') return 0;
    const name = key === undefined ? undefined : (JSON.parse(key) as [string, string])[1];
    return tallyCalls(tally, by, name);
  }

  private collectedLaunches(items: readonly DatedLaunch[]): TalliedLaunch[] {
    return items.flatMap(item => {
      if (!item.run.tallyEligible) return [];
      const tally = this.tallies.get(item.run.id);
      return tally && tally.state !== 'unsupported' ? [{ ...item, tally }] : [];
    });
  }

  /**
   * The day sums of each row of a breakdown that gives a launch one row (model, agent, project): made once per scope
   * and kept with it, so a row's numbers for any days are read from its days.
   */
  async dimensionDays(by: 'model' | 'agent' | 'project', slices: Slices) {
    // A model row names the model a tally reports where the launch named none: kept per number of tallies (they only
    // grow), so a tally that arrives makes the rows again.
    const key = by === 'model' ? `model:${this.tallies.size}` : by;
    let found = this.view.byDimension.get(key);
    if (!found && by === 'model') for (const old of this.view.byDimension.keys()) if (old.startsWith('model:')) this.view.byDimension.delete(old);
    if (!found) this.view.byDimension.set(key, found = (async () => {
      const rows = new Map<string, DimensionValue & { items: DatedLaunch[] }>();
      for (const item of this.datedLaunches) {
        const dimension = this.usageKeys(item, by)[0]!, row = rows.get(dimension.key);
        if (row) row.items.push(item);
        else rows.set(dimension.key, { ...dimension, items: [item] });
        if (slices.due) await slices.pause();
      }
      const result: DimensionDays[] = [];
      for (const { items, ...dimension } of rows.values()) result.push({ ...dimension, daily: await DailyUsage.of(items, slices) });
      return result;
    })());
    return found;
  }

  private taskBreakdown(by: AnalysisTaskBy, current: readonly DatedUnit[]) {
    return { by, rows: [...group(current, ({ unit }) => this.taskKeys(unit, by)).values()].map(({ items, ...dimension }) => {
      const { finished, accepted, passed, share } = taskCounts(items), totals = acceptedTotals(items.map(item => ({ ...item, prCount: 0 })));
      return { ...dimension, finished, accepted, passed, share, leadMedianMs: totals.leadMedianMs,
        submitsPerAccepted: accepted ? totals.submits / accepted : null };
    }).sort((a, b) => b.finished - a.finished || compareKey(a, b)) };
  }

  tasks(input: AnalysisTasksInput): AnalysisTasksView {
    const head = this.head(input);
    const prCounts = creditAcceptedPrs(this.datedUnits);
    const units = this.datedUnits.map(item => ({ ...item, prCount: prCounts.get(item.unit) ?? 0 }));
    const current = within(units, head.period);
    const previous = head.previous && within(units, head.previous);
    const value = taskTotals(current), before = previous && taskTotals(previous);
    const lifetime = this.head({}).period;
    const ever = lifetime && (input.period === 'all' ? value : taskTotals(within(units, lifetime)));
    const series = makeSeries(input.bucket, head, units, taskTotals);
    const counts = new Map<string, number>();
    for (const { day } of this.datedUnits) counts.set(day, (counts.get(day) ?? 0) + 1);
    const from = monday(head.firstDay ?? head.today), finished: number[] = [];
    if (head.firstDay) for (let day = from; day <= head.today; day = addDays(day, 1)) finished.push(counts.get(day) ?? 0);
    return { head, counts: { value: value.counts, previous: before?.counts ?? null },
      accepted: { value: value.accepted, previous: before?.accepted ?? null }, ever, series, grass: { from, finished },
      breakdown: input.by ? this.taskBreakdown(input.by, current) : null };
  }

  usage(input: AnalysisUsageInput, rows?: DimensionDays[]): AnalysisUsageView {
    const head = this.head(input), daily = this.view.daily;
    const value = daily.count(head.period, this.now);
    const lifetime = this.head({}).period;
    const ever = lifetime && (input.period === 'all' ? value : daily.count(lifetime, this.now));
    const series = { bucket: input.bucket, points: buckets(head.firstDay, head.today, input.bucket)
      .map(point => ({ ...point, counts: daily.count(point, this.now) })) };
    return { head, counts: { value, previous: head.previous && daily.count(head.previous, this.now) }, ever, series,
      breakdown: input.by ? this.usageBreakdown(input.by, head, input.bucket, rows) : null };
  }

  /** One look's breakdown alone (`analysis breakdown`): the same rows `analysis tasks` and `analysis usage` give. */
  breakdown(input: AnalysisBreakdownInput, rows?: DimensionDays[]): AnalysisBreakdownView {
    const head = this.head(input);
    if (input.look === 'tasks') return { head, breakdown: { look: 'tasks', ...this.taskBreakdown(input.by as AnalysisTaskBy, within(this.datedUnits, head.period)) } };
    return { head, breakdown: { look: 'usage', ...this.usageBreakdown(input.by, head, input.bucket, rows) } };
  }

  private usageBreakdown(by: AnalysisUsageBy, head: AnalysisHead, bucket: AnalysisBucket, rows?: DimensionDays[]) {
    if (isAnalysisTallyBy(by)) return this.countedBreakdown(by, head, { bucket, points: buckets(head.firstDay, head.today, bucket) });
    return { by, since: null, counted: null, series: null,
      rows: rows ? this.rowsOfDays(rows, head) : this.usageGroups(this.view.daily.within(head.period), by) };
  }

  /** The rows of a breakdown from their kept day sums; a launch whose row a tally has moved since is counted again. */
  private rowsOfDays(rows: DimensionDays[], head: AnalysisHead) {
    return rows.map(({ daily, ...dimension }) => ({ ...dimension, counts: daily.count(head.period, this.now), calls: null }))
      .filter(row => row.counts.launches > 0)
      .sort((a, b) => b.counts.launches - a.counts.launches || compareKey(a, b));
  }

  private countedBreakdown(by: AnalysisTallyBy, head: AnalysisHead, chart: { bucket: AnalysisBucket; points: AnalysisDays[] }) {
    const launches = this.collectedLaunches(this.datedLaunches);
    if (!launches.length) return { by, since: null, counted: null, series: null, rows: [] };
    const since = this.tallyDay;
    const current = within(launches, head.period);
    const previous = head.previous && head.previous.from >= since ? within(launches, head.previous) : null;
    const indexed = byBucket(launches, chart.bucket);
    return { by, since, counted: { value: countedTotals(current, by), previous: previous && countedTotals(previous, by) },
      series: chart.points.map(point => point.to < since ? null :
        countedTotals(within(indexed.get(bucketStart(point.from, chart.bucket))?.items ?? [], point), by)),
      rows: this.usageGroups(current, by) };
  }

  private useCounts(items: readonly DatedLaunch[]) { return usageCounts(items, this.now); }

  private usageGroups(items: readonly DatedLaunch[], by: AnalysisUsageBy) {
    return [...group(items, item => this.usageKeys(item, by)).values()].map(({ items, ...dimension }) => ({
      ...dimension, counts: this.useCounts(items),
      calls: by === 'tool' || by === 'mcp' ? items.reduce((sum, { run }) => sum + this.calls(run, by, dimension.key), 0) : null,
    })).sort((a, b) => (b.calls ?? b.counts.launches) - (a.calls ?? a.counts.launches) || compareKey(a, b));
  }

  /** Each unit with launches in the days (and the row, when given) and its value: launches are gathered by unit once. */
  private async usageEntries(input: AnalysisListInput, head: AnalysisHead, slices: Slices): Promise<Entry[]> {
    const by = input.by, inDays = this.view.daily.within(head.period);
    const launches = isAnalysisTallyBy(by) ? this.collectedLaunches(inDays) : inDays;
    const byUnit = new Map<string, DatedLaunch[]>();
    for (const item of launches) {
      if (by && !this.usageKeys(item, by).some(({ key }) => input.key === undefined || key === input.key)) continue;
      const found = byUnit.get(item.root);
      if (found) found.push(item);
      else byUnit.set(item.root, [item]);
      if (slices.due) await slices.pause();
    }
    const entries: Entry[] = [];
    for (const [root, items] of byUnit) {
      entries.push(this.usageEntry(this.facts.units.get(root)!, items, input));
      if (slices.due) await slices.pause();
    }
    return entries;
  }

  private usageEntry(unit: Unit, items: readonly DatedLaunch[], input: AnalysisListInput): Entry {
    if (!input.value) return entry(unit, null);
    if (input.value === 'calls') return entry(unit, items.reduce((sum, { run }) => sum + this.calls(run, input.by, input.key), 0));
    const { runs, runMs, tokens } = sumRunUsage(items.map(item => item.run), this.now);
    const output = tokens?.output ?? 0, inputs = tokens?.input ?? 0, cache = tokens ? tokens.cacheRead + tokens.cacheWrite : 0;
    const values: Record<string, number> = { launches: runs, runMs, newConversations: items.filter(item => item.first).length,
      output, input: inputs, cache, tokens: output + inputs + cache };
    return entry(unit, values[input.value] ?? null);
  }

  private taskEntries(input: AnalysisListInput, head: AnalysisHead): Entry[] {
    const prCounts = input.value === 'prs' ? creditAcceptedPrs(this.datedUnits) : null;
    const units = within(this.datedUnits, head.period).map(item => item.unit).filter(unit =>
      (input.set === 'finished' || input.set === 'accepted' && unit.outcome.acceptedAt || unit.outcome.outcome === input.set)
      && (!input.by || this.taskKeys(unit, input.by as AnalysisTaskBy).some(group => group.key === input.key)));
    return units.map(unit => {
      if (!input.value) return entry(unit, null);
      const { review, answer, ai, other } = unit.clock?.time ?? emptyClock();
      const values: Record<string, number | null> = { lead: unit.outcome.leadMs, submits: unit.outcome.submits,
        questions: unit.questions, prs: prCounts?.get(unit) ?? 0, you: review + answer, ai, other };
      return entry(unit, values[input.value] ?? null);
    });
  }

  async list(input: AnalysisListInput, slices: Slices): Promise<AnalysisUnitList> {
    const head = this.head(input);
    const home = input.set === 'finished' && input.period === 'today' && !input.end && !input.by && !input.value;
    // The page's rows are written out after the order is known: only they become rows.
    const entries = (input.set === 'used' ? await this.usageEntries(input, head, slices) : this.taskEntries(input, head))
      .filter(item => !input.value || item.value !== null && (item.value > 0 || input.value === 'lead' || input.value === 'submits'));
    if (slices.due) await slices.pause();
    entries.sort((a, b) => ((b.value ?? 0) - (a.value ?? 0)) ||
      (home ? 1 : -1) * (a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0) || a.number - b.number);
    const selector = createHash('sha256').update(JSON.stringify([head.project, head.timeZone, head.period, input.set, input.by, input.key, input.value]))
      .digest('base64url').slice(0, 22);
    let offset = 0;
    if (input.cursor) {
      const match = /^([\w-]{22})\.(\d+)$/.exec(input.cursor);
      if (!match || match[1] !== selector || !Number.isSafeInteger(Number(match[2])))
        throw new Problem(PROBLEM_CODE.invalidInput, 'Use a cursor from the same analysis list');
      offset = Number(match[2]);
    }
    const end = offset + (input.limit ?? 100);
    return { head, total: entries.length, rows: entries.slice(offset, end).map(({ unit, value }) => row(unit, value)),
      cursor: end < entries.length ? `${selector}.${end}` : null };
  }

  task(asked: string): AnalysisUnitValues {
    const root = this.facts.rootOf.get(asked), unit = root && this.facts.units.get(root);
    if (!unit || !this.allows(unit.node.project!)) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist in the analysis scope');
    const from = Date.parse(unit.outcome.requestedAt), to = unit.outcome.finishedAt ? Date.parse(unit.outcome.finishedAt) : this.now;
    const { time, band } = unit.clock ?? clocks(unit.log, unit.ownQuestions, unit.childQuestions, unit.launches, from, to, this.now);
    // Use the same Run attribution as the period view, over this Task's lifetime.
    const items = this.datedLaunches.filter(item => item.root === root);
    const collected = this.collectedLaunches(items);
    const models = [...group(items, ({ run }) => [this.modelKey(run)]).values()]
      .map(({ key, label, model, items }) => {
        const { launches, runMs, tokens } = this.useCounts(items);
        return { key, label, model, launches, runMs, output: tokens.output };
      }).sort((a, b) => b.launches - a.launches || compareKey(a, b));
    const tools = this.usageGroups(collected, 'tool').map(({ key, calls }) =>
      ({ name: (JSON.parse(key) as [string, string])[1], calls: calls! }));
    const toolCounts = new Map<string, number>();
    for (const { name, calls } of tools) toolCounts.set(name, (toolCounts.get(name) ?? 0) + calls);
    return { head: this.head({}), unit: { ...row(unit, null), requestedAt: unit.outcome.requestedAt, asked },
      band, time, marks: unitMarks(unit.log, from, to), submits: unit.outcome.submits,
      questions: unit.questions, ...unit.outcome.instructions, answers: unit.answers, workers: unit.workers, children: unit.children,
      usage: this.useCounts(items), models, prs: [...unit.prs].sort(),
      skills: this.usageGroups(collected, 'skill').map(group => group.key).sort(),
      tools: [...toolCounts].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name, 'en')),
      tallied: { runs: collected.length, of: items.filter(({ run }) => run.tallyEligible).length, since: this.tallyDay } };
  }
}
/** A unit in a list before the list is written out: its value, and what its order reads, taken once. */
type Entry = { unit: Unit; value: number | null; finishedAt: string; number: number };
const entry = (unit: Unit, value: number | null): Entry =>
  ({ unit, value, finishedAt: unit.outcome.finishedAt ?? '', number: Number(unit.node.id.slice(1)) });

export class AnalysisReader {
  private readonly facts: FactsCache;
  readonly tallies = new Map<string, Tally>();
  private readonly timeZone = serverZone();
  /** Reads of the facts are taken one at a time: each gives the loop back as it goes. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly tallySince: number, journal?: ChangeLog) {
    this.facts = new FactsCache(root, tallySince, journal);
  }
  close() { this.facts.close(); }

  /**
   * One read: the caller's scope, the facts at one read point, then the scope's days (all made in slices, so serve
   * answers others between them), then `apply`, which counts from what is kept.
   */
  private async scoped<T>(input: { project?: string; timeZone?: string }, caller: Caller,
    apply: (view: ScopedAnalysis, slices: Slices) => T | Promise<T>): Promise<T> {
    const turn = this.queue.then(() => this.readOnce(input, caller, apply));
    this.queue = turn.catch(() => {});
    return turn;
  }
  private async readOnce<T>(input: { project?: string; timeZone?: string }, caller: Caller,
    apply: (view: ScopedAnalysis, slices: Slices) => T | Promise<T>): Promise<T> {
    const store = new ControlStore(this.root, { busyTimeoutMs: 10_000 }, true), slices = new Slices();
    try {
      return await store.readAsync(async () => {
        const db = store.connection;
        const { readScope } = authorize(db, caller, { name: 'task.list' }, { task: null, quote: null });
        if (readScope !== null && input.project !== undefined && input.project !== readScope)
          throw new Problem(PROBLEM_CODE.forbidden, 'A Run reads only its own project');
        const facts = await this.facts.read(db, slices);
        const project = readScope ?? input.project ?? null, zone = input.timeZone ?? this.timeZone;
        const allows = matchingProject(facts, project, readScope), date = calendar(zone);
        if (kept.facts !== facts) { kept.facts = facts; kept.zones.clear(); }
        let days = kept.zones.get(zone);
        if (!days) kept.zones.set(zone, days = { days: zoneDays(facts, date, slices), scopes: new Kept(SCOPES_KEPT) });
        const scope = JSON.stringify([project, readScope]), { scopes } = days;
        let view = scopes.get(scope);
        if (!view) scopes.set(scope, view = days.days.then(zone => scopeView(zone, allows, slices)));
        let ready: ScopeView;
        try { ready = await view; }
        catch (error) { kept.zones.delete(zone); throw error; }
        return await apply(new ScopedAnalysis(facts, ready, project, allows, zone, Date.now(), this.tallySince, this.tallies, date), slices);
      });
    } finally { store.close(); }
  }
  /**
   * Reads ahead what the first analysis read would wait for: the facts, and the days of the face it opens on (every
   * project, the last 7 days by day). Serve calls it once, in a quiet moment after it starts (warmAnalysisWhenIdle).
   */
  async warm() {
    const person = { kind: 'human' } as const;
    await this.tasks({ period: '7d', bucket: 'day' }, person);
    await this.usage({ period: '7d', bucket: 'day' }, person);
  }
  tasks(input: AnalysisTasksInput, caller: Caller) { return this.scoped(input, caller, view => view.tasks(input)); }
  usage(input: AnalysisUsageInput, caller: Caller) {
    return this.scoped(input, caller, async (view, slices) => view.usage(input, await this.rowsFor(view, input.by, slices)));
  }
  breakdown(input: AnalysisBreakdownInput, caller: Caller) {
    return this.scoped(input, caller, async (view, slices) => view.breakdown(input, input.look === 'usage' ? await this.rowsFor(view, input.by, slices) : undefined));
  }
  list(input: AnalysisListInput, caller: Caller) { return this.scoped(input, caller, (view, slices) => view.list(input, slices)); }
  task(input: AnalysisTaskInput, caller: Caller) { return this.scoped(input, caller, view => view.task(input.task)); }
  /** A breakdown's kept day sums, for the breakdowns that give a launch one row (model, agent, project). */
  private async rowsFor(view: ScopedAnalysis, by: AnalysisUsageBy | undefined, slices: Slices) {
    if (by !== 'agent' && by !== 'project' && by !== 'model') return undefined;
    return view.dimensionDays(by, slices);
  }
}

const WARM_CHECK_MS = 1000, WARM_BUSY = 0.5, WARM_CHECKS = 30;
/**
 * Calls `warm` once serve has a quiet second (its event loop busy under half of it and `quiet()` true), checking each
 * second; after 30 checks it warms anyway. The work gives the loop back every slice as any read does.
 * Returns a stop for serve's close.
 */
export function warmAnalysisWhenIdle(reader: Pick<AnalysisReader, 'warm'>, quiet: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined, checks = 0;
  const check = (since = performance.eventLoopUtilization()) => {
    timer = setTimeout(() => {
      timer = undefined;
      const busy = performance.eventLoopUtilization(since).utilization;
      if (++checks < WARM_CHECKS && (busy > WARM_BUSY || !quiet())) return check();
      void reader.warm().catch(error => console.error('Analysis could not read ahead', error));
    }, WARM_CHECK_MS);
  };
  check();
  return () => { if (timer) clearTimeout(timer); };
}
