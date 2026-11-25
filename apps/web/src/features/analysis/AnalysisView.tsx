import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { BarRoom } from "@/features/chrome/Bar";
import { UNDER_BAR } from "@/state/bar";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { answerOf, useAnalysisFreshness, useTasksView, useUsageView } from "./data";
import { daysBetween, spanLabel } from "./format";
import { Layers } from "./Layers";
import { ShareCardButton } from "./ShareCard";
import { PointerTip, Seg, Shown, useChoices } from "./parts";
import { listOnAnswer, PERIOD_BACK, stepChosen, type AnalysisPlace, type ListPlace } from "./place";
import { TasksLook } from "./TasksLook";
import { UsageLook } from "./UsageLook";
import type { Head, Period } from "./contract";

const PRESETS = PERIOD_BACK;

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
  const { bucket } = useChoices();
  // What is seen first is read first: the look shown (the AI's use draws the tasks' finished too); its breakdown reads
  // on its own when it comes near the screen (TasksBreakdown, Breakdown).
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const tasks = useTasksView(project, place.span, bucket, null);
  const usage = useUsageView(project, place.span, bucket, null, place.look === "usage");
  const query = place.look === "tasks" ? tasks : usage;
  const head: Head | undefined = query.data?.head;
  const show = (next: Partial<AnalysisPlace>) => useViewStore.getState().showAnalysis({ ...place, ...next });
  // A number opens the tasks it was counted from: in the span of the answer it stands in, whatever was chosen since. The
  // same function whatever is open over the face, so opening a list does not draw the face again (its looks are memo).
  const latest = useRef({ place, head });
  useLayoutEffect(() => { latest.current = { place, head }; });
  const open = useCallback((list: Omit<ListPlace, "group" | "member"> & Partial<Pick<ListPlace, "group" | "member">>) => {
    const { place, head } = latest.current;
    if (head) useViewStore.getState().showAnalysis(listOnAnswer(place, head, { group: null, member: null, ...list }));
  }, []);
  const days = head?.period ?? null;
  const length = days ? daysBetween(days.from, days.to) : 0;
  const preset = "period" in place.span ? place.span.period : null;
  // The arrows move from the span chosen now, even while the answer for it is still on its way.
  const earlier = head ? stepChosen(place.span, head, -1) : null, later = head ? stepChosen(place.span, head, 1) : null;
  const step = (direction: -1 | 1) => { const to = direction < 0 ? earlier : later; if (to) show({ span: to, list: null, unit: null, card: null }); };
  const canEarlier = !!earlier, canLater = !!later;

  // The page scrolls as the list does, under the bar and clear of what stands at the screen's foot (--list-foot).
  return <><div ref={setRoot} data-list-scroll {...UNDER_BAR}
    className="relative min-h-75 flex-1 basis-0 overflow-auto overscroll-contain scroll-pb-(--list-foot) pb-(--list-foot) narrow:min-h-67.5">
    <div className="pb-12"><BarRoom />
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1 pb-8">
      <Seg label={t("look.label")} value={place.look} onChange={look => { useChoices.getState().choose({ all: false, grow: useChoices.getState().grow + 1 }); show({ look }); }}
        items={[["tasks", t("look.tasks")], ["usage", t("look.usage")]]} />
      {/* The card's way in stands at the row's end: beside the span on a computer, beside the looks on a phone, where
          the span takes a line of its own. */}
      <div className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-2 narrow:order-last narrow:ms-0 narrow:w-full">
        <Seg label={t("period.label")} value={preset ?? ""} onChange={period => show({ span: { period: period as Period }, list: null, unit: null, card: null })}
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
      <span className="narrow:ms-auto"><ShareCardButton place={place} /></span>
    </div>
    {/* While the answer for what was just chosen is on its way, the one shown is another's: dimmed, and out of reach. */}
    {/* The usage look draws the tasks' answer too (its finished tasks): both must be for what is chosen now. */}
    <Shown current={(answerOf<unknown>(query)?.current ?? true) && (place.look === "tasks" || (answerOf<unknown>(tasks)?.current ?? true))}>
      {query.data && !days ? <p className="text-soft">{t("usage.none")}</p>
        : !query.data || !days || !head ? query.isError ? <ReadFailure error={query.error} retry={() => void query.refetch()} />
          : <RegionSkeleton shape={place.look === "tasks" ? "analysisTasks" : "analysisUsage"} />
        : place.look === "tasks" && tasks.data ? <TasksLook view={tasks.data} span={place.span} root={root} days={days} open={open} zone={zoneName(head.timeZone)} />
          : usage.data && <UsageLook view={usage.data} span={place.span} root={root} tasks={tasks.data ?? null} days={days} open={open} zone={zoneName(head.timeZone)} />}
    </Shown>
    </div></div>
    <Layers place={place} project={project} days={days} />
    <PointerTip root={root} />
  </>;
}
