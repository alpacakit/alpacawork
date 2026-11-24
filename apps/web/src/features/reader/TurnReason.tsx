import { useTaskReport } from './use-task-report';
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { useReaderPeople } from "@/data/queries";
import type { Task } from "@/data/types";
import { stoppable } from "@/domain/tasks";
import type { ReasonedTurn } from "@/domain/lead";
import { causeSentence, type ErrorCause } from "@/domain/run-labels";
import { problemReasonText } from "@/data/client";
import { intentAbout, sendIntent, useIntentReady } from "@/features/coordinator/reader-send";
import { focusCoordinator, useInputDraft } from "@/features/coordinator/editor/draft";
import { hasReaderOperation } from "@/features/coordinator/editor/document";
import { Icon } from "@/components/ui/icon";
import { useReaderCard } from "./next-question";
import { useNow } from "@/state/clock";

/** A refused wake's code (wakeBlock's), as its words are named; another code is a refusal said in general. */
const blockKeys: Record<string, string> = {
  no_profile: "noProfile", too_deep: "depth", too_many_children: "children",
  responsible_missing: "responsibleUnavailable", not_resumable: "notResumable",
};

/** The name a turn's reason is said by: its sentence in the reader (ui:turn.reason) and its short word on a row (tree:status.turn). */
export const turnReasonKey = (turn: ReasonedTurn) => turn.reason === "blocked" ? blockKeys[turn.code ?? ""] ?? "refused" : turn.reason;

/**
 * A turn's reason in a sentence; only the limit says a count (how many wait behind it), a failure whose cause is
 * known (failureCause) says that cause's sentence (causeWords) instead, and a refused wake says the business reason serve kept with it.
 */
export const turnSentence = (turn: ReasonedTurn, t: TFunction<"ui">, causeWords?: string | null, stoppable = true) => turn.reason === "limit"
  ? t("turn.reason.limit", { count: turn.count ?? 0 })
  // A refused wake whose business reason serve kept (selection_required and the rest) is said as any refusal's reason is.
  : turn.reason === "blocked" && turn.problemReason ? problemReasonText(turn.problemReason)
  : turn.reason === "failed" && causeWords ? causeWords
  // A failure of what cannot stop (a project) offers only ways to continue, and its sentence says no more.
  : turn.reason === "failed" && !stoppable ? t("turn.reason.failedNoStop") : t(`turn.reason.${turnReasonKey(turn)}`);


/**
 * Why the user's turn came when it is not a review or a question (the ball's reason): automatic wakes stopped at their
 * limit (how many wait behind it), a delivery whose receipt is unknown, a refused wake (its code), a failure of what the
 * user asked. `about` is the Task it is said of, where it is not answered (a project cannot stop, so its failure says no stop).
 * Where the turn is answered (the reader names its `task`), the limit offers Continue and a failure
 * Continue with the same AI, with another AI, or Stop: requests go to the coordinator, Stop reports directly. A failure's
 * known `cause` names what it was.
 */
export function TurnReason({ turn, task, about = task, cause, className }: { turn: ReasonedTurn; task?: Task; about?: Task; cause?: ErrorCause | null; className?: string }) {
  const { t, i18n } = useTranslation("ui");
  const now = useNow();
  const words = turnSentence(turn, t, cause ? causeSentence(cause, t, now, i18n.language, stoppable(about)) : null, stoppable(about));
  const actions = task ? turnActions(turn).filter(action => action !== "stop" || stoppable(task)) : [];
  // The buttons stand on their own row under the sentence, so the sentence keeps its line height to its last line.
  return <span data-turn-reason={turn.reason} data-turn-cause={turn.reason === "failed" && cause ? cause.cause : undefined} className={className}>
    {actions.length ? <><span className="block">{words}</span><TurnActions actions={actions} task={task!} /></> : words}
  </span>;
}

type TurnAction = "continue" | "retry" | "switch" | "stop";
/** Continue on a limit; on a failure, continue with the same AI or another, or Stop where the server allows a stop (a project cannot stop); other turns are answered elsewhere. */
const turnActions = (turn: ReasonedTurn): readonly TurnAction[] => turn.reason === "limit" ? ["continue"] : turn.reason === "failed" ? ["retry", "switch", "stop"] : [];

/**
 * The turn's buttons: Continue and Continue with the same AI send their intent at once; Continue with another AI puts
 * its line in the input, as a send-back does, for the person to say which AI before sending; Stop reports directly
 * with the displayed Task versions.
 */
function TurnActions({ actions, task }: { actions: readonly TurnAction[]; task: Task }) {
  const { t } = useTranslation("ui");
  const people = useReaderPeople(task.id);
  const card = useReaderCard();
  const ready = useIntentReady(task);
  const draft = useInputDraft();
  const report = useTaskReport(task, people, card);
  const words: Record<TurnAction, string> = { continue: t("turn.continue"), retry: t("turn.retry"), switch: t("turn.switch"), stop: t("turn.stop") };
  const press = (action: TurnAction) => {
    if (action === "stop") report.submit("stop");
    else if (action === "switch") { if (draft.intend(task, intentAbout(task, action, people), t("reader:intent.switch"))) focusCoordinator(); }
    else sendIntent(intentAbout(task, action, people), card);
  };
  const disabled = (action: TurnAction) => action === "stop" ? !report.ready
    : action === "switch" ? !ready || draft.locked || hasReaderOperation(draft.doc) : !ready;
  return <span className="mt-2 flex flex-wrap gap-2">{actions.map((action) => <Button key={action} variant="outline" data-turn-action={action} className="min-h-6 px-2 text-xs"
    disabled={disabled(action)} onClick={() => press(action)}>{action === "switch" && <Icon name="edit" className="size-3.5" />}{words[action]}</Button>)}</span>;
}
