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

/**
 * The launches by model (its name with the version) or by effort, the two apart: each bin's launches stacked in the
 * colour of their model or effort, and the span's on the left, under one filter of a model and an effort. The numbers
 * are the server's (`analysis usage-series`): the screen only folds the models past the fifth into one grey.
 * `ready`: the chart's answer is in and stands on the same bins as the other charts; until then the row draws the
 * launches in one colour as the use's answer gives them.
 */
export function useLaunches(bins: Bin[], days: Days, bucket: Bucket, enabled: boolean) {
  const { t } = useTranslation("analysis");
  const project = useViewStore(state => state.project);
  const { launchBy: by, launchFilter: filter } = useChoices();
  const whole = bins.length ? { from: bins[0]!.from, to: bins[bins.length - 1]!.to } : null;
  // The colours and the choices are the whole record's without a filter, so neither moves as a filter is chosen. Without
  // one, the chart's answer is the same read as its colours'.
  const models = useUsageSeries(project, whole, bucket, "model", null, enabled);
  const efforts = useUsageSeries(project, whole, bucket, "effort", null, enabled);
  const chart = useUsageSeries(project, whole, bucket, by, filter, enabled);
  const span = useUsageSeries(project, days, bucket, by, filter, enabled);
  const colours = (by === "model" ? models : efforts).data;
  const slots = colours ? slotsOf(by, colours.groups) : [];
  const fits = (view: UsageSeriesView | undefined): view is UsageSeriesView => !!view && view.by === by
    && view.points.length === bins.length && view.points[0]?.from === bins[0]?.from;
  const chartView = fits(chart.data) ? chart.data : null, spanView = span.data?.by === by ? span.data : null;
  const ready = !!colours && !!chartView && !!spanView;
  const counts = ready ? bySlot(slots, chartView) : null, spanCounts = ready ? bySlot(slots, spanView) : null;
  const nameOf = (slot: Slot) => slot.other !== undefined ? t("usage.otherModels", { count: slot.other })
    : slot.label ?? t("usage.effortNone");
  // A part opens its own launches (one model or one effort), under the filter; the rest folded into one opens none.
  const member = (slot: Slot) => slot.keys.length === 1 ? { group: by, member: slot.keys[0]! } : null;
  return {
    by, filter, ready, slots, isFiltered: filtered(filter),
    total: (at: number) => chartView?.points[at]?.total ?? 0,
    spanTotal: spanView?.total ?? null,
    /** A bin's parts, those with launches, in the order they stack. */
    parts: (at: number) => counts ? slots.flatMap((slot, index) => counts.points[at]![index]! > 0 ? [{ slot, value: counts.points[at]![index]! }] : []) : [],
    spanParts: () => spanCounts ? slots.flatMap((slot, index) => spanCounts.totals[index]! > 0 ? [{ slot, value: spanCounts.totals[index]! }] : []) : [],
    nameOf, member,
    choices: {
      models: [...models.data?.groups ?? []].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
        .flatMap(group => group.value === null ? [] : [[group.value, group.label] as const]),
      efforts: efforts.data ? slotsOf("effort", efforts.data.groups).map(slot => [slot.value ?? EFFORT_NONE, nameOf(slot)] as const) : [],
    },
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

/**
 * What the launches are coloured by and filtered to: the model or the effort, then one model and one effort (each "all"
 * at first). A filter keeps what it is coloured by; the choices are the whole record's.
 */
export function LaunchControls({ launches }: { launches: Launches }) {
  const { t } = useTranslation("analysis");
  const choose = useChoices(state => state.choose);
  const set = (next: Partial<LaunchFilter>) => choose({ launchFilter: { ...launches.filter, ...next } });
  const select = "h-7 max-w-full min-w-0 truncate rounded-md border border-line bg-lit ps-2 pe-6 text-sm text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink";
  return <div className="mt-3 flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs text-muted">{t("usage.launchColor")}</span>
      <Seg label={t("usage.launchColor")} value={launches.by} onChange={(next: SeriesBy) => choose({ launchBy: next })}
        items={[["model", t("usage.launchModel")], ["effort", t("usage.launchEffort")]]} />
    </div>
    <div className="flex flex-wrap gap-2">
      <select aria-label={t("usage.launchModel")} value={launches.filter.model ?? ""} onChange={event => set({ model: event.target.value || null })}
        className={cn(select, launches.filter.model && "border-ink font-semibold")}>
        <option value="">{t("usage.allModels")}</option>
        {launches.choices.models.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <select aria-label={t("usage.launchEffort")} value={launches.filter.effort ?? ""} onChange={event => set({ effort: event.target.value || null })}
        className={cn(select, launches.filter.effort && "border-ink font-semibold")}>
        <option value="">{t("usage.allEfforts")}</option>
        {launches.choices.efforts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
  </div>;
}
