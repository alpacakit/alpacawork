import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ReadFailure } from "@/components/ui/loadable";
import { failedAddress } from "@/lib/failed-address";
import { BarRoom } from "@/features/chrome/Bar";
import { UNDER_BAR } from "@/state/bar";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { useAnalysisFreshness, useTasksView, useUsageView } from "./data";
import { daysBetween, spanLabel } from "./format";
import { PointerTip, ReadPart, Seg, useChoices, useReadSet } from "./parts";
import { analysisSurfaces, cardSpanOf, listOnAnswer, PERIOD_BACK, stepChosen, type AnalysisPlace, type ListPlace } from "./place";
import { TasksLook } from "./TasksLook";
import { FaceSkeleton } from "./FaceSkeleton";
import { UsageLook } from "./UsageLook";
import type { Head, Period, TasksView, UsageView } from "./contract";

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
  // The look's answers are one set (the AI's use draws its finished tasks too): the days said above and the numbers
  // under them are always the same set's, the last whole one until the new choice's has wholly come.
  const set = useReadSet(place.look, place.look === "tasks" ? [tasks] : [usage, tasks]);
  const head: Head | undefined = (set.data?.[0] as { head: Head } | undefined)?.head;
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
    {/* One part, whichever look: the usage look draws the tasks' answer too (its finished tasks), so it is drawn once both
        have come and each for what is chosen now (ReadPart); nothing is put in above what is drawn later. */}
    <ReadPart set={set}
      skeleton={<FaceSkeleton look={place.look} span={place.span} bucket={bucket} />}>
      {([first, finished]) => !days || !head ? <p className="text-soft">{t("usage.none")}</p>
        : place.look === "tasks" ? <TasksLook view={first as TasksView} span={place.span} root={root} days={days} open={open} zone={zoneName(head.timeZone)} />
          : <UsageLook view={first as UsageView} span={place.span} root={root} tasks={finished as TasksView} days={days} open={open} zone={zoneName(head.timeZone)} />}
    </ReadPart>
    </div></div>
    <LaterLayers place={place} project={project} days={days} />
    <PointerTip root={root} />
  </>;
}

/** The analysis's way to the card: over the page, for the span and the project in view. */
function ShareCardButton({ place }: { place: AnalysisPlace }) {
  const { t } = useTranslation("analysis");
  return <Button variant="outline" className="flex-none" onClick={() => useViewStore.getState().showAnalysis({ ...place, list: null, unit: null, card: cardSpanOf(place.span) })}>
    <Icon name="image" className="size-3.5" />{t("card.make")}</Button>;
}

/**
 * What opens over the face (a number's tasks, one task's values, the card) is its own part of the code; the face is not
 * (it is drawn with the list's code, so its only wait is for its answers: FaceSkeleton). The layers' part is fetched
 * when the list has been drawn and the screen is idle, or when the analysis opens; once fetched it is drawn at once.
 * `again`: at its address once more, made new, so the browser asks for it again instead of answering with the failure it
 * remembers for that address.
 */
type LayersPart = typeof import("./Layers");
let layersPart: LayersPart | undefined;
export const loadAnalysisLayers = (again?: string) => (again ? import(/* @vite-ignore */ again) as Promise<LayersPart>
  : import("./Layers")).then(part => layersPart = part);
function LaterLayers(props: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const [part, setPart] = useState(layersPart);
  // A part that could not be fetched is said, where a layer is open, as every read that could not be done, and asked
  // for again: at a new address, or, where the failure names none, by reading the page again.
  const [attempt, setAttempt] = useState<{ again?: string; failure?: unknown }>({});
  useEffect(() => {
    if (part || "failure" in attempt) return;
    let live = true;
    loadAnalysisLayers(attempt.again).then(next => { if (live) setPart(next); }, failure => { if (live) setAttempt({ ...attempt, failure }); });
    return () => { live = false; };
  }, [part, attempt]);
  if (part) return <part.Layers {...props} />;
  if (!("failure" in attempt) || !analysisSurfaces(props.place).length) return null;
  const retry = () => {
    const address = failedAddress(attempt.failure);
    if (!address) { location.reload(); return; }
    setAttempt({ again: `${address.split("?")[0]}?again=${Date.now()}` });
  };
  return <div role="dialog" className="fixed top-window right-window z-(--layer-reader) w-[min(548px,calc(100%-24px))] rounded-pane border-hairline border-lit-line bg-lit p-6 shadow-float narrow:inset-x-0 narrow:top-auto narrow:bottom-0 narrow:w-auto narrow:rounded-b-none">
    <ReadFailure size="region" error={attempt.failure} retry={retry} /></div>;
}
