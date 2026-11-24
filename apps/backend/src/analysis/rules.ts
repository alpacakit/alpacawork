import type { AnalysisUnitValues } from '@alpacawork/contract/analysis';
import { isReviewMark } from '@alpacawork/contract';
import { type RunRecord, type TokenCounters } from '@alpacawork/contract/run';
import { speaksForUser, type TaskState, type TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import { questionsOf } from '@alpacawork/raw/questions';

export type Interval = { from: number; to: number };
export type Clock = AnalysisUnitValues['time'];
export const emptyClock = (): Clock => ({ review: 0, answer: 0, ai: 0, other: 0 });
export const iso = (ms: number) => new Date(ms).toISOString();
export const shareOf = (passed: number, accepted: number) => accepted < 10 ? null : passed / accepted;

export type RunEvidence = Pick<RunRecord, 'id' | 'task' | 'role' | 'agent' | 'session' | 'launch' |
  'state' | 'created_at' | 'started_at' | 'ended_at' | 'pids' | 'usage'>;
export type Launch = {
  id: string; task: string; agent: string; model: string | null; effort: string | null; provider: string;
  session: string | null; started: number; ended: number | null; live: boolean; tokens: TokenCounters | null;
};

export function launchOf(run: RunEvidence, witnessed: boolean | null): Launch | null {
  // Null means that the Run predates the recorded attempt, so the Run's agent PID is the witness.
  if (run.state === 'joined' || run.state === 'queued' || !run.started_at || !(witnessed ?? run.pids.agent !== null)) return null;
  const live = run.state === 'running' && run.ended_at === null;
  return { id: run.id, task: run.task, agent: run.agent, ...modelOf(run), provider: run.session?.provider ?? run.launch.adapter,
    session: run.session?.id ?? null, started: Date.parse(run.started_at), ended: run.ended_at && Date.parse(run.ended_at) || null, live,
    tokens: !live && !run.usage?.includesEarlier ? run.usage?.run ?? null : null };
}
export const runtime = (run: Launch, now: number): number => Math.max(0, (run.ended ?? (run.live ? now : run.started)) - run.started);

export function firstConversations(launches: Iterable<Launch>): Set<string> {
  const first = new Map<string, Launch>();
  for (const run of launches) {
    if (!run.session) continue;
    const key = JSON.stringify([run.provider, run.session]), old = first.get(key);
    if (!old || run.started < old.started || run.started === old.started && Number(run.id.slice(1)) < Number(old.id.slice(1))) first.set(key, run);
  }
  return new Set(Array.from(first.values(), run => run.id));
}

export function modelOf(run: Pick<RunEvidence, 'launch'>) {
  const { model, effort } = run.launch.values;
  return { model: typeof model === 'string' ? model : null, effort: typeof effort === 'string' ? effort : null };
}
export const modelLabel = (model: string | null, effort: string | null, agent: string) =>
  model ? effort ? `${model}(${effort})` : model : agent;

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
  const requestedAt = initial?.at ?? log.find(entry => entry.kind === 'created')?.at ?? createdAt;
  const acceptedIndex = log.findIndex(accepts);
  const acceptedAt = log[acceptedIndex]?.at ?? null;
  let stoppedAt: string | null = null;
  let base: TaskBaseState = 'todo';
  if (!acceptedAt && state === 'stopped')
    for (const entry of log) {
      const next: TaskBaseState = entry.stage?.baseState ?? (entry.toState === 'held' || !entry.toState ? base : entry.toState);
      if (next === 'stopped' && base !== 'stopped') stoppedAt = entry.causeAt ?? entry.at;
      base = next;
    }
  const finishIndex = acceptedIndex < 0 ? log.length : acceptedIndex + 1;
  const submits = log.slice(0, finishIndex).filter(entry => isReviewMark(entry) && (!stoppedAt || entry.at <= stoppedAt)).length;
  const linked = new Map<string, TaskState | null>();
  for (const entry of log)
    if (entry.kind === 'linked' && entry.originCauseId && !linked.has(entry.originCauseId)) linked.set(entry.originCauseId, entry.fromState);
  const rework = log.some((entry, index) => {
    if (sendBack(entry)) return true;
    if (!instruction(entry)) return false;
    if (acceptedIndex >= 0 && index > acceptedIndex) return true;
    return (linked.has(entry.id) ? linked.get(entry.id) : entry.fromState) === 'waiting';
  });
  const passed = acceptedAt !== null && submits <= 1 && !rework;
  return { requestedAt, acceptedAt, stoppedAt, finishedAt: acceptedAt ?? stoppedAt, passed, submits,
    leadMs: acceptedAt === null ? null : Math.max(0, Date.parse(acceptedAt) - Date.parse(requestedAt)),
    outcome: acceptedAt ? passed ? 'passed' as const : 'reworked' as const : stoppedAt ? 'stopped' as const : null };
}
export type Outcome = ReturnType<typeof taskOutcome>;

export type UserQuestion = { from: number; to: number | null };
export function userQuestions(log: readonly TaskLog[]): UserQuestion[] {
  return questionsOf(log).flatMap(({ asked, closing }) => asked.askedTo === null
    ? [{ from: Date.parse(asked.at), to: closing === null ? null : Date.parse(closing.at) }] : []);
}

export function unitMarks(log: readonly TaskLog[], from: number, to: number): AnalysisUnitValues['marks'] {
  return log.flatMap((entry): AnalysisUnitValues['marks'] => {
    const at = Date.parse(entry.at);
    if (at <= from || at > to) return [];
    return instruction(entry) || sendBack(entry) ? [{ at: entry.at, kind: sendBack(entry) ? 'sendBack' : 'instruction' }] : [];
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
  for (const run of runs) add({ from: run.started, to: run.started + runtime(run, now) }, 'runs');
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
