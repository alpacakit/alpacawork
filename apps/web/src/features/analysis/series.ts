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

/**
 * One colour of the chart: the groups it stands for (one, or the rest folded into "other"), its colour class, and its
 * name (`label`; null: the other models, named by their count; for an effort, null: none recorded).
 */
export type Slot = { keys: string[]; color: string; label: string | null; value: string | null; other?: number };

const MODEL_COLORS = ["bg-series-1", "bg-series-2", "bg-series-3", "bg-series-4", "bg-series-5"];
/** Efforts in their order, each a step of one hue from light to deep; one not listed takes the grey of the rest. */
const EFFORT_STEPS: Record<string, string> = {
  minimal: "bg-effort-1", low: "bg-effort-1", medium: "bg-effort-2", high: "bg-effort-3", xhigh: "bg-effort-4", max: "bg-effort-5",
};
const EFFORT_ORDER = Object.keys(EFFORT_STEPS);

/**
 * The chart's colours, from the groups of the whole record without a filter (`groups`), so a colour stays with its
 * model or effort whatever is filtered. Models by their launches, the five most each in a colour of its own and the
 * rest as one grey; efforts in their order, none recorded last.
 */
export function slotsOf(by: SeriesBy, groups: UsageSeriesView["groups"]): Slot[] {
  if (by === "effort") {
    const rank = (value: string | null) => value === null ? EFFORT_ORDER.length + 1 : EFFORT_ORDER.includes(value) ? EFFORT_ORDER.indexOf(value) : EFFORT_ORDER.length;
    return [...groups].sort((a, b) => rank(a.value) - rank(b.value) || a.key.localeCompare(b.key)).map(group => ({
      keys: [group.key], value: group.value, label: group.value === null ? null : group.label,
      color: group.value === null ? "bg-effort-none" : EFFORT_STEPS[group.value] ?? "bg-series-other",
    }));
  }
  const most = [...groups].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const named = most.length > MODEL_COLORS.length ? most.slice(0, MODEL_COLORS.length) : most;
  const rest = most.slice(named.length);
  return [
    ...named.map((group, at) => ({ keys: [group.key], value: group.value, label: group.label, color: MODEL_COLORS[at]! })),
    ...rest.length ? [{ keys: rest.map(group => group.key), value: null, label: null, color: "bg-series-other", other: rest.length }] : [],
  ];
}

/**
 * An answer's launches by slot: each point's, and the whole answer's. A group the slots do not know (one that came
 * after the colours were read) counts with the rest.
 */
export function bySlot(slots: Slot[], view: UsageSeriesView) {
  const at = new Map<string, number>();
  slots.forEach((slot, index) => slot.keys.forEach(key => at.set(key, index)));
  const fallback = slots.findIndex(slot => slot.other !== undefined);
  const slotOf = (group: number) => at.get(view.groups[group]!.key) ?? fallback;
  const points = view.points.map(point => {
    const counts = slots.map(() => 0);
    for (const [group, count] of point.counts) { const slot = slotOf(group); if (slot >= 0) counts[slot]! += count; }
    return counts;
  });
  const totals = slots.map(() => 0);
  view.groups.forEach((group, index) => { const slot = slotOf(index); if (slot >= 0) totals[slot]! += group.total; });
  return { points, totals };
}
