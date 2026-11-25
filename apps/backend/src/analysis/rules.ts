import type { AnalysisUnitValues } from '@alpacawork/contract/analysis';
import { isReviewMark, runUsage, runUsageMs, runUsageSource, type RunContribution } from '@alpacawork/contract';
import type { RunRecord } from '@alpacawork/contract/run';
import { speaksForUser, type TaskState, type TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import { questionsOf } from '@alpacawork/raw/questions';

export type Interval = { from: number; to: number };
export type Clock = AnalysisUnitValues['time'];
export const emptyClock = (): Clock => ({ review: 0, answer: 0, ai: 0, other: 0 });
export const iso = (ms: number) => new Date(ms).toISOString();
const normalized = (time: string) => iso(Date.parse(time));
export const shareOf = (passed: number, accepted: number) => accepted < 10 ? null : passed / accepted;

export type RunEvidence = Pick<RunRecord, 'id' | 'task' | 'role' | 'agent' | 'session' | 'launch' |
  'state' | 'created_at' | 'started_at' | 'ended_at' | 'pids' | 'usage'>;
export type ModelRun = { id: string; agent: string; model: string | null; effort: string | null };
export type Launch = RunContribution & ModelRun & {
  task: string; provider: string; session: string | null;
};

export function launchOf(run: RunEvidence): Launch | null {
  const usage = runUsage(runUsageSource(run));
  if (!usage) return null;
  return { ...usage, task: run.task, ...modelRun(run),
    provider: run.session?.provider ?? run.launch.adapter, session: run.session?.id ?? null };
}

export function firstConversations(launches: Iterable<Launch>): Set<string> {
  const first = new Map<string, Launch>();
  for (const run of launches) {
    if (!run.session) continue;
    const key = JSON.stringify([run.provider, run.session]), old = first.get(key);
    if (!old || run.started < old.started || run.started === old.started && Number(run.id.slice(1)) < Number(old.id.slice(1))) first.set(key, run);
  }
  return new Set(Array.from(first.values(), run => run.id));
}

export function modelRun(run: RunEvidence): ModelRun {
  const { model, effort } = run.launch.values;
  return { id: run.id, agent: run.agent,
    model: typeof model === 'string' ? model : null, effort: typeof effort === 'string' ? effort : null };
}

export function prLinks(values: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const text of values)
    for (const match of text.matchAll(/(?<![\w.@/-])https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?![\w-])/gi))
      result.add(`https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/pull/${match[3]}`);
  return result;
}

const instruction = (entry: TaskLog) => entry.kind === 'request_accepted' && !entry.answers && speaksForUser(entry.actor);
const sendBack = (entry: TaskLog) => entry.kind === 'review_sent_back' && speaksForUser(entry.actor);
const accepts = (entry: TaskLog) => entry.toState === 'done' && entry.fromState !== 'done' &&
  speaksForUser(entry.actor) && (entry.kind === 'review_approved' ||
    entry.kind === 'reported' && (entry.stage ? entry.stage.action === 'report_done' : entry.fromState !== 'held'));

export function taskOutcome(log: readonly TaskLog[], state: TaskBaseState, createdAt: string) {
  const initial = log.find(instruction);
  const requestedAt = normalized(initial?.at ?? log.find(entry => entry.kind === 'created')?.at ?? createdAt);
  const acceptedIndex = log.findIndex(accepts);
  const acceptedAt = acceptedIndex < 0 ? null : normalized(log[acceptedIndex]!.at);
  let stoppedAt: string | null = null;
  let base: TaskBaseState = 'todo';
  if (!acceptedAt && state === 'stopped')
    for (const entry of log) {
      const next: TaskBaseState = entry.stage?.baseState ?? (entry.toState === 'held' || !entry.toState ? base : entry.toState);
      if (next === 'stopped' && base !== 'stopped') stoppedAt = normalized(entry.causeAt ?? entry.at);
      base = next;
    }
  const finishIndex = acceptedIndex < 0 ? log.length : acceptedIndex + 1;
  const stopTime = stoppedAt === null ? Infinity : Date.parse(stoppedAt);
  const submits = log.slice(0, finishIndex).filter(entry => isReviewMark(entry) && Date.parse(entry.at) <= stopTime).length;
  let nextTransition: TaskLog | undefined;
  const instructions = { sendBacks: 0, instructionsAtReview: 0, instructionsAfterAccept: 0, instructionsDuringWork: 0 };
  // Walk backward so each instruction sees its first subsequent state transition.
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]!;
    if (sendBack(entry)) instructions.sendBacks++;
    if (instruction(entry)) {
      const seen = nextTransition?.kind === 'linked' && nextTransition.originCauseId === entry.id
        ? nextTransition.fromState : entry.fromState;
      if (acceptedIndex >= 0 && index > acceptedIndex) instructions.instructionsAfterAccept++;
      else if (seen === 'waiting') instructions.instructionsAtReview++;
      else if (entry !== initial && (seen === 'doing' || seen === 'todo' || seen === 'held')) instructions.instructionsDuringWork++;
    }
    if (entry.toState !== null) nextTransition = entry;
  }
  const passed = acceptedAt !== null && submits <= 1 &&
    !instructions.sendBacks && !instructions.instructionsAtReview && !instructions.instructionsAfterAccept;
  return { requestedAt, acceptedAt, stoppedAt, finishedAt: acceptedAt ?? stoppedAt, passed, submits, instructions,
    leadMs: acceptedAt === null ? null : Math.max(0, Date.parse(acceptedAt) - Date.parse(requestedAt)),
    outcome: acceptedAt ? passed ? 'passed' as const : 'reworked' as const : stoppedAt ? 'stopped' as const : null };
}
export type Outcome = ReturnType<typeof taskOutcome>;

