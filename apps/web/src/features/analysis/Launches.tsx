import { useTranslation } from "react-i18next";
import { ReadFailure } from "@/components/ui/loadable";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { format } from "./format";
import { useUsageSeries } from "./data";
import { Seg, useChoices } from "./parts";
import { colourBook, EFFORT_NONE, filtered, partsOf, type LaunchFilter, type SeriesBy, type SeriesPart } from "./series";
import type { Bin, DayList, PartItem, RowSay } from "./rows";
import type { Bucket, UsageSeriesView } from "./contract";
import type { Span } from "./place";
import type { Open } from "./TasksLook";

/** The launches' answers read with the face (data.ts `useLaunchReads`): by model over the whole record and over the span, not filtered. */
export type LaunchAnswers = { models: UsageSeriesView; spanModels: UsageSeriesView };

/**
 * The launches by model (its name with the version) or by effort, the two apart: each bin's launches stacked in the
 * colour of their model or effort, and the span's on the left, under one filter of a model and an effort. The numbers
 * are the server's (`analysis usage-series`), each model or effort a part of its own. By model and not filtered they
 * are the face's own answers; anything else is read here, for this row alone: while it comes the row shows what it
 * showed, faint, and what cannot be read is said in the row with a way to ask again. The choices stay in reach, so
 * anything chosen can be left. What the row shows, and every list it opens, is one answer's: its axis and its filter
 * as the server counted it, not what is chosen since. `live`: false in the face's stand-in, which reads nothing.
 */
export function useLaunches(bins: Bin[], days: { from: string; to: string }, answers: LaunchAnswers, span: Span, bucket: Bucket, live = true) {
  const { t } = useTranslation("analysis");
  const project = useViewStore(state => state.project);
  const { launchBy: by, launchFilter: filter } = useChoices();
  const own = by !== "model" || filtered(filter);
  // The efforts over the whole record: their colours and the effort choices, read once the face is (never holding it up).
  const efforts = useUsageSeries(project, { period: "all" }, bucket, "effort", null, live);
  const chartRead = useUsageSeries(project, { period: "all" }, bucket, by, filter, live && own);
  const spanRead = useUsageSeries(project, span, bucket, by, filter, live && own);
  const fits = (view: UsageSeriesView | undefined): view is UsageSeriesView => !!view
    && view.points.length === bins.length && view.points[0]?.from === bins[0]?.from;
  const sameAnswer = (a: UsageSeriesView, b: UsageSeriesView) => a.by === b.by && JSON.stringify(a.filters) === JSON.stringify(b.filters);
  // The row's own answers once both have come for one choice (or, while another comes, the last that had), else the
  // face's: never a span's numbers for days other than those the face shows (its lists are for those days), never an
  // effort's colours before the whole record's efforts have come (a colour would change under the reader's eyes).
  const sameDays = (view: UsageSeriesView) => view.head.period?.from === days.from && view.head.period?.to === days.to;
  const ownPair = fits(chartRead.data) && spanRead.data && sameAnswer(chartRead.data, spanRead.data) && sameDays(spanRead.data)
    && (chartRead.data.by === "model" || !!efforts.data) ? [chartRead.data, spanRead.data] as const : null;
  const [chart, inSpan] = own && ownPair ? ownPair : [answers.models, answers.spanModels] as const;
  const current = !own || (!!ownPair && !chartRead.isPlaceholderData && !spanRead.isPlaceholderData && chart === chartRead.data);
  const failed = [efforts, ...own ? [chartRead, spanRead] : []].find(read => read.isError);
  const bookOf = (axis: SeriesBy) => colourBook(axis, (axis === "model" ? answers.models : efforts.data!).groups);
  const counts = fits(chart) ? partsOf(bookOf(chart.by), chart) : null, spanCounts = partsOf(bookOf(inSpan.by), inSpan);
  const shownBy = chart.by;
  const nameOf = (part: SeriesPart) => shownBy === "effort" && part.value === null ? t("usage.effortNone") : part.label;
  const choicesOf = (axis: SeriesBy, view: UsageSeriesView | undefined) => view ? partsOf(colourBook(axis, view.groups), { ...view, points: [] }).parts
    .map(part => [part.value ?? EFFORT_NONE, axis === "effort" && part.value === null ? t("usage.effortNone") : part.label] as const) : [];
  return {
    by, filter, current, ready: !!counts,
    failure: failed ? { error: failed.error, retry: () => { for (const read of [efforts, chartRead, spanRead]) if (read.isError) void read.refetch(); } } : null,
    /** What the numbers shown were counted under: a list opened from them takes it. */
    shown: { by: shownBy, filter: counts?.filter ?? spanCounts.filter, spanFilter: spanCounts.filter },
    /** Whether the numbers shown are filtered (the launches of the tasks finished, and their line, are then not said). */
    shownFiltered: filtered(spanCounts.filter),
    total: (at: number) => chart.points[at]?.total ?? 0,
    spanTotal: inSpan.total,
    /** A bin's parts, those with launches, in the order they stack. */
    parts: (at: number) => counts ? counts.points[at]!.map(([index, value]) => ({ part: counts.parts[index]!, value })) : [],
    spanParts: () => spanCounts.parts.flatMap((part, index) => spanCounts.totals[index]! > 0 ? [{ part, value: spanCounts.totals[index]! }] : []),
    nameOf, member: (part: SeriesPart) => ({ group: shownBy, member: part.key }),
    choices: { model: choicesOf("model", answers.models), effort: choicesOf("effort", efforts.data) },
  };
}
export type Launches = ReturnType<typeof useLaunches>;

