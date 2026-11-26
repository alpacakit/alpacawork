import type { AnalysisUnitValues } from '@alpacawork/contract/analysis';
import { isReviewMark, runUsage, runUsageMs, type RunContribution } from '@alpacawork/contract';
import type { RunRecord, RunUsage } from '@alpacawork/contract/run';
import { speaksForUser, type TaskState, type TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import { questionsOf } from '@alpacawork/raw/questions';
import type { AnswerParts, InstructionLabel } from '@alpacawork/raw';

export type Interval = { from: number; to: number };
export type Clock = AnalysisUnitValues['time'];
export const emptyClock = (): Clock => ({ review: 0, answer: 0, ai: 0, other: 0 });
export const iso = (ms: number) => new Date(ms).toISOString();
const normalized = (time: string) => iso(Date.parse(time));
export const shareOf = (passed: number, accepted: number) => accepted < 10 ? null : passed / accepted;

/** What of a Run the counting reads: its owner, its launch choices, its times, whether it started and its usage. */
export type RunEvidence = Pick<RunRecord, 'id' | 'task' | 'role' | 'agent' | 'session' | 'state' | 'created_at' | 'started_at' | 'ended_at'> & {
  launch: { adapter: string; values: Readonly<Record<string, unknown>> };
  pids: { agent: number | null }; usage: Pick<RunUsage, 'run' | 'includesEarlier'> | null;
};
export type ModelRun = { id: string; agent: string; model: string | null; effort: string | null };
export type Launch = RunContribution & ModelRun & {
  task: string; provider: string; session: string | null;
};

export function launchOf(run: RunEvidence): Launch | null {
  const usage = runUsage({ startedAt: run.started_at, endedAt: run.ended_at, state: run.state,
    processStarted: run.pids.agent !== null, usage: run.usage });
  if (!usage) return null;
  return { ...usage, task: run.task, ...modelRun(run),
    provider: run.session?.provider ?? run.launch.adapter, session: run.session?.id ?? null };
}

/** Whether a launch began before another of its conversation: the earlier start, then the lower Run number. */
export const beganBefore = (run: Launch, other: Launch) =>
  run.started < other.started || run.started === other.started && Number(run.id.slice(1)) < Number(other.id.slice(1));

export function firstConversations(launches: Iterable<Launch>): Set<string> {
  const first = new Map<string, Launch>();
  for (const run of launches) {
    if (!run.session) continue;
    const key = JSON.stringify([run.provider, run.session]), old = first.get(key);
    if (!old || beganBefore(run, old)) first.set(key, run);
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

/**
 * A question to the user, read for analysis: when it was open, whether the user answered it, whether it asked to take a
 * result as it is (`accept`, the asker's decide_kind; `estimated` where the question predates that record and its words
 * were read instead), the user's instruction that withdrew it in place of an answer, and how the answer read item by item.
 */
export type UserQuestion = {
  id: string; from: number; to: number | null; answered: boolean; accept: boolean; estimated: boolean;
  replacedBy: string | null; replacedAt: number | null; parts: AnswerParts | null;
  /** Item by item (in order, from 1), whether the asker recommended one of its choices. */
  recommends: boolean[];
};
/** Words that mark a question as asking to take a result as it is, for a question asked before decide_kind was recorded. */
const ACCEPT_WORDS = /merge|adopt|accept|マージ|取り込|取込|採用|受け入れ|main\s*に入れ/i;
const itemWords = (item: Readonly<Record<string, unknown>>) => [item.decide_question,
  ...(Array.isArray(item.decide_choices) ? item.decide_choices : []).map(choice =>
    choice && typeof choice === 'object' ? (choice as Record<string, unknown>).decide_choice : null)]
  .filter((text): text is string => typeof text === 'string');
/** Whether a question asks to take a result as it is: any item the asker marked `accept`, or for an older one, its words. */
export function questionKind(decide: readonly Readonly<Record<string, unknown>>[]) {
  const kinds = decide.map(item => item.decide_kind);
  if (kinds.some(kind => typeof kind === 'string')) return { accept: kinds.includes('accept'), estimated: false };
  return { accept: decide.some(item => itemWords(item).some(text => ACCEPT_WORDS.test(text))), estimated: true };
}

/**
 * Every question to the user, in log order. A withdrawn question was replaced by the user's instruction that came in
 * place of its answer: the instruction whose arrival withdrew it, or one sent later naming it (`task request --answers`
 * on the closed question).
 */
export function userQuestions(log: readonly TaskLog[]): UserQuestion[] {
  const instructions = new Map(log.filter(instruction).map(entry => [entry.id, entry] as const));
  const naming = new Map<string, TaskLog>();
  for (const entry of log)
    if (entry.kind === 'request_accepted' && entry.answers && speaksForUser(entry.actor) && !naming.has(entry.answers))
      naming.set(entry.answers, entry);
  return questionsOf(log).flatMap(({ asked, closing }) => {
    if (asked.askedTo !== null) return [];
    const replacing = closing?.kind !== 'question_withdrawn' ? undefined
      : closing.originCauseId !== undefined && instructions.get(closing.originCauseId) || naming.get(asked.id);
    return [{
    id: asked.id, from: Date.parse(asked.at), to: closing === null ? null : Date.parse(closing.at),
    answered: closing?.kind === 'answered' && speaksForUser(closing.actor), ...questionKind(asked.decide),
    replacedBy: replacing?.id ?? null, replacedAt: replacing ? Date.parse(replacing.at) : null,
    parts: closing?.kind === 'answered' ? closing.answerParts ?? null : null,
    // Recommended as the question's own check and the answer's record read it: a recommendation with words.
    recommends: asked.decide.map(item => Array.isArray(item.decide_choices) && item.decide_choices.some(choice =>
      !!choice && typeof choice === 'object' && !!String((choice as Record<string, unknown>).decide_choice_recommended ?? '').trim())),
  }];
  });
}

/**
 * How a unit went, from its own log and the user's questions of its whole subtree (`questions`). A review round is a
 * submit for review or a question to the user that asks to take a result as it is; an instruction that came in place of
 * the answer to such a question is rework, as an instruction at review is. `estimated`: a round was read from a
 * question's words (asked before its kind was recorded).
 */
export function taskOutcome(log: readonly TaskLog[], state: TaskBaseState, createdAt: string, questions: readonly UserQuestion[] = []) {
  const initial = log.find(instruction);
  const requestedAt = normalized(initial?.at ?? log.find(entry => entry.kind === 'created')?.at ?? createdAt);
  const acceptedIndex = log.findIndex(accepts);
  const acceptedAt = acceptedIndex < 0 ? null : normalized(log[acceptedIndex]!.at);
  let stoppedAt: string | null = null, doneAt: string | null = null;
  let base: TaskBaseState = 'todo';
  // A unit done without the user's acceptance (its owner reported it done) is dated by its last turn to done.
  if (!acceptedAt && (state === 'stopped' || state === 'done'))
    for (const entry of log) {
      const next: TaskBaseState = entry.stage?.baseState ?? (entry.toState === 'held' || !entry.toState ? base : entry.toState);
      if (next === state && base !== state) {
        if (state === 'stopped') stoppedAt = normalized(entry.causeAt ?? entry.at);
        else doneAt = normalized(entry.causeAt ?? entry.at);
      }
      base = next;
    }
  const finishIndex = acceptedIndex < 0 ? log.length : acceptedIndex + 1;
  const stopTime = stoppedAt === null ? Infinity : Date.parse(stoppedAt);
  const finishTime = Date.parse(acceptedAt ?? stoppedAt ?? doneAt ?? '') || Infinity, requestTime = Date.parse(requestedAt);
  const reviews = log.slice(0, finishIndex).filter(entry => isReviewMark(entry) && Date.parse(entry.at) <= stopTime).length;
  // The questions asked while the unit was open, as its question count and its clocks read them.
  const open = questions.filter(question => question.from >= requestTime && question.from <= finishTime);
  const rounds = open.filter(question => question.accept);
  const replaced = rounds.filter(question => question.replacedBy !== null);
  // Each replacing instruction counts once, wherever under the unit it was given: at review, or after acceptance when
  // it came after the acceptance.
  const acceptTime = acceptedAt === null ? Infinity : Date.parse(acceptedAt);
  const replacing = new Map(replaced.map(question => [question.replacedBy!, question.replacedAt! > acceptTime]));
  let nextTransition: TaskLog | undefined;
  const instructions = { sendBacks: 0, instructionsAtReview: 0, instructionsAfterAccept: 0, instructionsDuringWork: 0 };
  /** The records counted as rework, each once: the counts above are their numbers by kind. */
  const rework: { id: string; kind: 'sendBack' | 'atReview' | 'afterAccept' }[] = [];
  // Walk backward so each instruction sees its first subsequent state transition.
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]!;
    if (sendBack(entry)) { instructions.sendBacks++; rework.push({ id: entry.id, kind: 'sendBack' }); }
    if (instruction(entry) && !replacing.has(entry.id)) {
      const seen = nextTransition?.kind === 'linked' && nextTransition.originCauseId === entry.id
        ? nextTransition.fromState : entry.fromState;
      if (acceptedIndex >= 0 && index > acceptedIndex) { instructions.instructionsAfterAccept++; rework.push({ id: entry.id, kind: 'afterAccept' }); }
      else if (seen === 'waiting') { instructions.instructionsAtReview++; rework.push({ id: entry.id, kind: 'atReview' }); }
      else if (entry !== initial && (seen === 'doing' || seen === 'todo' || seen === 'held')) instructions.instructionsDuringWork++;
    }
    if (entry.toState !== null) nextTransition = entry;
  }
  for (const [id, after] of replacing) {
    if (after) instructions.instructionsAfterAccept++; else instructions.instructionsAtReview++;
    rework.push({ id, kind: after ? 'afterAccept' : 'atReview' });
  }
  const passed = acceptedAt !== null && reviews <= 1 &&
    !instructions.sendBacks && !instructions.instructionsAtReview && !instructions.instructionsAfterAccept;
  return { requestedAt, acceptedAt, stoppedAt, doneAt, finishedAt: acceptedAt ?? stoppedAt, passed, submits: reviews + rounds.length,
    estimated: open.some(question => question.estimated), instructions, rework,
    leadMs: acceptedAt === null ? null : Math.max(0, Date.parse(acceptedAt) - Date.parse(requestedAt)),
    outcome: acceptedAt ? passed ? 'passed' as const : 'reworked' as const : stoppedAt ? 'stopped' as const
      : doneAt ? 'doneUnaccepted' as const : null };
}
export type Outcome = ReturnType<typeof taskOutcome>;

/**
 * The last time a task ended (became done or stopped, its acceptance included) at or before `now`, or null when it never
 * did: a task reopened after it ended waits again from there, not from its first end.
 */
export function lastEndedAt(log: readonly TaskLog[], now: number): number | null {
  let base: TaskBaseState = 'todo', last: number | null = null;
  for (const entry of log) {
    const next: TaskBaseState = entry.stage?.baseState ?? (entry.toState === 'held' || !entry.toState ? base : entry.toState);
    const at = Date.parse(entry.causeAt ?? entry.at);
    if ((next === 'done' || next === 'stopped') && next !== base && at <= now) last = at;
    base = next;
  }
  return last;
}

/**
 * The user's instructions and send-backs to a unit (its own log, `log`) or any Task under it (`logs`, the unit's
 * included), after the request itself (answers are not instructions), and the labels their senders gave them: an
 * instruction's or a send-back's log entry carries its Request's ID, which its label names.
 */
export function laterInstructions(log: readonly TaskLog[], logs: readonly (readonly TaskLog[])[]) {
  const initial = log.find(instruction), counted = new Set<string>(), labels: InstructionLabel[] = [];
  const since = initial ? Date.parse(initial.at) : -Infinity;
  for (const history of logs)
    for (const entry of history)
      if (entry.kind === 'request_labeled' && entry.label) labels.push(entry.label);
      else if ((instruction(entry) || sendBack(entry)) && entry !== initial && Date.parse(entry.at) >= since) counted.add(entry.id);
  return { count: counted.size, labels: labels.filter(label => counted.has(label.request)) };
}

export function unitMarks(log: readonly TaskLog[], from: number, to: number): AnalysisUnitValues['marks'] {
  return log.flatMap((entry): AnalysisUnitValues['marks'] => {
    const at = Date.parse(entry.at);
    if (at <= from || at > to) return [];
    return instruction(entry) || sendBack(entry) ? [{ at: iso(at), kind: sendBack(entry) ? 'sendBack' : 'instruction' }] : [];
  });
}

type Boundary = { state?: TaskState; questions: number; own: number; accepting: number; runs: number };
export function clocks(log: readonly TaskLog[], own: readonly UserQuestion[], descendants: readonly UserQuestion[],
  runs: readonly Launch[], from: number, to: number, now: number) {
  const time = emptyClock(), band: AnalysisUnitValues['band'] = [];
  if (to <= from) return { time, band, waits: [] as Interval[] };
  const cuts = new Map<number, Boundary>();
  const at = (t: number) => {
    const previous = cuts.get(t);
    if (previous) return previous;
    const value = { questions: 0, own: 0, accepting: 0, runs: 0 };
    cuts.set(t, value);
    return value as Boundary;
  };
  const add = (interval: Interval, kind: 'questions' | 'own' | 'accepting' | 'runs') => {
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
  for (const question of [...own, ...descendants])
    if (question.accept) add({ from: question.from, to: question.to ?? to }, 'accepting');
  for (const run of runs) add({ from: run.started, to: run.started + runUsageMs(run, now) }, 'runs');
  const ordered = [...cuts].sort(([a], [b]) => a - b);
  let state: TaskState = 'todo', asking = 0, askingOwn = 0, accepting = 0, active = 0;
  const waits: Interval[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const [start, point] = ordered[i]!, end = ordered[i + 1]![0];
    state = point.state ?? state;
    asking += point.questions; askingOwn += point.own; accepting += point.accepting; active += point.runs;
    // A question asking to take a result as it is is a review, as a submit for review is.
    const part = state === 'waiting' ? 'review' : state !== 'doing' ? 'other'
      : accepting > 0 ? 'review' : asking + askingOwn > 0 ? 'answer' : active > 0 ? 'ai' : 'other';
    time[part] += end - start;
    if (part === 'review' || part === 'answer') {
      const last = waits.at(-1);
      if (last?.to === start) last.to = end;
      else waits.push({ from: start, to: end });
    }
    const kind = state === 'waiting' || state === 'doing' && askingOwn > 0 ? 'yours' : state === 'doing' ? 'doing' : 'paused';
    const previous = band.at(-1);
    if (previous?.kind === kind) previous.to = iso(end);
    else band.push({ from: iso(start), to: iso(end), kind });
  }
  return { time, band, waits };
}

/**
 * A unit's review rounds as time and tokens (`analysis task` rounds, and the accepted tasks' first and later rounds): a
 * round is the work up to one review (a submit for review or a question asking to take a result, as `submits` counts
 * them) and the wait until the user answered it, withdrew it or sent it back (a hold in review keeps it open). The first
 * round starts at the request, each next one where the one before closed, and the last runs until the unit finished (or
 * `now`). A launch counts toward the round it started in, with all its tokens; one started after the end, toward none.
 */
export type Round = { from: number; to: number; tokens: number };
export function reviewRounds(log: readonly TaskLog[], questions: readonly UserQuestion[], launches: readonly Launch[],
  from: number, to: number): Round[] {
  const closes: number[] = [];
  log.forEach((entry, index) => {
    const at = Date.parse(entry.at);
    if (!isReviewMark(entry) || at < from || at > to) return;
    // A hold and its release while in review keep the review open; it closes when the task leaves review otherwise.
    const leaving = log.slice(index + 1).find(later => later.toState !== null && later.toState !== 'waiting' && later.toState !== 'held');
    closes.push(leaving ? Date.parse(leaving.at) : to);
  });
  for (const question of questions)
    if (question.accept && question.from >= from && question.from <= to) closes.push(question.replacedAt ?? question.to ?? to);
  // The last round runs on to the end: what follows the last review's answer (the acceptance) is part of it.
  const ends = [...new Set(closes.map(at => Math.min(to, Math.max(from, at))))].sort((a, b) => a - b);
  if (ends.length) ends[ends.length - 1] = to; else ends.push(to);
  const rounds: Round[] = [];
  let start = from;
  for (const end of ends) {
    if (end <= start && rounds.length) continue;
    rounds.push({ from: start, to: end, tokens: 0 });
    start = end;
  }
  // A Run started after the unit finished (work after its acceptance) is in no round.
  for (const run of launches) {
    if (!run.tokens || run.started >= to) continue;
    let round = rounds[0]!;
    for (const each of rounds) if (run.started >= each.from) round = each;
    round.tokens += run.tokens.input + run.tokens.cacheRead + run.tokens.cacheWrite + run.tokens.output;
  }
  return rounds;
}
