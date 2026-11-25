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

/** The launches' answers read with the face (data.ts `useLaunchReads`): each axis over the whole record and over the span, none filtered. */
export type LaunchAnswers = { models: UsageSeriesView; efforts: UsageSeriesView; spanModels: UsageSeriesView; spanEfforts: UsageSeriesView };

/**
 * The launches by model (its name with the version) or by effort, the two apart: each bin's launches stacked in the
 * colour of their model or effort, and the span's on the left, under one filter of a model and an effort. The numbers
 * are the server's (`analysis usage-series`), each model or effort a part of its own. Without a filter they are the
 * face's own answers. A filter's are read here, for this row alone: while they come the row shows what it showed,
 * faint, and a filter that cannot be read says so in the row, with a way to ask again; the choices stay in reach, so
 * any filter can be left. `live`: false in the face's stand-in, which reads nothing.
 */
export function useLaunches(bins: Bin[], answers: LaunchAnswers, span: Span, bucket: Bucket, live = true) {
  const { t } = useTranslation("analysis");
  const project = useViewStore(state => state.project);
  const { launchBy: by, launchFilter: filter } = useChoices();
  const isFiltered = filtered(filter);
  const whole = by === "model" ? answers.models : answers.efforts, wholeSpan = by === "model" ? answers.spanModels : answers.spanEfforts;
  const chartRead = useUsageSeries(project, { period: "all" }, bucket, by, filter, live && isFiltered);
  const spanRead = useUsageSeries(project, span, bucket, by, filter, live && isFiltered);
  const fits = (view: UsageSeriesView | undefined): view is UsageSeriesView => !!view && view.by === by
    && view.points.length === bins.length && view.points[0]?.from === bins[0]?.from;
  // A filter's answer, or (until it has come) the last one this row drew for this axis, or the unfiltered.
  const chart = isFiltered && fits(chartRead.data) ? chartRead.data : whole;
  const inSpan = isFiltered && spanRead.data?.by === by ? spanRead.data : wholeSpan;
  const current = !isFiltered || (chart === chartRead.data && inSpan === spanRead.data && !chartRead.isPlaceholderData && !spanRead.isPlaceholderData);
  const failed = isFiltered ? [chartRead, spanRead].find(read => read.isError) : undefined;
  const book = colourBook(by, whole.groups);
  const ready = fits(chart);
  const counts = ready ? partsOf(book, chart) : null, spanCounts = partsOf(book, inSpan);
  const nameOf = (part: SeriesPart) => by === "effort" && part.value === null ? t("usage.effortNone") : part.label;
  // A part opens its own launches (one model or one effort), under the filter.
  const member = (part: SeriesPart) => ({ group: by, member: part.key });
  const choicesOf = (axis: SeriesBy) => partsOf(colourBook(axis, (axis === "model" ? answers.models : answers.efforts).groups),
    axis === "model" ? answers.models : answers.efforts).parts.map(part => [part.value ?? EFFORT_NONE, axis === "effort" && part.value === null ? t("usage.effortNone") : part.label] as const);
  return {
    by, filter, ready, isFiltered, current, failure: failed ? { error: failed.error, retry: () => { void chartRead.refetch(); void spanRead.refetch(); } } : null,
    total: (at: number) => chart.points[at]?.total ?? 0,
    spanTotal: inSpan.total,
    /** A bin's parts, those with launches, in the order they stack. */
    parts: (at: number) => counts ? counts.parts.flatMap((part, index) => counts.points[at]![index]! > 0 ? [{ part, value: counts.points[at]![index]! }] : []) : [],
    spanParts: () => spanCounts.parts.flatMap((part, index) => spanCounts.totals[index]! > 0 ? [{ part, value: spanCounts.totals[index]! }] : []),
    nameOf, member, choices: { model: choicesOf("model"), effort: choicesOf("effort") },
  };
}
export type Launches = ReturnType<typeof useLaunches>;

/** What the launches row says of a bin: its total, and its parts by colour, each opening its own launches of that bin. */
export function launchesSay(launches: Launches, name: string, line: RowSay["line"], extra: RowSay["parts"]): RowSay {
  const share = (value: number, all: number) => all ? `${Math.round(value / all * 100)}%` : "";
  const list = (more: Partial<DayList>) => (bin: Bin): DayList => ({ set: "used", value: "launches", from: bin.from, to: bin.to, filter: launches.filter, ...more });
  return {
    name, total: at => format("times", launches.total(at)), line, list: bin => list({})(bin),
    parts: at => [...launches.parts(at).map(({ part, value }) => ({
      color: part.color, name: launches.nameOf(part), value: format("times", value), share: share(value, launches.total(at)),
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
    onOpen: () => open({ set: "used", value: "launches", ...launches.member(part), filter: launches.filter }),
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