export type UserQuestion = { from: number; to: number | null; answered: boolean };
export function userQuestions(log: readonly TaskLog[]): UserQuestion[] {
  return questionsOf(log).flatMap(({ asked, closing }) => asked.askedTo === null
    ? [{ from: Date.parse(asked.at), to: closing === null ? null : Date.parse(closing.at),
      answered: closing?.kind === 'answered' && speaksForUser(closing.actor) }] : []);
}

export function unitMarks(log: readonly TaskLog[], from: number, to: number): AnalysisUnitValues['marks'] {
  return log.flatMap((entry): AnalysisUnitValues['marks'] => {
    const at = Date.parse(entry.at);
    if (at <= from || at > to) return [];
    return instruction(entry) || sendBack(entry) ? [{ at: iso(at), kind: sendBack(entry) ? 'sendBack' : 'instruction' }] : [];
  });
}

type Boundary = { state?: TaskState; questions: number; own: number; runs: number };
export function clocks(log: readonly TaskLog[], own: readonly UserQuestion[], descendants: readonly UserQuestion[],
  runs: readonly Launch[], from: number, to: number, now: number) {
  const time = emptyClock(), band: AnalysisUnitValues['band'] = [];
  if (to <= from) return { time, band };
  const cuts = new Map<number, Boundary>();
  const at = (t: number) => {
    const previous = cuts.get(t);
    if (previous) return previous;
    const value = { questions: 0, own: 0, runs: 0 };
    cuts.set(t, value);
    return value as Boundary;
  };
  const add = (interval: Interval, kind: 'questions' | 'own' | 'runs') => {
    const start = Math.max(from, interval.from), end = Math.min(to, interval.to);
    if (start < end) { at(start)[kind]++; at(end)[kind]--; }
  };
  at(from); at(to);
  let transition = from;
  for (const entry of log) {
    if (entry.toState === null) continue;
    transition = Math.max(transition, Date.parse(entry.at));
    if (transition >= to) break;
    at(transition).state = entry.stage ? entry.stage.hold ? 'held' : entry.stage.baseState : entry.toState;
  }
  for (const question of own) add({ from: question.from, to: question.to ?? to }, 'own');
  for (const question of descendants) add({ from: question.from, to: question.to ?? to }, 'questions');
  for (const run of runs) add({ from: run.started, to: run.started + runUsageMs(run, now) }, 'runs');
  const ordered = [...cuts].sort(([a], [b]) => a - b);
  let state: TaskState = 'todo', asking = 0, askingOwn = 0, active = 0;
  for (let i = 0; i + 1 < ordered.length; i++) {
    const [start, point] = ordered[i]!, end = ordered[i + 1]![0];
    state = point.state ?? state;
    asking += point.questions; askingOwn += point.own; active += point.runs;
    const part = state === 'waiting' ? 'review' : state !== 'doing' ? 'other'
      : asking + askingOwn > 0 ? 'answer' : active > 0 ? 'ai' : 'other';
    time[part] += end - start;
    const kind = state === 'waiting' || state === 'doing' && askingOwn > 0 ? 'yours' : state === 'doing' ? 'doing' : 'paused';
    const previous = band.at(-1);
    if (previous?.kind === kind) previous.to = iso(end);
    else band.push({ from: iso(start), to: iso(end), kind });
  }
  return { time, band };
}
