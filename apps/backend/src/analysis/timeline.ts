import type { AnalysisDeliverable } from '@alpacawork/contract/analysis';
import type { RunCompaction } from '@alpacawork/contract/run';
import type { RunSummary } from '@alpacawork/contract/run-summary';
import type { TestObservation } from '../runs/step-evidence.js';
import { adoptedReview, reviewAdoptions } from '../control/action-reasons.js';
/**
 * One task's timeline (analysis trace) and the situation at one instant (analysis at), built from the records as they
 * are: the task log (states, questions, instructions, reports), the Runs (queue, run, compactions), each Run's step
 * journal and conditions, and its protocol events (commands stopped at the limit). Nothing here reads storage; the
 * records are loaded once (timeline-reads.ts) and every number of an answer is counted from that one load.
 */
import { analysisBreakdownKeys, type AnalysisStepsMissing, type AnalysisAtView, type AnalysisLane, type AnalysisMark, type AnalysisSpan, type AnalysisTraceScope,
  type AnalysisTraceView } from '@alpacawork/contract/analysis';
import { clocks, iso, questionKind, taskOutcome, userQuestions, type Interval } from './rules.js';
import { changeEvents } from './changes.js';
import { splitWaits, type Activity } from './presence.js';
import type { RunConditions } from '@alpacawork/contract/run';
import { isRequestLog, speaksForUser, type TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import { questionsOf, type Question } from '@alpacawork/raw/questions';

export { iso, type Interval };

export type InstructionBy = 'user' | 'parent' | 'owner';
export type InstructionPurpose = 'instruction' | 'send-back' | 'return';
/** An instruction as its request holds it: who sent it, why, and its first line. */
export type TraceRequest = { id: string; task: string; at: number; by: InstructionBy; purpose: InstructionPurpose;
  firstLine: string; answers: string | null; authorTask?: string | null; resultRun?: string | null };
/** A step of a Run as its step journal timed it and its output named it. `inside`: the sub-agent step it ran in. */
export type TraceStep = { n: number; tool: string; kind: string; line: string; fingerprint: string | null;
  from: number | null; to: number | null; state: string; source: string | null; inside: string | null; id: string;
  subagentSteps: number;
  /** A digest of what came back when the whole of it was kept; null when it was cut or not seen, so it compares with nothing. */
  output: string | null;
  outputChars?: number;
  /** How many lines what it ran has after its first (`line`): a script or heredoc whose body is not read here. */
  more: number };
export type StepsMissing = AnalysisStepsMissing;
export type TraceSummary = Pick<RunSummary, 'state' | 'basis' | 'outputs' | 'produced'> & { tests: TestObservation[] };
export type TraceRun = {
  id: string; task: string; placement: string; role: 'owner' | 'member'; agent: string; model: string | null;
  effort: string | null; state: string; reason: string | null; request: string; supersededBy: string | null;
  created: number; started: number | null; ended: number | null;
  compactions: readonly (Omit<RunCompaction, 'at' | 'windowTokens'> & { at: number })[];
  summary: TraceSummary;
  /** Null when the Run has no step times (any step without its start), for `stepsMissing`. */
  steps: readonly TraceStep[] | null; stepsMissing: StepsMissing | null;
  conditions: RunConditions | null;
  stopped: readonly { at: number; seconds: number; signal: string }[];
};
export type TraceTask = { id: string; parent: string | null; title: string; created: number; log: readonly TaskLog[] };
export type TraceValueChange = { fields: string[]; direction: boolean };
export type TraceRecords = {
  root: string; project: string; scope: AnalysisTraceScope;
  /** The root first, then every task under it: the breakdown, the waits and the findings read them all whatever the scope. */
  tasks: readonly TraceTask[]; runs: readonly TraceRun[]; requests: ReadonlyMap<string, TraceRequest>;
  valueChanges: ReadonlyMap<string, TraceValueChange>;
  deliverables: readonly AnalysisDeliverable[];
  deliveredFiles: ReadonlyMap<string, ReadonlySet<string>>;
  rootState: TaskBaseState;
  /** The user's actions on every task, in time order (AnalysisFacts.activity), to split the waits by where the user was. */
  activity: readonly Activity[];
  /** The version of the records read (timeline-reads.ts). */
  version: string;
  now: number;
};

/** The tasks a trace lists (its scope): the root alone, or with every task under it. */
export const shownTasks = (records: TraceRecords): ReadonlySet<string> =>
  new Set(records.scope === 'self' ? [records.root] : records.tasks.map(task => task.id));

const taskLane = (task: string) => `task:${task}`;
const agentLane = (placement: string) => `agent:${placement}`;
const isMoving = (run: TraceRun) => run.ended === null;

/** A task's state from one log entry on, as the screen reads it (held over its base state). */
const stateAfter = (entry: TaskLog) => entry.toState === null ? null : entry.stage ? entry.stage.hold ? 'held' : entry.stage.baseState : entry.toState;

/** Each state a task was in, from its creation: [from, to) with to null while it lasts. */
export function stateSpans(task: TraceTask): { from: number; to: number | null; state: string; log: string }[] {
  const spans: { from: number; to: number | null; state: string; log: string }[] = [];
  const first = task.log[0];
  spans.push({ from: task.created, to: null, state: 'todo', log: first?.id ?? `created:${task.id}` });
  for (const entry of task.log) {
    const state = stateAfter(entry);
    if (state === null) continue;
    const at = Date.parse(entry.at), last = spans.at(-1)!;
    if (state === last.state) continue;
    if (at <= last.from) { last.state = state; last.log = entry.id; continue; }
    last.to = at;
    spans.push({ from: at, to: null, state, log: entry.id });
  }
  return spans;
}

export function stateAt(task: TraceTask, at: number): string | null {
  if (at < task.created) return null;
  let state: string | null = null;
  for (const span of stateSpans(task)) if (span.from <= at) state = span.state;
  return state;
}

/** Whether the scope can still change: a Run not ended, or the root not done or stopped. */
export function isOpen(records: TraceRecords) {
  const root = records.tasks[0]!, state = stateAt(root, records.now);
  return records.runs.some(isMoving) || (state !== 'done' && state !== 'stopped');
}

const MOVES: ReadonlySet<string> = new Set(['request_accepted', 'review_sent_back', 'answered', 'asked', 'question_withdrawn', 'review_approved']);
/**
 * The scope's whole period: from the root's creation to now while it can change, else to the last thing that moved it
 * (a change of state, an instruction, an answer, a question, a Run): a comment or a values edit after the end does not
 * stretch it with idle time.
 */
export function wholePeriod(records: TraceRecords): Interval {
  const from = Math.min(...records.tasks.map(task => task.created), ...records.runs.map(run => run.created));
  if (isOpen(records)) return { from, to: Math.max(from, records.now) };
  let to = from;
  for (const task of records.tasks) for (const entry of task.log) if (MOVES.has(entry.kind) || entry.toState !== null) to = Math.max(to, Date.parse(entry.at));
  for (const run of records.runs) to = Math.max(to, run.ended ?? run.started ?? run.created);
  return { from, to };
}

const runInterval = (run: TraceRun, end: number): Interval | null =>
  run.started === null || run.state === 'joined' ? null : { from: run.started, to: run.ended ?? end };
const queueInterval = (run: TraceRun, end: number): Interval | null => {
  const to = run.started ?? run.ended ?? end;
  return to > run.created ? { from: run.created, to } : null;
};
const questionInterval = ({ asked, closing }: Question, end: number): Interval =>
  ({ from: Date.parse(asked.at), to: closing ? Date.parse(closing.at) : end });

const clip = (interval: Interval, window: Interval): Interval | null => {
  const from = Math.max(interval.from, window.from), to = Math.min(interval.to, window.to);
  return from < to ? { from, to } : null;
};
/** The time a set of intervals covers inside the window, overlaps counted once. */
export function unionMs(intervals: readonly Interval[], window: Interval): number {
  const parts = intervals.flatMap(interval => { const part = clip(interval, window); return part ? [part] : []; })
    .sort((a, b) => a.from - b.from);
  let total = 0, end = -Infinity;
  for (const { from, to } of parts) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

type Category = 'owner-working' | 'member-working' | 'child-working' | 'held' | 'answer-user' | 'answer-task' | 'waiting-review' | 'queued';
const ORDER: readonly Category[] = ['owner-working', 'member-working', 'child-working', 'held', 'answer-user', 'answer-task', 'waiting-review', 'queued'];
export type Segment = Interval & { key: Category | 'idle' };

/**
 * Every instant of the window given to the first category that holds then (ORDER), else idle: the segments, merged
 * where one category runs on. Their lengths sum to the window's.
 */
export function segments(records: TraceRecords, window: Interval): Segment[] {
  const root = records.tasks[0]!, end = window.to;
  const sets = new Map<Category, Interval[]>(ORDER.map(key => [key, []]));
  for (const run of records.runs) {
    const interval = runInterval(run, end);
    if (interval) sets.get(run.task !== root.id ? 'child-working' : run.role === 'owner' ? 'owner-working' : 'member-working')!.push(interval);
    const queued = queueInterval(run, end);
    if (queued) sets.get('queued')!.push(queued);
  }
  for (const span of stateSpans(root)) {
    if (span.state === 'held') sets.get('held')!.push({ from: span.from, to: span.to ?? end });
    if (span.state === 'waiting') sets.get('waiting-review')!.push({ from: span.from, to: span.to ?? end });
  }
  // A question to the user asking to take a result as it is is a review, as in the counts (rules.ts clocks).
  for (const task of records.tasks)
    for (const question of questionsOf(task.log))
      sets.get(question.asked.askedTo !== null ? 'answer-task' : questionKind(question.asked.decide).accept ? 'waiting-review' : 'answer-user')!
        .push(questionInterval(question, end));
  const cuts = new Set([window.from, window.to]);
  const deltas = new Map<number, Map<Category, number>>();
  const add = (at: number, key: Category, delta: number) => {
    cuts.add(at);
    let point = deltas.get(at);
    if (!point) deltas.set(at, point = new Map());
    point.set(key, (point.get(key) ?? 0) + delta);
  };
  for (const [key, intervals] of sets) for (const interval of intervals) {
    const part = clip(interval, window);
    if (part) { add(part.from, key, 1); add(part.to, key, -1); }
  }
  const ordered = [...cuts].sort((a, b) => a - b), active = new Map<Category, number>(ORDER.map(key => [key, 0]));
  const result: Segment[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const from = ordered[i]!, to = ordered[i + 1]!;
    for (const [key, delta] of deltas.get(from) ?? []) active.set(key, active.get(key)! + delta);
    if (from < window.from || to > window.to) continue;
    const key = ORDER.find(category => active.get(category)! > 0) ?? 'idle', last = result.at(-1);
    if (last?.key === key && last.to === from) last.to = to;
    else result.push({ from, to, key });
  }
  return result;
}

/** The top-level steps of a Run as intervals (a sub-agent's steps run inside its own step), open ones to the Run's end. */
const stepIntervals = (run: TraceRun, end: number): Interval[] => (run.steps ?? []).flatMap(step =>
  step.inside === null && step.from !== null ? [{ from: step.from, to: step.to ?? run.ended ?? end }] : []);

/**
 * The time the user was waited on, by the counts' rule (rules.ts clocks, as `analysis task` reads it): over the task's
 * own period (its request to its acceptance, stop or done, else now) within the window, an open question to the user
 * from the task or any task under it is a wait even while an AI works, and so is review. It is not the breakdown's
 * partition, where AI work comes first. `settled`: the split no longer moves with the time of the read.
 */
export function waited(records: TraceRecords, window: Interval) {
  const [root, ...below] = records.tasks, own = userQuestions(root!.log), descendants = below.flatMap(task => userQuestions(task.log));
  const outcome = taskOutcome(root!.log, records.rootState, iso(root!.created), [...own, ...descendants]);
  const end = outcome.finishedAt ?? outcome.doneAt;
  const from = Math.max(window.from, Date.parse(outcome.requestedAt)), to = Math.min(window.to, end ? Date.parse(end) : records.now);
  const clock = clocks(root!.log, own, descendants, [], from, to, records.now);
  const family = new Set(records.tasks.map(task => task.id));
  const { split, settled } = splitWaits(clock.waits, records.activity, task => family.has(task), records.now);
  return { time: { review: clock.time.review, answer: clock.time.answer }, waits: split, settled };
}

/** The window's breakdown: the wall time split into parts that do not overlap, AI use, and step-level time when known. */
export function breakdown(records: TraceRecords, window: Interval, parts: readonly Segment[]): AnalysisTraceView['breakdown'] {
  const ms = new Map<string, number>();
  for (const part of parts) {
    const key = part.key === 'answer-user' || part.key === 'answer-task' ? 'waiting-answer' : part.key;
    ms.set(key, (ms.get(key) ?? 0) + part.to - part.from);
  }
  const answer = (key: Category) => parts.filter(part => part.key === key).reduce((sum, part) => sum + part.to - part.from, 0);
  const counted = records.runs.flatMap(run => {
    const interval = runInterval(run, window.to), part = interval && clip(interval, window);
    return part ? [{ run, part }] : [];
  });
  const known = counted.every(({ run }) => run.steps !== null);
  let toolMs = 0, stepWorkMs = 0;
  if (known) for (const { run, part } of counted) {
    const steps = stepIntervals(run, window.to);
    toolMs += unionMs(steps, part);
    for (const step of steps) { const inside = clip(step, part); if (inside) stepWorkMs += inside.to - inside.from; }
  }
  const aiWorkMs = counted.reduce((sum, { part }) => sum + part.to - part.from, 0);
  return {
    wall: window.to - window.from, categories: analysisBreakdownKeys.map(key => ({ key, ms: ms.get(key) ?? 0 })),
    answerTo: { user: answer('answer-user'), task: answer('answer-task') },
    aiBusyMs: unionMs(counted.map(({ part }) => part), window), aiWorkMs,
    toolMs: known ? toolMs : null, thinkingMs: known ? aiWorkMs - toolMs : null, stepWorkMs: known ? stepWorkMs : null,
  };
}

/**
 * One lane per task the trace lists, and one per placement that ran there: a placement's Runs follow one another on it.
 * Placements of one task, role and agent are numbered in the order they first ran, so their labels differ.
 */
export function lanes(records: TraceRecords): AnalysisLane[] {
  const shown = shownTasks(records);
  const result: AnalysisLane[] = records.tasks.filter(task => shown.has(task.id)).map(task => ({ id: taskLane(task.id), kind: 'task',
    task: task.id, parent: task.parent && shown.has(task.parent) ? taskLane(task.parent) : null, placement: null, role: null, agent: null,
    label: `${task.id} ${task.title}` }));
  const seats = new Map<string, TraceRun>(), numbers = new Map<string, number>();
  for (const run of [...records.runs].sort((a, b) => a.created - b.created))
    if (shown.has(run.task) && !seats.has(run.placement)) seats.set(run.placement, run);
  for (const [placement, run] of seats) {
    const kind = `${run.task} ${run.role} ${run.agent}`, number = (numbers.get(kind) ?? 0) + 1;
    numbers.set(kind, number);
    const label = number > 1 || [...seats.values()].filter(other => `${other.task} ${other.role} ${other.agent}` === kind).length > 1
      ? `${kind} ${number}` : kind;
    result.push({ id: agentLane(placement), kind: 'agent', task: run.task, parent: taskLane(run.task), placement, role: run.role,
      agent: run.agent, label });
  }
  return result;
}

/**
 * A Run's steps as its step times stand: null when any step the output names lacks its start, or ended without its end
 * time (its time is unknown, not zero, and it is not running). Only a step still running has no end.
 */
export const timedSteps = (steps: readonly TraceStep[]): readonly TraceStep[] | null =>
  steps.some(step => step.from === null || step.to === null && step.state !== 'running') ? null : steps;

/** The time inside a Run with no step running, when its step times are known: what it thought, wrote or waited on. */
export function thinkingIntervals(run: TraceRun, now: number): Interval[] {
  if (!run.steps || run.started === null || run.state === 'joined') return [];
  const end = run.ended ?? now, gaps: Interval[] = [];
  let cursor = run.started;
  for (const step of stepIntervals(run, end).sort((a, b) => a.from - b.from)) {
    if (step.from > cursor) gaps.push({ from: cursor, to: Math.min(step.from, end) });
    cursor = Math.max(cursor, step.to);
  }
  if (cursor < end) gaps.push({ from: cursor, to: end });
  return gaps.filter(gap => gap.to > gap.from);
}

type RunTaken = NonNullable<Extract<AnalysisSpan, { kind: 'run' }>['taken']>;
function takenByRun(records: TraceRecords) {
  const decisions = new Map<string, RunTaken>();
  const approvals = new Map<string, RunTaken>();
  const latestDecision = new Map<string | null, number>();
  const tasks = new Map(records.tasks.map(task => [task.id, task]));
  for (const task of records.tasks) {
    const reviews = reviewAdoptions(task.log);
    for (const entry of task.log) {
      const taken = entry.reason?.taken;
      const request = isRequestLog(entry.kind) ? records.requests.get(entry.id) : undefined;
      if (taken) {
        if (taken.of !== null) decisions.set(records.requests.get(taken.of)?.resultRun ?? taken.of,
          { code: taken.code, cause: taken.cause, aspects: taken.aspects, source: 'recorded', log: entry.id });
        const judged = taken.of !== null ? records.requests.get(taken.of) : undefined;
        const seat = (request || judged)?.authorTask ?? null;
        const at = Date.parse(entry.at);
        latestDecision.set(seat, Math.max(latestDecision.get(seat) ?? 0, at));
      }
      const approvedRun = reviews.get(entry.id)?.run;
      if (approvedRun) {
        const { of: _of, ...taken } = adoptedReview(null);
        approvals.set(approvedRun, { ...taken, source: 'recorded', log: entry.id });
        latestDecision.set(null, Math.max(latestDecision.get(null) ?? 0, Date.parse(entry.at)));
      }
    }
  }
  return (run: TraceRun): RunTaken | undefined => {
    if (run.supersededBy) return undefined;
    const request = records.requests.get(run.request);
    const recorded = approvals.get(run.id) ?? decisions.get(run.id) ??
      (request?.resultRun ? undefined : decisions.get(run.request));
    if (recorded) return recorded;
    if (!request || request.resultRun && request.resultRun !== run.id || request.answers || request.purpose === 'return' || !['succeeded', 'needs_review'].includes(run.state))
      return undefined;
    const seat = request.authorTask ?? null, requester = seat === null ? undefined : tasks.get(seat);
    const ended = run.ended ?? Infinity;
    const movedOn = (latestDecision.get(seat) ?? 0) > ended ||
      requester?.log.some(entry => entry.toState === 'done' && Date.parse(entry.at) >= ended);
    return { code: 'undetermined', cause: null, aspects: [], source: movedOn ? 'inferred' : 'pending', log: null };
  };
}

export function spans(records: TraceRecords): AnalysisSpan[] {
  const result: AnalysisSpan[] = [], shown = shownTasks(records);
  const end = (time: number | null) => time === null ? null : iso(time);
  for (const task of records.tasks) {
    if (!shown.has(task.id)) continue;
    for (const span of stateSpans(task))
      result.push({ id: `state:${task.id}:${span.log}`, lane: taskLane(task.id), kind: 'task-state', from: iso(span.from),
        to: end(span.to), task: task.id, state: span.state });
    for (const { asked, closing } of questionsOf(task.log))
      result.push({ id: `question:${asked.id}`, lane: taskLane(task.id), kind: 'question', from: iso(Date.parse(asked.at)),
        to: closing ? iso(Date.parse(closing.at)) : null, task: task.id, question: asked.id, askedTo: asked.askedTo ?? 'user',
        ...questionKind(asked.decide),
        closed: closing === null ? null : closing.kind === 'answered' ? 'answered' : closing.kind === 'question_withdrawn' ? 'withdrawn' : 'expired' });
  }
  const takenFor = takenByRun(records);
  for (const run of records.runs) {
    if (!shown.has(run.task)) continue;
    const lane = agentLane(run.placement), queued = queueInterval(run, Infinity);
    if (run.started === null || run.started > run.created)
      result.push({ id: `queued:${run.id}`, lane, kind: 'queued', from: iso(run.created),
        to: queued && Number.isFinite(queued.to) ? iso(queued.to) : null, run: run.id, behind: behind(records, run) });
    if (run.started === null || run.state === 'joined') continue;
    const taken = takenFor(run);
    result.push({ id: `run:${run.id}`, lane, kind: 'run', from: iso(run.started), to: end(run.ended), run: run.id,
      state: run.state, reason: run.reason, model: run.model, effort: run.effort, steps: run.steps ? 'recorded' : 'not-recorded', basis: run.summary.basis, ...(taken && { taken }) });
    thinkingIntervals(run, records.now).forEach((gap, index) => result.push({ id: `thinking:${run.id}.${index}`, lane, kind: 'thinking',
      from: iso(gap.from), to: run.ended === null && gap.to === records.now ? null : iso(gap.to), run: run.id }));
    for (const step of run.steps ?? []) if (step.from !== null)
      result.push({ id: `step:${run.id}.${step.n}`, lane, kind: 'step', from: iso(step.from), to: end(step.to), run: run.id,
        step: step.n, tool: step.tool, line: step.line, state: step.state, source: step.source, inside: step.inside,
        subagentSteps: step.subagentSteps });
  }
  return result;
}

/** The Run of the same seat that was running when this one waited in the queue (the conversation it waited for). */
function behind(records: TraceRecords, run: TraceRun): string | null {
  const until = run.started ?? run.ended ?? records.now;
  let found: TraceRun | null = null;
  for (const other of records.runs) {
    if (other === run || other.placement !== run.placement || other.started === null) continue;
    const otherEnd = other.ended ?? Infinity;
    if (other.started < until && otherEnd > run.created && (!found || otherEnd > (found.ended ?? Infinity))) found = other;
  }
  return found?.id ?? null;
}

/** Each Run that ran differently from the Run before it on the same seat (changes.ts), with what changed. */
export function changeMarks(records: TraceRecords): AnalysisMark[] {
  return changeEvents(records.runs.filter(run => run.state !== 'joined'), run => run.placement).flatMap(({ run, previous, changes }) =>
    previous ? [{ id: `change:${run.id}`, lane: agentLane(run.placement), kind: 'change' as const, at: iso(run.started!),
      run: run.id, previous: previous.id, changes }] : []);
}

export function marks(records: TraceRecords): AnalysisMark[] {
  const result: AnalysisMark[] = [], shown = shownTasks(records);
  for (const task of records.tasks) {
    if (!shown.has(task.id)) continue;
    const lane = taskLane(task.id), asked = new Map(questionsOf(task.log).map(question => [question.asked.id, question.asked]));
    for (const entry of task.log) {
      const at = iso(Date.parse(entry.at)), base = { id: entry.id, lane, at, task: task.id };
      if (isRequestLog(entry.kind)) {
        const request = records.requests.get(entry.id);
        result.push({ ...base, kind: 'instruction', request: entry.id,
          by: request?.by ?? (speaksForUser(entry.actor) ? 'user' : 'parent'),
          purpose: entry.kind === 'review_sent_back' ? 'send-back' : request?.purpose ?? 'instruction',
          taken: entry.reason?.taken ?? null, placed: entry.reason?.placed ?? null, answers: entry.answers ?? null, firstLine: request?.firstLine ?? null });
      } else if (entry.kind === 'answered' && entry.questionId) {
        const question = asked.get(entry.questionId);
        result.push({ ...base, kind: 'answer', question: entry.questionId,
          by: speaksForUser(entry.actor) ? 'user' : question?.askedTo ?? 'user' });
      } else if (entry.kind === 'question_withdrawn' && entry.questionId)
        result.push({ ...base, kind: 'question-withdrawn', question: entry.questionId, log: entry.id });
      else if (entry.kind === 'reported')
        result.push({ ...base, kind: 'report', log: entry.id, state: stateAfter(entry), title: entry.title, taken: entry.reason?.taken ?? null });
      else if (entry.kind === 'responsible_changed' || entry.kind === 'placement_changed')
        result.push({ ...base, kind: 'assigned', log: entry.id, role: entry.placementEffect === 'responsible' ? 'owner' : entry.placementEffect ?? null,
          model: entry.launchValues?.model ?? null, effort: entry.launchValues?.effort ?? null,
          placed: entry.reason?.placed ?? null, taken: entry.reason?.taken ?? null });
      else if (entry.kind === 'moved') result.push({ ...base, kind: 'moved', log: entry.id });
      const trigger = entry.reason?.trigger ?? null;
      const { fields, direction } = records.valueChanges.get(entry.id) ?? { fields: [], direction: false };
      if (fields.length || entry.kind === 'body_updated' && entry.changedFields?.some(field => field === 'values' || field === 'body'))
        result.push({ ...base, id: `values:${entry.id}`, kind: 'values-changed', log: entry.id, fields: [...fields],
          trigger, direction: trigger?.code !== 'refine' && direction });
    }
  }
  for (const run of records.runs) {
    if (!shown.has(run.task)) continue;
    const lane = agentLane(run.placement);
    run.compactions.forEach(({ at, ...compaction }, index) => result.push({ id: `compacted:${run.id}.${index}`, lane, kind: 'compacted',
      ...compaction, at: iso(at), run: run.id }));
    if (run.started !== null) {
      const base = { lane, run: run.id };
      for (const { test, at } of run.summary.tests)
        result.push({ ...base, ...test, id: `test:${run.id}.${test.step}`, kind: 'test',
          at: iso(at ?? run.started), atSource: at === null ? 'run-start' : 'step' });
      const { commits, files, prs } = run.summary.produced;
      const produced = [
        ...commits.map(item => ({ step: item.step, what: 'commit' as const, ref: item.sha })),
        ...files.filter(item => records.deliveredFiles.get(run.id)?.has(item.path)).map(item => ({ step: item.step, what: 'file' as const, ref: item.path })),
        ...prs.map(item => ({ step: item.step, what: item.action === 'created' ? 'pr-created' as const : 'pr-merged' as const, ref: item.url })),
      ];
      const steps = new Map(run.steps?.map(step => [step.n, step]));
      produced.forEach((item, index) => {
        const step = steps.get(item.step), at = step?.to ?? step?.from ?? null;
        result.push({ ...base, ...item, id: `produced:${run.id}.${item.step}.${index}`, kind: 'produced',
          at: iso(at ?? run.started!), atSource: at === null ? 'run-start' : 'step' });
      });
    }
    run.stopped.forEach((stop, index) => result.push({ id: `command-stopped:${run.id}.${index}`, lane, kind: 'command-stopped',
      at: iso(stop.at), run: run.id, seconds: stop.seconds, signal: stop.signal }));
  }
  return [...result, ...changeMarks(records).filter(mark => mark.kind !== 'change' || shown.has(records.runs.find(run => run.id === mark.run)!.task))];
}

/** The screen's address of a scene: the task's timeline, at an instant or on a finding. */
export function sceneUrl(task: string, scope: AnalysisTraceScope, scene: { at?: number | string; finding?: string } = {}) {
  const params = new URLSearchParams({ task, tab: 'analysis' });
  if (scope === 'subtree') params.set('scope', 'subtree');
  if (scene.at !== undefined) params.set('at', typeof scene.at === 'number' ? iso(scene.at) : scene.at);
  if (scene.finding) params.set('finding', scene.finding);
  return `/?${params}`;
}

const HISTORY_LINES = 5;
type StepAt = AnalysisAtView['runs'][number]['before'];
const stepAt = (step: TraceStep): NonNullable<StepAt> => ({ step: step.n, tool: step.tool, line: step.line,
  from: step.from === null ? null : iso(step.from), to: step.to === null ? null : iso(step.to) });

/** The situation at `at`: each task's state, the Runs running and their steps, the queue, the open questions, the last history lines. */
export function situationAt(records: TraceRecords, at: number): Omit<AnalysisAtView, 'head' | 'url' | 'part' | 'values' | 'valuesReason'> {
  const shown = shownTasks(records);
  records = { ...records, tasks: records.tasks.filter(task => shown.has(task.id)), runs: records.runs.filter(run => shown.has(run.task)) };
  const tasks = records.tasks.flatMap(task => { const state = stateAt(task, at); return state === null ? [] : [{ task: task.id, title: task.title, state }]; });
  const runs = records.runs.filter(run => run.started !== null && run.state !== 'joined' && run.started <= at && (run.ended === null || at < run.ended))
    .map(run => {
      const request = records.requests.get(run.request) ?? null, steps = run.steps ?? [];
      const top = steps.filter(step => step.inside === null && step.from !== null);
      const current = steps.filter(step => step.from !== null && step.from <= at && at < (step.to ?? run.ended ?? Infinity));
      // The step that ended last before the instant (steps run in parallel end out of their order).
      const before = top.filter(step => step.to !== null && step.to <= at).reduce<TraceStep | null>((last, step) =>
        !last || step.to! > last.to! || step.to === last.to && step.n > last.n ? step : last, null);
      const after = top.find(step => step.from! > at) ?? null;
      return { run: run.id, task: run.task, role: run.role, agent: run.agent, model: run.model, effort: run.effort, since: iso(run.started!),
        request: request && { id: request.id, by: request.by, purpose: request.purpose, at: iso(request.at), firstLine: request.firstLine },
        steps: run.steps ? 'recorded' as const : 'not-recorded' as const, basis: run.summary.basis, current: current.map(stepAt),
        before: before && stepAt(before), after: after && stepAt(after) };
    });
  const queued = records.runs.filter(run => run.created <= at && at < (run.started ?? run.ended ?? Infinity))
    .map(run => ({ run: run.id, task: run.task, since: iso(run.created) }));
  const questions = records.tasks.flatMap(task => questionsOf(task.log).filter(({ asked, closing }) =>
    Date.parse(asked.at) <= at && (closing === null || Date.parse(closing.at) > at))
    .map(({ asked }) => ({ question: asked.id, task: task.id, askedTo: asked.askedTo ?? 'user', since: iso(Date.parse(asked.at)), title: asked.title,
      ...questionKind(asked.decide) })));
  const history = records.tasks.flatMap(task => task.log.filter(entry => Date.parse(entry.at) <= at).map(entry => ({ task: task.id, entry })))
    .sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at)).slice(-HISTORY_LINES)
    .map(({ task, entry }) => ({ log: entry.id, task, kind: entry.kind, at: iso(Date.parse(entry.at)),
      title: entry.title ?? records.requests.get(entry.id)?.firstLine ?? null }));
  return { tasks, runs, queued, questions, history };
}
