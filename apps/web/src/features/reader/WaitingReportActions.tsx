import { createContext, useContext, useMemo, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { TaskDetail } from "@/data/types";
import { decideOf, isOther, isStop, offeredChoices, type Choice, type Question } from "@/domain/questions";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { useInputDraft, answerInDraft, focusCoordinator } from '@/features/coordinator/editor/draft';
import { answersIn, toggleAnswer, choiceAnswer, sameAnswer, sameQuestion, type Answer } from '@/features/coordinator/editor/document';
import { useWriteDisabled } from '@/data/queries';
import { MarkdownBody } from "./MarkdownBody";
import { useCueAnswer } from "./answer-cue";
import { useAskedChoice } from "./swipe-refusal";
import { useReaderTurnUnadmitted } from './next-question';
import { useSteadyControl } from '@/lib/steady-control';

/** An open question asked of the user: its ID, which an answer names, and what it asks as fixed when it was asked. */
type Asked = { id: string; questions: Question[] };

/**
 * The question the choices answer: `id`, the record drawn, while it is open and asked of the user, read from what
 * its record fixed when it was asked. Null for any other record, one asked of the parent and one closed.
 */
function useAsked(task: Pick<TaskDetail, "questions">, id: string | null): Asked | null {
  const question = id === null ? undefined : task.questions.find(each => each.id === id && each.destination.kind === "user");
  const questionId = question?.id, items = question?.decide;
  // Draft edits redraw the choices, but what was asked needs reading only when it changes.
  return useMemo(() => questionId === undefined || items === undefined ? null : { id: questionId, questions: decideOf(items) }, [questionId, items]);
}

/**
 * Choices toggle badges in the coordinator's draft (answerInDraft); after them each question offers Other (none of
 * them), chosen the same way, with the input brought up to say what instead. Sending happens only in its editor.
 */
function useWaitingAnswer(task: TaskDetail, question: string | null) {
  const { t } = useTranslation("reader");
  // Readable questions remain visible during refresh or offline restoration.
  // The shared write guard below owns whether their answers can be changed.
  const asked = useAsked(task, question);
  const draft = useInputDraft();
  // A choice only puts an answer in the input, so it waits as sending does: until serve admits the last message.
  const unadmitted = useReaderTurnUnadmitted(task.id);
  // Those waits are short in ordinary use, so the choices dim only when one lasts; a press in one toggles once it ends,
  // while the same question is still asked (useSteadyControl).
  const steady = useSteadyControl(useWriteDisabled(task.id) || draft.locked || unadmitted, asked?.id);
  const disabled = steady.disabled;
  const cueAnswer = useCueAnswer(disabled);
  const answer = (question: Question, choice: Choice) => steady.press((event: MouseEvent<HTMLElement>) => {
    if (!asked) return;
    const badge = choiceAnswer(task, asked.id, question, choice);
    const button = event.currentTarget;
    // Other put in asks for the words that say what instead.
    const write = isOther(question, choice) && !on(question, choice) ? { task: task.id, question: asked.id, n: question.n } : null;
    answerInDraft(draft, doc => {
      const next = toggleAnswer(doc, task, badge);
      cueAnswer({ button, task: task.id, question: asked.id, n: question.n, answer: choice.answer, adds: answersIn(next, task.id).some(each => sameQuestion(each, { question: asked.id, n: question.n })) });
      return next;
    }, write);
  });
  // A press leaves focus where it is (the person's, in the input, or none): on a phone the input losing it puts the
  // keyboard down under the press, as gaining it raises it. Keys and a computer's opened input are as before.
  const keepFocus = (event: MouseEvent) => event.preventDefault();
  // A choice is on while the draft holds it for this question: the same number of another question is another answer.
  const on = (question: Question, choice: Choice, answers?: readonly Answer[]) => !!asked && (answers ?? answersIn(draft.doc, task.id)).some(each => sameQuestion(each, { question: asked.id, n: question.n }) && each.answer === choice.answer);
  /**
   * The question's choices, Stop when it offers one (with a cross: choosing it stops the task), then Other (dashed,
   * with a pen: it brings the input up to write in); a question with no choices is answered by writing (Write an answer).
   */
  const offered = (question: Question) => offeredChoices(question,
    { stop: t("answer.stop"), other: t(question.choices.length ? "answer.other" : "answer.write") });
  // Recommended sits on its button's top edge: it takes no width, stays with its own button, and reads apart from what is
  // chosen (filled). The button holds it, so it is read with the choice's name. It rises 1rem over the edge, and its
  // button keeps that 1rem over itself (room), so the label is clear of what is above it by the gap that place already
  // has: the words before the choices, or the choice before. The other choices keep their gaps as they are.
  const choices = (question: Question, className: string, onFollow: (id: string) => void) => {
    const offeredChoices = offered(question);
    // Share the collection for display; event handlers still read through on() when pressed.
    const answers = asked && offeredChoices.length ? answersIn(draft.doc, task.id) : undefined;
    return offeredChoices.map(choice => {
      const selected = on(question, choice, answers), recommended = choice.recommended !== null, other = isOther(question, choice);
      return <div key={choice.answer}
        className={cn("min-w-0", choice.text && "w-full")}><Button variant="outline"
        aria-pressed={selected} className={cn("relative whitespace-normal text-left", className, recommended && "mt-4",
          other && !selected && "border-dashed bg-transparent text-muted hover:text-ink", selected && "border-turn bg-picked hover:bg-picked-hover")}
        disabled={disabled} onMouseDown={keepFocus} onClick={answer(question, choice)}>
        {other && <Icon name="edit" className="size-3.5 flex-none text-muted" />}{choice.name}
        {recommended && <span data-recommended
          className="pointer-events-none absolute -top-4 left-2 rounded-full border border-turn bg-lit px-1.5 text-xs whitespace-nowrap text-turn">{t("brief.recommended")}</span>}
        {isStop(question, choice) && <Icon name="close" aria-label={t("answer.stopMark")} className="ml-1.5 size-3.5 flex-none text-muted" />}
      </Button>
        {choice.text ? <div className="mt-type-close pl-2.5"><MarkdownBody text={choice.text} task={task} onFollow={onFollow} report /></div> : null}
        {choice.recommended ? <p data-recommended-why className="m-0 mt-type-close pl-2.5 text-sm text-turn">{choice.recommended}</p> : null}
      </div>;
    });
  };
  // A row of choices side by side: the room over the picked one does not stretch the others in its row taller, they
  // stand on the row's foot with it.
  const row = (question: Question) => cn("flex flex-wrap gap-1.5", question.choices.some(choice => choice.recommended !== null) && "items-end");
  return { asked, choices, row };
}

/** The open Task as the feed holds it now, whole: its rows hold only what they draw of it (ReportFeed), and answering
 * needs all of it, current (its hash, its questions). */
export const FeedTask = createContext<TaskDetail | null>(null);

export function FeedWaitingActions({ question, onFollow }: { question: string; onFollow: (id: string) => void }) {
  const task = useContext(FeedTask);
  if (!task) throw new Error("FeedWaitingActions stands inside a feed");
  return <WaitingReportActions task={task} question={question} onFollow={onFollow} />;
}

/**
 * The open question `question` asked of the user in the column, under its report, on a quiet panel: each question with
 * its number among them, what it says, and its choices to press (as small as the column's other controls on a wide screen).
 */
export function WaitingReportActions({ task, question, onFollow }: { task: TaskDetail; question: string; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const { asked, choices, row } = useWaitingAnswer(task, question);
  const refused = useAskedChoice(state => state.asked);
  if (!asked) return null;
  const { questions } = asked, count = questions.length;
  return <div data-waiting-report-actions className="mt-4 rounded-lg bg-well px-4 py-3 narrow:px-3">
    {questions.map((question, at) => <section key={question.n} data-question={question.n} data-written={question.choices.length ? undefined : ""}
      className={cn("scroll-my-20 py-2", at > 0 && "mt-1 border-t border-rule pt-3")}>
      <p data-question-number className="m-0 text-xs text-muted tabular-nums">{t("answer.question", { total: count, n: at + 1 })}</p>
      <h3 className="m-0 mt-type-close text-md font-semibold">{question.ask}</h3>
      <div role="group" aria-label={question.ask} className={cn("mt-type-block", row(question))}>
        {choices(question, "h-auto min-h-control-sm bg-lit px-2.5 py-1 text-sm narrow:min-h-11", onFollow)}</div>
      {/* Why a right swipe did not send: said here, under what is left to choose (askChoice). */}
      <p data-ask-hint role="status" className="m-0 text-sm text-turn not-empty:mt-1.5">
        {!!refused && sameAnswer(refused, { task: task.id, question: asked.id, n: question.n }) && (refused.words
          ? <Button variant="ref" className="text-turn decoration-turn pointer-coarse:min-h-11" onClick={() => focusCoordinator({ task: task.id, question: asked.id, n: question.n })}>{t(refused.said ? "swipe.writeAfterOther" : "swipe.otherWords")}</Button>
          : !refused.said && t(question.choices.length ? "swipe.choose" : "swipe.write"))}</p>
      {question.note && <div className="mt-type-block"><MarkdownBody text={question.note} task={task} onFollow={onFollow} /></div>}
    </section>)}
  </div>;
}
