import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { comparison, delta, parts, share, shareDelta } from "../src/features/analysis/format";
import { analysisMoved, analysisSurfaces, analysisValues, belowLayer, listOnAnswer, readAnalysis, settleSpan, spanQuery, stepChosen, type AnalysisPlace } from "../src/features/analysis/place";
import { axisLabels } from "../src/features/analysis/charts";
import { dayIntent, inSpanOf, legendShapes, lineDots, lineTop, spanMost } from "../src/features/analysis/rows";
import { tipAround, tipBeside, tipPlace } from "../src/features/analysis/parts";
import { isStep, surfacesOf } from "../src/state/history-step";
import type { Navigation } from "../src/state/view-store";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });

const HOUR = 3_600_000;

const signed = /^[+−]/;
const same = (text: string) => !signed.test(text);

test("hours are written to one place under ten and whole from ten; a count is grouped", () => {
  expect(parts("hours", 1.44 * HOUR).value).toBe("1.4");
  expect(parts("hours", 147.4 * HOUR).value).toBe("147");
  expect(parts("tasks", 1511).value).toBe("1,511");
});

test("large token counts take the largest step they reach, and a gap is written in the larger value's step", () => {
  const steps = (i18n.t("analysis:unit.scales", { returnObjects: true }) as { at: number; unit: string }[]);
  const [big, small] = steps;
  expect(parts("tokens", big!.at * 74).unit).toBe(big!.unit);
  expect(parts("tokens", small!.at * 3011).unit).toBe(small!.unit);
  expect(parts("tokens", small!.at - 1).unit).toBe("");
  expect(delta("tokens", big!.at * 74, big!.at * 74.25)).toMatch(/^−0[.,]3\D/);
  expect(delta("tokens", big!.at * 99.7, big!.at * 79.29)).toMatch(/^\+20[.,]4\D/);
});

test("a gap has the direction of the change and the kind's rounding; one that rounds to nothing is the same", () => {
  expect(delta("tasks", 60, 64)).toBe("−4");
  expect(delta("tasks", 128, 105)).toBe("+23");
  expect(delta("hours", 1.4 * HOUR, 1.7 * HOUR)).toBe("−0.3");
  expect(delta("hours", 160.3 * HOUR, 161 * HOUR)).toBe("−1");
  expect(same(delta("tasks", 1, 1))).toBe(true);
  expect(same(delta("hours", 1.42 * HOUR, 1.44 * HOUR))).toBe(true);
  expect(same(delta("hours", 1.4 * HOUR, 1.5 * HOUR))).toBe(false);
  // No span before: nothing is said (no "no record" line).
  expect(comparison("tasks", 3, null, 1)).toBeNull();
});

test("a share the server withholds (under ten accepted) is never written, nor is its gap", () => {
  expect(share(0.734)).toBe("73%");
  expect(share(null)).toBe("—");
  expect(shareDelta(0.73, 0.67)).toMatch(/^\+6\D/);
  expect(same(shareDelta(0.731, 0.729)!)).toBe(true);
  expect(shareDelta(0.73, null)).toBeNull();
  expect(shareDelta(null, 0.67)).toBeNull();
});

const place = (url: string) => readAnalysis(new URLSearchParams(url));
const navigation = (analysis: AnalysisPlace | null, task: string | null = null): Navigation => ({ project: null, task, taskAddress: null, full: false,
  pane: "task", path: null, query: "", image: null, view: null, event: null, analysis });
const step = (from: string, to: string) => isStep(navigation(place(from)), navigation(place(to)), new URL(`http://x/?${from}`), new URL(`http://x/?${to}`));

test("the analysis's place survives its URL, with the defaults left out", () => {
  const shown = place("face=analysis&look=usage&span=2026-11-01~2026-11-30&list=used&measure=runMs&group=model&member=opus(high)&unit=T12")!;
  expect(shown).toEqual({ look: "usage", span: { from: "2026-11-01", to: "2026-11-30" },
    list: { set: "used", value: "runMs", group: "model", member: "opus(high)", days: null }, unit: "T12" });
  // A list opened from a chart's bin keeps that bin's days.
  const bin = place("face=analysis&list=finished&bin=2026-11-09~2026-11-15")!;
  expect(bin.list).toMatchObject({ set: "finished", days: { from: "2026-11-09", to: "2026-11-15" } });
  expect(place(new URLSearchParams(analysisValues(bin)).toString())).toEqual(bin);
  expect(place(new URLSearchParams(analysisValues(shown)).toString())).toEqual(shown);
  expect(analysisValues(place("face=analysis"))).toEqual([["face", "analysis"]]);
  // A whole of skills, tools or MCP has a list without a row; a model's breakdown needs its row.
  expect(place("face=analysis&look=usage&list=used&measure=calls&group=tool")!.list).toMatchObject({ group: "tool", member: null });
  expect(place("face=analysis&list=finished&group=model")!.list).toMatchObject({ group: null, member: null });
  expect(place("look=usage")).toBeNull();
});

