import { expect, test } from "vitest";
import { colourBook, faceAnswer, partsOf } from "../src/features/analysis/series";
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

test("every model is a part of its own, a colour staying with it whatever is filtered or comes later", () => {
  const groups = ["a", "b", "c", "d", "e", "f", "g"].map((key, at) => group(key, key, 70 - at * 10));
  const book = colourBook("model", groups);
  // A filtered answer lists some groups in its own order, and one the colours were read before (h).
  const answer = view([group("h", "h", 4), group("g", "g", 3), group("b", "b", 5)], [[[0, 4], [1, 1], [2, 2]], [[1, 2], [2, 3]]]);
  const { parts, points, totals } = partsOf(book, answer);
  expect(parts.map(part => [part.key, part.color])).toEqual([["b", "bg-series-2"], ["g", "bg-series-other"], ["h", "bg-series-other"]]);
  expect(points).toEqual([[[0, 2], [1, 1], [2, 4]], [[0, 3], [1, 2]]]);
  // Each point's parts add up to its total, and the answer's to its own.
  answer.points.forEach((point, at) => expect(points[at]!.reduce((sum, [, each]) => sum + each, 0)).toBe(point.total));
  expect(totals.reduce((sum, each) => sum + each, 0)).toBe(answer.total);
});

test("efforts stand in their order with a colour each, none recorded last", () => {
  const groups = [group("n", null, 9), group("h", "high", 5), group("l", "low", 1), group("m", "medium", 4),
    group("i", "minimal", 1), group("o", "off", 2), group("u", "ultra", 2), group("c", "constructor", 1)];
  const { parts } = partsOf(colourBook("effort", groups), view(groups, []));
  expect(parts.map(part => part.value)).toEqual(["minimal", "low", "medium", "high", "constructor", "off", "ultra", null]);
  const colours = parts.map(part => part.color);
  expect(new Set(colours).size).toBe(colours.length);
  expect(colours.at(-1)).toBe("bg-effort-none");
});

test("an answer's numbers carry the filter they were counted under, for the lists they open", () => {
  const groups = [group("o", "Opus 5.5", 4)];
  const answer = { ...view(groups, [[[0, 4]]]), filters: { model: "Opus 5.5", effort: null, effortMissing: true } };
  expect(partsOf(colourBook("model", groups), answer).filter).toEqual({ model: "Opus 5.5", effort: "-" });
});

test("the launches row takes only the face's own answers: its project, its day, its bins and span", () => {
  const face = view([group("o", "Opus 5.5", 4)], [[[0, 4]], [[0, 0]]]);
  const { onBins, onSpan } = faceAnswer(face, face.points);
  expect(onBins(face) && onSpan(face)).toBe(true);
  expect(onBins({ ...face, head: { ...face.head, project: "P2" } })).toBe(false);
  expect(onSpan({ ...face, head: { ...face.head, period: { from: "2026-11-19", to: "2026-11-25" } } })).toBe(false);
  // A day further on: the last bin ends a day later, so an answer that ends earlier does not stand on the bins.
  expect(onBins({ ...face, points: face.points.map((point, at) => at === 1 ? { ...point, to: "2026-11-24" } : point) })).toBe(false);
});

test("a list opened under a filter keeps it in the URL", () => {
  const place = { look: "usage" as const, span: { period: "7d" as const }, unit: null, card: null,
    list: { set: "used" as const, value: "launches" as const, group: "model" as const, member: "k", filter: { model: "Opus 5.5", effort: "-" } } };
  const url = new URLSearchParams(analysisValues(place));
  expect(readAnalysis(url)?.list?.filter).toEqual({ model: "Opus 5.5", effort: "-" });
});
