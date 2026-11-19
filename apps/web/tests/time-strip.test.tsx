import { expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TaskHistory } from "../src/domain/time-history";
import { atOf, settleScroll, stripAxis, useStrip, xOf, zoomStrip, type StripAxis } from "../src/features/tree/time-line";

const hour = 3_600_000;
const now = Date.parse("2026-10-04T12:00:00.000Z");
const work = (_id: string, from: number, to: number) =>
  ([from, to] as const);
/** Three days: work on the first morning, nothing for two days, work in the last two hours. */
const axis = { from: () => now - 72 * hour, end: () => now + hour, now, busy: [work("T1", now - 72 * hour, now - 66 * hour), work("T2", now - 2 * hour, now)] };
const width = (pieces: ReturnType<typeof stripAxis>) => pieces.at(-1)!.x1;

test("the strip is laid out at the zoom: a shorter stretch per screen makes it longer, and it never fits in less than the screen", () => {
  const day = stripAxis({ ...axis, viewMs: 24 * hour }, 900);
  const six = stripAxis({ ...axis, viewMs: 6 * hour }, 900);
  expect(width(six)).toBeGreaterThan(width(day));
  // One screen-width of a linear piece is `viewMs` long.
  const linear = six.find((piece) => !piece.gap && piece.to - piece.from > hour)!;
  expect((linear.x1 - linear.x0) / (linear.to - linear.from)).toBeCloseTo(900 / (6 * hour), 9);
  const all = stripAxis({ ...axis, viewMs: 30 * 24 * hour }, 900);
  expect(width(all)).toBeCloseTo(900, 6);
});

test("a reader past half the screen hides the oldest part of the strip at its zoom; a strip that fits whole stays whole", () => {
  const six = { ...axis, viewMs: 6 * hour };
  const scale = (pieces: ReturnType<typeof stripAxis>) => {
    const linear = pieces.find((piece) => !piece.gap && piece.to - piece.from > hour)!;
    return (linear.x1 - linear.x0) / (linear.to - linear.from);
  };
  // Its zoom is for 900px: in the 500px left in sight it keeps that scale, and it is what those 500px show at it.
  const beside = stripAxis(six, 500, 900);
  expect(scale(beside)).toBeCloseTo(900 / (6 * hour), 12);
  expect(beside).toEqual(stripAxis({ ...six, viewMs: 6 * hour * 500 / 900 }, 500));
  expect(width(beside)).toBeGreaterThan(500);
  // Zooming beside the reader goes on from the scale drawn: the zoom for 900px, not for the 500px in sight.
  expect(zoomStrip(six, 500, 0, 250, 0.5, 900)!.viewMs).toBeCloseTo(3 * hour, -1);
  // Everything at once is fitted into the 500px in sight, not into the 900px out of it.
  const all = { ...axis, viewMs: 30 * 24 * hour };
  expect(width(stripAxis(all, 500, 900))).toBeCloseTo(500, 6);
  // A strip shorter at its scale than the 900px but longer than the 500px is as long as that, so a zoom never jumps.
  const natural = width(stripAxis({ ...axis, viewMs: 14 * hour }, 500, 900));
  expect(natural).toBeGreaterThan(500);
  expect(natural).toBeLessThan(900);
  // From all of it fitted in sight, a notch zooms in to the very strip it would with nothing hidden.
  const plain = zoomStrip({ ...all, viewMs: 30 * 24 * hour * 500 / 900 }, 500, 0, 250, 0.9)!;
  const hidden = zoomStrip(all, 500, 0, 250, 0.9, 900)!;
  expect(stripAxis({ ...axis, viewMs: hidden.viewMs }, 500, 900)).toEqual(stripAxis({ ...axis, viewMs: plain.viewMs }, 500));
});

test("a stretch in which nothing happened is one short piece, so two days of nothing cost 32px", () => {
  const pieces = stripAxis({ ...axis, viewMs: 24 * hour }, 900);
  const gaps = pieces.filter((piece) => piece.gap);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.x1 - gaps[0]!.x0).toBe(32);
  expect(gaps[0]!.to - gaps[0]!.from).toBeGreaterThan(48 * hour);
});

test("the strip is never longer than 60,000px however far it is zoomed in", () => {
  const busy = { ...axis, busy: [work("T1", now - 72 * hour, now)] };
  expect(width(stripAxis({ ...busy, viewMs: 20 * 60_000 }, 900))).toBeCloseTo(60_000, 3);
});

