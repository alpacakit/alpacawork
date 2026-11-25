/**
 * One task's timeline (analysis trace) and the situation at one instant (analysis at), built from the records as they
 * are: the task log (states, questions, instructions, reports), the Runs (queue, run, compactions), each Run's step
 * journal and conditions, and its protocol events (commands stopped at the limit). Nothing here reads storage; the
 * records are loaded once (timeline-reads.ts) and every number of an answer is counted from that one load.
 */
import { analysisBreakdownKeys, type AnalysisAtView, type AnalysisLane, type AnalysisMark, type AnalysisSpan, type AnalysisTraceScope,
  type AnalysisTraceView } from '@alpacawork/contract/analysis';
import { iso, questionKind, type Interval } from './rules.js';
import { changeEvents } from './changes.js';
import { splitWaits, type Activity } from './presence.js';
import type { RunConditions } from '@alpacawork/contract/run';
import { speaksForUser } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import { questionsOf, type Question } from '@alpacawork/raw/questions';

export { iso, type Interval };

export type InstructionFrom = 'user' | 'parent' | 'owner';
export type InstructionPurpose = 'instruction' | 'send-back' | 'return';
/** An instruction as its request holds it: who sent it, why, and its first line. */
export type TraceRequest = { id: string; task: string; at: number; from: InstructionFrom; purpose: InstructionPurpose;
  firstLine: string; answers: string | null };
/** A step of a Run as its step journal timed it and its output named it. `inside`: the sub-agent step it ran in. */
export type TraceStep = { n: number; tool: string; kind: string; line: string; fingerprint: string | null;
  from: number | null; to: number | null; state: string; source: string | null; inside: string | null; id: string;
  subagentSteps: number; output: string | null };
export type StepsMissing = 'before-journal' | 'provider-unsupported';
export type TraceRun = {
  id: string; task: string; placement: string; role: 'owner' | 'member'; agent: string; model: string | null;
  effort: string | null; state: string; reason: string | null; request: string; supersededBy: string | null;
  created: number; started: number | null; ended: number | null;
  compactions: readonly { at: number; beforeTokens: number | null; afterTokens: number | null }[];
  /** Null when the Run has no step times, for `stepsMissing`. */
  steps: readonly TraceStep[] | null; stepsMissing: StepsMissing | null;
  conditions: RunConditions | null;
  stopped: readonly { at: number; seconds: number; signal: string }[];
};
export type TraceTask = { id: string; parent: string | null; title: string; created: number; log: readonly TaskLog[] };
export type TraceRecords = {
  root: string; project: string; scope: AnalysisTraceScope;
  /** The root first, then the tasks under it (subtree scope only). */
  tasks: readonly TraceTask[]; runs: readonly TraceRun[]; requests: ReadonlyMap<string, TraceRequest>;
  /** Instruction labels by request (request_labeled): fix, addition or new_request. */
  labels: ReadonlyMap<string, string>;
  /** The root and every task under it, whatever the scope: the user acting on any of them acts on this task. */
  family: ReadonlySet<string>;
  /** The user's actions on every task, in time order (AnalysisFacts.activity), to split the waits by where the user was. */
  activity: readonly Activity[];
  now: number;
};

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

