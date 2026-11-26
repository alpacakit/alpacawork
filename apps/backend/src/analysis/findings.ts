/**
 * Findings: places in a task's timeline worth a look, each found by one fixed rule with its threshold and the records it
 * stands on. The rule set is experimental: rule IDs are kept (a changed rule gets a new ID), thresholds may move once
 * real tasks have shown how often each rule is wrong.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { AnalysisEvidence, AnalysisFindingRule } from '@alpacawork/contract/analysis';
import { analysisFindingRules } from '@alpacawork/contract/analysis';
import { questionsOf } from '@alpacawork/raw/questions';
import { prLinks, taskOutcome, userQuestions } from './rules.js';
import { iso, segments, unionMs, type Interval, type TraceRecords, type TraceRun, type TraceStep } from './timeline.js';

export type Threshold = { value: number; unit: 'minutes' | 'count' };
/** The default threshold of each rule; null for a rule that finds every case. */
export const DEFAULT_THRESHOLDS: Readonly<Record<AnalysisFindingRule, Threshold | null>> = {
  'long-wait': { value: 30, unit: 'minutes' },
  'repeated-question': { value: 3, unit: 'count' },
  'long-step': { value: 5, unit: 'minutes' },
  'limit-hit': null,
  'repeated-failure': { value: 3, unit: 'count' },
  'same-result': { value: 2, unit: 'count' },
  'fan-out': { value: 20, unit: 'count' },
  'queue-wait': { value: 5, unit: 'minutes' },
  'failed-run': null,
  rework: null,
  idle: { value: 15, unit: 'minutes' },
};
/** Rules that read step times: with no Run of the scope holding them, they cannot find anything and say so. */
export const STEP_RULES: ReadonlySet<AnalysisFindingRule> = new Set(['long-step', 'repeated-failure', 'same-result', 'fan-out']);
/** A finding of many steps names the first few; `count` says how many there were. */
const EVIDENCE_STEPS = 10;

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
 * What a question asks about, so asking it again reads as the same question whatever its wording (design: the same pull
 * request, or the same set of choices): the pull requests it names, with their repository when a link gives one, else
 * the first word (label) of each choice. A question naming no pull request and offering no choices has no topic.
 */
