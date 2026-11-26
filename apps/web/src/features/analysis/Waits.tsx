import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { duration, share } from "./format";
import { tip } from "./parts";

/**
 * The time the user was waited on, by where the user was (`waits` of the analysis answers): away (nothing done anywhere
 * for 30 minutes), on other tasks, or free for this one, each with its share of `total`.
 */
export function Waits({ waits, total, className }: { waits: { away: number; otherTasks: number; thisTask: number }; total: number; className?: string }) {
  const { t } = useTranslation("analysis");
  const parts = [["away", waits.away], ["otherTasks", waits.otherTasks], ["thisTask", waits.thisTask]] as const;
  return <ul data-waits="" className={cn("flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted", className)}>
    {parts.map(([key, ms]) => <li key={key} className="whitespace-nowrap" {...tip(t(`waits.${key}Tip`))}>
      {t(`waits.${key}`)} <b className="font-semibold text-ink tabular-nums">{duration(ms)}</b>
      {total > 0 && <span className="ms-1 text-soft">{share(ms / total)}</span>}</li>)}
  </ul>;
}
