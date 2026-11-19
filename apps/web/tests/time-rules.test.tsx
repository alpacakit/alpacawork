import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Segment, TaskHistory } from "../src/domain/time-history";
import { clockLabels, heightOf, shapeOf, stripAxis, TimeClock, useProbe, useStripProbe, type Piece } from "../src/features/tree/time-line";

/**
 * The time view's rules. The clock writes clock times only (a fold is a cut with round times
 * on both sides, never its length); the line evens out stretches under 6px without inventing a height or hiding
 * lone work or the state now; a mouse without a held button points at the shared time guide.
 */
const minute = 60_000, hour = 60 * minute;
const now = Date.parse("2026-10-04T12:00:00.000Z");
const work = (_id: string, from: number, to: number) =>
  ([from, to] as const);
/** 1px a minute: a stretch of n minutes is n px wide. */
const scale = { x: (at: number) => (at - now) / minute, from: now - 10 * hour, to: now + hour };
const hand = (from: number, to: number): Segment => ({ from: now + from * minute, to: now + to * minute, kind: "work" });

test("the clock writes clock times and dates only, and a fold starts and ends on a round time", () => {
  const axis = { from: () => now - 72 * hour, end: () => now + hour, now, viewMs: 24 * hour,
    busy: [work("T1", now - 72 * hour + 7 * minute, now - 66 * hour + 13 * minute), work("T2", now - 2 * hour + 11 * minute, now)] };
  const pieces = stripAxis(axis, 900);
  const gap = pieces.find((piece) => piece.gap)!;
  for (const at of [gap.from, gap.to]) expect([new Date(at).getMinutes() % 5, new Date(at).getSeconds()]).toEqual([0, 0]);
  const labels = clockLabels(pieces, pieces.at(-1)!.x1, now, [10_000, 10_001], "en");
  expect(labels.length).toBeGreaterThan(3);
  for (const label of labels) expect(label.text).toMatch(/^(\d{1,2}\/\d{1,2})?( ?\d{2}:\d{2})?$/);
  // The times on both sides of the fold are written.
  expect(labels.map((label) => label.at)).toEqual(expect.arrayContaining([gap.from, gap.to]));
});

test("no clock label runs over a fold's cut, and only what is on screen is written, the first of it with its date", () => {
  const day = 24 * hour;
  // Two folds close together: the time after the first fold could reach the second's cut.
  const pieces: Piece[] = [
    { from: now - 3 * day, to: now - 2 * day, x0: 0, x1: 300, gap: false },
    { from: now - 2 * day, to: now - day - 4 * hour, x0: 300, x1: 330, gap: true },
    { from: now - day - 4 * hour, to: now - day - 3 * hour, x0: 330, x1: 380, gap: false },
    { from: now - day - 3 * hour, to: now - 2 * hour, x0: 380, x1: 410, gap: true },
    { from: now - 2 * hour, to: now, x0: 410, x1: 900, gap: false },
  ];
  const width = (text: string) => text.length * 6.8;
  const extent = (label: { x: number; anchor: string; text: string }): [number, number] => label.anchor === "start" ? [label.x, label.x + width(label.text)]
    : label.anchor === "end" ? [label.x - width(label.text), label.x] : [label.x - width(label.text) / 2, label.x + width(label.text) / 2];
  const cuts = pieces.filter((piece) => piece.gap).map((piece) => (piece.x0 + piece.x1) / 2);
  for (const label of clockLabels(pieces, 900, now, [10_000, 10_001], "en")) {
    const [a, b] = extent(label);
    for (const cut of cuts) expect(b <= cut - 2.5 || a >= cut + 2.5).toBe(true);
  }
  const seen = clockLabels(pieces, 900, now, [10_000, 10_001], "en", [150, 900]);
  for (const label of seen) expect(extent(label)[0]).toBeGreaterThanOrEqual(150);
  expect(seen[0]!.text).toMatch(/^\d{1,2}\/\d{1,2}/);
  // With the reader's text at twice the browser's size (the steps are rem), the words are twice as wide and the
  // clock writes fewer of them, still apart.
  const big = clockLabels(pieces, 900, now, [10_000, 10_001], "en", [0, 900], 2);
  const bigExtent = (label: { x: number; anchor: string; text: string }) => extent(label).map((edge) => label.anchor === "start"
    ? label.x + (edge - label.x) * 2 : label.anchor === "end" ? label.x - (label.x - edge) * 2 : label.x + (edge - label.x) * 2) as [number, number];
  const ordered = big.map(bigExtent).sort((a, b) => a[0] - b[0]);
  for (const [at, [, end]] of ordered.slice(0, -1).entries()) expect(end).toBeLessThanOrEqual(ordered[at + 1]![0]);
  expect(big.length).toBeLessThanOrEqual(clockLabels(pieces, 900, now, [10_000, 10_001], "en").length);
});

test("the axis shows the year when its day crosses into another year", () => {
  const start = new Date(2026, 11, 31, 22).getTime();
  const end = new Date(2027, 0, 1, 2).getTime();
  const today = new Date(2027, 0, 1, 0, 21).getTime();
  const labels = clockLabels([{ from: start, to: end, x0: 0, x1: 900, gap: false }], 900, today, [2000, 2001], "ja");
  expect(labels.some((label) => label.text.includes("2026/12/31"))).toBe(true);
  expect(labels.some((label) => label.text === "1/1")).toBe(true);
});

