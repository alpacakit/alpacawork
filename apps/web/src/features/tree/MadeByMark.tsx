import { useTranslation } from "react-i18next";
import type { Task } from "@/data/types";
import { cn } from "@/lib/utils";

/**
 * "Auto" ("Trial" for one made by trying it) on the row of a task an automation created itself, so the person tells it from the ones they asked for;
 * pointed at, it names the automation as it was named then. Tasks an agent created below one carry no mark.
 */
export function MadeByMark({ task, className }: { task: Pick<Task, "madeBy">; className?: string }) {
  const { t } = useTranslation("automations");
  if (!task.madeBy) return null;
  const trial = task.madeBy.trial === true;
  const tip = t(trial ? "origin.trialTip" : "origin.tip", { id: task.madeBy.automationId, name: task.madeBy.name });
  // Above the row's press (its cover), so a pointer resting on it reads the tip; a press on it still opens the row.
  return <span data-made-by={task.madeBy.automationId} title={tip} aria-label={tip}
    className={cn("relative z-1 flex-none rounded-sm px-1 text-xs", trial ? "bg-new/10 text-new" : "text-muted ring-1 ring-line", className)}>{t(trial ? "origin.trial" : "origin.chip")}</span>;
}
