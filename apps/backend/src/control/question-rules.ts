/** The fixed destination and applicability of a question. Meaning and the choice of ancestor belong to the AI. */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { closureOf, openQuestions, questionsOf, type AskedLog, type TaskBaseState, type TaskLifecycle, type TaskLog } from '@alpacawork/raw';

type QuestionTask = { id: string; parentId: string | null; kind: 'task' | 'project' };
export type QuestionNode = QuestionTask & { lifecycle: TaskLifecycle; baseState?: TaskBaseState; log: readonly TaskLog[] };
export function questionSnapshot(tasks: Iterable<QuestionNode | { id: string; meta: Omit<QuestionNode, 'id'> }>): Map<string, QuestionNode> {
  return new Map([...tasks].map(task => {
    const node = 'meta' in task ? { id: task.id, ...task.meta } : task;
    return [node.id, node];
  }));
}
function containingProject(task: QuestionTask, tasks: ReadonlyMap<string, QuestionTask>): string | null {
  const seen = new Set<string>();
  let current: QuestionTask | undefined = task;
  while (current && !seen.has(current.id)) {
    if (current.kind === 'project') return current.id;
    seen.add(current.id);
    current = current.parentId === null ? undefined : tasks.get(current.parentId);
  }
  return null;
}
export function validQuestionDestination(taskId: string, destination: string | null, tasks: ReadonlyMap<string, QuestionNode>): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (destination === null) return true;
  if (task.kind === 'project') return false;
  const target = tasks.get(destination);
  if (!target || target.lifecycle !== 'active' || target.baseState === 'stopped' || target.id === task.id ||
      containingProject(task, tasks) !== containingProject(target, tasks)) return false;
  const seen = new Set<string>([task.id]);
  let parent = task.parentId;
  while (parent !== null && !seen.has(parent)) {
    if (parent === destination) return true;
    seen.add(parent);
    parent = tasks.get(parent)?.parentId ?? null;
  }
  return false;
}
function canAsk(taskId: string, destination: string | null, tasks: ReadonlyMap<string, QuestionNode>,
  responsible: (id: string) => boolean): boolean {
  return validQuestionDestination(taskId, destination, tasks) &&
    (destination === null || tasks.get(destination)?.kind !== 'project' || responsible(destination));
}

/** The current destinations a Run can choose, nearest ancestor first. */
export function questionDestinations(taskId: string, tasks: ReadonlyMap<string, QuestionNode>,
  responsible: (id: string) => boolean): (QuestionNode | null)[] {
  const destinations: (QuestionNode | null)[] = [null];
  const seen = new Set([taskId]);
  for (let id = tasks.get(taskId)?.parentId; id && !seen.has(id); id = tasks.get(id)?.parentId) {
    seen.add(id);
    const node = tasks.get(id);
    if (node && canAsk(taskId, id, tasks, responsible)) destinations.push(node);
  }
  return destinations;
}

/** Rechecks the chosen destination against the write transaction's current tree and placements. */
export function questionDestination(askTo: string, taskId: string, tasks: ReadonlyMap<string, QuestionNode>,
  responsible: (id: string) => boolean = () => false): string | null {
  const destination = askTo === 'user' ? null : askTo;
  if (!canAsk(taskId, destination, tasks, responsible))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Ask the user, a strict ancestor Task in the same project, or the project responsible',
      { task: taskId, destination: askTo }, { reason: { kind: 'question_destination_invalid' } });
  return destination;
}
function lifecycleAt(task: QuestionNode, at?: string): TaskLifecycle {
  if (at === undefined) return task.lifecycle;
  let lifecycle: TaskLifecycle = 'active';
  for (const log of task.log) {
    if (Date.parse(log.at) > Date.parse(at)) continue;
    if (log.kind === 'archived') lifecycle = 'archived';
    if (log.kind === 'deleted') lifecycle = 'deleted';
    if (log.kind === 'restored') lifecycle = 'active';
  }
  return lifecycle;
}
/** Historical open/close and lifecycle facts are read at the Run's end; later changes do not rewrite that boundary. */
export function questionApplicable(taskId: string, asked: AskedLog, tasks: ReadonlyMap<string, QuestionNode>, at?: string): boolean {
  const task = tasks.get(taskId);
  if (!task || lifecycleAt(task, at) !== 'active') return false;
  const project = containingProject(task, tasks), owner = project === null ? undefined : tasks.get(project);
  if (!owner || lifecycleAt(owner, at) !== 'active' || !openQuestions(task.log, at).some(q => q.id === asked.id)) return false;
  // A move closes an invalid destination in its transaction. For a past boundary, that log is the structural witness.
  return at !== undefined || validQuestionDestination(taskId, asked.askedTo, tasks);
}