test("a stretch under 6px goes into the neighbour closest in height, and every height drawn is one that was", () => {
  // 2 people for 30 min, 3 for 2 min (a spike), 2 for 30 min, nobody for 3 min (a dip), 1 for 30 min.
  const hands = [hand(-95, -33), hand(-95, -33), hand(-65, -63), hand(-30, 0)];
  const stretches = shapeOf(now - 95 * minute, now, hands, [], scale, false);
  expect(stretches.every((each) => scale.x(each.to) - scale.x(each.from) >= 6)).toBe(true);
  expect(stretches.map((each) => each.count)).toEqual([2, 1]);
  expect(stretches[0]!.peak).toBe(3);
  expect(stretches.reduce((sum, each) => sum + each.merged, 0)).toBeGreaterThan(0);
  for (const each of stretches) expect([0, 1, 2, 3]).toContain(each.count);
});

test("a person's step stays the same whether a short overlap is evened away or not", () => {
  // Two people at once for 8 min: wider than 6px at 1px a minute, evened into one person at half that.
  const hands = [hand(-60, -22), hand(-30, -10)];
  const half = { ...scale, x: (at: number) => scale.x(at) / 2 };
  const level = { base: 16, unit: 6, rise: 9 };
  const steps = [scale, half].map((each) => heightOf(shapeOf(now - 60 * minute, now, hands, [], each, false), level)(1));
  expect(steps[0]).toBe(steps[1]);
});

test("lone short work and the stretch a task is in now are never evened away", () => {
  const lone = shapeOf(now - 60 * minute, now - 10 * minute, [hand(-30, -29)], [], scale, false);
  expect(lone.some((each) => each.count === 1)).toBe(true);
  const waiting: Segment = { from: now - 2 * minute, to: now, kind: "review" };
  const open = shapeOf(now - 60 * minute, now, [], [waiting], scale, true);
  expect(open.at(-1)).toMatchObject({ count: 0, wait: "review" });
  expect(shapeOf(now - 60 * minute, now, [], [waiting], scale, false).some((each) => each.wait === "review")).toBe(false);
});

test("a fold is marked on the clock wherever it lies, the strip's very start too", () => {
  const folded: Piece[] = [{ from: now - 30 * hour, to: now - 2 * hour, x0: 0, x1: 32, gap: true }, { from: now - 2 * hour, to: now + hour, x0: 32, x1: 632, gap: false }];
  const { container } = render(<TimeClock place="test" pieces={folded} width={632} now={now} onShowAll={() => {}} />);
  expect(container.querySelectorAll("path")).toHaveLength(1);
});

afterEach(() => { cleanup(); useProbe.getState().set(null); });
const pieces: Piece[] = [{ from: now - hour, to: now, x0: 0, x1: 600, gap: false }];
const svg = () => document.body.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));

test("the time guide follows a mouse without a held button and clears while dragging", () => {
  const strip = svg();
  const { result } = renderHook(() => useStripProbe({ place: "list", row: "T1", pieces, stretches: [], hands: [], now }));
  const move = (buttons: number) => act(() => result.current.strip.onPointerMove({ pointerType: "mouse", buttons, target: strip, currentTarget: strip, clientX: 300 } as never));
  move(0);
  expect(useProbe.getState().probe).toEqual({ place: "list", row: "T1", at: now - 30 * minute, runs: 0 });
  move(1);
  expect(useProbe.getState().probe).toBeNull();
});

test("pointing at where a Run ended no longer counts it; pointing inside counts it", () => {
  const hands = [{ from: now - 40 * minute, to: now - 20 * minute, kind: "below" as const }];
  const { result } = renderHook(() => useStripProbe({ place: "list", row: "T1", pieces, stretches: [], hands, now }));
  act(() => result.current.mark.show("stop", now - 20 * minute));
  expect(useProbe.getState().probe?.runs).toBe(0);
  act(() => result.current.mark.show("inside", now - 30 * minute));
  expect(useProbe.getState().probe?.runs).toBe(1);
});

test("pointing at now, or past it, counts what runs now, not what ended now", () => {
  const hands = [{ from: now - 10 * minute, to: now, kind: "below" as const, open: true as const }, { from: now - 40 * minute, to: now, kind: "work" as const },
    { from: now, to: now, kind: "below" as const, open: true as const }];
  const { result } = renderHook(() => useStripProbe({ place: "list", row: "T1", pieces, stretches: [], hands, now }));
  act(() => result.current.mark.show("now", now));
  expect(useProbe.getState().probe?.runs).toBe(2);
  act(() => result.current.mark.show("ahead", now + 5 * minute));
  expect(useProbe.getState().probe?.runs).toBe(2);
});

test("touch movement leaves the time guide closed", () => {
  const strip = svg();
  const { result } = renderHook(() => useStripProbe({ place: "list", row: "T1", pieces, stretches: [], hands: [], now }));
  act(() => result.current.strip.onPointerMove({ pointerType: "touch", buttons: 0, target: strip, currentTarget: strip, clientX: 100 } as never));
  expect(useProbe.getState().probe).toBeNull();
  strip.remove();
});