test("zooming keeps the time under the pointer where it is", () => {
  const busy = { ...axis, busy: [work("T1", now - 72 * hour, now)] };
  const before = stripAxis({ ...busy, viewMs: 24 * hour }, 900);
  const scrollLeft = width(before) - 900, offset = 600;
  const under = atOf(before, scrollLeft + offset);
  const zoom = zoomStrip({ ...busy, viewMs: 24 * hour }, 900, scrollLeft, offset, 0.5)!;
  expect(zoom.viewMs).toBeCloseTo(12 * hour, -1);
  expect(zoom.hold).toEqual({ at: under, offset });
  const after = stripAxis({ ...busy, viewMs: zoom.viewMs }, 900);
  const settled = settleScroll(after, zoom.hold, false, width(after), scrollLeft);
  expect(atOf(after, settled + offset)).toBeCloseTo(under, -2);
  expect(xOf(after, under) - settled).toBeCloseTo(offset, 6);
});

test("a changed zoom refreshes the visible interval before the next frame", () => {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 900 });
  const scroller = { current: element };
  const busy = { ...axis, busy: [work("T1", now - 72 * hour, now)] };
  const { result, rerender } = renderHook(({ viewMs }) => useStrip(scroller, { width: 900, zoomWidth: 900, letGo: false }, 0, { ...busy, viewMs, setViewMs: () => {} }, true),
    { initialProps: { viewMs: 24 * hour } });
  const before = result.current.seen;
  expect(before).not.toBeNull();
  rerender({ viewMs: 6 * hour });
  expect(result.current.seen?.to).not.toBe(before!.to);
});

test("continuous native scrolling refreshes the visible interval once per frame", () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 900 });
  Object.defineProperty(element, "scrollWidth", { value: 5000 });
  const scroller = { current: element };
  const busy = { ...axis, busy: [work("T1", now - 72 * hour, now)] };
  const { result } = renderHook(() => useStrip(scroller, { width: 900, zoomWidth: 900, letGo: false }, 0, { ...busy, viewMs: 24 * hour, setViewMs: () => {} }, true));
  const before = result.current.seen!.from;
  act(() => {
    element.scrollLeft = 100;
    element.dispatchEvent(new Event("scroll"));
    element.scrollLeft = 200;
    element.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
  });
  expect(result.current.seen!.from).not.toBe(before);
  const halfway = result.current.seen!.from;
  act(() => {
    element.scrollLeft = 300;
    element.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    frames.shift()!(16);
  });
  expect(result.current.seen!.from).toBeGreaterThan(halfway);
});

test("a hidden strip gives the scroller no sideways room and leaves it alone; shown again, it starts at now", () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 900 });
  let scrollWidth = 900;
  Object.defineProperty(element, "scrollWidth", { get: () => scrollWidth });
  const scroller = { current: element };
  const busy = { ...axis, busy: [work("T1", now - 72 * hour, now)] };
  const { result, rerender } = renderHook(({ shown }) => useStrip(scroller, { width: 900, zoomWidth: 900, letGo: false }, 0, { ...busy, viewMs: 24 * hour, setViewMs: () => {} }, shown),
    { initialProps: { shown: false } });
  expect(result.current.width).toBe(0);
  expect(result.current.seen).toBeNull();
  expect(element.scrollLeft).toBe(0);
  // A sideways scroll of the hidden list sees no time.
  act(() => { element.scrollLeft = 50; element.dispatchEvent(new Event("scroll")); });
  expect(result.current.seen).toBeNull();
  element.scrollLeft = 0;
  scrollWidth = width(result.current.pieces);
  rerender({ shown: true });
  expect(result.current.width).toBe(scrollWidth);
  expect(result.current.width).toBeGreaterThan(900);
  expect(element.scrollLeft).toBe(scrollWidth);
  expect(result.current.seen!.to).toBeGreaterThanOrEqual(now);
  // Read back in time, hidden (the browser clamps the scroll to 0), and shown again: it opens on now, not on the start.
  act(() => { element.scrollLeft = 100; element.dispatchEvent(new Event("scroll")); });
  scrollWidth = 900;
  rerender({ shown: false });
  element.scrollLeft = 0;
  expect(result.current.width).toBe(0);
  expect(result.current.seen).toBeNull();
  scrollWidth = width(result.current.pieces);
  rerender({ shown: true });
  expect(element.scrollLeft).toBe(scrollWidth);
});

