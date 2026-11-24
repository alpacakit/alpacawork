import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { ChangeLog } from '@alpacawork/db';
import type { AnalysisAcceptedTotals, AnalysisBucket, AnalysisDays, AnalysisHead, AnalysisListInput, AnalysisListRow,
  AnalysisTaskInput, AnalysisTaskBy, AnalysisTaskCounts, AnalysisTasksInput, AnalysisTasksView, AnalysisUnitList,
  AnalysisUnitValues, AnalysisUsageBy, AnalysisUsageCounts, AnalysisUsageInput, AnalysisUsageView,
  AnalysisOwnerChoices, AnalysisOwnerChoicesInput, OwnerChoice } from '@alpacawork/contract/analysis';
import { enabledAgents, settingAdapter, sumRunUsage, type Selection } from '@alpacawork/contract';
import { launchSnapshot, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { authorize, type Caller } from '../control/authorize.js';
import { readControl } from '../control/task-store.js';
import type { Tally } from '../agents/adapters/tally.js';
import { FactsCache, type AnalysisFacts, type Unit } from './facts.js';
import { addDays, bucketStart, buckets, calendar, inDays, makeHead, monday, serverZone } from './calendar.js';
import { clocks, emptyClock, median, modelLabel, modelOf, shareOf, unitMarks, type Launch } from './rules.js';
import { summarizeOwnerChoices } from './owner-choices.js';

type DatedUnit = { day: string; unit: Unit };
type DatedLaunch = { day: string; root: string; run: Launch };
type Group<T> = { key: string; label: string; items: T[] };
type DimensionValue = { key: string; label: string };
const group = <T>(items: Iterable<T>, keys: (item: T) => readonly DimensionValue[]): Map<string, Group<T>> => {
  const result = new Map<string, Group<T>>();
  for (const item of items) for (const { key, label } of keys(item)) {
    const found = result.get(key);
    if (found) found.items.push(item);
    else result.set(key, { key, label, items: [item] });
  }
  return result;
};
const single = (key: string, label = key) => [{ key, label }];
const compareKey = (a: { label: string; key: string }, b: { label: string; key: string }) =>
  a.label.localeCompare(b.label, 'en') || a.key.localeCompare(b.key, 'en');
const compareTask = (a: Unit, b: Unit) => Number(a.node.id.slice(1)) - Number(b.node.id.slice(1));

function taskCounts(units: readonly Unit[]): AnalysisTaskCounts {
  let passed = 0, accepted = 0, stopped = 0;
  for (const { outcome } of units) {
    if (outcome.passed) passed++;
    if (outcome.acceptedAt) accepted++;
    else if (outcome.stoppedAt) stopped++;
  }
  return { passed, reworked: accepted - passed, stopped, accepted, finished: accepted + stopped, share: shareOf(passed, accepted) };
}
function acceptedTotals(units: readonly Unit[]): AnalysisAcceptedTotals {
  let submits = 0, questions = 0;
  const leads: number[] = [], time = emptyClock(), prs = new Set<string>();
  for (const unit of units) {
    if (!unit.outcome.acceptedAt) continue;
    leads.push(unit.outcome.leadMs!);
    submits += unit.outcome.submits; questions += unit.questions;
    for (const link of unit.prs) prs.add(link);
    const clock = unit.clock!.time;
    time.review += clock.review; time.answer += clock.answer; time.ai += clock.ai; time.other += clock.other;
  }
  return { leadMedianMs: median(leads), submits, questions, prs: prs.size, time };
}
function usageCounts(items: readonly DatedLaunch[], first: ReadonlySet<string>, now: number): AnalysisUsageCounts {
  let live = 0, newConversations = 0;
  const tasks = new Set<string>();
  for (const { root, run } of items) {
    tasks.add(root);
    if (run.live) live++;
    if (first.has(run.id)) newConversations++;
  }
  const { runs, runMs, tokens, tokensUnknown } = sumRunUsage(items.map(item => item.run), now);
  return { launches: runs, runMs, live, newConversations, tokensUnknown, tasks: tasks.size,
    tokens: { output: tokens?.output ?? 0, input: tokens?.input ?? 0, cache: tokens ? tokens.cacheRead + tokens.cacheWrite : 0 } };
}

function makeSeries<T extends { day: string }, C>(bucket: AnalysisBucket, head: AnalysisHead, records: readonly T[], counts: (items: T[]) => C) {
  const indexed = group(records, record => single(bucketStart(record.day, bucket)));
  const points = buckets(head.firstDay, head.today, bucket).map(point => ({
    ...point, counts: counts(indexed.get(bucketStart(point.from, bucket))?.items ?? []),
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

function modelChoice({ adapter, model, effort }: Launch) {
  return model === null ? null : { key: JSON.stringify([adapter, model, effort]), choice: { adapter, model, effort } };
}

function canLaunch(config: AgentsSettings, { adapter, model, effort }: OwnerChoice) {
  return enabledAgents(config.agents).some(([profile, setting]) => {
    if (settingAdapter(profile, setting) !== adapter) return false;
    const selections: Selection[] = effort === null ? [{ model }, { model, effort }] : [{ model, effort }];
    return selections.some(selected => {
      try {
        const launched = launchSnapshot(config, profile, 'start', process.env.PATH ?? '', selected);
        if (!launched.ok) return false;
        const resolved = modelOf(launched);
        return resolved.model === model && resolved.effort === effort;
      } catch (error) {
        if (error instanceof Problem && error.code === PROBLEM_CODE.invalidInput) return false;
        throw error;
      }
    });
  });
}

class ScopedAnalysis {
  readonly today: string;
  readonly firstDay: string | null;
  readonly datedUnits: DatedUnit[] = [];
  readonly datedLaunches: DatedLaunch[] = [];
  readonly date: ReturnType<typeof calendar>;
  private readonly allows: (project: string) => boolean;

  constructor(private readonly facts: AnalysisFacts, readonly project: string | null, ownProject: string | null,
    private readonly timeZone: string, readonly now: number, private readonly tallies: ReadonlyMap<string, Tally>) {
    this.date = calendar(timeZone);
    this.today = this.date(now);
    this.allows = matchingProject(facts, project, ownProject);
    // Convert all instants at this read point using one shared date formatter.
    let first = Infinity;
    for (const unit of facts.units.values()) if (unit.node.requested && this.allows(unit.node.project!)) {
      first = Math.min(first, Date.parse(unit.outcome.requestedAt));
      if (unit.outcome.finishedAt) this.datedUnits.push({ unit, day: this.date(Date.parse(unit.outcome.finishedAt)) });
    }
    for (const run of facts.launches) {
      const root = facts.rootOf.get(run.task), unit = root && facts.units.get(root);
      if (unit && this.allows(unit.node.project!)) {
        first = Math.min(first, run.started);
        this.datedLaunches.push({ root, run, day: this.date(run.started) });
      }
    }
    this.firstDay = Number.isFinite(first) ? this.date(Math.min(first, now)) : null;
  }

  head(input: Parameters<typeof makeHead>[4]) {
    return makeHead(this.project, this.timeZone, this.today, this.firstDay, input);
  }

  ownerChoices(input: AnalysisOwnerChoicesInput, config: AgentsSettings): AnalysisOwnerChoices {
    const { purpose, weight } = input;
    const units = [...this.facts.units.values()].filter(({ node, ownerChoiceContext }) =>
      node.requested && this.allows(node.project!) && ownerChoiceContext?.purpose === purpose && ownerChoiceContext.weight === weight);
    return { project: this.project, purpose, weight,
      ...summarizeOwnerChoices(units, modelChoice, choice => canLaunch(config, choice), this.now) };
  }

  private taskKeys(unit: Unit, by: AnalysisTaskBy): DimensionValue[] {
    if (by === 'agent') return single(unit.firstAgent);
    if (by === 'model') return single(unit.firstModel);
    return this.projectKey(unit);
  }

  private projectKey(unit: Unit) {
    const id = unit.node.project!;
    return single(id, this.facts.nodes.get(id)?.title ?? id);
  }

  private usageKeys(item: DatedLaunch, by: AnalysisUsageBy): DimensionValue[] {
    const { run } = item;
    if (by === 'project') return this.projectKey(this.facts.units.get(item.root)!);
    if (by === 'agent') return single(run.agent);
    const tally = this.tallies.get(run.id);
    if (by === 'model') return single(modelLabel(run.model ?? tally?.model ?? null, run.effort, run.agent));
    if (by === 'skill') return Object.keys(tally?.skills ?? {}).map(name => ({ key: name, label: name }));
    return Object.keys(by === 'tool' ? tally?.tools ?? {} : tally?.mcp ?? {}).map(name => ({
      key: JSON.stringify([tally!.provider, name]), label: `${name} · ${tally!.provider}`,
    }));
  }

  private calls(run: Launch, by: AnalysisUsageBy | undefined, key: string | undefined): number {
    const tally = this.tallies.get(run.id);
    if (!tally || !key || by !== 'tool' && by !== 'mcp') return 0;
    const [, name] = JSON.parse(key) as [string, string];
    return (by === 'tool' ? tally.tools : tally.mcp)[name] ?? 0;
  }

  private tallyCoverage(items: readonly DatedLaunch[]) {
    return { runs: items.filter(({ run }) => {
      const tally = this.tallies.get(run.id);
      return tally && tally.state !== 'unsupported';
    }).length, of: items.length };
  }

  tasks(input: AnalysisTasksInput): AnalysisTasksView {
    const head = this.head(input);
    const current = within(this.datedUnits, head.period).map(item => item.unit);
    const previous = head.previous && within(this.datedUnits, head.previous).map(item => item.unit);
    const series = makeSeries(input.bucket, head, this.datedUnits, items => taskCounts(items.map(item => item.unit)));
    const counts = new Map<string, number>();
    for (const { day } of this.datedUnits) counts.set(day, (counts.get(day) ?? 0) + 1);
    const from = monday(head.firstDay ?? head.today), finished: number[] = [];
    if (head.firstDay) for (let day = from; day <= head.today; day = addDays(day, 1)) finished.push(counts.get(day) ?? 0);
    const by = input.by;
    const breakdown = by ? { by, rows: [...group(current, unit => this.taskKeys(unit, by)).values()].map(({ key, label, items }) => {
      const { finished, accepted, passed, share } = taskCounts(items), totals = acceptedTotals(items);
      return { key, label, finished, accepted, passed, share, leadMedianMs: totals.leadMedianMs,
        submitsPerAccepted: accepted ? totals.submits / accepted : null };
    }).sort((a, b) => b.finished - a.finished || compareKey(a, b)) } : null;
    return { head, counts: { value: taskCounts(current), previous: previous && taskCounts(previous) },
      accepted: { value: acceptedTotals(current), previous: previous && acceptedTotals(previous) },
      series, grass: { from, finished }, breakdown };
  }

  usage(input: AnalysisUsageInput): AnalysisUsageView {
    const head = this.head(input);
    const current = within(this.datedLaunches, head.period), previous = head.previous && within(this.datedLaunches, head.previous);
    const series = makeSeries(input.bucket, head, this.datedLaunches, items => this.useCounts(items));
    const by = input.by;
    return { head, counts: { value: this.useCounts(current), previous: previous && this.useCounts(previous) }, series,
      breakdown: by ? { by, tallied: by === 'skill' || by === 'tool' || by === 'mcp' ? this.tallyCoverage(current) : null,
        rows: this.usageGroups(current, by) } : null };
  }

  private useCounts(items: readonly DatedLaunch[]) { return usageCounts(items, this.facts.first, this.now); }

  private usageGroups(items: readonly DatedLaunch[], by: AnalysisUsageBy) {
    return [...group(items, item => this.usageKeys(item, by)).values()].map(({ key, label, items }) => ({
      key, label, counts: this.useCounts(items),
      calls: by === 'tool' || by === 'mcp' ? items.reduce((sum, { run }) => sum + this.calls(run, by, key), 0) : null,
    })).sort((a, b) => (b.calls ?? b.counts.launches) - (a.calls ?? a.counts.launches) || compareKey(a, b));
  }

  private usageRows(input: AnalysisListInput, head: AnalysisHead) {
    const selected = within(this.datedLaunches, head.period).filter(item =>
      !input.by || this.usageKeys(item, input.by).some(key => key.key === input.key));
    return [...group(selected, item => single(item.root)).values()].map(({ key, items }) => {
      const unit = this.facts.units.get(key)!;
      if (!input.value) return row(unit, null);
      if (input.value === 'calls') return row(unit, items.reduce((sum, { run }) => sum + this.calls(run, input.by, input.key), 0));
      const { launches, runMs, newConversations, tokens } = this.useCounts(items);
      return row(unit, ({ launches, runMs, newConversations, ...tokens } as Record<string, number>)[input.value] ?? null);
    });
  }

  private taskRows(input: AnalysisListInput, head: AnalysisHead) {
    const units = within(this.datedUnits, head.period).map(item => item.unit).filter(unit =>
      (input.set === 'finished' || input.set === 'accepted' && unit.outcome.acceptedAt || unit.outcome.outcome === input.set)
      && (!input.by || this.taskKeys(unit, input.by as AnalysisTaskBy).some(group => group.key === input.key)));
    const credited = new Set<string>();
    return units.sort(compareTask).map(unit => {
      if (!input.value) return row(unit, null);
      if (input.value === 'prs') {
        let added = 0;
        // Credit a shared URL once, to the first contributing Task ID in this selection.
        for (const link of unit.prs) if (!credited.has(link)) { credited.add(link); added++; }
        return row(unit, added);
      }
      const { review, answer, ai, other } = unit.clock?.time ?? emptyClock();
      const values: Record<string, number | null> = { lead: unit.outcome.leadMs, submits: unit.outcome.submits,
        questions: unit.questions, you: review + answer, ai, other };
      return row(unit, values[input.value] ?? null);
    });
  }

  list(input: AnalysisListInput): AnalysisUnitList {
    const head = this.head(input);
    const home = input.set === 'finished' && input.period === 'today' && !input.end && !input.by && !input.value;
    const rows = (input.set === 'used' ? this.usageRows(input, head) : this.taskRows(input, head))
      .filter(item => !input.value || item.value !== null && (item.value > 0 || input.value === 'lead' || input.value === 'submits'))
      .sort((a, b) => ((b.value ?? 0) - (a.value ?? 0)) ||
        (home ? 1 : -1) * (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') || Number(a.id.slice(1)) - Number(b.id.slice(1)));
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
    return { head, total: rows.length, rows: rows.slice(offset, end), cursor: end < rows.length ? `${selector}.${end}` : null };
  }

  task(asked: string): AnalysisUnitValues {
    const root = this.facts.rootOf.get(asked), unit = root && this.facts.units.get(root);
    if (!unit || !this.allows(unit.node.project!)) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist in the analysis scope');
    const from = Date.parse(unit.outcome.requestedAt), to = unit.outcome.finishedAt ? Date.parse(unit.outcome.finishedAt) : this.now;
    const { time, band } = unit.clock ?? clocks(unit.log, unit.ownQuestions, unit.childQuestions, unit.launches, from, to, this.now);
    // Use the same Run attribution as the period view, over this Task's lifetime.
    const items = this.datedLaunches.filter(item => item.root === root);
    const models = this.usageGroups(items, 'model').map(({ label, counts }) =>
      ({ label, launches: counts.launches, runMs: counts.runMs, output: counts.tokens.output }));
    const tools = this.usageGroups(items, 'tool').map(({ key, calls }) =>
      ({ name: (JSON.parse(key) as [string, string])[1], calls: calls! }));
    const toolCounts = new Map<string, number>();
    for (const { name, calls } of tools) toolCounts.set(name, (toolCounts.get(name) ?? 0) + calls);
    return { head: this.head({}), unit: { ...row(unit, null), requestedAt: unit.outcome.requestedAt, asked },
      band, time, marks: unitMarks(unit.log, from, to), submits: unit.outcome.submits,
      questions: unit.questions, ...unit.outcome.instructions, answers: unit.answers, workers: unit.workers, children: unit.children,
      usage: this.useCounts(items), models, prs: [...unit.prs].sort(),
      skills: this.usageGroups(items, 'skill').map(group => group.key).sort(),
      tools: [...toolCounts].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name, 'en')),
      tallied: this.tallyCoverage(items) };
  }
}

export class AnalysisReader {
  private readonly facts: FactsCache;
  readonly tallies = new Map<string, Tally>();
  private readonly timeZone = serverZone();
  constructor(private readonly root: string, journal?: ChangeLog) { this.facts = new FactsCache(root, journal); }
  close() { this.facts.close(); }

  private scoped<T>(input: { project?: string; timeZone?: string }, caller: Caller, apply: (view: ScopedAnalysis) => T): T {
    return readControl(this.root, db => this.readAt(db, input, caller, apply));
  }
  private readAt<T>(db: DatabaseSync, input: { project?: string; timeZone?: string }, caller: Caller,
    apply: (view: ScopedAnalysis) => T): T {
    const { readScope } = authorize(db, caller, { name: 'task.list' }, { task: null, quote: null });
    if (readScope !== null && input.project !== undefined && input.project !== readScope)
      throw new Problem(PROBLEM_CODE.forbidden, 'A Run reads only its own project');
    const facts = this.facts.read(db);
    return apply(new ScopedAnalysis(facts, readScope ?? input.project ?? null, readScope, input.timeZone ?? this.timeZone, Date.now(), this.tallies));
  }
  tasks(input: AnalysisTasksInput, caller: Caller) { return this.scoped(input, caller, view => view.tasks(input)); }
  usage(input: AnalysisUsageInput, caller: Caller) { return this.scoped(input, caller, view => view.usage(input)); }
  list(input: AnalysisListInput, caller: Caller) { return this.scoped(input, caller, view => view.list(input)); }
  task(input: AnalysisTaskInput, caller: Caller) { return this.scoped(input, caller, view => view.task(input.task)); }
  ownerChoices(input: AnalysisOwnerChoicesInput, caller: Caller) {
    return this.scoped(input, caller, view => {
      const settings = readAgentsSettings(this.root);
      if (!settings.ok) throw settings.error;
      return view.ownerChoices(input, settings.config);
    });
  }
}
