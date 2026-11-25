/**
 * Findings: places in a task's timeline worth a look, each found by one fixed rule with its threshold and the records it
 * stands on. The rule set is experimental: rule IDs are kept (a changed rule gets a new ID), thresholds may move once
 * real tasks have shown how often each rule is wrong.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { AnalysisEvidence, AnalysisFindingRule } from '@alpacawork/contract/analysis';
import { analysisFindingRules } from '@alpacawork/contract/analysis';
import { speaksForUser } from '@alpacawork/raw';
import { questionsOf } from '@alpacawork/raw/questions';
import { prLinks, userQuestions } from './rules.js';
import { iso, segments, unionMs, type Interval, type TraceRecords, type TraceRun, type TraceStep } from './timeline.js';

export type Threshold = { value: number; unit: 'minutes' | 'count' };
/** The default threshold of each rule; null for a rule that finds every case. */
export const DEFAULT_THRESHOLDS: Readonly<Record<AnalysisFindingRule, Threshold | null>> = {
  'long-wait': { value: 30, unit: 'minutes' },
  'repeated-question': { value: 3, unit: 'count' },
  'long-step': { value: 5, unit: 'minutes' },
  'limit-hit': null,
  'repeated-command': { value: 3, unit: 'count' },
  'queue-wait': { value: 5, unit: 'minutes' },
  'failed-run': null,
  rework: null,
  idle: { value: 15, unit: 'minutes' },
};
/** Rules that read step times: with no Run of the scope holding them, they cannot find anything and say so. */
export const STEP_RULES: ReadonlySet<AnalysisFindingRule> = new Set(['long-step', 'repeated-command']);

/** A long step is also one this many times its fingerprint's median, and at least LONG_STEP_FLOOR_MS. */
const LONG_STEP_FACTOR = 3, LONG_STEP_FLOOR_MS = 30_000;
const MINUTE = 60_000;

export type Found = { rule: AnalysisFindingRule; anchor: string; at: number; durationMs: number; lane: string | null;
  count: number | null; source: 'recorded' | 'inferred'; evidence: AnalysisEvidence[] };

const taskLane = (task: string) => `task:${task}`;
const agentLane = (run: TraceRun) => `agent:${run.placement}`;
const limitOf = (threshold: Threshold | null) => threshold === null ? 0 : threshold.unit === 'minutes' ? threshold.value * MINUTE : threshold.value;

/** `rule=value` options over the defaults; a rule without a threshold refuses one. */
export function thresholdsOf(options: readonly string[] = []): Record<AnalysisFindingRule, Threshold | null> {
  const result = { ...DEFAULT_THRESHOLDS };
  for (const option of options) {
    const [rule, value] = option.split('=') as [AnalysisFindingRule, string];
    const base = DEFAULT_THRESHOLDS[rule];
    if (!base) throw new Problem(PROBLEM_CODE.invalidInput, `Rule ${rule} finds every case and takes no threshold`);
    result[rule] = { value: Number(value), unit: base.unit };
  }
  return result;
}

/**
 * What a question asks about, so asking it again reads as the same question whatever its wording: the pull requests it
 * names, or (naming none) the first word of each choice, its label.
 */