/** A reply names a fixed question, independently of the Task document version. */
export function replyQuestion(taskId: string, log: readonly TaskLog[], questionId: string) {
  const question = questionsOf(log).find(item => item.asked.id === questionId);
  if (!question) throw new Problem(PROBLEM_CODE.notFound, 'Question does not exist',
    { task: taskId, question: questionId }, { reason: { kind: 'question_does_not_exist' } });
  return question;
}

/** A question whose fixed destination no longer takes it. */
export const destinationGone = (taskId: string, questionId: string) =>
  new Problem(PROBLEM_CODE.questionExpired, 'Question destination is no longer applicable', { task: taskId, question: questionId });

/** The Task's question `questionId` while it is open; refused once answered, withdrawn or expired (raw questionsOf). */
export function assertQuestionOpen(taskId: string, log: readonly TaskLog[], questionId: string) {
  const question = replyQuestion(taskId, log, questionId);
  const detail = { task: taskId, question: questionId };
  if (question.closing?.kind === 'question_expired')
    throw new Problem(PROBLEM_CODE.questionExpired, 'Question destination is no longer applicable', detail,
      { reason: { kind: 'question_destination_invalid' } });
  if (question.closing?.toState === 'stopped')
    throw new Problem(PROBLEM_CODE.questionExpired, 'The question expired when the Task was stopped', detail);
  if (question.closing) throw new Problem(PROBLEM_CODE.questionClosed, 'The question is already closed', detail);
  return question;
}

/**
 * Open questions accept an answer; answered and withdrawn questions accept further instructions from their original
 * recipient. Stopped/moved questions are expired. Permission is still decided exclusively by authorize's task.answer.
 * Call after an entry has matched an existing operation, so later expiry does not invalidate an accepted replay.
 */
export function assertQuestionReplyApplicable(taskId: string, question: ReturnType<typeof replyQuestion>,
  tasks: ReadonlyMap<string, QuestionNode>): void {
  if (closureOf(question)?.kind === 'expired' ||
      !validQuestionDestination(taskId, question.asked.askedTo, tasks))
    throw destinationGone(taskId, question.asked.id);
}

/** Non-question notices keep their existing lifecycle; inactive questions are suspended, never closed or reissued. */
export function questionReturnApplicable(row: { outcome: string; causeLogId: string | null }, tasks: ReadonlyMap<string, QuestionNode>, at?: string): boolean {
  return questionReturnApplicableBy(row, logId => [...tasks.values()].find(task => task.log.some(entry => entry.id === logId))?.id, tasks, at);
}
/**
 * questionReturnApplicable with the Task that holds a log entry found by `asker` (a reverse index), so a read of one
 * Task's returns reads only the Tasks its questions came from.
 */
export function questionReturnApplicableBy(row: { outcome: string; causeLogId: string | null }, asker: (logId: string) => string | undefined,
  tasks: ReadonlyMap<string, QuestionNode>, at?: string): boolean {
  if (row.outcome !== 'question') return true;
  const owner = row.causeLogId === null ? undefined : asker(row.causeLogId);
  const task = owner === undefined ? undefined : tasks.get(owner);
  const asked = task && openQuestions(task.log, at).find(q => q.id === row.causeLogId);
  return !!asked && questionApplicable(task.id, asked, tasks, at);
}
