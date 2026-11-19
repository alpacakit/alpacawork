import { useTaskReport } from './use-task-report';
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { useReaderPeople } from "@/data/queries";
import type { Task } from "@/data/types";
import type { ReasonedTurn } from "@/domain/lead";
import { causeSentence, type ErrorCause } from "@/domain/run-labels";
import { problemReasonText } from "@/data/client";
import { intentAbout, sendIntent, useIntentReady } from "@/features/coordinator/reader-send";
import { useReaderCard } from "./next-question";

/** A refused wake's code (wakeBlock's), as its words are named; another code is a refusal said in general. */
const blockKeys: Record<string, string> = {
  no_profile: "noProfile", too_deep: "depth", too_many_children: "children",
  responsible_missing: "responsibleUnavailable", not_resumable: "notResumable",
};

/** The name a turn's reason is said by: its sentence in the reader (ui:turn.reason) and its short word on a row (tree:status.turn). */
export const turnReasonKey = (turn: ReasonedTurn) => turn.reason === "blocked" ? blockKeys[turn.code ?? ""] ?? "refused" : turn.reason;

/**
 * A turn's reason in a sentence; only the limit says a count (how many wait behind it), a failure whose cause is
 * known (failureCause) says that cause instead, and a refused wake says the business reason serve kept with it.
 */
export const turnSentence = (turn: ReasonedTurn, t: TFunction<"ui">, cause?: ErrorCause | null) => turn.reason === "limit"
  ? t("turn.reason.limit", { count: turn.count ?? 0 })
  // A refused wake whose business reason serve kept (selection_required and the rest) is said as any refusal's reason is.
  : turn.reason === "blocked" && turn.problemReason ? problemReasonText(turn.problemReason)
  : turn.reason === "failed" && cause ? causeSentence(cause, t) : t(`turn.reason.${turnReasonKey(turn)}`);

/**
 * Why the user's turn came when it is not a review or a question (the ball's reason): automatic wakes stopped at their
 * limit (how many wait behind it), a delivery whose receipt is unknown, a refused wake (its code), a failure of what the
 * user asked. Where the turn is answered (the reader names its `task`), the limit offers Continue and a failure Retry and
 * Stop: requests go to the coordinator, Stop reports directly. A failure's known `cause` names what it was.
 */
export function TurnReason({ turn, task, cause, className }: { turn: ReasonedTurn; task?: Task; cause?: ErrorCause | null; className?: string }) {
  const { t } = useTranslation("ui");
  const words = turnSentence(turn, t, cause);
  return <span data-turn-reason={turn.reason} data-turn-cause={turn.reason === "failed" && cause ? cause : undefined} className={className}>
    {words}{task && <TurnActions turn={turn} task={task} />}
  </span>;
}

/** Continue on a limit, Retry and Stop on a failure: requests carry their intent; Stop reports directly with the displayed Task versions. */
function TurnActions({ turn, task }: { turn: ReasonedTurn; task: Task }) {
  const { t } = useTranslation("ui");
  const people = useReaderPeople(task.id);
  const card = useReaderCard();
  const ready = useIntentReady(task);
  const report = useTaskReport(task, people, card);
  const words = { continue: t("turn.continue"), retry: t("turn.retry"), stop: t("turn.stop") };
  const actions: readonly (keyof typeof words)[] = turn.reason === "limit" ? ["continue"] : turn.reason === "failed" ? ["retry", "stop"] : [];
  return actions.map((action) => <Button key={action} variant="outline" data-turn-action={action} className="ml-2 min-h-6 px-2 text-xs"
    disabled={action === 'stop' ? !report.ready : !ready} onClick={() => { if (action === 'stop') report.submit('stop'); else sendIntent(intentAbout(task, action, people), card); }}>{words[action]}</Button>);
}
