import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { comparison, delta, parts, share, shareDelta } from "../src/features/analysis/format";
import { analysisMoved, analysisSurfaces, analysisValues, belowLayer, listOnAnswer, readAnalysis, settleSpan, spanQuery, stepChosen, type AnalysisPlace } from "../src/features/analysis/place";
import { axisLabels } from "../src/features/analysis/charts";
import { lineDots } from "../src/features/analysis/rows";
import { tipBeside, tipPlace } from "../src/features/analysis/parts";
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
  expect(delta("tokens", big!.at * 74, big!.at * 74.25)).toMatch(/^−0[.,]25/);
});

test("a gap has the direction of the change and the kind's rounding; one that rounds to nothing is the same", () => {
  expect(delta("tasks", 60, 64)).toBe("−4");
  expect(delta("tasks", 128, 105)).toBe("+23");
  expect(delta("hours", 1.4 * HOUR, 1.7 * HOUR)).toBe("−0.3");
  expect(same(delta("tasks", 1, 1))).toBe(true);
  expect(same(delta("hours", 1.42 * HOUR, 1.44 * HOUR))).toBe(true);
  expect(same(delta("hours", 1.4 * HOUR, 1.5 * HOUR))).toBe(false);
  expect(comparison("tasks", 3, null, 1).gap).toBeNull();
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
    list: { set: "used", value: "runMs", group: "model", member: "opus(high)" }, unit: "T12" });
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

test("a line has no point where a bin has none and does not bridge it; a faint point's lines are faint", () => {
  const { dots, lines } = lineDots([0.9, null, 0, 0.5], 1, at => at === 2);
  expect(dots.map(dot => dot && { y: Math.round(dot.y), faint: dot.faint })).toEqual([{ y: 10, faint: false }, null, { y: 100, faint: true }, { y: 50, faint: false }]);
  expect(lines.map(line => [line.from, line.to].map(dot => dots.indexOf(dot)))).toEqual([[2, 3]]);
  expect(lines[0]!.faint).toBe(true);
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
