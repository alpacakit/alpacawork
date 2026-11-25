import { useTranslation } from "react-i18next";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { format } from "./format";
import { useUsageSeries } from "./data";
import { Seg, useChoices } from "./parts";
import { bySlot, EFFORT_NONE, filtered, slotsOf, type LaunchFilter, type SeriesBy, type Slot } from "./series";
import type { Bin, DayList, PartItem, RowSay } from "./rows";
import type { Bucket, UsageSeriesView } from "./contract";
import type { Open } from "./TasksLook";

type Days = { from: string; to: string };

/** The launches chart's answers (data.ts `useLaunchReads`): the whole record under the filter, without it, and the span under it. */
export type LaunchAnswers = [UsageSeriesView, UsageSeriesView, UsageSeriesView];

/**
 * The launches by model (its name with the version) or by effort, the two apart: each bin's launches stacked in the
 * colour of their model or effort, and the span's on the left, under one filter of a model and an effort. The numbers
 * are the server's (`analysis usage-series`): the screen only folds the models past the fifth into one grey. The
 * colours are the whole record's without a filter, so none moves as a filter is chosen. `ready`: the chart's answer
 * stands on the same bins as the other charts; until it does, the row draws the launches in one colour as the use's
 * answer gives them.
 */
export function useLaunches(bins: Bin[], [chart, colours, span]: LaunchAnswers) {
  const { t } = useTranslation("analysis");
  const { launchBy: by, launchFilter: filter } = useChoices();
  const slots = colours.by === by ? slotsOf(by, colours.groups) : [];
  const ready = chart.by === by && span.by === by && slots.length > 0
    && chart.points.length === bins.length && chart.points[0]?.from === bins[0]?.from;
  const counts = ready ? bySlot(slots, chart) : null, spanCounts = ready ? bySlot(slots, span) : null;
  const nameOf = (slot: Slot) => slot.other !== undefined ? t("usage.otherModels", { count: slot.other })
    : slot.label ?? t("usage.effortNone");
  // A part opens its own launches (one model or one effort), under the filter; the rest folded into one opens none.
  const member = (slot: Slot) => slot.keys.length === 1 ? { group: by, member: slot.keys[0]! } : null;
  return {
    by, filter, ready, slots, colours, isFiltered: filtered(filter),
    total: (at: number) => chart.points[at]?.total ?? 0,
    spanTotal: span.total,
    /** A bin's parts, those with launches, in the order they stack. */
    parts: (at: number) => counts ? slots.flatMap((slot, index) => counts.points[at]![index]! > 0 ? [{ slot, value: counts.points[at]![index]! }] : []) : [],
    spanParts: () => spanCounts ? slots.flatMap((slot, index) => spanCounts.totals[index]! > 0 ? [{ slot, value: spanCounts.totals[index]! }] : []) : [],
    nameOf, member,
  };
}
export type Launches = ReturnType<typeof useLaunches>;

/** What the launches row says of a bin: its total, and its parts by colour, each opening its own launches of that bin. */
export function launchesSay(launches: Launches, name: string, line: RowSay["line"], extra: RowSay["parts"]): RowSay {
  const share = (value: number, all: number) => all ? `${Math.round(value / all * 100)}%` : "";
  const list = (more: Partial<DayList>) => (bin: Bin): DayList => ({ set: "used", value: "launches", from: bin.from, to: bin.to, filter: launches.filter, ...more });
  return {
    name, total: at => format("times", launches.total(at)), line, list: bin => list({})(bin),
    parts: at => [...launches.parts(at).map(({ slot, value }) => ({
      color: slot.color, name: launches.nameOf(slot), value: format("times", value), share: share(value, launches.total(at)),
      list: launches.member(slot) ? list(launches.member(slot)!) : undefined,
    })), ...extra?.(at) ?? []],
  };
}

/** The span's launches by colour on the left, each opening its own launches of the span. */
export function launchesParts(launches: Launches, open: Open): PartItem[] {
  const all = launches.spanTotal ?? 0;
  return launches.spanParts().map(({ slot, value }) => ({
    color: slot.color, name: launches.nameOf(slot),
    value: <b className="font-semibold tabular-nums">{format("times", value)}</b>,
    share: all ? `${Math.round(value / all * 100)}%` : "",
    onOpen: launches.member(slot) ? () => open({ set: "used", value: "launches", ...launches.member(slot)!, filter: launches.filter }) : undefined,
  }));
}

/** A filter's choices from one answer: models by their launches, efforts in their order, none recorded last. */
function choicesOf(by: SeriesBy, view: UsageSeriesView | undefined, nameOf: (slot: Slot) => string): (readonly [string, string])[] {
  if (!view) return [];
  if (by === "effort") return slotsOf("effort", view.groups).map(slot => [slot.value ?? EFFORT_NONE, nameOf(slot)] as const);
  return [...view.groups].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .flatMap(group => group.value === null ? [] : [[group.value, group.label] as const]);
}

/**
 * What the launches are coloured by and filtered to: the model or the effort, then one model and one effort (each "all"
 * at first). A filter keeps what it is coloured by. The choices are the whole record's: those of what the chart is
 * coloured by are its colours' answer; the other's are read once the face is drawn, not with it (a phone opens its
 * choices at the touch, too soon to read them then).
 */
export function LaunchControls({ launches, bucket }: { launches: Launches; bucket: Bucket }) {
  const { t } = useTranslation("analysis");
  const choose = useChoices(state => state.choose);
  const project = useViewStore(state => state.project);
  const other: SeriesBy = launches.by === "model" ? "effort" : "model";
  const otherRead = useUsageSeries(project, { period: "all" }, bucket, other, null);
  const choices = { [launches.by]: choicesOf(launches.by, launches.colours, launches.nameOf), [other]: choicesOf(other, otherRead.data, launches.nameOf) } as Record<SeriesBy, (readonly [string, string])[]>;
  const set = (next: Partial<LaunchFilter>) => choose({ launchFilter: { ...launches.filter, ...next } });
  const select = "h-7 max-w-full min-w-0 truncate rounded-md border border-line bg-lit ps-2 pe-6 text-sm text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink";
  // A chosen value the choices do not hold yet (its list still on its way) is still named, so the filter reads true.
  const options = (by: SeriesBy) => { const list = choices[by], value = launches.filter[by];
    return value !== null && !list.some(([key]) => key === value) ? [...list, [value, value === EFFORT_NONE ? t("usage.effortNone") : value] as const] : list; };
  return <div className="mt-3 flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs text-muted">{t("usage.launchColor")}</span>
      <Seg label={t("usage.launchColor")} value={launches.by} onChange={(next: SeriesBy) => choose({ launchBy: next })}
        items={[["model", t("usage.launchModel")], ["effort", t("usage.launchEffort")]]} />
    </div>
    <div className="flex flex-wrap gap-2">
      {(["model", "effort"] as const).map(by => <select key={by} aria-label={t(by === "model" ? "usage.launchModel" : "usage.launchEffort")}
        value={launches.filter[by] ?? ""} onChange={event => set({ [by]: event.target.value || null })}
        className={cn(select, launches.filter[by] && "border-ink font-semibold")}>
        <option value="">{t(by === "model" ? "usage.allModels" : "usage.allEfforts")}</option>
        {options(by).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>)}
    </div>
  </div>;
}
