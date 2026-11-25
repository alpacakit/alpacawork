import type { UsageSeriesView } from "./contract";

/** What the launches chart is coloured by: the model (with its version) or the effort it ran at. */
export type SeriesBy = "model" | "effort";
/** A launch filter as the screen keeps it: a model and an effort, each exact or null for all. `EFFORT_NONE`: no effort recorded. */
export type LaunchFilter = { model: string | null; effort: string | null };
export const EFFORT_NONE = "-";
export const NO_FILTER: LaunchFilter = { model: null, effort: null };
export const filtered = (filter: LaunchFilter) => filter.model !== null || filter.effort !== null;
/** The filter as the analysis commands take it (`model`, `effort`, `effortMissing`). */
export const filterQuery = (filter: LaunchFilter | null | undefined) => ({
  model: filter?.model ?? null,
  effort: filter?.effort && filter.effort !== EFFORT_NONE ? filter.effort : null,
  effortMissing: filter?.effort === EFFORT_NONE ? "true" : null,
});

/** One model or effort of the chart: its key (which opens its launches), its value as a filter takes it, its name and colour. */
export type SeriesPart = { key: string; value: string | null; label: string; color: string };

const MODEL_COLORS = ["bg-series-1", "bg-series-2", "bg-series-3", "bg-series-4", "bg-series-5"];
/** Efforts in their order, each a step of one hue from light to deep. */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_COLORS = ["bg-effort-1", "bg-effort-2", "bg-effort-3", "bg-effort-4", "bg-effort-5", "bg-effort-6"];
/** An effort the order does not know takes a hue apart from the blues, in the order they come; past these, the grey of the rest, as models past the fifth. */
const OTHER_EFFORT_COLORS = ["bg-series-2", "bg-series-4", "bg-series-5", "bg-series-3"];
const REST = "bg-series-other", NONE = "bg-effort-none";

/** The order the parts stand in, the chart's foot first: models by their launches; efforts in their order, others after, none recorded last. */
function ordered(by: SeriesBy, groups: UsageSeriesView["groups"]) {
  if (by === "model") return [...groups].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const rank = (value: string | null) => value === null ? EFFORT_ORDER.length + 1 : EFFORT_ORDER.includes(value) ? EFFORT_ORDER.indexOf(value) : EFFORT_ORDER.length;
  return [...groups].sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
}

/**
 * The colours, from the whole record without a filter (`groups`), so a colour stays with its model or effort whatever
 * is filtered: the five models with the most launches each a colour of its own and the rest grey; each effort of the
 * order its step, others a hue apart, none recorded grey. A group the book does not hold (one that came after it was
 * read) is grey, and still a part of its own.
 */
export function colourBook(by: SeriesBy, groups: UsageSeriesView["groups"]) {
  const book = new Map<string, string>();
  let other = 0;
  ordered(by, groups).forEach((group, at) => book.set(group.key, by === "model" ? MODEL_COLORS[at] ?? REST
    : group.value === null ? NONE : EFFORT_ORDER.includes(group.value) ? EFFORT_COLORS[EFFORT_ORDER.indexOf(group.value)]!
      : OTHER_EFFORT_COLORS[other++] ?? REST));
  return { by, colorOf: (key: string, value: string | null) => book.get(key) ?? (by === "effort" && value === null ? NONE : REST), order: new Map([...book.keys()].map((key, at) => [key, at])) };
}
export type ColourBook = ReturnType<typeof colourBook>;

/**
 * An answer's launches by part, every group a part of its own, in the book's order (one it does not hold after): each
 * point's parts with launches, as [part, count] in that order (an answer over years of days with many models stays as
 * small as the server sent it), and the whole answer's per part, as the server counted them. And the filter and axis
 * the answer was counted under, which a list opened from its numbers takes, whatever is chosen since.
 */
export function partsOf(book: ColourBook, view: UsageSeriesView) {
  const known = (key: string) => book.order.get(key) ?? Number.MAX_SAFE_INTEGER;
  const order = view.groups.map((_, index) => index).sort((a, b) => known(view.groups[a]!.key) - known(view.groups[b]!.key));
  const at = new Map(order.map((group, place) => [group, place]));
  const parts: SeriesPart[] = order.map(index => { const group = view.groups[index]!;
    return { key: group.key, value: group.value, label: group.label, color: book.colorOf(group.key, group.value) }; });
  const points = view.points.map(point => point.counts.map(([group, count]) => [at.get(group)!, count] as [number, number]).sort((a, b) => a[0] - b[0]));
  const filter: LaunchFilter = { model: view.filters.model, effort: view.filters.effortMissing ? EFFORT_NONE : view.filters.effort };
  return { by: view.by, filter, parts, points, totals: order.map(index => view.groups[index]!.total) };
}
