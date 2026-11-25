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
import { CluesSum, waitsOf } from './clues.js';
import { addSplit, emptySplit, splitWaits, type WaitSplit } from './presence.js';
import { readChanges } from './timeline-reads.js';
import type { AnalysisChangesInput } from '@alpacawork/contract/analysis';

type DatedUnit = { day: string; unit: Unit };
type CountedUnit = DatedUnit & { prCount: number };
/**
 * A launch with its local day and its unit (`root`, and `slot`, the unit's own number for counting units once). Whether it
 * began its conversation is read from the facts it is counted with (`AnalysisFacts.first`): another unit's Run can change it.
 */
type DatedLaunch = { day: string; root: string; slot: number; run: FactLaunch };
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
  let passed = 0, accepted = 0, stopped = 0, doneUnaccepted = 0;
  for (const { unit: { outcome } } of units) {
    if (outcome.passed) passed++;
    if (outcome.acceptedAt) accepted++;
    else if (outcome.stoppedAt) stopped++;
    else if (outcome.doneAt) doneUnaccepted++;
  }
  return { passed, reworked: accepted - passed, stopped, doneUnaccepted, accepted, finished: accepted + stopped, share: shareOf(passed, accepted) };
}
/** Accepted or stopped: a unit done without acceptance is dated too, but is not among the finished. */
const isFinished = (unit: Unit) => !!unit.outcome.finishedAt;
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
/** `waits`: a unit's waits split by where the user was (clues.waitsOf over the facts counted). */
type Waits = (unit: Unit) => WaitSplit;
function acceptedTotals(units: readonly CountedUnit[], waits: Waits): AnalysisAcceptedTotals {
  let submits = 0, questions = 0, prs = 0, noQuestions = 0, passedNoQuestions = 0, submitsEstimated = 0;
  const leads: number[] = [], time = emptyClock(), clues = new CluesSum();
  for (const { unit, prCount } of units) {
    if (!unit.outcome.acceptedAt) continue;
    leads.push(unit.outcome.leadMs!);
    submits += unit.outcome.submits; questions += unit.questions;
    prs += prCount;
    if (unit.asked.every(question => question.accept)) {
      noQuestions++;
      if (unit.outcome.passed) passedNoQuestions++;
    }
    if (unit.outcome.estimated) submitsEstimated++;
    const clock = unit.clock!.time;
    time.review += clock.review; time.answer += clock.answer; time.ai += clock.ai; time.other += clock.other;
    clues.add(unit, waits(unit));
  }
  return { leadMedianMs: median(leads), submits, questions, prs, time, ...clues.clues(), noQuestions, passedNoQuestions, submitsEstimated };
}

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

