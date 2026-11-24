import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { comparison, delta, parts, share, shareDelta } from "../src/features/analysis/format";
import { analysisMoved, analysisSurfaces, analysisValues, belowLayer, readAnalysis, spanQuery, type AnalysisPlace } from "../src/features/analysis/place";
import { settleSpan } from "../src/features/analysis/AnalysisView";
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
