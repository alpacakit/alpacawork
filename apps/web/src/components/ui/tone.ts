import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { userTurn, type Ball, type HOME_SECTIONS } from "@alpacawork/contract";
import { rowSection } from "@/domain/row-status";
import type { Task, TaskState } from "@/data/types";
import type { IconName } from "./icon";

/**
 * The one place that says what a colour means. Each meaning the screen says by colour is one token in styles.css,
 * named for the meaning, in light and dark. This file gives a task's state and ball their meaning, icon and word, and
 * the class for each meaning; a screen takes its colour from here, or by a token's own class where the meaning is fixed
 * (`text-warn` on a read that failed), never by a value.
 *
 *   turn     Your turn: the task's ball is yours (the server's ball, read by userTurn)
 *   working  Working: someone is at work on it
 *   done     Done
 *   stopped  Stop (a task stopped by hand)
 *   error    Error: a run that ended in one, a stretch that is stuck
 *   todo     Not started
 *   quiet    held, a review whose Run is still at work, and what is said in passing
 *   aside    what a line says under its title (a list row's id, words and time), a step under the title in either theme
 *   late     past its estimate: in ink and a little heavier, not in a colour
 *   plain    ink
 *
 * Tokens with a fixed meaning, used by class: `new` New, `changed` Changed,
 * `warn` Warning (a read, a save or a setting that failed), `scrim` under a dialog, `paper` behind a Task-folder page.
 */
export type Tone = "turn" | "working" | "done" | "stopped" | "error" | "todo" | "quiet" | "aside" | "late" | "plain";

/** Text classes; SVG lines and marks take the same colour through `currentColor`. */
export const TONE: Record<Tone, string> = {
  turn: "text-turn", working: "text-working", done: "text-done", stopped: "text-stopped", error: "text-error",
  todo: "text-todo", quiet: "text-muted", aside: "text-aside", late: "font-medium text-ink", plain: "text-ink",
};

const STATE_TONE = { todo: "todo", doing: "working", error: "error", waiting: "quiet", held: "quiet", done: "done", stopped: "stopped" } as const satisfies Record<TaskState, Tone>;

/** The turn a task's look says: a hold or a failure keeps its own state, whoever's turn it is. */
const visibleTurn = (state: TaskState, ball: Ball | null) => state === "held" || state === "error" ? null : userTurn(ball);

/** Whether the task asks the user a question, shown over working/review states. */
const asksUser = (turn: ReturnType<typeof visibleTurn>) => turn?.reason === "question";

/**
 * A state's meaning and icon. A failure keeps its error colour and icon; other user turns take the turn colour. A wait is for a review, said by
 * its icon, and a question asked of you by its own. A held turn is still yours but set aside, so it is said in grey (and
 * under `data-held`, its turn colour is grey too).
 */
export function stateLook(state: TaskState, ball: Ball | null = null): { tone: Tone; icon: IconName } {
  const turn = visibleTurn(state, ball);
  return { tone: turn !== null ? "turn" : STATE_TONE[state], icon: asksUser(turn) ? "question" : state === "waiting" ? "review" : state };
}

/** A state's meaning, icon and word together; `turn` marks what waits on the reader. */
export function useStateLook(state: TaskState, ball: Ball | null = null) {
  const { t } = useTranslation("ui");
  const look = stateLook(state, ball);
  return { ...look, word: asksUser(visibleTurn(state, ball)) ? t("turn.question") : stateWord(state, t), turn: look.tone === "turn" };
}

/** A state's word; a wait is for a review, so it is said as one (Awaiting review). */
export function useStateWords() {
  const { t } = useTranslation("ui");
  return (state: TaskState): string => stateWord(state, t);
}

export function stateWord(state: TaskState, t: TFunction<"ui">): string {
  switch (state) {
    case "todo": return t("ui:state.todo");
    case "doing": return t("ui:state.doing");
    case "error": return t("ui:state.error");
    case "waiting": return t("ui:state.waitingReview");
    case "held": return t("ui:state.held");
    case "done": return t("ui:state.done");
    case "stopped": return t("ui:state.stopped");
  }
}

/**
 * What a home row's section says over its Task's own look: Waiting is a pause, and Error says the error even on a Task whose
 * state is still Working (a child stopped where its parent cannot mend it). The other sections, and a row drawn outside the
 * list, keep the Task's state look.
 */
const SECTION_LOOK: Record<(typeof HOME_SECTIONS)[number], "state" | "error" | "pause"> =
  { doing: "state", error: "error", review: "state", awaited: "pause", held: "state", todo: "state", done: "state" };

/** A list row's meaning, icon and word: its Task's state look, or what its section says over it (SECTION_LOOK). */
export function useRowLook(task: Pick<Task, "state" | "ball" | "homeRow" | "rowFacts">) {
  const section = rowSection(task);
  const look = section ? SECTION_LOOK[section] : "state";
  const state = task.state !== "held" && task.rowFacts.kind?.kind === "question" ? "waiting" : task.state;
  const own = useStateLook(look === "error" ? "error" : state, look === "error" ? null : task.ball);
  const { t } = useTranslation("tree");
  return look === "pause" ? { ...own, tone: "quiet" as const, icon: "pause" as const, word: t("home.awaited") } : own;
}
