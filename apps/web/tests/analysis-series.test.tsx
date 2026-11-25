import { expect, test } from "vitest";
import { bySlot, slotsOf } from "../src/features/analysis/series";
import { analysisValues, readAnalysis } from "../src/features/analysis/place";
import type { UsageSeriesView } from "../src/features/analysis/contract";

const group = (key: string, value: string | null, total: number) => ({ key, label: value ?? "", value, total });
const view = (groups: UsageSeriesView["groups"], points: [number, number][][]): UsageSeriesView => ({
  head: { timeZone: "Asia/Tokyo", today: "2026-11-25", firstDay: "2026-11-01", project: null, period: { from: "2026-11-24", to: "2026-11-25" }, previous: null },
  filters: { model: null, effort: null, effortMissing: false }, metric: { id: "launches", unit: "runs", aggregation: "sum" },
  bucket: "day", by: "model", groups, total: groups.reduce((sum, each) => sum + each.total, 0),
  points: points.map((counts, at) => ({ from: `2026-11-2${4 + at}`, to: `2026-11-2${4 + at}`, complete: true,
    total: counts.reduce((sum, [, count]) => sum + count, 0), counts })),
});

test("models past the fifth fold into one grey, and every launch is still counted", () => {
  const groups = ["a", "b", "c", "d", "e", "f", "g"].map((key, at) => group(key, key, 70 - at * 10));
  const slots = slotsOf("model", groups);
  expect(slots.map(slot => slot.color)).toEqual(["bg-series-1", "bg-series-2", "bg-series-3", "bg-series-4", "bg-series-5", "bg-series-other"]);
  expect(slots[5]).toMatchObject({ keys: ["f", "g"], other: 2 });
  // A filtered answer lists only some groups, in its own order: each keeps the colour of its model.
  const answer = view([group("g", "g", 3), group("b", "b", 5)], [[[0, 1], [1, 2]], [[0, 2], [1, 3]]]);
  const counts = bySlot(slots, answer);
  expect(counts.points).toEqual([[0, 2, 0, 0, 0, 1], [0, 3, 0, 0, 0, 2]]);
  expect(counts.totals.reduce((sum, each) => sum + each, 0)).toBe(answer.total);
});

test("efforts stand in their order, none recorded last", () => {
  const slots = slotsOf("effort", [group("n", null, 9), group("h", "high", 5), group("l", "low", 1), group("m", "medium", 4)]);
  expect(slots.map(slot => [slot.value, slot.color])).toEqual([
    ["low", "bg-effort-1"], ["medium", "bg-effort-2"], ["high", "bg-effort-3"], [null, "bg-effort-none"]]);
});

test("a list opened under a filter keeps it in the URL", () => {
  const place = { look: "usage" as const, span: { period: "7d" as const }, unit: null, card: null,
    list: { set: "used" as const, value: "launches" as const, group: "model" as const, member: "k", filter: { model: "Opus 5.5", effort: "-" } } };
  const url = new URLSearchParams(analysisValues(place));
  expect(readAnalysis(url)?.list?.filter).toEqual({ model: "Opus 5.5", effort: "-" });
});
