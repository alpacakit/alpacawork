import { OTHER_WORD, STOP_WORD, choiceWord } from "@alpacawork/contract";
/**
 * A question's `decide` items (what it asks, fixed when it was asked: the task view's `questions[].decide`) as the
 * screen draws them: each question with its number, its choices to press and its note. Pressing a choice answers
 * `<n>-<its word>`. Two choices are the app's own, named by the screen in the reader's language and answered by a
 * word the app keeps: Stop (offered when the question says what stopping means), which stops the task instead of
 * answering, and Other, which every question offers.
 */
export type Choice = { name: string; answer: string; text: string; recommended: string | null };
export type Question = { n: string; ask: string; choices: Choice[]; stop: string | null; note: string };

/** How an answer is written: the question's number, then the word that answers it. */
const answerKey = (n: string, word: string) => `${n}-${word}`;
const text = (value: unknown) => typeof value === "string" ? value : "";

/** The one reading of a question's choices: its items as its asking record fixed them, never the task's values now. */
export function decideOf(items: readonly Record<string, unknown>[]): Question[] {
  return items.map((item, at) => {
    const n = String(at + 1), choices = Array.isArray(item.decide_choices) ? item.decide_choices as Record<string, unknown>[] : [];
    return { n, ask: text(item.decide_question), stop: text(item.decide_stop) || null, note: text(item.decide_note),
      choices: choices.map(choice => ({ name: text(choice.decide_choice), answer: answerKey(n, choiceWord(text(choice.decide_choice))),
        text: text(choice.decide_choice_detail), recommended: text(choice.decide_choice_recommended) || null })) };
  });
}

/** An answer is Stop or Other by its word, wherever it is read. */
export const isOtherAnswer = (answer: { n: string; answer: string }) => answer.answer === answerKey(answer.n, OTHER_WORD);
export const isStop = (question: Question, choice: Choice) => choice.answer === answerKey(question.n, STOP_WORD);
export const isOther = (question: Question, choice: Choice) => isOtherAnswer({ n: question.n, answer: choice.answer });
/**
 * What a question offers to press, in order: its choices, Stop with what stopping means here (when it says so), then
 * Other, chosen as one of them is (one per question, pressed again to take back) with the person's own words to
 * follow; for a question with no choices it is how it is answered. `names` are the two as the screen reads them.
 */
export function offeredChoices(question: Question, names: { stop: string; other: string }): Choice[] {
  return [...question.choices,
    ...question.stop === null ? [] : [{ name: names.stop, answer: answerKey(question.n, STOP_WORD), text: question.stop, recommended: null }],
    { name: names.other, answer: answerKey(question.n, OTHER_WORD), text: "", recommended: null }];
}