export function questionTopic(decide: readonly Record<string, unknown>[]): { prs: string[]; choices: string } {
  const text = JSON.stringify(decide);
  const prs = new Set([...prLinks([text])].map(link => link.replace(/^.*\/pull\//, '#')));
  for (const match of text.matchAll(/\bPR\s*#(\d+)/gi)) prs.add(`#${match[1]}`);
  const choices = decide.flatMap(item => Array.isArray(item.decide_choices) ? item.decide_choices : [])
    .map(choice => String((choice as Record<string, unknown>).decide_choice ?? '').trim().split(/\s+/)[0] ?? '');
  return { prs: [...prs].sort(), choices: JSON.stringify(choices.sort()) };
}

/** Questions on one topic: those naming a pull request in common (directly or through another), else the same choices. */
export function sameTopics<T>(items: readonly T[], topic: (item: T) => ReturnType<typeof questionTopic>): T[][] {
  const owner = items.map((_, index) => index);
  const find = (index: number): number => owner[index] === index ? index : owner[index] = find(owner[index]!);
  const first = new Map<string, number>();
  items.forEach((item, index) => {
    const { prs, choices } = topic(item);
    for (const key of prs.length ? prs.map(pr => `pr:${pr}`) : [`choices:${choices}`]) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, index); else owner[find(index)] = find(seen);
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, index) => { const root = find(index); groups.set(root, [...groups.get(root) ?? [], item]); });
  return [...groups.values()];
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const stepMs = (step: TraceStep, run: TraceRun, end: number) => (step.to ?? run.ended ?? end) - step.from!;
const timedTopSteps = (run: TraceRun) => (run.steps ?? []).filter(step => step.inside === null && step.from !== null);

type Rule = (records: TraceRecords, window: Interval, threshold: Threshold | null) => Found[];

const rules: Record<AnalysisFindingRule, Rule> = {
  /** A question open while no AI of the scope ran: the time it waited with nothing else going on. */
  'long-wait': (records, window, threshold) => {
    const busy = records.runs.flatMap(run => run.started === null || run.state === 'joined' ? [] : [{ from: run.started, to: run.ended ?? window.to }]);
    return records.tasks.flatMap(task => questionsOf(task.log).flatMap(({ asked, closing }) => {
      const open = { from: Date.parse(asked.at), to: closing ? Date.parse(closing.at) : window.to };
      const length = unionMs([open], window);
      const still = length - unionMs(busy.flatMap(run => { const from = Math.max(run.from, open.from), to = Math.min(run.to, open.to); return from < to ? [{ from, to }] : []; }), window);
      return still >= limitOf(threshold) && still > 0 ? [{ rule: 'long-wait', anchor: asked.id, at: open.from, durationMs: still,
        lane: taskLane(task.id), count: null, source: 'recorded', evidence: [{ question: asked.id, task: task.id }] } satisfies Found] : [];
    }));
  },
  /** The same decision asked again and again in one task (questionTopic). */
  'repeated-question': (records, window, threshold) => records.tasks.flatMap(task => {
    const groups = sameTopics(questionsOf(task.log), ({ asked }) => questionTopic(asked.decide as Record<string, unknown>[]));
    return groups.filter(group => group.length >= limitOf(threshold)).map(group => ({
      rule: 'repeated-question' as const, anchor: group[0]!.asked.id, at: Date.parse(group[0]!.asked.at),
      durationMs: unionMs(group.map(({ asked, closing }) => ({ from: Date.parse(asked.at), to: closing ? Date.parse(closing.at) : window.to })), window),
      lane: taskLane(task.id), count: group.length, source: 'recorded' as const,
      evidence: group.map(({ asked }) => ({ question: asked.id, task: task.id })) }));
  }),
  /**
   * A step at least the threshold long, or LONG_STEP_FACTOR times the median of the steps with its fingerprint (at
   * least LONG_STEP_FLOOR_MS). A step that ran a sub-agent is judged by the sub-agent's own steps.
   */
  'long-step': (records, window, threshold) => {
    const timed = records.runs.flatMap(run => (run.steps ?? []).filter(step => step.from !== null && step.subagentSteps === 0)
      .map(step => ({ run, step, ms: stepMs(step, run, window.to) })));
    const byPrint = new Map<string, number[]>();
    for (const { step, ms } of timed) if (step.fingerprint) byPrint.set(step.fingerprint, [...byPrint.get(step.fingerprint) ?? [], ms]);
    return timed.filter(({ step, ms }) => {
      const same = step.fingerprint ? byPrint.get(step.fingerprint)! : [];
      return ms >= limitOf(threshold) || same.length >= 3 && ms >= LONG_STEP_FLOOR_MS && ms >= LONG_STEP_FACTOR * median(same);
    }).map(({ run, step, ms }) => ({ rule: 'long-step', anchor: `${run.id}.${step.n}`, at: step.from!, durationMs: ms,
      lane: agentLane(run), count: null, source: 'recorded', evidence: [{ run: run.id, step: step.n }] }));
  },
  /** A command the Run's manager stopped at the command time limit, with the step it stopped when the journal has it. */
  'limit-hit': records => records.runs.flatMap(run => run.stopped.map((stop, index) => {
    const step = timedTopSteps(run).find(item => item.from! <= stop.at && stop.at <= (item.to ?? Infinity));
    return { rule: 'limit-hit' as const, anchor: `${run.id}.${index}`, at: stop.at - stop.seconds * 1000, durationMs: stop.seconds * 1000,
      lane: agentLane(run), count: null, source: 'recorded' as const,
      evidence: [step ? { run: run.id, step: step.n } : { run: run.id }] };
  })),
  /**
   * The same command run again with nothing changed: one fingerprint at least the threshold times in a row (other
   * reads between allowed, an edit breaks the row) with the same output each time, or failing the same way each time
   * (edits between allowed). Commands repeated with work between and a new result (tests after a fix) are not findings.
   */
  'repeated-command': (records, window, threshold) => records.runs.flatMap(run => {
    const found: Found[] = [];
    const flush = (row: TraceStep[]) => {
      if (row.length < limitOf(threshold) || found.some(item => item.anchor === `${run.id}.${row[0]!.n}`)) return;
      found.push({ rule: 'repeated-command', anchor: `${run.id}.${row[0]!.n}`, at: row[0]!.from!,
        durationMs: row.reduce((sum, step) => sum + stepMs(step, run, window.to), 0), lane: agentLane(run), count: row.length,
        source: 'recorded', evidence: row.map(step => ({ run: run.id, step: step.n })) });
    };
    const steps = timedTopSteps(run);
    const unchanged = new Map<string, TraceStep[]>(), failing = new Map<string, TraceStep[]>();
    for (const step of steps) {
      if (step.kind === 'edit') { for (const row of unchanged.values()) flush(row); unchanged.clear(); }
      if (step.kind !== 'command' || !step.fingerprint) continue;
      const row = unchanged.get(step.fingerprint);
      if (row && row.at(-1)!.output !== null && row.at(-1)!.output === step.output) row.push(step);
      else { if (row) flush(row); unchanged.set(step.fingerprint, [step]); }
      const failed = failing.get(step.fingerprint);
      if (step.state === 'failed') failing.set(step.fingerprint, [...failed ?? [], step]);
      else if (failed) { flush(failed); failing.delete(step.fingerprint); }
    }
    for (const row of unchanged.values()) flush(row);
    for (const row of failing.values()) flush(row);
    return found;
  }),
  /** A Run that waited in the queue at least the threshold before it started. */
  'queue-wait': (records, window, threshold) => records.runs.flatMap(run => {
    const to = run.started ?? run.ended ?? window.to, ms = to - run.created;
    return ms >= limitOf(threshold) && ms > 0 ? [{ rule: 'queue-wait' as const, anchor: run.id, at: run.created, durationMs: ms,
      lane: agentLane(run), count: null, source: 'recorded' as const, evidence: [{ run: run.id }] }] : [];
  }),
  /** A Run that failed or was stopped, with the Run that took its place when there is one. */
  'failed-run': (records, window) => records.runs.filter(run => run.state === 'failed' || run.state === 'cancelled').map(run => ({
    rule: 'failed-run' as const, anchor: run.id, at: run.started ?? run.created,
    durationMs: (run.ended ?? window.to) - (run.started ?? run.created), lane: agentLane(run), count: null, source: 'recorded' as const,
    evidence: [{ run: run.id }, ...run.supersededBy ? [{ run: run.supersededBy }] : []] })),
  /**
   * Work done again: a result sent back, an instruction from the user while the result waited for review or after it
   * was done, or an instruction that came in place of answering a question asking to take a result (as the counts read
   * rework, rules.ts taskOutcome). Its time runs until the task next waits for review or is done.
   */
  rework: (records, window) => records.tasks.flatMap(task => {
    const replaced = new Map(userQuestions(task.log).filter(question => question.accept && question.replacedBy !== null)
      .map(question => [question.replacedBy!, question.id]));
    return task.log.flatMap((entry, index) => {
      const sentBack = entry.kind === 'review_sent_back' && speaksForUser(entry.actor);
      const instruction = entry.kind === 'request_accepted' && speaksForUser(entry.actor) &&
        (replaced.has(entry.id) || !entry.answers && (entry.fromState === 'waiting' || entry.fromState === 'done'));
      if (!sentBack && !instruction) return [];
      const at = Date.parse(entry.at), question = replaced.get(entry.id);
      const next = task.log.slice(index + 1).find(later => later.toState === 'waiting' || later.toState === 'done' ||
        later.stage?.baseState === 'waiting' || later.stage?.baseState === 'done');
      return [{ rule: 'rework' as const, anchor: entry.id, at, durationMs: Math.max(0, (next ? Date.parse(next.at) : window.to) - at),
        lane: taskLane(task.id), count: null, source: 'recorded' as const,
        evidence: [{ log: entry.id, task: task.id }, ...question ? [{ question, task: task.id }] : []] }];
    });
  }),
  /** A stretch at least the threshold long when nothing ran, nothing waited in the queue and no question or review was open. */
  idle: (records, window, threshold) => segments(records, window).filter(part => part.key === 'idle' && part.to - part.from >= limitOf(threshold))
    .map(part => ({ rule: 'idle' as const, anchor: iso(part.from), at: part.from, durationMs: part.to - part.from,
      lane: taskLane(records.root), count: null, source: 'recorded' as const, evidence: [{ log: idleEvidence(records, part.from), task: records.root }] })),
};

/** The last record before an idle stretch: what the scope did just before nothing went on. */
function idleEvidence(records: TraceRecords, at: number) {
  let last = records.tasks[0]!.log[0]?.id ?? `created:${records.root}`, time = -Infinity;
  for (const task of records.tasks) for (const entry of task.log) {
    const when = Date.parse(entry.at);
    if (when <= at && when >= time) { time = when; last = entry.id; }
  }
  return last;
}

/** The findings of the chosen rules inside the window (those that started there), the longest first. */
export function findFindings(records: TraceRecords, window: Interval, chosen: readonly AnalysisFindingRule[],
  thresholds: Record<AnalysisFindingRule, Threshold | null>): Found[] {
  return chosen.flatMap(rule => rules[rule](records, window, thresholds[rule]))
    .filter(found => found.at >= window.from && found.at < window.to)
    .sort((a, b) => b.durationMs - a.durationMs || a.at - b.at || a.anchor.localeCompare(b.anchor));
}

export const allRules = analysisFindingRules;
