import type { Task } from "@/data/types";
import type { PeopleIndex } from "@/domain/people";
import { useTranslation } from "react-i18next";
import { askedOfUser, failureCause, leadOf, reasonedTurn } from "@/domain/lead";
import { formatClock } from "@/domain/time";
import { TONE } from "@/components/ui/tone";
import { cn } from "@/lib/utils";
import { TurnReason } from "./TurnReason";

/**
 * The list summary stays independent of the report column. It says what the server lists on the task's row: the
 * question it asks you, why your turn came otherwise, the words written as they are.
 */
export function BriefLine({ task, people, id, className }: { task: Task; people: PeopleIndex; id?: string; className?: string }) {
  const { t } = useTranslation("reader");
  const turn = reasonedTurn(task.ball);
  if (turn) return <TurnReason turn={turn} cause={failureCause(task, people)} className={cn("text-sm text-turn", className)} />;
  const lead = leadOf(task, people);
  const asks = askedOfUser(task);
  const line = lead.failureReason ? t(`history.reasons.${lead.failureReason}`, { defaultValue: t("history.reasons.unknown") }) : lead.line;
  if (!line && !asks) return null;
  return <span id={id} data-card-lead={lead.kind} data-asks={asks ? "" : undefined}
    className={cn("min-w-0 w-full text-sm font-normal [overflow-wrap:anywhere]", asks ? "text-ink" : TONE.quiet, className)}>
    {asks ? <><span className={cn("mr-1.5 font-semibold", TONE.turn)}>{t("ui:turn.question")}</span>{asks}</>
      : <>{lead.kind === "doing" && lead.at && <><time dateTime={lead.at}>{formatClock(lead.at)}</time> · </>}{line}</>}
  </span>;
}