function usageCounts(items: readonly DatedLaunch[], first: ReadonlySet<string>, now: number): AnalysisUsageCounts {
  let newConversations = 0;
  for (const item of items) if (first.has(item.run.id)) newConversations++;
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
  static async of(launches: readonly DatedLaunch[], first: ReadonlySet<string>, slices: Slices) {
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
      daily.ended.push({ runs, runMs, tokensUnknown, newConversations: items.filter(item => first.has(item.run.id)).length,
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
  // A unit done without acceptance has not finished: its row names no outcome, and its time is when it was done.
  return { id: unit.node.id, project: unit.node.project!, title: unit.node.title,
    outcome: unit.outcome.outcome === 'doneUnaccepted' ? null : unit.outcome.outcome,
    finishedAt: unit.outcome.finishedAt, ...(unit.outcome.doneAt ? { doneAt: unit.outcome.doneAt } : {}), value };
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
/** One unit's part of a zone's days: kept with the unit, so facts that change only other units date only theirs again. */
type UnitDays = { project: string; dated: DatedUnit | null; first: number; launches: ZoneLaunch[];
  /** A requested unit open now: not yet ended (accepted, stopped or done), or reopened after it ended. */
  open: Unit | null };
type ZoneDays = { units: UnitDays[]; launches: ZoneLaunch[] };
/** A launch in a zone's days, with its unit's project (the same object in the unit's days and the zone's). */
type ZoneLaunch = DatedLaunch & { project: string };
/** A scope's units and launches; its day sums are made when a read first needs them (`dailyOf`). */
type ScopeView = { units: DatedUnit[]; launches: DatedLaunch[]; first: number; open: Unit[]; daily?: Promise<DailyUsage>;
  byDimension: Map<string, Promise<DimensionDays[]>> };
type DimensionDays = DimensionValue & { daily: DailyUsage };
/**
 * A zone's days for the facts they were made from and, with them, its scopes' (a zone let go takes its scopes and its
 * units' days with it). New facts make the zone's days again from the units' kept days, dating only changed units.
 */
type ZoneKept = { facts?: AnalysisFacts; days?: Promise<ZoneDays>; units: WeakMap<Unit, UnitDays>;
  scopes: Kept<string, { facts: AnalysisFacts; view: Promise<ScopeView> }> };
const kept = { zones: new Kept<string, ZoneKept>(ZONES_KEPT) };
/** How many zones and scopes the analysis keeps now (they stay within their bounds however many are read). */
export const analysisKept = () => {
  let scopes = 0;
  for (const zone of kept.zones.values()) scopes += zone.scopes.count;
  return { zones: kept.zones.count, scopes };
};
/** Each unit's own number for counting units once, the same in every scope and reading of the facts. */
const slots = new Map<string, number>();
const slotOf = (id: string) => { let slot = slots.get(id); if (slot === undefined) slots.set(id, slot = slots.size); return slot; };

async function zoneDays(facts: AnalysisFacts, kept: WeakMap<Unit, UnitDays>, date: (time: number) => string, slices: Slices): Promise<ZoneDays> {
  const zone: ZoneDays = { units: [], launches: [] };
  for (const unit of facts.units.values()) {
    let days = kept.get(unit);
    if (!days) {
      const project = unit.node.project!, slot = slotOf(unit.node.id);
      days = { project, dated: null, first: Infinity, launches: [], open: null };
      if (unit.node.requested) {
        days.first = Date.parse(unit.outcome.requestedAt);
        const ended = unit.outcome.finishedAt ?? unit.outcome.doneAt;
        if (ended) days.dated = { unit, day: date(Date.parse(ended)) };
        if (unit.node.state !== 'done' && unit.node.state !== 'stopped') days.open = unit;
      // A top-level Task the user did not request counts only when its owner reported it done (nobody accepts it).
      } else if (unit.outcome.doneAt) days.dated = { unit, day: date(Date.parse(unit.outcome.doneAt)) };
      for (const run of unit.launches) {
        days.first = Math.min(days.first, run.started);
        days.launches.push({ root: unit.node.id, slot, run, day: date(run.started), project });
      }
      kept.set(unit, days);
    }
    zone.units.push(days);
    for (const launch of days.launches) zone.launches.push(launch);
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
  const view = { units: [] as DatedUnit[], launches: [] as DatedLaunch[], first: Infinity, open: [] as Unit[] };
  for (const unit of zone.units) {
    if (!inScope(unit.project)) continue;
    view.first = Math.min(view.first, unit.first);
    if (unit.dated) view.units.push(unit.dated);
    if (unit.open) view.open.push(unit.open);
  }
  for (const launch of zone.launches) {
    if (inScope(launch.project)) view.launches.push(launch);
    if (slices.due) await slices.pause();
  }
  return { ...view, byDimension: new Map() };
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
  private readonly openUnits: readonly Unit[];
  private readonly tallyDay: string;
  /** The scope's day sums, once a read that needs them has made them (`daily`). */
  private days?: DailyUsage;

  /** `view`: the scope's units and launches, for the reads that count over them (one task's values need none). */
  constructor(private readonly facts: AnalysisFacts, private readonly view: ScopeView | null, first: number, readonly project: string | null,
    private readonly allows: (project: string) => boolean, private readonly timeZone: string, readonly now: number,
    tallySince: number, private readonly tallies: ReadonlyMap<string, Tally>, readonly date: ReturnType<typeof calendar>) {
    this.today = date(now);
    this.tallyDay = date(tallySince);
    this.datedUnits = view?.units ?? [];
    this.datedLaunches = view?.launches ?? [];
    this.openUnits = view?.open ?? [];
    this.firstDay = Number.isFinite(first) ? date(Math.min(first, now)) : null;
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

  /** Whether a launch's tools were counted (its tally collected, and not of an adapter the tally cannot read). */
  private tallied(item: DatedLaunch) {
    const tally = item.run.tallyEligible ? this.tallies.get(item.run.id) : undefined;
    return !!tally && tally.state !== 'unsupported';
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
  /** The scope's day sums, made once per scope by the first read that needs them. */
  async daily(slices: Slices) {
    return this.days = await (this.view!.daily ??= DailyUsage.of(this.datedLaunches, this.facts.first, slices));
  }

  async dimensionDays(by: 'model' | 'agent' | 'project', slices: Slices) {
    // A model row names the model a tally reports where the launch named none: kept per number of tallies (they only
    // grow), so a tally that arrives makes the rows again.
    const key = by === 'model' ? `model:${this.tallies.size}` : by;
    const kept = this.view!.byDimension;
    let found = kept.get(key);
    if (!found && by === 'model') for (const old of kept.keys()) if (old.startsWith('model:')) kept.delete(old);
    if (!found) kept.set(key, found = (async () => {
      const rows = new Map<string, DimensionValue & { items: DatedLaunch[] }>();
      for (const item of this.datedLaunches) {
        const dimension = this.usageKeys(item, by)[0]!, row = rows.get(dimension.key);
        if (row) row.items.push(item);
        else rows.set(dimension.key, { ...dimension, items: [item] });
        if (slices.due) await slices.pause();
      }
      const result: DimensionDays[] = [];
      for (const { items, ...dimension } of rows.values()) result.push({ ...dimension, daily: await DailyUsage.of(items, this.facts.first, slices) });
      return result;
    })());
    return found;
  }

  private taskBreakdown(by: AnalysisTaskBy, current: readonly DatedUnit[]) {
    return { by, rows: [...group(current, ({ unit }) => this.taskKeys(unit, by)).values()].map(({ items, ...dimension }) => {
      const { finished, accepted, passed, share } = taskCounts(items), totals = acceptedTotals(items.map(item => ({ ...item, prCount: 0 })), this.waits);
      return { ...dimension, finished, accepted, passed, share, leadMedianMs: totals.leadMedianMs,
        submitsPerAccepted: accepted ? totals.submits / accepted : null };
    }).sort((a, b) => b.finished - a.finished || compareKey(a, b)) };
  }

  /** A unit's waits split by where the user was, over these facts. */
  private readonly waits: Waits = unit => waitsOf(this.facts, unit, this.now);
  private readonly taskTotals = (units: readonly CountedUnit[]) => ({ counts: taskCounts(units), accepted: acceptedTotals(units, this.waits) });

  /**
   * The requested tasks open now, with their waits for the user so far: from the request, or for one reopened after it
   * ended, from that end; an open wait runs to now. Each is counted once per read (it moves with the time of the read).
   */
  private unfinished() {
    const time = { review: 0, answer: 0 }, waits = emptySplit();
    for (const clock of this.openClocks().values()) {
      time.review += clock.time.review; time.answer += clock.time.answer;
      addSplit(waits, clock.split);
    }
    return { tasks: this.openUnits.length, time, waits };
  }
  private openClocksMade?: Map<Unit, ReturnType<typeof clocks> & { split: WaitSplit }>;
  private openClocks() {
    if (this.openClocksMade) return this.openClocksMade;
    const made = new Map<Unit, ReturnType<typeof clocks> & { split: WaitSplit }>(), activity = this.facts.activity();
    for (const unit of this.openUnits) {
      const ended = unit.outcome.finishedAt ?? unit.outcome.doneAt, id = unit.node.id;
      const clock = clocks(unit.log, unit.ownQuestions, unit.childQuestions, unit.launches,
        Date.parse(ended ?? unit.outcome.requestedAt), this.now, this.now);
      made.set(unit, { ...clock, split: splitWaits(clock.waits, activity, task => task === id || this.facts.rootOf.get(task) === id, this.now).split });
    }
    return this.openClocksMade = made;
  }

  tasks(input: AnalysisTasksInput): AnalysisTasksView {
    const head = this.head(input), taskTotals = this.taskTotals;
    const prCounts = creditAcceptedPrs(this.datedUnits);
    const units = this.datedUnits.map(item => ({ ...item, prCount: prCounts.get(item.unit) ?? 0 }));
    const current = within(units, head.period);
    const previous = head.previous && within(units, head.previous);
    const value = taskTotals(current), before = previous && taskTotals(previous);
    const lifetime = this.head({}).period;
    const ever = lifetime && (input.period === 'all' ? value : taskTotals(within(units, lifetime)));
    const series = makeSeries(input.bucket, head, units, taskTotals);
    const counts = new Map<string, number>();
    for (const { day, unit } of this.datedUnits) if (isFinished(unit)) counts.set(day, (counts.get(day) ?? 0) + 1);
    const from = monday(head.firstDay ?? head.today), finished: number[] = [];
    if (head.firstDay) for (let day = from; day <= head.today; day = addDays(day, 1)) finished.push(counts.get(day) ?? 0);
    return { head, counts: { value: value.counts, previous: before?.counts ?? null },
      accepted: { value: value.accepted, previous: before?.accepted ?? null }, ever, series, grass: { from, finished },
      unfinished: this.unfinished(),
      breakdown: input.by ? this.taskBreakdown(input.by, current.filter(item => isFinished(item.unit))) : null };
  }

  usage(input: AnalysisUsageInput, rows?: DimensionDays[]): AnalysisUsageView {
    const head = this.head(input), daily = this.days!;
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
    if (input.look === 'tasks') return { head, breakdown: { look: 'tasks', ...this.taskBreakdown(input.by as AnalysisTaskBy,
      within(this.datedUnits, head.period).filter(item => isFinished(item.unit))) } };
    return { head, breakdown: { look: 'usage', ...this.usageBreakdown(input.by, head, input.bucket, rows) } };
  }

  private usageBreakdown(by: AnalysisUsageBy, head: AnalysisHead, bucket: AnalysisBucket, rows?: DimensionDays[]) {
    if (isAnalysisTallyBy(by)) return this.countedBreakdown(by, head, { bucket, points: buckets(head.firstDay, head.today, bucket) });
    return { by, since: null, counted: null, series: null,
      rows: rows ? this.rowsOfDays(rows, head) : this.usageGroups(this.days!.within(head.period), by) };
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

  private useCounts(items: readonly DatedLaunch[]) { return usageCounts(items, this.facts.first, this.now); }

  private usageGroups(items: readonly DatedLaunch[], by: AnalysisUsageBy) {
    return [...group(items, item => this.usageKeys(item, by)).values()].map(({ items, ...dimension }) => ({
      ...dimension, counts: this.useCounts(items),
      calls: by === 'tool' || by === 'mcp' ? items.reduce((sum, { run }) => sum + this.calls(run, by, dimension.key), 0) : null,
    })).sort((a, b) => (b.calls ?? b.counts.launches) - (a.calls ?? a.counts.launches) || compareKey(a, b));
  }

  /** Each unit with launches in the days (and the row, when given) and its value: launches are gathered by unit once. */
  private async usageEntries(input: AnalysisListInput, head: AnalysisHead, slices: Slices): Promise<Entry[]> {
    const by = input.by, byUnit = new Map<string, DatedLaunch[]>(), tallied = isAnalysisTallyBy(by);
    for (const item of this.datedLaunches) {
      if (slices.due) await slices.pause();
      if (!inDays(item.day, head.period) || tallied && !this.tallied(item)) continue;
      if (by && !this.usageKeys(item, by).some(({ key }) => input.key === undefined || key === input.key)) continue;
      const found = byUnit.get(item.root);
      if (found) found.push(item);
      else byUnit.set(item.root, [item]);
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
    const values: Record<string, number> = { launches: runs, runMs, newConversations: items.filter(item => this.facts.first.has(item.run.id)).length,
      output, input: inputs, cache, tokens: output + inputs + cache };
    return entry(unit, values[input.value] ?? null);
  }

  private taskEntries(input: AnalysisListInput, head: AnalysisHead): Entry[] {
    const prCounts = input.value === 'prs' ? creditAcceptedPrs(this.datedUnits) : null;
    // The unfinished are those of the read, whatever the period, as `unfinished` counts them.
    const candidates = input.set === 'unfinished' ? this.openUnits : within(this.datedUnits, head.period).map(item => item.unit);
    const units = candidates.filter(unit => (input.set === 'unfinished' || input.set === 'finished' && isFinished(unit) ||
      input.set === 'accepted' && unit.outcome.acceptedAt || unit.outcome.outcome === input.set)
      && (!input.by || this.taskKeys(unit, input.by as AnalysisTaskBy).some(group => group.key === input.key)));
    return units.map(unit => {
      if (!input.value) return entry(unit, null);
      const { review, answer, ai, other } = (input.set === 'unfinished' ? this.openClocks().get(unit)!.time : unit.clock?.time) ?? emptyClock();
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

  /** The user's actions on every task, as the counts read them (presence.ts). */
  activity() { return this.facts.activity(); }

  task(asked: string): AnalysisUnitValues {
    const root = this.facts.rootOf.get(asked), unit = root && this.facts.units.get(root);
    if (!unit || !this.allows(unit.node.project!)) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist in the analysis scope');
    const ended = unit.outcome.finishedAt ?? unit.outcome.doneAt;
    const from = Date.parse(unit.outcome.requestedAt), to = ended ? Date.parse(ended) : this.now;
    const { time, band } = unit.clock ?? clocks(unit.log, unit.ownQuestions, unit.childQuestions, unit.launches, from, to, this.now);
    // Use the same Run attribution as the period view, over this Task's lifetime (its own launches; no day is read).
    const slot = slotOf(unit.node.id), items = unit.launches.map(run => ({ root: unit.node.id, slot, run, day: '' }));
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
    const clues = new CluesSum();
    clues.add(unit, waitsOf(this.facts, unit, this.now));
    return { head: this.head({}), unit: { ...row(unit, null), requestedAt: unit.outcome.requestedAt, asked },
      ...clues.clues(), submitsEstimated: unit.outcome.estimated,
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
  ({ unit, value, finishedAt: unit.outcome.finishedAt ?? unit.outcome.doneAt ?? '', number: Number(unit.node.id.slice(1)) });

/** The earliest instant of a scope's record (its first day), for a read that dates nothing else: kept per facts. */
const firsts = new WeakMap<AnalysisFacts, Map<string, number>>();
function firstOf(facts: AnalysisFacts, scope: string, allows: (project: string) => boolean) {
  let kept = firsts.get(facts);
  if (!kept) firsts.set(facts, kept = new Map());
  let first = kept.get(scope);
  if (first === undefined) {
    first = Infinity;
    for (const unit of facts.units.values()) {
      if (!allows(unit.node.project!)) continue;
      if (unit.node.requested) first = Math.min(first, Date.parse(unit.outcome.requestedAt));
      for (const run of unit.launches) first = Math.min(first, run.started);
    }
    kept.set(scope, first);
  }
  return first;
}

export class AnalysisReader {
  private readonly facts: FactsCache;
  readonly tallies = new Map<string, Tally>();
  private readonly timeZone = serverZone();
  /**
   * Only the facts are read one at a time (they are one shared state, kept up to each read's read point). Everything
   * after them a read makes or counts on its own, in slices: a short read (a list, a task's values) never waits behind a
   * long count, only for what it reads itself, and its slices take their turns with the long count's.
   */
  private factsTurn: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly tallySince: number, journal?: ChangeLog) {
    this.facts = new FactsCache(root, tallySince, journal);
  }
  close() { this.facts.close(); }

  private readFacts(slices: Slices) {
    const turn = this.factsTurn.then(() => this.facts.read(slices));
    this.factsTurn = turn.catch(() => {});
    return turn;
  }

  /**
   * One read: the caller's scope, then the facts at one read point (they take their own, in their turn: FactsCache.read)
   * and what it counts over them alone (`needs`: nothing more for one task's values; the scope's units and launches;
   * those and their day sums), then `apply`. Every number of one answer is counted from those facts.
   */
  private async scoped<T>(input: { project?: string; timeZone?: string }, caller: Caller, needs: 'facts' | 'scope' | 'days',
    apply: (view: ScopedAnalysis, slices: Slices) => T | Promise<T>): Promise<T> {
    const store = new ControlStore(this.root, { busyTimeoutMs: 10_000 }, true), slices = new Slices();
    let readScope: string | null;
    try { ({ readScope } = store.read(db => authorize(db, caller, { name: 'task.list' }, { task: null, quote: null }))); }
    finally { store.close(); }
    if (readScope !== null && input.project !== undefined && input.project !== readScope)
      throw new Problem(PROBLEM_CODE.forbidden, 'A Run reads only its own project');
    const facts = await this.readFacts(slices);
    const project = readScope ?? input.project ?? null, zone = input.timeZone ?? this.timeZone;
    const allows = matchingProject(facts, project, readScope), date = calendar(zone), scope = JSON.stringify([project, readScope]);
    const view = needs === 'facts' ? null : await this.view(facts, zone, scope, allows, date, slices);
    const analysis = new ScopedAnalysis(facts, view, view?.first ?? firstOf(facts, scope, allows), project, allows, zone,
      Date.now(), this.tallySince, this.tallies, date);
    if (needs === 'days') await analysis.daily(slices);
    return await apply(analysis, slices);
  }

  /** A scope's units and launches for these facts: kept per zone and scope, made again only when the facts change. */
  private async view(facts: AnalysisFacts, zone: string, scope: string, allows: (project: string) => boolean,
    date: (time: number) => string, slices: Slices) {
    let entry = kept.zones.get(zone);
    if (!entry) kept.zones.set(zone, entry = { units: new WeakMap(), scopes: new Kept(SCOPES_KEPT) });
    if (entry.facts !== facts) { entry.facts = facts; entry.days = zoneDays(facts, entry.units, date, slices); entry.scopes.clear(); }
    let found = entry.scopes.get(scope);
    if (!found || found.facts !== facts) {
      const days = entry.days!;
      found = { facts, view: days.then(zone => scopeView(zone, allows, slices)) };
      if (entry.facts === facts) entry.scopes.set(scope, found);
    }
    try { return await found.view; }
    catch (error) { kept.zones.delete(zone); throw error; }
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
  tasks(input: AnalysisTasksInput, caller: Caller) { return this.scoped(input, caller, 'scope', view => view.tasks(input)); }
  usage(input: AnalysisUsageInput, caller: Caller) {
    return this.scoped(input, caller, 'days', async (view, slices) => view.usage(input, await this.rowsFor(view, input.by, slices)));
  }
  breakdown(input: AnalysisBreakdownInput, caller: Caller) {
    return this.scoped(input, caller, input.look === 'usage' ? 'days' : 'scope',
      async (view, slices) => view.breakdown(input, input.look === 'usage' ? await this.rowsFor(view, input.by, slices) : undefined));
  }
  list(input: AnalysisListInput, caller: Caller) { return this.scoped(input, caller, 'scope', (view, slices) => view.list(input, slices)); }
  task(input: AnalysisTaskInput, caller: Caller) { return this.scoped(input, caller, 'facts', view => view.task(input.task)); }
  /** The user's actions on every task, read from the same facts as the counts, for a reader that splits waits as they do. */
  activity(caller: Caller) { return this.scoped({}, caller, 'facts', view => view.activity()); }
  changes(input: AnalysisChangesInput, caller: Caller) {
    return this.scoped(input, caller, 'scope', (view, slices) => readChanges(this.root, view.head(input), view.datedLaunches, input, slices));
  }
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