test("a strip fitted into the screen zooms from what is drawn, so the first notch already shows", () => {
  // Eight hours of work in three days: at a day a screen it is shorter than the screen, so it is drawn fitted.
  const fitted = stripAxis({ ...axis, viewMs: 24 * hour }, 900);
  expect(width(fitted)).toBeCloseTo(900, 6);
  const zoom = zoomStrip({ ...axis, viewMs: 24 * hour }, 900, 0, 450, 0.8)!;
  expect(zoom.viewMs).toBeLessThan(24 * hour);
  expect(width(stripAxis({ ...axis, viewMs: zoom.viewMs }, 900))).toBeGreaterThan(900);
  // Fitted is as wide as it goes.
  expect(zoomStrip({ ...axis, viewMs: 24 * hour }, 900, 0, 450, 1.5)).toBeNull();
});

test("zoom stops at twenty minutes a screen and at the longest strip", () => {
  const busy = { ...axis, busy: [work("T1", now - 72 * hour, now)] };
  expect(zoomStrip({ ...busy, viewMs: 20 * 60_000 }, 900, 0, 0, 0.5)).toBeNull();
  expect(zoomStrip({ ...busy, viewMs: 12 * hour }, 900, 0, 0, 0.01)!.viewMs).toBe(20 * 60_000);
});

test("the room left after now may depend on the zoom: a step in is still a step that shows", () => {
  // The list ends 18% of a screen after now (three hours at most), so its end moves in as it zooms in.
  const list = { ...axis, end: (viewMs: number) => now + Math.min(viewMs * 0.18, 3 * hour), viewMs: 24 * hour };
  const zoom = zoomStrip(list, 900, 0, 450, 0.67)!;
  expect(width(stripAxis({ ...list, viewMs: zoom.viewMs }, 900))).toBeGreaterThan(900);
  expect(zoomStrip({ ...list, viewMs: zoom.viewMs }, 900, 0, 450, 1.5)).not.toBeNull();
});

test("a strip at its right end follows now as it grows; one scrolled away stays where it is", () => {
  const pieces = stripAxis({ ...axis, viewMs: 24 * hour }, 900);
  expect(settleScroll(pieces, null, true, 2400, 1500)).toBe(2400);
  expect(settleScroll(pieces, null, false, 2400, 700)).toBe(700);
  // A held time wins over following now: the reader has just zoomed about it.
  expect(settleScroll(pieces, { at: now - hour, offset: 100 }, true, 2400, 700)).toBeCloseTo(xOf(pieces, now - hour) - 100, 6);
});

test("all of time puts the whole strip in sight: a short history zooms out past show's zoom, a long one stays at it", () => {
  const element = document.createElement("div");
  let clientWidth = 900;
  Object.defineProperty(element, "clientWidth", { get: () => clientWidth });
  Object.defineProperty(element, "scrollWidth", { get: () => clientWidth });
  const scroller = { current: element };
  const minute = 60_000;
  const strip = (axis: Omit<StripAxis, "viewMs">, viewMs: number, all: boolean) =>
    renderHook(() => useStrip(scroller, { width: clientWidth, zoomWidth: clientWidth, letGo: false }, 0, { ...axis, viewMs, all, futureWidth: 80, setViewMs: () => {} }, true));
  const whole = (pieces: ReturnType<typeof stripAxis>) => pieces.at(-1)!.x1 <= clientWidth + 0.5;
  // 25 minutes of work: the strip reaches 5 minutes past what show's zoom (28 minutes) brings onto the screen.
  const earliest = now - 25 * minute;
  const short = { ...axis, from: (viewMs: number) => Math.min(earliest, now - viewMs) - 5 * minute, busy: [work("T1", earliest, now)] };
  expect(whole(strip(short, 28 * minute, false).result.current.pieces)).toBe(false);
  expect(whole(strip(short, 28 * minute, true).result.current.pieces)).toBe(true);
  // At any width.
  clientWidth = 400;
  expect(whole(strip(short, 28 * minute, true).result.current.pieces)).toBe(true);
  clientWidth = 900;
  // Three days with a long quiet stretch folded away: show's zoom already has all of it in sight, and is kept.
  const long = { ...axis, from: (viewMs: number) => Math.min(now - 72 * hour, now - viewMs) - 5 * minute };
  expect(strip(long, 81 * hour, true).result.current.pieces).toEqual(strip(long, 81 * hour, false).result.current.pieces);
  expect(whole(strip(long, 81 * hour, true).result.current.pieces)).toBe(true);
});
