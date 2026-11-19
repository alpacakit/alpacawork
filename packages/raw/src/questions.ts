/** Browser-safe: the only fold for whether a question is open. It reads one Task's log and nothing else. */
import type { FieldItem } from './control-document.js';
import { closesQuestion, type TaskLog } from './task-log-schema.js';

/** A question: its destination and what it asks (`decide`) are fixed when it is asked, and null is the user. */
export type AskedLog = TaskLog & { kind: 'asked'; askedTo: string | null; decide: FieldItem[] };
/** A question and the first log that closed it: its answer, its withdrawal, or the stop that expired it. */
export type Question = { asked: AskedLog; closing: TaskLog | null };

const isAsked = (entry: TaskLog): entry is AskedLog => entry.kind === 'asked' && entry.askedTo !== undefined && entry.decide !== undefined;
/** An answer or a withdrawal closes the question it names; a stop expires every question asked before it. */
const closes = (entry: TaskLog, asked: AskedLog) =>
  closesQuestion(entry.kind) ? entry.questionId === asked.id : entry.toState === 'stopped';

/** Every question in log order with the first log after it that closed it, or null while it is open. */
export function questionsOf(log: readonly TaskLog[]): Question[] {
  const questions: Question[] = [];
  for (const entry of log) {
    for (const question of questions)
      if (!question.closing && closes(entry, question.asked)) question.closing = entry;
    if (isAsked(entry)) questions.push({ asked: entry, closing: null });
  }
  return questions;
}

/** How a question closed, and when: its answer, its withdrawal, or the stop that expired it; null while it is open. */
type QuestionClosure = { at: string; kind: 'answered' | 'withdrawn' | 'expired' };
export const closureOf = ({ closing }: Question): QuestionClosure | null => closing === null ? null : { at: closing.at,
  kind: closing.kind === 'answered' ? 'answered' : closing.kind === 'question_withdrawn' ? 'withdrawn' : 'expired' };

/** The questions open now, or at `at`: asked by then and not closed by then (a Run's end is judged at its end time). */
export function openQuestions(log: readonly TaskLog[], at?: string): AskedLog[] {
  const time = at === undefined ? Infinity : Date.parse(at);
  return questionsOf(log).filter(({ asked, closing }) =>
    Date.parse(asked.at) <= time && (closing === null || Date.parse(closing.at) > time)).map(({ asked }) => asked);
}

/** A Task's own question to the user, derived from its authoritative log. */
export const hasOpenUserQuestion = (log: readonly TaskLog[]): boolean =>
  openQuestions(log).some(question => question.askedTo === null);