/** What the launches row says of a bin: its total, and its parts by colour, each opening its own launches of that bin. */
export function launchesSay(launches: Launches, name: string, line: RowSay["line"], extra: RowSay["parts"], used: (at: number) => number): RowSay {
  // Where the series does not stand on the chart's bins, the bars are the use's launches in one colour: so is what a bin says.
  const total = (at: number) => launches.ready ? launches.total(at) : used(at);
  const share = (value: number, all: number) => all ? `${Math.round(value / all * 100)}%` : "";
  const list = (more: Partial<DayList>) => (bin: Bin): DayList => ({ set: "used", value: "launches", from: bin.from, to: bin.to, filter: launches.shown.filter, ...more });
  return {
    name, total: at => format("times", total(at)), line, list: bin => list({})(bin),
    parts: at => [...launches.parts(at).map(({ part, value }) => ({
      color: part.color, name: launches.nameOf(part), value: format("times", value), share: share(value, total(at)),
      list: list(launches.member(part)),
    })), ...extra?.(at) ?? []],
  };
}

/** The span's launches by colour on the left, each opening its own launches of the span. */
export function launchesParts(launches: Launches, open: Open): PartItem[] {
  const all = launches.spanTotal;
  return launches.spanParts().map(({ part, value }) => ({
    color: part.color, name: launches.nameOf(part),
    value: <b className="font-semibold tabular-nums">{format("times", value)}</b>,
    share: all ? `${Math.round(value / all * 100)}%` : "",
    onOpen: () => open({ set: "used", value: "launches", ...launches.member(part), filter: launches.shown.spanFilter }),
  }));
}

/**
 * What the launches are coloured by and filtered to: the model or the effort, then one model and one effort (each "all"
 * at first). A filter keeps what it is coloured by; the choices are the whole record's, read with the face. A filter
 * that could not be read is said here, with a way to ask again.
 */
export function LaunchControls({ launches }: { launches: Launches }) {
  const { t } = useTranslation("analysis");
  const choose = useChoices(state => state.choose);
  const set = (next: Partial<LaunchFilter>) => choose({ launchFilter: { ...launches.filter, ...next } });
  const select = "h-7 max-w-full min-w-0 truncate rounded-md border border-line bg-lit ps-2 pe-6 text-sm text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink";
  // A chosen value the record no longer holds is still named, so the filter reads true and can be left.
  const options = (by: SeriesBy) => { const list = launches.choices[by], value = launches.filter[by];
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
    {launches.failure && <ReadFailure error={launches.failure.error} retry={launches.failure.retry} />}
  </div>;
}