export function questionTopic(decide: readonly Record<string, unknown>[]): string[] {
  const text = JSON.stringify(decide);
  const prs = new Set([...prLinks([text])].map(link => link.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//, '$1/$2#')));
  // A bare `#5` names a pull request only when no link says which repository: it joins only other bare ones.
  if (!prs.size) for (const match of text.matchAll(/\bPR\s*#(\d+)/gi)) prs.add(`#${match[1]}`);
  if (prs.size) return [...prs].sort().map(pr => `pr:${pr}`);
  const choices = decide.flatMap(item => Array.isArray(item.decide_choices) ? item.decide_choices : [])
    .map(choice => String((choice as Record<string, unknown>).decide_choice ?? '').trim().split(/\s+/)[0] ?? '').filter(Boolean);
  return choices.length ? [`choices:${JSON.stringify(choices.sort())}`] : [];
}

/** Questions on one topic: those sharing a topic key (directly or through another); one without a topic stands alone. */
export function sameTopics<T>(items: readonly T[], topic: (item: T) => string[]): T[][] {
  const owner = items.map((_, index) => index);
  const find = (index: number): number => owner[index] === index ? index : owner[index] = find(owner[index]!);
  const first = new Map<string, number>();
  items.forEach((item, index) => {
    for (const key of topic(item)) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, index); else owner[find(index)] = find(seen);
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, index) => { const root = find(index); groups.set(root, [...groups.get(root) ?? [], item]); });
  return [...groups.values()];
}

/** A log record as evidence, with its first line: an instruction's words, or the record's title. */
function logEvidence(records: TraceRecords, task: string, id: string): AnalysisEvidence {
  const entry = records.tasks.find(item => item.id === task)?.log.find(record => record.id === id);
  return { log: id, task, firstLine: records.requests.get(id)?.firstLine ?? entry?.title ?? null };
}
const stepEvidence = (run: TraceRun, steps: readonly TraceStep[]) => steps.slice(0, EVIDENCE_STEPS).map(step => ({ run: run.id, step: step.n }));

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const stepMs = (step: TraceStep, run: TraceRun, end: number) => (step.to ?? run.ended ?? end) - step.from!;
const timedTopSteps = (run: TraceRun) => (run.steps ?? []).filter(step => step.inside === null && step.from !== null);

/**
 * Shell commands that write files or the work folder (by their first line), the one list the repeat rules read: output
 * redirection (other than to /dev/null or another stream), tee, rm, mv, cp, sed -i, touch, mkdir, ln, chmod, truncate,
 * dd, patch, git commands that change the work folder, package installs, and interpreters run inline (which may write).
 */
export const WRITING_COMMANDS: readonly RegExp[] = [
  // A redirection to a file, `>&file` and `&>file` included; not `2>&1`, `>&-` or /dev/null.
  /(?:^|[^=\-<>&])(?:&>>?|>>?)(?:&(?![0-9-]))?(?![&>=])(?!\s*\/dev\/null)/,
  /\b(?:tee|rm|rmdir|mv|cp|touch|mkdir|ln|chmod|chown|truncate|dd|patch|install|rsync|unzip|tar)\b/,
  /\bsed\b[^|;&]*\s-[a-zA-Z]*i/,
  /\bperl\b[^|;&]*\s-[a-zA-Z]*i/,
  // Global options (`-C <path>`, `-c <key=value>`, `--git-dir=…`) may come before the command.
  /\bgit(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+(?:commit|checkout|switch|restore|apply|am|reset|merge|rebase|pull|stash|cherry-pick|revert|add|rm|mv|clean|worktree|branch|tag|init|clone)\b/,
  /\b(?:pnpm|npm|yarn|pip3?|cargo|go)\s+(?:install|i|add|remove|update|get|build)\b/,
  /\b(?:python3?|node|ruby|perl|bash|sh|zsh)\s+(?:-[a-zA-Z]*[ce]\b|-\s*$|-\s*<<)/,
];
/**
 * Whether a step may have written: an edit, a command matching WRITING_COMMANDS, or one whose body (lines after its
 * first) is not read here. When it is not known, it counts as a write, so a repeat across it is no finding.
 */
export const writes = (step: TraceStep) => step.kind === 'edit' ||
  step.kind === 'command' && (step.more > 0 || WRITING_COMMANDS.some(pattern => pattern.test(step.line)));

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
   * The same failure again and again: a command of one fingerprint failing with the same whole output at least the
   * threshold times in a row (writes between allowed; a success ends the row; a cut output compares with nothing). A command repeated successfully with the same output
   * is same-result; one whose output changes (a status check, tests after a fix) is no finding.
   */
  'repeated-failure': (records, window, threshold) => records.runs.flatMap(run => {
    const found: Found[] = [], rows = new Map<string, TraceStep[]>();
    const flush = (row: TraceStep[] | undefined) => {
      if (!row || row.length < limitOf(threshold)) return;
      found.push({ rule: 'repeated-failure', anchor: `${run.id}.${row[0]!.n}`, at: row[0]!.from!,
        durationMs: row.reduce((sum, step) => sum + stepMs(step, run, window.to), 0), lane: agentLane(run), count: row.length,
        source: 'recorded', evidence: stepEvidence(run, row) });
    };
    for (const step of timedTopSteps(run)) {
      if (step.kind !== 'command' || !step.fingerprint) continue;
      const row = rows.get(step.fingerprint);
      if (step.state !== 'failed') { flush(row); rows.delete(step.fingerprint); continue; }
      if (row && step.output !== null && row.at(-1)!.output === step.output) row.push(step);
      else { flush(row); rows.set(step.fingerprint, [step]); }
    }
    for (const row of rows.values()) flush(row);
    return found;
  }),
  /**
   * The same read again with the same answer (design: the redundant re-read): a step known to have succeeded, shell
   * commands included, with one fingerprint and the same whole output at least the threshold times in one Run, and no
   * write between (writes). The later reads learned nothing.
   */
  'same-result': (records, window, threshold) => records.runs.flatMap(run => {
    const groups = new Map<string, TraceStep[]>(), found: Found[] = [];
    const flush = () => {
      for (const group of groups.values()) if (group.length >= limitOf(threshold))
        found.push({ rule: 'same-result', anchor: `${run.id}.${group[0]!.n}`, at: group[0]!.from!,
          durationMs: group.reduce((sum, step) => sum + stepMs(step, run, window.to), 0), lane: agentLane(run), count: group.length,
          source: 'recorded', evidence: stepEvidence(run, group) });
      groups.clear();
    };
    for (const step of timedTopSteps(run)) {
      if (writes(step)) { flush(); continue; }
      // Only a step known to have succeeded, with the whole of its output kept, compares.
      if (step.state !== 'done' || !step.fingerprint || step.output === null) continue;
      const key = `${step.fingerprint}\u0000${step.output}`;
      groups.set(key, [...groups.get(key) ?? [], step]);
    }
    flush();
    return found;
  }),
  /**
   * One by one where one read could do: steps of one fingerprint (the same command or read with its paths, IDs and
   * numbers replaced) with differing arguments, at least the threshold times in one Run. A sign the reader lacks a filter.
   */
  'fan-out': (records, window, threshold) => records.runs.flatMap(run => {
    const groups = new Map<string, TraceStep[]>();
    for (const step of timedTopSteps(run))
      if (step.kind !== 'edit' && step.fingerprint) groups.set(step.fingerprint, [...groups.get(step.fingerprint) ?? [], step]);
    return [...groups.values()].filter(group => group.length >= limitOf(threshold) && new Set(group.map(step => step.line)).size > 1)
      .map(group => ({ rule: 'fan-out' as const, anchor: `${run.id}.${group[0]!.n}`, at: group[0]!.from!,
        durationMs: group.reduce((sum, step) => sum + stepMs(step, run, window.to), 0), lane: agentLane(run), count: group.length,
        source: 'recorded' as const, evidence: stepEvidence(run, group) }));
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
   * Work done again, by the counts' rule (rules.ts taskOutcome, as `analysis task` counts sendBacks,
   * instructionsAtReview and instructionsAfterAccept): a result sent back, an instruction at review or after acceptance,
   * and an instruction given in place of answering a question asking to take a result. Its time runs until the task the
   * record is on next waits for review or is done.
   */
  rework: (records, window) => {
    const [root, ...below] = records.tasks, own = userQuestions(root!.log);
    const questions = [...own, ...below.flatMap(task => userQuestions(task.log))];
    const outcome = taskOutcome(root!.log, records.rootState, iso(root!.created), questions);
    const replaced = new Map(records.tasks.flatMap(task => userQuestions(task.log)
      .filter(question => question.accept && question.replacedBy !== null).map(question => [question.replacedBy!, { question: question.id, task: task.id }])));
    return outcome.rework.flatMap(({ id }) => {
      const task = records.tasks.find(item => item.log.some(entry => entry.id === id));
      if (!task) return [];
      const index = task.log.findIndex(entry => entry.id === id), at = Date.parse(task.log[index]!.at), question = replaced.get(id);
      const next = task.log.slice(index + 1).find(later => later.toState === 'waiting' || later.toState === 'done' ||
        later.stage?.baseState === 'waiting' || later.stage?.baseState === 'done');
      return [{ rule: 'rework' as const, anchor: id, at, durationMs: Math.max(0, (next ? Date.parse(next.at) : window.to) - at),
        lane: taskLane(task.id), count: null, source: 'recorded' as const,
        evidence: [logEvidence(records, task.id, id), ...question ? [question] : []] }];
    });
  },
  /** A stretch at least the threshold long when nothing ran, nothing waited in the queue and no question or review was open. */
  idle: (records, window, threshold) => segments(records, window).filter(part => part.key === 'idle' && part.to - part.from >= limitOf(threshold))
    .map(part => ({ rule: 'idle' as const, anchor: iso(part.from), at: part.from, durationMs: part.to - part.from,
      lane: taskLane(records.root), count: null, source: 'recorded' as const, evidence: [idleEvidence(records, part.from)] })),
};

/** The last record before an idle stretch: what the task or those under it did just before nothing went on. */
function idleEvidence(records: TraceRecords, at: number): AnalysisEvidence {
  let last: { task: string; id: string } | null = null, time = -Infinity;
  for (const task of records.tasks) for (const entry of task.log) {
    const when = Date.parse(entry.at);
    if (when <= at && when >= time) { time = when; last = { task: task.id, id: entry.id }; }
  }
  return last ? logEvidence(records, last.task, last.id) : { log: `created:${records.root}`, task: records.root, firstLine: null };
}

/** The findings of the chosen rules inside the window (those that started there), the longest first. */
export function findFindings(records: TraceRecords, window: Interval, chosen: readonly AnalysisFindingRule[],
  thresholds: Record<AnalysisFindingRule, Threshold | null>): Found[] {
  return chosen.flatMap(rule => rules[rule](records, window, thresholds[rule]))
    .filter(found => found.at >= window.from && found.at <= window.to)
    .sort((a, b) => b.durationMs - a.durationMs || a.at - b.at || a.anchor.localeCompare(b.anchor));
}

export const allRules = analysisFindingRules;
