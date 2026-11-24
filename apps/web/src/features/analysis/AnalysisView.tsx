import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { BarRoom } from "@/features/chrome/Bar";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { useAnalysisFreshness, useTasksView, useUsageView } from "./data";
import { daysBetween, spanLabel } from "./format";
import { Layers } from "./Layers";
import { PointerTip, Seg, useChoices } from "./parts";
import { stepSpan, type AnalysisPlace, type ListPlace, type Span } from "./place";
import { TasksLook } from "./TasksLook";
import { UsageLook } from "./UsageLook";
import type { Head, Period } from "./contract";

const PRESETS: { period: Period; back: number | null }[] = [{ period: "today", back: 0 }, { period: "7d", back: 6 }, { period: "28d", back: 27 }, { period: "all", back: null }];

/**
 * A span as it is kept: whole days that end today and are as long as a named period are that period, so the period's
 * switch shows chosen and the URL stays short.
 */
export function settleSpan(days: { from: string; to: string }, today: string): Span {
  if (days.to !== today) return days;
  const length = daysBetween(days.from, days.to);
  const preset = PRESETS.find(each => each.back !== null && each.back + 1 === length);
  return preset ? { period: preset.period } : days;
}

/** The zone the days are counted in, by its name in the reader's language. */
function zoneName(zone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "long" }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value ?? zone;
  } catch { return zone; }
}

/**
 * The analysis face: what can be counted from the records, for the project in view. The same left edge as the list;
 * the look (tasks, or the AI's use) and the span of days at the top, then the look. Every number opens the tasks
 * behind it over the page (`Layers`).
 */
export function AnalysisView({ place }: { place: AnalysisPlace }) {
  const { t } = useTranslation("analysis");
  useAnalysisFreshness();
  const project = useViewStore(state => state.project);
  const { bucket, taskGroup, usageGroup } = useChoices();
  const tasks = useTasksView(project, place.span, bucket, taskGroup);
  const usage = useUsageView(project, place.span, bucket, usageGroup);
  const query = place.look === "tasks" ? tasks : usage;
  const head: Head | undefined = query.data?.head;
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const show = (next: Partial<AnalysisPlace>) => useViewStore.getState().showAnalysis({ ...place, ...next });
  const pick = (days: { from: string; to: string }) => head && show({ span: settleSpan(days, head.today), list: null, unit: null });
  const open = (list: Omit<ListPlace, "group" | "member"> & Partial<Pick<ListPlace, "group" | "member">>) =>
    show({ list: { group: null, member: null, ...list }, unit: null });
  const days = head?.period ?? null;
  const length = days ? daysBetween(days.from, days.to) : 0;
  const preset = "period" in place.span ? place.span.period : null;
  const step = (direction: -1 | 1) => days && head && show({ span: settleSpan(stepSpan(days, direction), head.today), list: null, unit: null });
  const canEarlier = !!days && !!head?.firstDay && stepSpan(days, -1).from >= head.firstDay;
  const canLater = !!days && !!head && stepSpan(days, 1).to <= head.today;

  return <div ref={setRoot} className="flex flex-1 flex-col pb-12">
    <BarRoom />
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1 pb-6">
      <Seg label={t("look.label")} value={place.look} onChange={look => { useChoices.getState().choose({ all: false, rules: false, grow: useChoices.getState().grow + 1 }); show({ look }); }}
        items={[["tasks", t("look.tasks")], ["usage", t("look.usage")]]} />
      <div className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-2 narrow:ms-0 narrow:w-full">
        <Seg label={t("period.label")} value={preset ?? ""} onChange={period => show({ span: { period: period as Period }, list: null, unit: null })}
          items={PRESETS.map(each => [each.period, t(`period.${each.period}`)] as const)} />
        <div className="flex items-center gap-0.5 whitespace-nowrap narrow:w-full">
          <button type="button" aria-label={t("period.earlier")} title={t("period.earlier")} disabled={!canEarlier} onClick={() => step(-1)}
            className="grid size-7 flex-none place-items-center rounded-md text-muted hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent">
            <Icon name="left" className="size-3.5" /></button>
          <b className="min-w-[13em] px-1.5 text-center font-semibold narrow:min-w-0 narrow:flex-1">
            {days ? `${spanLabel(days.from, days.to)}${length > 1 && !preset ? `${t("sep")}${t("period.days", { count: length })}` : ""}` : " "}</b>
          <button type="button" aria-label={t("period.later")} title={t("period.later")} disabled={!canLater} onClick={() => step(1)}
            className="grid size-7 flex-none place-items-center rounded-md text-muted hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent">
            <Icon name="right" className="size-3.5" /></button>
        </div>
      </div>
    </div>
    <div className={cn("transition-opacity duration-(--motion-base)", query.isPlaceholderData && "opacity-60")}>
      {query.data && !days ? <p className="text-soft">{t("usage.none")}</p>
        : !query.data || !days || !head ? query.isError ? <p className="text-soft">{query.error.message}</p> : <RegionSkeleton shape="rows" rows={8} />
        : place.look === "tasks" && tasks.data ? <TasksLook view={tasks.data} days={days} open={open} pick={pick} zone={zoneName(head.timeZone)} />
          : usage.data && <UsageLook view={usage.data} days={days} open={open} pick={pick} zone={zoneName(head.timeZone)} />}
    </div>
    <Layers place={place} project={project} days={days} />
    <PointerTip root={root} />
  </div>;
}