test("Back undoes one step at a time: a span chosen, the list opened, a task's values opened; another look is not a step", () => {
  const list = "face=analysis&span=today&list=passed&measure=lead";
  expect(step("", "face=analysis")).toBe(true);
  expect(step("face=analysis", "face=analysis&span=28d")).toBe(true);
  expect(step("face=analysis", "face=analysis&look=usage")).toBe(false);
  expect(step("face=analysis&span=today", list)).toBe(true);
  expect(step(list, `${list}&unit=T5`)).toBe(true);
  expect(surfacesOf(`?${list}&unit=T5`)).toHaveLength(2);
  // Opening the task from its values leaves the analysis for the reader: a step, which Back undoes.
  expect(isStep(navigation(place(`${list}&unit=T5`)), navigation(null, "T5"), new URL(`http://x/?${list}&unit=T5`), new URL("http://x/?task=T5"))).toBe(true);
  // Closing a layer takes away it and those over it.
  const open = place(`${list}&unit=T5`)!;
  expect(belowLayer(open, 1)).toMatchObject({ list: open.list, unit: null });
  expect(belowLayer(open, 0)).toMatchObject({ list: null, unit: null, span: { period: "today" } });
  expect(analysisSurfaces(belowLayer(open, 0))).toEqual([]);
  expect(analysisMoved(open, { ...open, look: "usage" })).toBe(false);
});

