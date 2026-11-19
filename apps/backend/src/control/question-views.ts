/** Views of the canonical question log, shared by task get and launch text. */
import { closureOf, questionsOf, type Question } from '@alpacawork/raw';
import { isFinished } from '@alpacawork/contract/branch';
import { questionApplicable, type QuestionNode } from './question-rules.js';
export function questionView(task: QuestionNode, question: Question, tasks: ReadonlyMap<string, QuestionNode>) {
  const { asked, closing } = question;
  return { id: asked.id, taskId: task.id,
    destination: asked.askedTo === null ? { kind: 'user' as const } : { kind: 'task' as const, taskId: asked.askedTo },
    title: asked.title!, summary: asked.description!, askedAt: asked.at,
    state: closureOf(question)?.kind ?? 'open' as const,
    applicable: questionApplicable(task.id, asked, tasks),
    ...(closing ? { closedAt: closing.at, ...(closing.closureReason ? { closureReason: closing.closureReason } : {}) } : {}),
    readCommand: `alpacawork task get --task ${task.id} --question ${asked.id}` };
}
export function incomingQuestions(taskId: string, tasks: ReadonlyMap<string, QuestionNode>) {
  return [...tasks.values()].flatMap(task => questionsOf(task.log).filter(q => q.closing === null && q.asked.askedTo === taskId)
    .map(q => questionView(task, q, tasks))).filter(q => q.applicable).sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
}
/** Informational answers on the current path; they grant no authority to change another branch. */
export function relevantAnswers(taskId: string, tasks: ReadonlyMap<string, QuestionNode>) {
  return [...tasks.values()].flatMap(task => questionsOf(task.log).filter(q => {
    if (q.closing?.kind !== 'answered' || q.asked.askedTo === null || q.asked.askedTo === taskId || task.id === taskId) return false;
    let parent = task.parentId;
    const seen = new Set<string>();
    let included = false;
    while (parent && parent !== q.asked.askedTo && !seen.has(parent)) {
      if (parent === taskId) included = true;
      seen.add(parent); parent = tasks.get(parent)?.parentId ?? null;
    }
    return parent === q.asked.askedTo && included;
  }).map(q => ({ ...questionView(task, q, tasks), answerId: q.closing!.id, answeredAt: q.closing!.at,
    sourceFinished: isFinished([...task.log].reverse().find(l => l.toState !== null)?.toState) })));
}

/** Historical decisions remain attributed to their fixed seat even if the asking branch later moves. */
export function decisionsMade(taskId: string, tasks: ReadonlyMap<string, QuestionNode>) {
  return [...tasks.values()].flatMap(task => questionsOf(task.log).filter(q => q.asked.askedTo === taskId && q.closing?.kind === 'answered')
    .map(q => ({ ...questionView(task, q, tasks), answerId: q.closing!.id, answeredAt: q.closing!.at })));
}