/** The scope's whole period: from the root's creation to now while it can change, else to its last record. */
export function wholePeriod(records: TraceRecords): Interval {
  const from = Math.min(...records.tasks.map(task => task.created), ...records.runs.map(run => run.created));
  if (isOpen(records)) return { from, to: Math.max(from, records.now) };
  let to = from;
  for (const task of records.tasks) for (const entry of task.log) to = Math.max(to, Date.parse(entry.at));
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

/** The window's breakdown, and whether it still changes with the time of the read (`settled` false: the wait split runs to now). */
export function breakdown(records: TraceRecords, window: Interval, parts: readonly Segment[]): AnalysisTraceView['breakdown'] & { settled: boolean } {
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
  const waits = splitWaits(parts.filter(part => part.key === 'answer-user' || part.key === 'answer-task' || part.key === 'waiting-review'),
    records.activity, task => records.family.has(task), records.now);
  return {
    wall: window.to - window.from, categories: analysisBreakdownKeys.map(key => ({ key, ms: ms.get(key) ?? 0 })),
    answerTo: { user: answer('answer-user'), task: answer('answer-task') },
    waits: waits.split, settled: waits.settled,
    aiBusyMs: unionMs(counted.map(({ part }) => part), window), aiWorkMs,
    toolMs: known ? toolMs : null, thinkingMs: known ? aiWorkMs - toolMs : null, stepWorkMs: known ? stepWorkMs : null,
  };
}

/** One lane per task, and one per agent seat (placement) that ran: a seat's Runs follow one another on it. */
export function lanes(records: TraceRecords): AnalysisLane[] {
  const inScope = new Set(records.tasks.map(task => task.id));
  const result: AnalysisLane[] = records.tasks.map(task => ({ id: taskLane(task.id), kind: 'task', task: task.id,
    parent: task.parent && inScope.has(task.parent) ? taskLane(task.parent) : null, role: null, agent: null,
    label: `${task.id} ${task.title}` }));
  const seats = new Map<string, TraceRun>();
  for (const run of records.runs) if (!seats.has(run.placement)) seats.set(run.placement, run);
  for (const [placement, run] of seats)
    result.push({ id: agentLane(placement), kind: 'agent', task: run.task, parent: taskLane(run.task), role: run.role,
      agent: run.agent, label: `${run.task} ${run.role} ${run.agent}` });
  return result;
}

export function spans(records: TraceRecords): AnalysisSpan[] {
  const result: AnalysisSpan[] = [];
  const end = (time: number | null) => time === null ? null : iso(time);
  for (const task of records.tasks) {
    for (const span of stateSpans(task))
      result.push({ id: `state:${task.id}:${span.log}`, lane: taskLane(task.id), kind: 'task-state', from: iso(span.from),
        to: end(span.to), task: task.id, state: span.state });
    for (const { asked, closing } of questionsOf(task.log))
      result.push({ id: `question:${asked.id}`, lane: taskLane(task.id), kind: 'waiting-answer', from: iso(Date.parse(asked.at)),
        to: closing ? iso(Date.parse(closing.at)) : null, task: task.id, question: asked.id, askedTo: asked.askedTo ?? 'user',
        closed: closing === null ? null : closing.kind === 'answered' ? 'answered' : closing.kind === 'question_withdrawn' ? 'withdrawn' : 'expired' });
  }
  for (const run of records.runs) {
    const lane = agentLane(run.placement), queued = queueInterval(run, Infinity);
    if (run.started === null || run.started > run.created)
      result.push({ id: `queued:${run.id}`, lane, kind: 'queued', from: iso(run.created),
        to: queued && Number.isFinite(queued.to) ? iso(queued.to) : null, run: run.id, behind: behind(records, run) });
    if (run.started === null || run.state === 'joined') continue;
    result.push({ id: `run:${run.id}`, lane, kind: 'run', from: iso(run.started), to: end(run.ended), run: run.id,
      state: run.state, reason: run.reason, model: run.model, effort: run.effort, steps: run.steps ? 'recorded' : 'not-recorded' });
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
  const result: AnalysisMark[] = [];
  for (const task of records.tasks) {
    const lane = taskLane(task.id), asked = new Map(questionsOf(task.log).map(question => [question.asked.id, question.asked]));
    for (const entry of task.log) {
      const at = iso(Date.parse(entry.at)), base = { id: entry.id, lane, at, task: task.id };
      if (entry.kind === 'request_accepted' || entry.kind === 'review_sent_back') {
        const request = records.requests.get(entry.id);
        result.push({ ...base, kind: 'instruction', request: entry.id,
          from: request?.from ?? (speaksForUser(entry.actor) ? 'user' : 'parent'),
          purpose: entry.kind === 'review_sent_back' ? 'send-back' : request?.purpose ?? 'instruction',
          label: records.labels.get(entry.id) ?? null, answers: entry.answers ?? null });
      } else if (entry.kind === 'answered' && entry.questionId) {
        const question = asked.get(entry.questionId);
        result.push({ ...base, kind: 'answer', question: entry.questionId,
          by: speaksForUser(entry.actor) ? 'user' : question?.askedTo ?? 'user' });
      } else if (entry.kind === 'question_withdrawn' && entry.questionId)
        result.push({ ...base, kind: 'question-withdrawn', question: entry.questionId, log: entry.id });
      else if (entry.kind === 'reported')
        result.push({ ...base, kind: 'report', log: entry.id, state: stateAfter(entry), title: entry.title });
      else if (entry.kind === 'responsible_changed' || entry.kind === 'placement_changed')
        result.push({ ...base, kind: 'assigned', log: entry.id });
      else if (entry.kind === 'moved') result.push({ ...base, kind: 'moved', log: entry.id });
      else if (entry.kind === 'body_updated' && entry.changedFields?.some(field => field === 'values' || field === 'body'))
        result.push({ ...base, kind: 'values-changed', log: entry.id });
    }
  }
  for (const run of records.runs) {
    const lane = agentLane(run.placement);
    run.compactions.forEach((compaction, index) => result.push({ id: `compacted:${run.id}.${index}`, lane, kind: 'compacted',
      at: iso(compaction.at), run: run.id, beforeTokens: compaction.beforeTokens, afterTokens: compaction.afterTokens }));
    run.stopped.forEach((stop, index) => result.push({ id: `command-stopped:${run.id}.${index}`, lane, kind: 'command-stopped',
      at: iso(stop.at), run: run.id, seconds: stop.seconds, signal: stop.signal }));
  }
  return [...result, ...changeMarks(records)];
}

/** The screen's address of a scene: the task's timeline, at an instant or on a finding. */
export function sceneUrl(task: string, scope: AnalysisTraceScope, scene: { at?: number | string; finding?: string } = {}) {
  const params = new URLSearchParams({ task, tab: 'timeline' });
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
export function situationAt(records: TraceRecords, at: number): Omit<AnalysisAtView, 'head' | 'url'> {
  const tasks = records.tasks.flatMap(task => { const state = stateAt(task, at); return state === null ? [] : [{ task: task.id, title: task.title, state }]; });
  const runs = records.runs.filter(run => run.started !== null && run.state !== 'joined' && run.started <= at && (run.ended === null || at < run.ended))
    .map(run => {
      const request = records.requests.get(run.request) ?? null, steps = run.steps ?? [];
      const top = steps.filter(step => step.inside === null && step.from !== null);
      const current = steps.filter(step => step.from !== null && step.from <= at && at < (step.to ?? run.ended ?? Infinity));
      const before = top.filter(step => step.to !== null && step.to <= at).at(-1) ?? null;
      const after = top.find(step => step.from! > at) ?? null;
      return { run: run.id, task: run.task, role: run.role, agent: run.agent, model: run.model, effort: run.effort, since: iso(run.started!),
        request: request && { id: request.id, from: request.from, purpose: request.purpose, at: iso(request.at), firstLine: request.firstLine },
        steps: run.steps ? 'recorded' as const : 'not-recorded' as const, current: current.map(stepAt),
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
  return { tasks, runs, queued, questions, history, values: null, valuesReason: 'not-recorded' };
}
