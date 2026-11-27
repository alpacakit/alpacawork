import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import type { Task, TaskDetail } from "@/data/types";
import { openAutomation } from "@/features/automations/open";
import { useAutomation } from "@/features/automations/data";

/**
 * Under the title of a task an automation made (itself, or an agent below one it made): which automation, as it was
 * named then, and which of its runs (or that it was a trial). Pressed, it opens that automation on any face; one deleted since says so.
 */
export function OriginLine({ task, detail }: { task: Task; detail: TaskDetail | undefined }) {
  const { t } = useTranslation("automations");
  const origin = task.madeBy ?? detail?.logs.find(entry => entry.kind === "created")?.origin;
  const automation = useAutomation(origin?.automationId ?? null).data;
  if (!origin) return null;
  const deleted = automation?.deleted === true;
  return <button type="button" data-task-origin={origin.automationId} disabled={deleted} aria-label={deleted ? undefined : t("origin.open", { id: origin.automationId })}
    onClick={() => openAutomation(origin.automationId)}
    className="mb-1 flex max-w-full items-center gap-1.5 rounded-sm text-start text-sm text-muted enabled:hover:text-ink disabled:cursor-default">
    {/* A trial's task says so: it is not one of the runs it counts. */}
    <span data-task-origin-chip={origin.trial ? "trial" : "run"} className={origin.trial ? "flex-none rounded-sm bg-new/10 px-1 text-xs text-new" : "flex-none rounded-sm px-1 text-xs ring-1 ring-line"}>
      {t(origin.trial ? "origin.trial" : "origin.chip")}</span>
    <span className="min-w-0 [overflow-wrap:anywhere]">
      <span className="tabular-nums">{origin.automationId}</span> {t("origin.line", { name: origin.name })}{!origin.trial && <>{t("join")}{t("origin.run", { number: origin.runNumber })}</>}
      {deleted && <>{t("join")}{t("origin.deleted")}</>}
    </span>
    {!deleted && <Icon name="right" className="size-3.5 flex-none" />}
  </button>;
}