test("a span is asked for as a named period where it is one, and kept as one when it ends today", () => {
  expect(spanQuery({ period: "28d" })).toEqual({ period: "28d" });
  expect(spanQuery({ from: "2026-11-10", to: "2026-11-16" })).toEqual({ period: "7d", end: "2026-11-16" });
  expect(spanQuery({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  expect(settleSpan({ from: "2026-11-17", to: "2026-11-23" }, "2026-11-23")).toEqual({ period: "7d" });
  expect(settleSpan({ from: "2026-11-23", to: "2026-11-23" }, "2026-11-23")).toEqual({ period: "today" });
  expect(settleSpan({ from: "2026-11-10", to: "2026-11-16" }, "2026-11-23")).toEqual({ from: "2026-11-10", to: "2026-11-16" });
});

test("a line has no point where a bin has none and does not bridge it; a value over the top stands on it, marked", () => {
  const { dots, lines } = lineDots([0.9, null, 0, 0.5, 3], 1, at => at === 2);
  expect(dots.map(dot => dot && { y: Math.round(dot.y), faint: dot.faint, over: dot.over }))
    .toEqual([{ y: 10, faint: false, over: false }, null, { y: 100, faint: true, over: false }, { y: 50, faint: false, over: false }, { y: 0, faint: false, over: true }]);
  expect(lines.map(line => [line.from, line.to].map(dot => dots.indexOf(dot)))).toEqual([[2, 3], [3, 4]]);
});

test("a scale's top is set by the bins of the chosen span, not a larger one outside it", () => {
  const bins = ["2026-11-01", "2026-11-02", "2026-11-03"].map(day => ({ from: day, to: day, complete: true }));
  const span = { from: "2026-11-02", to: "2026-11-03" };
  expect(spanMost(bins, span, at => [600, 10, 4][at]!)).toBe(10);
});

test("a line's top is the larger of the span's largest and the 90th percentile of every steady bin shown", () => {
  // Twenty bins shown, the last two the span: steady bins outside it run from 1 to 4, one outlier at 40.
  const values = [...Array.from({ length: 17 }, (_, at) => 1 + at * 3 / 16), 40, 0.5, 0.6];
  const inSpan = (at: number) => at >= 18, steady = () => true;
  // The 90th percentile of the twenty (the 18th smallest) is 4: the course outside the span stays readable, the outlier is cut.
  expect(lineTop(values, steady, inSpan)).toBe(lineTop([4], () => true));
  // A span larger than that sets the top itself.
  expect(lineTop([...values.slice(0, 18), 7, 0.6], steady, inSpan)).toBe(lineTop([7], () => true));
  // The span's largest counts its bins on ten tasks or more; when none of the span's is, every bin of the span.
  expect(lineTop([1, 3, 9], at => at === 0, at => at >= 1)).toBe(lineTop([9], () => true));
  expect(lineTop([1, 3, 9], at => at !== 2, at => at >= 1)).toBe(lineTop([3], () => true));
  // Small values keep their places on the scale (0.21 a task is not written as 0).
  expect(lineTop([0.21], () => true)).toBeCloseTo(0.3);
});

test("a number opens its tasks in the span its answer was counted for, even after another span was chosen", () => {
  const list = { set: "passed", value: "lead", group: null, member: null } as const;
  const head = (from: string, to: string) => ({ period: { from, to }, today: "2026-11-24", firstDay: "2026-10-15" });
  // Today chosen, the 7-day answer still on screen: its number opens the 7 days.
  expect(listOnAnswer({ ...place("face=analysis&span=today")! }, head("2026-11-18", "2026-11-24"), list)).toMatchObject({ span: { period: "7d" }, list });
  // The answer for what is chosen keeps the span as it was chosen (all time stays all time).
  expect(listOnAnswer({ ...place("face=analysis&span=all")! }, head("2026-10-15", "2026-11-24"), list).span).toEqual({ period: "all" });
  expect(listOnAnswer({ ...place("face=analysis&span=today")! }, head("2026-10-01", "2026-10-31"), list).span).toEqual({ from: "2026-10-01", to: "2026-10-31" });
});

test("the chart's day, week and month names never touch, at any width and length, and the last is always named", () => {
  for (const wide of [false, true]) for (const count of [1, 2, 7, 28, 41, 120, 366]) for (const width of [280, 330, 700, 1370]) {
    const named = axisLabels(count, wide, at => at % 7 === 3, width);
    expect(named.at(-1)).toBe(count - 1);
    const bin = width / count;
    const extent = (at: number) => wide ? [(at + 0.5) * bin - 17, (at + 0.5) * bin + 17] : at === count - 1 && at ? [width - 34, width] : [at * bin, at * bin + 34];
    for (let i = 1; i < named.length; i++) expect(extent(named[i]!)[0]! - extent(named[i - 1]!)[1]!).toBeGreaterThanOrEqual(8);
  }
  // Room for them: the first day and the Mondays are named.
  expect(axisLabels(41, false, at => at % 7 === 3, 1370)).toEqual([0, 3, 10, 17, 24, 31, 38, 40]);
});

test("a small window stands above its mark where it fits, else under it, else is held to the screen and scrolls", () => {
  expect(tipPlace({ top: 400, bottom: 410, height: 100, screen: 844 })).toEqual({ top: 294, maxHeight: null });
  expect(tipPlace({ top: 60, bottom: 70, height: 100, screen: 844 })).toEqual({ top: 76, maxHeight: null });
  // 38 marks' lines, taller than either side of a phone's screen: never past it.
  const tall = tipPlace({ top: 330, bottom: 340, height: 700, screen: 844 });
  expect(tall).toEqual({ top: 346, maxHeight: 494 });
  expect(tall.top + tall.maxHeight!).toBeLessThanOrEqual(844 - 4);
  expect(tipPlace({ top: 700, bottom: 710, height: 900, screen: 844 })).toEqual({ top: 4, maxHeight: 690 });
});

test("the arrows move from the span chosen now, not from the answer still on screen", () => {
  const head = { today: "2026-11-24", firstDay: "2026-10-15" };
  // Today chosen (the 7 days' answer may still be shown): earlier is the day before.
  expect(stepChosen({ period: "today" }, head, -1)).toEqual({ from: "2026-11-23", to: "2026-11-23" });
  expect(stepChosen({ period: "today" }, head, 1)).toBeNull();
  expect(stepChosen({ from: "2026-11-11", to: "2026-11-17" }, head, 1)).toEqual({ period: "7d" });
  expect(stepChosen({ period: "all" }, head, -1)).toBeNull();
});

test("a pressed bin's window stands over or under it, where there is more room, and beside it only when neither holds it", () => {
  const screen = { screenWidth: 390, screenHeight: 844 };
  // Low on the screen: over the bin, centred on it, kept on the screen.
  expect(tipAround({ left: 300, right: 310, top: 600, bottom: 690, width: 240, height: 250, ...screen })).toEqual({ left: 146, top: 342, maxHeight: null });
  // High on the screen: under it.
  expect(tipAround({ left: 20, right: 30, top: 100, bottom: 190, width: 240, height: 250, ...screen })).toEqual({ left: 4, top: 198, maxHeight: null });
  // Neither side holds it: beside it.
  expect(tipAround({ left: 20, right: 30, top: 300, bottom: 600, width: 240, height: 400, ...screen }).left).toBe(38);
});

test("a day's window stands beside its bar, on the side with room, and never past the screen", () => {
  const screen = { screenWidth: 1440, screenHeight: 900 };
  expect(tipBeside({ left: 600, right: 620, top: 300, width: 220, height: 160, ...screen })).toEqual({ left: 628, top: 300, maxHeight: null });
  // Near the right edge it goes left of the bar; near the foot it moves up; taller than the screen it is held to it.
  expect(tipBeside({ left: 1380, right: 1400, top: 300, width: 220, height: 160, ...screen }).left).toBe(1152);
  expect(tipBeside({ left: 600, right: 620, top: 820, width: 220, height: 160, ...screen }).top).toBe(736);
  expect(tipBeside({ left: 600, right: 620, top: 100, width: 220, height: 1200, ...screen })).toEqual({ left: 628, top: 4, maxHeight: 892 });
});

test("the day counting began is always named, and no other name on the axis touches it", () => {
  for (const width of [330, 1038]) for (const must of [0, 30, 59, 60]) {
    const named = axisLabels(61, false, at => at % 7 === 3, width, must);
    expect(named).toContain(must);
    const bin = width / 61, extent = (at: number) => { const from = Math.min(at * bin, width - 34); return [from, from + 34]; };
    for (let i = 1; i < named.length; i++) expect(extent(named[i]!)[0]! - extent(named[i - 1]!)[1]!).toBeGreaterThanOrEqual(8);
    for (const at of named) expect(extent(at)[1]).toBeLessThanOrEqual(width);
  }
});

test("a day the pointer passes going left fast, on its way to the row's legend, waits; slower or any other way it is taken at once", () => {
  const at = (x: number, y: number, time: number) => ({ x, y, time });
  expect(dayIntent(at(800, 100, 0), at(700, 104, 20))).toBe("wait");
  expect(dayIntent(at(800, 100, 0), at(790, 100, 100))).toBe("now");
  expect(dayIntent(at(800, 100, 0), at(900, 100, 20))).toBe("now");
  expect(dayIntent(at(800, 100, 0), at(760, 160, 20))).toBe("now");
  expect(dayIntent(null, at(700, 100, 20))).toBe("now");
  // Starting left from rest, it waits (a slow one is taken a moment later).
  expect(dayIntent(at(800, 100, 0), at(790, 100, 400))).toBe("wait");
  // A small move from rest (over a column's edge) is taken at once.
  expect(dayIntent(at(800, 100, 0), at(798, 100, 400))).toBe("now");
});

test("a row keeps room for one legend of each shape its days take, not one a day: three years of days come to a handful", () => {
  const names = Array.from({ length: 1096 }, (_, at) => `${at % 12 + 1}/${at % 28 + 1}（${"月火水木金土日"[at % 7]}）`);
  const say = { name: "トークン", total: (at: number) => `${(at * 37) % 900}万`,
    parts: (at: number) => [{ color: "", name: "出力", value: `${at % 90}万` }],
    line: { name: "1件あたり", value: (at: number) => at % 5 ? `${at % 9}万` : "—", base: (at: number) => at % 5 ? `終わった ${at % 30}件` : "終わった 0件" } };
  const shapes = legendShapes(say, names);
  expect(shapes.length).toBeLessThan(100);
  // Words that differ, not only digits, each keep a room of their own.
  const lines = new Set(shapes.map(at => say.line.value(at) === "—"));
  expect(lines).toEqual(new Set([true, false]));
});
