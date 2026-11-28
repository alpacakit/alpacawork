import { axisPad, axisMinGap, logKey, userTurn, type Ball, type Busy } from "@alpacawork/contract";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { cn } from "@/lib/utils";
import type { ListWidth } from "@/lib/use-list-width";
import { readerEdgeHeld } from "@/state/screen-settings";
import { Icon } from "@/components/ui/icon";
import { onReaderMove } from "@/components/ui/hover-card";
import { MarkShape, type MarkKind, type MarkTone } from "@/components/ui/timeline-mark";
import { TONE } from "@/components/ui/tone";
import { FINISH_MARK, STOP_MARK } from "@/domain/report-events";
import { useTimeView } from "@/state/time-view";
import { TimeTipPopover } from "./time-tip";
import type { FinishWords } from "@/domain/finish-words";
import { isHand, type Segment, type TaskHistory, type TimeEvent } from "@/domain/time-history";
import { formatCalendarDate, formatClock, sameCalendarDay } from "@/domain/time";
import { arrive, distance, duration, easing, justHappened, reducedMotion, scrollMotion } from "@/lib/motion";
import { continuesDrawing, liveDrawing, sameDrawingSource, type DrawingSource } from "@/lib/drawing";

/**
 * A task's time as one line, the one part both the list's time view and the reader's History
 * band draw with. The line's height says how many Runs work on the task and under it, as the row's running count does; on the base its colour says whose turn it
 * is; the future band names a running estimate with a dashed way on to it, and past its estimate the line is inked; marks sit
 * where the turn changed. The axis folds stretches in which nothing happened into a narrow cut. The clock says only clock
 * times, the line is evened to the zoom (shapeOf), and pointing at a line shows its clock time (useStripProbe).
 */
const BREAK_W = 32;
export type Piece = { from: number; to: number; x0: number; x1: number; gap: boolean };
/** How far a mark reaches above and below its centre: its ring of 9, and 1 more where its focus ring is stroked. */
export const MARK_REACH = 10;
/**
 * The line's geometry for a row: the row's height, where the base sits, one person's step, and the most it may rise.
 * The marks and words of a row keep the row's middle, as its title does, whatever the line's base is.
 */
export type Level = { height: number; base: number; unit: number; rise: number };
type Wait = Exclude<Segment["kind"], "work" | "member" | "below">;
export type Scale = { x: (at: number) => number; from: number; to: number; width: number };

const isWait = (segment: Segment): segment is Segment & { kind: Wait } => !isHand(segment);

/**
 * The time axis under the hand. Scrolling it sideways is the scroller's own scrolling (wheel, trackpad, a finger),
 * so the browser decides between up-down and sideways as it does everywhere. Pinching or ctrl/⌘ + wheel
 * from the time strip zooms its axis; the title column and other surfaces leave page zoom to the browser.
 * A mouse without a sideways wheel can drag the strip. A press that does not move stays a press.
 * Its answer says whether the strip is under the hand now: two fingers pinching it, or a mouse pressed on it.
 */
function useStripInput(scroller: RefObject<HTMLElement | null>, zoom: (factor: number, clientX: number) => void, shown: boolean) {
  const handler = useRef(zoom);
  handler.current = zoom;
  const held = useRef(false);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !shown) return;
    const onStrip = (target: EventTarget | null) => target instanceof Element && !!target.closest("[data-time-strip]");
    const bothOnStrip = (touches: TouchList) => touches.length === 2 && onStrip(touches[0]!.target) && onStrip(touches[1]!.target);
    const wheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || !onStrip(event.target)) return;
      event.preventDefault();
      // Fine trackpad steps need to show, while one mouse-wheel notch should be no larger than a key step.
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      const exponent = Math.max(-Math.log(1.5), Math.min(Math.log(1.5), pixels * 0.012));
      handler.current(Math.exp(exponent), event.clientX);
    };
    let touching = false, spread: number | null = null, scale = 1, gestureZoom = false, last: number | null = null, moved = 0;
    const hand = () => { held.current = spread !== null || gestureZoom || last !== null; };
    // Only two fingers that began on strips need to cancel native moves; a normal pan stays with the browser.
    const releaseTouch = () => { spread = null; element.removeEventListener("touchmove", touchMove); };
    const distance = (touches: TouchList) => Math.abs(touches[0]!.clientX - touches[1]!.clientX) + Math.abs(touches[0]!.clientY - touches[1]!.clientY);
    const touchStart = (event: TouchEvent) => {
      touching = true;
      releaseTouch();
      spread = bothOnStrip(event.touches) ? Math.max(1, distance(event.touches)) : null;
      if (spread !== null) element.addEventListener("touchmove", touchMove, { passive: false });
      hand();
    };
    const touchMove = (event: TouchEvent) => {
      // A clock mark may be replaced by React while the fingers stay down. Their start targets
      // may then be detached, but the gesture still belongs to the strip where both began.
      if (spread === null || event.touches.length !== 2) { releaseTouch(); hand(); return; }
      event.preventDefault();
      const now = Math.max(1, distance(event.touches));
      // Safari also sends gesturechange for this pinch. Once it starts, that event owns the zoom.
      if (!gestureZoom) handler.current(spread / now, (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2);
      spread = now;
    };
    const touchEnd = (event: TouchEvent) => {
      touching = event.touches.length > 0;
      if (event.touches.length !== 2) releaseTouch();
      hand();
    };
    const gestureStart = (event: Event) => {
      gestureZoom = touching ? spread !== null : onStrip(event.target);
      // GestureEvent.scale starts at this event, after any zoom already applied by touchmove.
      scale = 1;
      if (gestureZoom) event.preventDefault();
      hand();
    };
    const gestureChange = (event: Event) => {
      if (!gestureZoom) return;
      const gesture = event as Event & { scale: number; clientX: number };
      event.preventDefault();
      handler.current(scale / gesture.scale, gesture.clientX);
      scale = gesture.scale;
    };
    const gestureEnd = () => { gestureZoom = false; hand(); };
    const down = (event: PointerEvent) => { if (event.pointerType === "mouse" && event.button === 0 && (event.target as Element).closest("[data-time-strip]")) { last = event.clientX; moved = 0; hand(); } };
    const move = (event: PointerEvent) => {
      if (last === null) return;
      moved += Math.abs(event.clientX - last);
      // Only a real drag takes the pointer: a press on a mark or a row must still reach it.
      if (moved > 4) { if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId); element.scrollLeft -= event.clientX - last; }
      last = event.clientX;
    };
    const up = () => { last = null; hand(); };
    const click = (event: Event) => { if (moved > 4) { event.stopPropagation(); event.preventDefault(); } moved = 0; };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchend", touchEnd); element.addEventListener("touchcancel", touchEnd);
    element.addEventListener("gesturestart", gestureStart); element.addEventListener("gesturechange", gestureChange); element.addEventListener("gestureend", gestureEnd);
    element.addEventListener("pointerdown", down); element.addEventListener("pointermove", move);
    // A press let go off the strip (or off the page) ends there too: the release goes to whatever is under it.
    window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up); element.addEventListener("click", click, true);
    return () => {
      releaseTouch();
      held.current = false;
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchend", touchEnd); element.removeEventListener("touchcancel", touchEnd);
      element.removeEventListener("gesturestart", gestureStart); element.removeEventListener("gesturechange", gestureChange); element.removeEventListener("gestureend", gestureEnd);
      element.removeEventListener("pointerdown", down); element.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); element.removeEventListener("click", click, true);
    };
  }, [scroller, shown]);
  return () => held.current;
}

/** After the last zoom step, how long the strip still counts as being zoomed (wheel notches and key presses have no end). */
const ZOOM_SETTLE_MS = 600;
/** A strip is never longer than this: a longer one is drawn at the closest zoom that fits it. */
const STRIP_MAX = 60_000;
const MIN_VIEW = 20 * 60_000;
/**
 * `from` and `end`: where the strip starts and ends at a zoom. The list reaches back at least a screen and leaves room
 * after now that depends on the zoom, so they are rules, not times.
 */
export type StripAxis = { from: (viewMs: number) => number; end: (viewMs: number) => number; now: number; busy: Busy; viewMs: number;
  /** A list row reserves this many pixels after now, independent of the time zoom. */
  futureWidth?: number };
/** Whether all of the strip is in `screen`, what is in sight of it: "all of time" is shown. */
export const wholeIn = (pieces: Piece[], screen: number) => (pieces.at(-1)?.x1 ?? 0) <= screen + 0.5;
/**
 * The zoom that brings `first` to `last` onto `screen`, what is in sight of a strip zoomed for `layout`, with a little air
 * on both sides, and the time it starts at.
 */
export function showZoom(first: number, last: number, screen: number, layout: number, futureWidth = 0): { viewMs: number; at: number } {
  const air = Math.max(60_000, (last - first) * 0.06);
  const sight = Math.max(60, layout - futureWidth) / Math.max(60, screen - futureWidth);
  return { viewMs: Math.max(MIN_VIEW, last - first + 2 * air) * sight, at: first - air };
}
/** A time kept `offset` px from the strip's left edge of the screen: what a zoom holds still. */
export type Hold = { at: number; offset: number };

/**
 * The strip's axis at the zoom `viewMs` (how much time one screen-width shows), as long as it needs to be.
 * It is never shorter than the screen (zoomed out that far, it is fitted into it) nor longer than STRIP_MAX.
 * `open` is the screen the zoom is for, when wider than what is in sight (a reader past half the screen): the
 * strip keeps that screen's scale, so the reader hides its oldest part rather than squeezing it. It is laid out as
 * what is in sight shows at that scale (what it folds away goes with that), and so is fitted into it only when shorter.
 */
export function stripAxis(axis: StripAxis, screen: number, open = screen): Piece[] {
  if (open <= screen) return axisAt(axis, screen);
  const past = (width: number) => Math.max(60, width - (axis.futureWidth ?? 0)), from = axis.from(axis.viewMs), to = axis.end(axis.viewMs);
  return axisAt({ ...axis, viewMs: axis.viewMs * past(screen) / past(open), from: () => from, end: () => to }, screen);
}

function axisAt({ from: start, end, now, busy, viewMs, futureWidth = 0 }: StripAxis, screen: number): Piece[] {
  const from = start(viewMs);
  // Shorter than the room it is fitted into it; longer than the most a strip takes it is drawn closer.
  const fit = (to: number, room: number, most: number) => {
    const perMs = room / viewMs;
    const strip = buildAxis(from, to, now, busy, 0, viewMs, perMs);
    const width = strip.at(-1)?.x1 ?? 0;
    if (width < room) return buildAxis(from, to, now, busy, room, viewMs);
    return width > most ? buildAxis(from, to, now, busy, 0, viewMs, perMs * most / width) : strip;
  };
  if (!futureWidth) return fit(end(viewMs), screen, STRIP_MAX);
  const pastScreen = Math.max(60, screen - futureWidth);
  const past = fit(now, pastScreen, STRIP_MAX - futureWidth);
  const edge = past.at(-1)?.x1 ?? pastScreen;
  return [...past, { from: now, to: end(viewMs), x0: edge, x1: edge + futureWidth, gap: false }];
}

/** The amount of linear time drawn across the past part of one screen. Folded gaps have their own fixed width. */
export function shownScaleMs(pieces: Piece[], screen: number, futureWidth = 0): number {
  const linear = pieces.find((piece) => !piece.gap && piece.to > piece.from && piece.x1 > piece.x0);
  return linear ? Math.max(1, screen - futureWidth) * (linear.to - linear.from) / (linear.x1 - linear.x0) : 0;
}

/**
 * A zoom by `factor` (above 1 = a longer stretch of time on screen) about the point `offset` px into the screen:
 * the next zoom, and the time under that point, to be held there. The zoom starts from what is actually drawn
 * (a strip fitted into the screen is drawn closer than its `viewMs` says) and, zooming in, goes on until the
 * strip is longer than the screen: what is folded away changes with the zoom, so one step may not be enough,
 * and a notch that changes nothing would read as a dead control.
 * Null at the ends: a fitted strip cannot go wider, one at STRIP_MAX or at MIN_VIEW a screen cannot go closer.
 */
export function zoomStrip(axis: StripAxis, screen: number, scrollLeft: number, offset: number, factor: number, open = screen): { viewMs: number; hold: Hold } | null {
  const pieces = stripAxis(axis, screen, open);
  const linear = pieces.find((piece) => !piece.gap && piece.to > piece.from && piece.x1 > piece.x0);
  if (!linear) return null;
  if (factor >= 1 ? wholeIn(pieces, screen) : pieces.at(-1)!.x1 >= STRIP_MAX - 0.5) return null;
  const shown = shownScaleMs(pieces, open, axis.futureWidth);
  const floor = Math.min(MIN_VIEW, shown);
  let next = Math.max(floor, shown * factor);
  const width = pieces.at(-1)!.x1;
  // Whether this zoom has not changed the strip's length the way it goes (a factor of 1 goes neither way).
  const unchanged = (drawn: Piece[]) => factor < 1 ? drawn.at(-1)!.x1 <= width + 0.5 : factor > 1 && drawn.at(-1)!.x1 >= width - 0.5;
  let candidate = stripAxis({ ...axis, viewMs: next }, screen, open);
  for (let step = 0; step < 12 && unchanged(candidate) && (factor > 1 || next > floor); step++) {
    next = Math.max(floor, next * factor);
    candidate = stripAxis({ ...axis, viewMs: next }, screen, open);
  }
  if (unchanged(candidate)) return null;
  return Math.abs(next - shown) < 1 ? null : { viewMs: next, hold: { at: atOf(pieces, scrollLeft + offset), offset } };
}

/**
 * Where the strip is scrolled to once it has been laid out again: a held time goes back under its point; a strip
 * that was at its right end (on now) stays there as it grows; otherwise it stays where it is.
 */
export function settleScroll(pieces: Piece[], hold: Hold | null, atEnd: boolean, scrollWidth: number, scrollLeft: number): number {
  return hold ? xOf(pieces, hold.at) - hold.offset : atEnd ? scrollWidth : scrollLeft;
}

/**
 * With no hand on the scroller, how long it goes without a scroll before it counts as at rest: longer than a frame's gap
 * in a wheel's or a trackpad's scrolling, short enough to follow the eye. Not scrollend: Chrome sends it between the
 * wheel events of one trackpad swipe still being scrolled.
 */
const STILL_MS = 160;
const GLIDE = "edge-glide";

/**
 * The notes at the strip's edges ([data-edge]: a state's icon with its time, ‹ …, … ›) say what lies past an
 * edge of what is shown, so they stand at it, but only once the strip is at rest. Pushed back to the edge by
 * script on every scroll event, each a frame behind the browser's own scrolling, they shook. So while the strip
 * scrolls they ride with the time under them, as everything else on it does, and once it rests (no hand on the
 * scroller, and STILL_MS without a scroll) they glide to its edges over --motion-slow ease-out. One that
 * has gone out of sight comes in from its own side by --motion-shift-far, fading in. A glide still under way when the
 * strip moves again runs on to its end on top of the ride. Reduced motion puts them there at once, one coming into
 * sight only fading in.
 * Where they stand is a time (the strip's left edge at rest). A new axis while the strip rests (new work, now moving on,
 * a zoom) puts them at its edge at once; while it moves, they keep to that time until it rests. Each note is drawn at
 * what is seen, whose left is at `base`, and moved by the difference. Called after the strip has scrolled to its axis.
 */
function useEdgeRest(scroller: RefObject<HTMLElement | null>, lead: number, pieces: Piece[], base: number | null, source: DrawingSource) {
  const rest = useRef<{ at: number; source: DrawingSource } | null>(null);
  /** A scroll event alone may be the axis laying itself out; native input owns a move under the hand. */
  const moving = useRef<"axis" | "hand" | null>(null);
  const held = useRef(false);
  const laid = useRef(pieces);
  const latest = useRef({ lead, pieces, base, source });
  latest.current = { lead, pieces, base, source };
  // Any commit may draw notes anew (what is seen changed, a row changed): each is moved to where they stand before paint.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || base === null) { rest.current = null; return; }
    const rebased = rest.current && !sameDrawingSource(rest.current.source, source) && !continuesDrawing(rest.current.source, source);
    if (rest.current === null || rebased && moving.current !== "hand" || laid.current !== pieces && !moving.current)
      rest.current = { at: atOf(pieces, element.scrollLeft), source };
    laid.current = pieces;
    stand(element, xOf(pieces, rest.current.at) - base);
  });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let timer = 0;
    const settle = () => {
      const { lead, pieces, base, source } = latest.current;
      if (held.current) return;
      const hand = moving.current === "hand", before = rest.current;
      moving.current = null;
      if (base === null || before === null) return;
      rest.current = { at: atOf(pieces, element.scrollLeft), source };
      if (Math.abs(xOf(pieces, before.at) - element.scrollLeft) < 0.5) return;
      const offset = xOf(pieces, rest.current.at) - base;
      if (hand || continuesDrawing(before.source, source)) glide(element, lead, offset);
      else stand(element, offset);
    };
    const wait = () => { moving.current ??= "axis"; clearTimeout(timer); if (!held.current) timer = window.setTimeout(settle, STILL_MS); };
    const input = () => { moving.current = "hand"; wait(); };
    const wheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey && !event.defaultPrevented) input(); };
    const key = (event: KeyboardEvent) => { if (stripKey(event) === "scroll") input(); };
    const hold = () => { input(); held.current = true; clearTimeout(timer); };
    const letGo = () => { if (held.current) { held.current = false; wait(); } };
    // A finger is down from touchstart to the last finger's touchend anywhere on the page (its pointer is cancelled once
    // the page pans); a mouse or pen from its press on the scroller (its scrollbar too) to its release anywhere. A touch's
    // later events go to where it began, even once React has taken that out of the page (a clock time scrolled away under
    // the finger), where they no longer bubble: they are heard there too.
    const touched = new Set<EventTarget>();
    const press = (event: PointerEvent) => { if (event.pointerType !== "touch") hold(); };
    const release = (event: PointerEvent) => { if (event.pointerType !== "touch") letGo(); };
    const lift = (event: Event) => {
      if ((event as TouchEvent).touches.length) return;
      for (const target of touched) { target.removeEventListener("touchend", lift); target.removeEventListener("touchcancel", lift); }
      touched.clear();
      letGo();
    };
    const touch = (event: TouchEvent) => {
      hold();
      const target = event.target ?? element;
      if (touched.has(target)) return;
      touched.add(target);
      target.addEventListener("touchend", lift); target.addEventListener("touchcancel", lift);
    };
    element.addEventListener("scroll", wait, { passive: true });
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("keydown", key);
    element.addEventListener("pointerdown", press, { passive: true });
    element.addEventListener("touchstart", touch, { passive: true });
    window.addEventListener("touchend", lift, true); window.addEventListener("touchcancel", lift, true);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); window.addEventListener("blur", letGo);
    return () => {
      held.current = false;
      clearTimeout(timer);
      for (const target of touched) { target.removeEventListener("touchend", lift); target.removeEventListener("touchcancel", lift); }
      element.removeEventListener("scroll", wait);
      element.removeEventListener("wheel", wheel); element.removeEventListener("keydown", key);
      element.removeEventListener("pointerdown", press); element.removeEventListener("touchstart", touch);
      window.removeEventListener("touchend", lift, true); window.removeEventListener("touchcancel", lift, true);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("blur", letGo);
    };
  }, [scroller]);
}

/** SVG glyphs keep their coordinates and hit targets; the HTML layer alone moves on the compositor.
 * Overflow stays visible through each wrapper, so neither the words nor their focus/click area are clipped. */
export function EdgeLayer({ children, layer }: { children: ReactNode; layer?: RefObject<HTMLDivElement | null> }) {
  return <foreignObject width={1} height={1} style={{ overflow: "visible", pointerEvents: "none" }}>
    <div ref={layer} data-edge-layer style={{ width: 1, height: 1, overflow: "visible" }}>
      <svg width={1} height={1} style={{ overflow: "visible", pointerEvents: "none" }}>{children}</svg>
    </div>
  </foreignObject>;
}
const edgeLayer = (edge: SVGGraphicsElement) => edge.closest<HTMLElement>("[data-edge-layer]")!;
const edgesIn = (element: HTMLElement) => [...element.querySelectorAll<SVGGraphicsElement>("[data-edge]")];
function stand(element: HTMLElement, offset: number) {
  for (const edge of edgesIn(element)) edgeLayer(edge).style.transform = `translateX(${offset}px)`;
}

/** The edge notes to `offset`, each from where it is drawn now: see useEdgeRest. */
function glide(element: HTMLElement, lead: number, offset: number) {
  const edges = edgesIn(element);
  const box = element.getBoundingClientRect(), left = box.left + lead, right = box.left + element.clientWidth;
  const was = edges.map((edge) => edge.getBoundingClientRect());
  for (const edge of edges) for (const each of edgeLayer(edge).getAnimations?.() ?? []) if (each.id === GLIDE) each.cancel();
  stand(element, offset);
  if (typeof element.animate !== "function" || document.hidden) return;
  const timing: KeyframeAnimationOptions = { id: GLIDE, duration: duration("slow"), easing: easing("out") };
  const far = distance("shift-far");
  // Read all destinations before starting any animations, so one edge does not flush the next edge's style.
  const destinations = edges.map(edge => edge.getBoundingClientRect());
  edges.forEach((edge, index) => {
    const from = was[index]!, to = destinations[index]!;
    const by = (shift: number) => edgeLayer(edge).animate([{ transform: `translateX(${shift}px)` }, { transform: "translateX(0)" }], { ...timing, composite: "add" });
    if (from.right > left && from.left < right) {
      if (!reducedMotion() && Math.abs(from.left - to.left) >= 0.5) by(from.left - to.left);
      return;
    }
    if (far) by(to.left + to.width / 2 < (left + right) / 2 ? -far : far);
    edgeLayer(edge).animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, duration: duration(far ? "slow" : "fast") });
  });
}

/**
 * The reader's edge let go: the strip, held at its scale while the edge was dragged, moves from that scale to the
 * one it is laid out at now, about now, over --motion-base, as the edge notes glide once the strip rests. Reduced motion
 * puts it there at once.
 */
function settleStrip(scroller: HTMLElement, from: Piece[], to: Piece[], now: number) {
  if (reducedMotion()) return;
  const scale = (strip: Piece[]) => {
    const near = strip.filter((piece) => !piece.gap && piece.to <= now + 1 && piece.x1 > piece.x0).at(-1);
    return near ? (near.x1 - near.x0) / (near.to - near.from) : 0;
  };
  const ratio = scale(from) / scale(to);
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return;
  const transformOrigin = `${xOf(to, now)}px 0`;
  for (const strip of scroller.querySelectorAll<SVGElement>("[data-time-strip]"))
    strip.animate([{ transform: `scaleX(${ratio})`, transformOrigin }, { transform: "none", transformOrigin }],
      { duration: duration("base"), easing: easing("out") });
}

/**
 * A time strip inside a sideways scroller: stripAxis laid out, starting at its right end, on now. Zooming keeps the
 * time under the pointer where it is. `lead` is what stays fixed left of the strip inside the scroller (the title column).
 * `list` is the scroller's widths (useListWidth), read once by the list for its title column and its strip alike, so the
 * two never see different widths. The zoom is for `layout` (its zoomWidth): a reader past half the screen narrows only
 * what is seen of the strip (`screen`, stripAxis's `open`).
 * The strip alone gives the scroller its sideways room and sets where it scrolls to, and only while it is `shown`:
 * hidden, it is 0 wide, leaves the scroller alone and sees no time; shown again, it starts at now.
 */
export function useStrip(scroller: RefObject<HTMLElement | null>, list: ListWidth, lead: number,
  axis: StripAxis & { all?: boolean; setViewMs: (viewMs: number | "all") => void }, shown: boolean, source: DrawingSource = liveDrawing) {
  const { from, end, now, busy, viewMs: asked, all = false, futureWidth, setViewMs } = axis;
  const screen = Math.max(120, list.width - lead), layout = Math.max(screen, list.zoomWidth - lead);
  // All of time is the closest zoom out from `asked` (show's zoom for the history) at which all of the strip is
  // in sight, found anew for every width and every now: the strip starts a little before the history, and that stretch
  // folds away only once it is long enough, so a short history at show's zoom is longer than the screen.
  const viewMs = useMemo(() => {
    if (!all) return asked;
    for (let next = asked, step = 0; step <= 40; step++, next *= 1.25)
      if (wholeIn(stripAxis({ from, end, now, busy, viewMs: next, futureWidth }, screen, layout), screen)) return next;
    return asked;
  }, [all, asked, from(asked), end(asked), now, busy, futureWidth, screen, layout]);
  const start = from(viewMs), to = end(viewMs);
  const pieces = useMemo(() => stripAxis({ from, end, now, busy, viewMs, futureWidth }, screen, layout), [start, to, now, busy, viewMs, futureWidth, screen, layout]);
  const width = shown ? pieces.at(-1)?.x1 ?? screen : 0;
  const latest = useRef(pieces);
  latest.current = pieces;
  const hold = useRef<Hold | null>(null);
  /** The list's widths the strip last moved for once the reader's edge was let go: it moves once for each. */
  const settledFor = useRef<ListWidth | null>(null);
  const atEnd = useRef(true);
  /** On the way to now (toNow's smooth scroll): the strip counts as at its end until it gets there or the reader takes over. */
  const seeking = useRef(false);
  const laidOut = useRef<Piece[] | null>(null);
  const zoomedAt = useRef(Number.NEGATIVE_INFINITY);
  const [seen, setSeen] = useState<{ from: number; to: number } | null>(null);
  const look = () => {
    const element = scroller.current;
    if (!element) return;
    const next = { from: atOf(latest.current, element.scrollLeft), to: atOf(latest.current, element.scrollLeft + screen) };
    setSeen((was) => was && Math.abs(was.from - next.from) < 1000 && Math.abs(was.to - next.to) < 1000 ? was : next);
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (!shown) {
      atEnd.current = true; seeking.current = false; hold.current = null; laidOut.current = null;
      setSeen(null);
      return;
    }
    // A new axis with now on screen (new work came in) keeps now where it was on screen, so it is not pushed off it.
    const before = laidOut.current;
    laidOut.current = pieces;
    if (!hold.current && !atEnd.current && before && before !== pieces) {
      const offset = xOf(before, now) - element.scrollLeft;
      if (offset >= 0 && offset <= screen) hold.current = { at: now, offset };
    }
    // Laid out for the widths read as the reader's edge was let go, it moves there from the layout it was held at.
    if (list.letGo && settledFor.current !== list && before && before !== pieces) settleStrip(element, before, pieces, now);
    const left = settleScroll(pieces, hold.current, atEnd.current, element.scrollWidth, element.scrollLeft);
    // Writing the same position cancels an in-flight smooth scroll in the browser.
    if (left !== element.scrollLeft) element.scrollLeft = left;
    hold.current = null;
    // A new axis moves marks and edge notes even without a scroll event. Refresh its visible
    // interval before paint; while the reader's edge is held, once it is let go.
    if (!readerEdgeHeld.get()) look();
  }, [pieces, screen, shown]);
  // After the layout above: widths it has seen, laid out for or not, are not moved for again (a later zoom is a zoom).
  useLayoutEffect(() => { settledFor.current = list; }, [list]);
  useEdgeRest(scroller, lead, pieces, shown && seen ? xOf(pieces, seen.from) : null, source);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !shown) return;
    let frame = 0;
    const scrolled = () => {
      const end = element.scrollLeft + element.clientWidth >= element.scrollWidth - 2;
      if (end) seeking.current = false;
      atEnd.current = end || seeking.current;
      // The visible interval also decides whether an edge note exists. Keep it current while
      // panning, with at most one React update per frame for any number of native scroll events.
      if (!frame && !readerEdgeHeld.get()) frame = requestAnimationFrame(() => { frame = 0; look(); });
    };
    const stopHeld = readerEdgeHeld.subscribe(() => { if (!readerEdgeHeld.get()) look(); });
    const takeOver = () => { seeking.current = false; };
    element.addEventListener("scroll", scrolled, { passive: true });
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) element.addEventListener(type, takeOver, { passive: true });
    return () => {
      element.removeEventListener("scroll", scrolled); cancelAnimationFrame(frame); stopHeld();
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"] as const) element.removeEventListener(type, takeOver);
    };
  }, [scroller, screen, shown]);
  const zoomBy = (factor: number, clientX: number) => {
    const element = scroller.current;
    if (!element) return;
    const offset = Math.min(screen, Math.max(0, clientX - element.getBoundingClientRect().left - lead));
    const zoom = zoomStrip({ from, end, now, busy, viewMs, futureWidth }, screen, element.scrollLeft, offset, factor, layout);
    if (!zoom) return;
    hold.current = zoom.hold;
    atEnd.current = false;
    zoomedAt.current = performance.now();
    setViewMs(zoom.viewMs);
  };
  const underHand = useStripInput(scroller, zoomBy, shown);
  /** To `zoom` (a time per screen, or all of time) with `at` at the screen's left edge. */
  const go = (zoom: number | "all", at: number) => {
    const element = scroller.current;
    atEnd.current = false;
    if (zoom !== (all ? "all" : viewMs)) { hold.current = { at, offset: 0 }; setViewMs(zoom); }
    else if (element) element.scrollLeft = xOf(latest.current, at);
  };
  const onto = (first: number, last: number) => showZoom(first, last, screen, layout, futureWidth);
  return {
    pieces, width, screen, layout, seen, zoomBy, to,
    /** Choose a named period without moving away from the reader's current time. */
    toScale: (next: number) => {
      const element = scroller.current;
      if (!element || !all && next === viewMs) return;
      if (!atEnd.current) hold.current = { at: atOf(latest.current, element.scrollLeft + screen / 2), offset: screen / 2 };
      setViewMs(next);
    },
    /** Brings a stretch of time onto the screen, with a little air on both sides. */
    show: (first: number, last: number) => { const zoom = onto(first, last); go(zoom.viewMs, zoom.at); },
    /** All of time, from `first` (the oldest history) to `last`: kept all in sight until another zoom is chosen. */
    showAll: (first: number, last: number) => go("all", onto(first, last).at),
    /** Whether now is on screen while the strip is left alone: not pinched, pressed or just zoomed, not read back in time. */
    onNow: () => {
      const element = scroller.current;
      return !!element && !underHand() && performance.now() - zoomedAt.current > ZOOM_SETTLE_MS
        && xOf(latest.current, now) <= element.scrollLeft + screen + 1;
    },
    /** Back to the right end, where now is; from there the strip follows now again. */
    toNow: () => { atEnd.current = true; seeking.current = true; scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: scrollMotion() }); },
    /** The next layout starts at the right end (a different set of rows is a different strip). */
    restart: () => { atEnd.current = true; seeking.current = false; hold.current = null; },
  };
}

/**
 * Only what a person is to know gets a mark, in the colours History's marks have: where the task finished (green), what
 * your turn waits on (orange) and where it stopped (red), each only while it is so (standingRecord). The rest is in the
 * line's shape (work starting and ending), and a press on the line opens it in History (lineReports).
 */
export function compactMark({ source }: TimeEvent): { kind: MarkKind; tone: MarkTone } | null {
  if (!source.note) return null;
  if (source.finished) return FINISH_MARK;
  if (source.stopped) return STOP_MARK;
  return source.yours ? { kind: "report", tone: "turn" } : null;
}

/**
 * A stretch of the line as it is drawn: `count` people at work, or on the base (0) coloured by `wait`.
 * `peak` is the most people at once inside it and `merged` how many short stretches of the exact line were evened
 * into it, so a merged stretch can say so in its note.
 */
type Stretch = { from: number; to: number; count: number; wait: Wait | null; peak: number; merged: number };
/** A run, with the task it belongs to. */
export type Hand = Segment & { task: string };
/** A stretch narrower than this on screen is merged into a neighbour: under it a step reads as a crumb, not as a step. */
const GRAIN = 6;

/**
 * The line between `start` and `end`, raised by how many `hands` overlap and on the base in the wait it sits in,
 * evened to the zoom: the narrowest stretch under GRAIN px goes into the neighbour closest to it in height (a short
 * dip fills, a short spike flattens, a short stair step joins the step beside it), until none is left. Every height
 * drawn is one that really was, and two things are never merged away, however short: work alone between quiet
 * stretches, and (`open`, a line not ended) the last stretch, which is how the task is now.
 * Zooming in gives each stretch more pixels, so the steps part again.
 */
export function shapeOf(start: number, end: number, hands: Segment[], waits: Segment[], scale: Pick<Scale, "x" | "from" | "to">, open: boolean): Stretch[] {
  const { x } = scale;
  const first = Math.max(start, scale.from);
  end = Math.min(end, scale.to);
  if (end <= first) return [];
  const endpoints = new Set([first, end]);
  const starts: number[] = [], ends: number[] = [];
  for (const { from, to } of hands) {
    endpoints.add(from);
    endpoints.add(to);
    starts.push(from);
    ends.push(to);
  }
  for (const segment of waits) {
    endpoints.add(segment.from);
    endpoints.add(segment.to);
  }
  const cuts: number[] = [];
  for (const at of endpoints) if (at >= first && at <= end) cuts.push(at);
  cuts.sort((a, b) => a - b);
  // How many hands hold a time between two cuts: those begun before it less those ended before it. A row may hold every
  // Run under it, so this is counted from sorted ends, not by asking each hand at each cut.
  starts.sort((a, b) => a - b); ends.sort((a, b) => a - b);
  const before = (sorted: number[], at: number) => { let low = 0, high = sorted.length; while (low < high) { const mid = (low + high) >> 1; if (sorted[mid]! < at) low = mid + 1; else high = mid; } return low; };
  type Node = Stretch & { prev: Node | null; next: Node | null; alive: boolean; version: number };
  let head: Node | null = null, tail: Node | null = null, length = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!, to = cuts[i + 1]!, mid = (from + to) / 2;
    const count = before(starts, mid) - before(ends, mid);
    let wait: Wait | null = null;
    if (!count) for (const segment of waits) {
      if (segment.from <= mid && segment.to >= mid) {
        wait = segment.kind as Wait;
        if (wait === "stuck") break;
      }
    }
    if (tail && tail.count === count && tail.wait === wait) { tail.to = to; continue; }
    const node: Node = { from, to, count, wait, peak: count, merged: 0, prev: tail, next: null, alive: true, version: 0 };
    if (tail) tail.next = node; else head = node;
    tail = node; length++;
  }
  // The narrowest stretch under GRAIN goes first, the earliest among equals, as one pass over all of them would pick it.
  const width = (each: Stretch) => x(each.to) - x(each.from);
  const alike = (a: Stretch, b: Stretch) => a.count === b.count && (a.count > 0 || a.wait === b.wait);
  const mergeable = (each: Node) => each.alive && length >= 2 && width(each) < GRAIN
    && !(each.count && !each.prev?.count && !each.next?.count) && !(open && each.next === null);
  type Entry = { node: Node; version: number; width: number; from: number };
  const heap: Entry[] = [];
  const less = (a: Entry, b: Entry) => a.width < b.width || a.width === b.width && a.from < b.from;
  const push = (node: Node | null) => {
    if (!node || !mergeable(node)) return;
    heap.push({ node, version: node.version, width: width(node), from: node.from });
    for (let i = heap.length - 1; i > 0;) { const up = (i - 1) >> 1; if (!less(heap[i]!, heap[up]!)) break; [heap[i], heap[up]] = [heap[up]!, heap[i]!]; i = up; }
  };
  const pop = () => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l; if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break; [heap[i], heap[m]] = [heap[m]!, heap[i]!]; i = m; }
    }
    return top;
  };
  const remove = (node: Node) => {
    node.alive = false; length--;
    if (node.prev) node.prev.next = node.next; else head = node.next;
    if (node.next) node.next.prev = node.prev; else tail = node.prev;
  };
  const changed = (node: Node | null) => { if (node) { node.version++; push(node); } };
  for (let node = head; node; node = node.next) push(node);
  while (heap.length) {
    const entry = pop(), each = entry.node;
    if (entry.version !== each.version || !mergeable(each)) continue;
    const into = [each.prev, each.next].filter((side): side is Node => !!side && (!each.count || side.count > 0))
      .sort((a, b) => Math.abs(a.count - each.count) - Math.abs(b.count - each.count) || width(b) - width(a))[0]!;
    into.from = Math.min(into.from, each.from); into.to = Math.max(into.to, each.to);
    into.peak = Math.max(into.peak, each.peak); into.merged += each.merged + 1;
    remove(each);
    // The neighbour may now meet one like it on its other side.
    let survivor = into;
    for (const [a, b] of [[into, into.next], [into.prev, into]] as const) {
      if (a && b && a.alive && b.alive && alike(a, b)) { a.to = b.to; a.peak = Math.max(a.peak, b.peak); a.merged += b.merged; remove(b); survivor = a; }
    }
    // What can be merged next around it may have changed: its width, its neighbours, and theirs.
    for (const node of [survivor.prev?.prev ?? null, survivor.prev, survivor, survivor.next, survivor.next?.next ?? null]) changed(node);
  }
  const out: Stretch[] = [];
  for (let node = head; node; node = node.next) out.push({ from: node.from, to: node.to, count: node.count, wait: node.wait, peak: node.peak, merged: node.merged });
  return out;
}

/** A row's own runs and waits. */
export function lineOf(own: TaskHistory | null, now: number, scale: Scale) {
  const hands: Hand[] = [];
  const waits: (Segment & { kind: Wait })[] = [];
  if (!own) return { stretches: [] as Stretch[], hands, waits, drops: false };
  for (const segment of own.segments) {
    if (isWait(segment)) waits.push(segment);
    else hands.push({ ...segment, task: own.taskId });
  }
  const end = own.end ?? now;
  return { stretches: shapeOf(own.start, end, hands, waits, scale, own.end == null),
    hands, waits, drops: own.end != null && end <= scale.to };
}

/**
 * How high the line stands with `count` at work: a step a person while the most at once fits under `rise`. A row that
 * has had more at once grows as the square root of the count, up to `rise` at its most, so one at work still stands
 * clear of the base there and each one more is a smaller step.
 * The most at once is each stretch's `peak`, not its evened `count`: whether a short overlap is evened away depends on
 * the zoom, and the axis moves a little with every update, so the step would change with it and every run on the row
 * would rise and fall.
 */
export function heightOf(stretches: Stretch[], level: Level) {
  let maximum = 1;
  for (const each of stretches) maximum = Math.max(maximum, each.peak);
  return (count: number) => level.base - Math.min(count * level.unit, level.rise * Math.sqrt(count / maximum));
}

const WAIT_LINE = { held: ["text-lit-line", 1, "2 3"], review: ["text-lit-line", 1, undefined], stuck: [TONE.error, 1.5, undefined] } as const;

/**
 * The line itself. Each raised run is one outline and one fill, drawn in one stroke, so no step leaves a crumb on
 * another and no two fills overlap into a stripe. It steps down at its end only when that is a real end (done), not now.
 * `late` draws only its work, as it looks past the estimate (Lane clips it there): a grey fill under a softened ink
 * outline. An estimate is the agent's own guess, so running past it is said quietly, never in an alarm's colour.
 * Where no one is at work the line is only a trace that the task was there: the quietest stroke on the sheet. From
 * `turnFrom` on it is the turn's colour, whatever the wait under it is called.
 */
function Wave({ stretches, scale, level, drops, turnFrom, late }: { stretches: Stretch[]; scale: Scale; level: Level; drops: boolean; turnFrom: number | null;
  /** Paint over the working tint before applying the overdue fill. */
  late?: boolean }) {
  const { x } = scale;
  if (!stretches.length) return null;
  const y = heightOf(stretches, level);
  const out: ReactNode[] = [];
  const flat = (key: string, from: number, to: number, [colour, width, dash]: readonly [string, number, string | undefined]) => to > from && out.push(
    <line key={key} x1={x(from)} x2={x(to)} y1={level.base} y2={level.base} className={colour} stroke="currentColor" strokeWidth={width} strokeDasharray={dash} />);
  for (let i = 0; i < stretches.length;) {
    const each = stretches[i]!;
    if (!each.count) {
      if (late) { i++; continue; }
      const base = each.wait ? WAIT_LINE[each.wait] : ["text-idle-line", 1, undefined] as const;
      const turn = turnFrom !== null && each.wait !== "held" && each.wait !== "stuck" ? Math.max(each.from, Math.min(each.to, turnFrom)) : each.to;
      flat(`b${i}`, each.from, turn, base);
      flat(`t${i}`, turn, each.to, ["text-turn-line", 1, undefined]);
      i++;
      continue;
    }
    let d = `M${x(each.from)} ${y(0)}`, j = i;
    // Work alone that is narrower than a stroke is drawn 2px wide, so it can be seen and pointed at.
    for (; j < stretches.length && stretches[j]!.count; j++) d += `V${y(stretches[j]!.count)}H${Math.max(x(stretches[j]!.to), x(stretches[j]!.from) + 2)}`;
    // Past the estimate the grey covers the working tint under it, rather than mixing with it.
    if (late) out.push(<path key={`c${i}`} d={`${d}V${y(0)}Z`} className="text-bg" fill="currentColor" stroke="none" />,
      <path key={`f${i}`} d={`${d}V${y(0)}Z`} className="fill-overdue-area" stroke="none" />);
    else out.push(<path key={`f${i}`} d={`${d}V${y(0)}Z`} className="fill-work-area" stroke="none" />);
    out.push(<path key={`w${i}`} d={j < stretches.length || drops ? `${d}V${y(0)}` : d} className={late ? "text-overdue" : TONE.working} fill="none"
      stroke="currentColor" strokeWidth={1.5} />);
    i = j;
  }
  return <g strokeLinecap="round" strokeLinejoin="round">{out}</g>;
}

export type MarkAt = { id?: string; event: TimeEvent; display?: "pin" | "mark" };

/** A task's own marks. */
export const laneMarks = (history: TaskHistory | null): MarkAt[] => {
  const marks: MarkAt[] = [];
  history?.events.forEach(event => {
    if (compactMark(event) !== null) marks.push({ id: history.taskId, event, display: event.source.yours ? "pin" : "mark" });
  });
  return marks;
};

/** What a press on the line can open: what was reported, by the same display rule as the task's History. */
export const lineReports = (history: TaskHistory | null): MarkAt[] => {
  const reports: MarkAt[] = [];
  history?.events.forEach(event => {
    if (event.source.log && event.source.note?.mark?.kind === "report" && event.source.note.displayed !== false)
      reports.push({ id: history.taskId, event });
  });
  return reports;
};

function latest(items: MarkAt[], eligible: (item: MarkAt) => boolean): MarkAt | undefined {
  let best: MarkAt | undefined;
  for (const item of items) {
    if (!eligible(item)) continue;
    if (!best || (best.event.at - item.event.at || best.event.key.localeCompare(item.event.key)) < 0) best = item;
  }
  return best;
}

/**
 * The report opened by a press on the pointed stretch: the task's last report inside it. A stretch in which only the work
 * under the task went on has none, and opens the task as a quiet stretch does, not at a report hours before.
 */
export function stretchReport(stretches: Stretch[], reports: MarkAt[], pointed: number, now: number): MarkAt | undefined {
  const stretch = stretches.find(each => pointed >= each.from && pointed <= each.to);
  if (!stretch || !stretch.count && stretch.wait !== "review") return undefined;
  const end = Math.min(stretch.to, now);
  return latest(reports, mark => mark.event.at >= stretch.from && mark.event.at <= end);
}

/** The marks on a line. A task stands on few records (standingRecord), so each has room for its own. */
function Marks({ marks, scale, y, onPick, probe }: {
  marks: MarkAt[]; scale: Scale; y: number; onPick: (key: string, id?: string) => void; probe?: MarkProbe;
}) {
  const shown: ReactNode[] = [];
  marks.forEach(({ id, event, display }) => {
    if (event.at >= scale.from && event.at <= scale.to) shown.push(
      <Mark key={`${id ?? ""}:${event.key}`} event={event} shape={compactMark(event)!} pin={display === "pin"} x={scale.x(event.at)} y={y}
        onPick={() => onPick(event.key, id)} probe={probe} />);
  });
  return <>{shown}</>;
}

/** A mark names what it stands for, as History does; generated record details stay out of its note and label. */
function useMarkWords() {
  const { t } = useTranslation("reader");
  return (kind: MarkKind) => kind === "error" ? t("history.runError") : t("history.approved");
}

/** An edge note's ground around its text: wide enough to meet across the gaps between its characters, so the line stops at the note. */
export const EDGE_HALO = 8;
/**
 * The row's ground under an edge note's icon and words, from `from` to `to`: the line runs at the row's base, under the
 * words' middle, and stops clear of them rather than being nicked by each glyph's halo.
 */
export const EdgeGround = ({ from, to, y }: { from: number; to: number; y: number }) =>
  <rect x={from} y={y - 8} width={Math.max(0, to - from)} height={16} rx={8} className="fill-[var(--row-ground,var(--bg))]" />;

/**
 * What every pressable glyph on a strip that opens History (a mark, an edge note) is: one button; the band's expected
 * report opens its tip instead (FutureLabel). A pointer's press, Enter or Space does
 * `onPress`, never the strip's own press under it. One that stands for a moment (`point`) shows its time on the strip's
 * probe while a mouse points at it or it has focus, and with a `ring`, is ringed while History points at that record.
 */
export function StripPress({ onPress, point, probe, ring, glyph, style, className, attributes, children }: {
  onPress: () => void; point?: { key: string; at: number }; probe?: MarkProbe;
  /** Where the ring is drawn, in which tone, and its radius while History points at the record (9 otherwise). */
  ring?: { x: number; y: number; tone: MarkTone; pointed: number };
  glyph?: RefObject<SVGGElement | null>; style?: CSSProperties; className?: string;
  attributes?: { [name: `data-${string}`]: string | boolean | undefined; "aria-label"?: string }; children: ReactNode }) {
  const hovered = useTimeView(state => point !== undefined && state.hovered?.key === point.key);
  const show = point && probe ? () => probe.show(point.key, point.at) : undefined;
  return <g ref={glyph} style={{ ...style, pointerEvents: "auto" }} role="button" tabIndex={0} {...attributes}
    className={cn("cursor-pointer outline-none", ring && "[&:focus-visible>circle:first-of-type]:stroke-muted", className)}
    onClick={(e) => { e.stopPropagation(); onPress(); }}
    onPointerEnter={show && ((e) => { if (e.pointerType === "mouse") show(); })}
    onFocus={show} onBlur={show && (() => probe!.hide())}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPress(); }
    }}>
    {ring && <circle cx={ring.x} cy={ring.y} r={hovered ? ring.pointed : 9} fill="transparent" className={TONE[ring.tone]}
      stroke={hovered ? "currentColor" : "none"} strokeWidth={2} />}
    {children}
  </g>;
}

/** The shared mark (components/ui/timeline-mark), made pickable: it opens History at that event. Pointing at it or focusing it shows its clock time. */
function Mark({ event, shape: { kind, tone }, pin, x, y, onPick, probe }: { event: TimeEvent; shape: { kind: MarkKind; tone: MarkTone }; pin: boolean; x: number; y: number; onPick: () => void; probe?: MarkProbe }) {
  const { t } = useTranslation("tree");
  const words = useMarkWords()(kind);
  const icon = event.source.note?.kind === "question" ? "question" : "review";
  const label = pin ? t("timeView.yourTurn") : words;
  // A report that lands while the screen is open grows from its point on the line, once.
  const own = useRef<SVGGElement>(null), layer = useRef<HTMLDivElement>(null);
  const [layered, setLayered] = useState(false);
  const arrival = useRef<{ key: string; at: number; pending: boolean } | null>(null);
  useLayoutEffect(() => {
    if (arrival.current?.key !== event.key || arrival.current.at !== event.at)
      arrival.current = { key: event.key, at: event.at, pending: justHappened(`mark:${event.key}`, event.at) };
    if (!own.current) return;
    // A zoom can move the glyph while it arrives. Its former fill-box origin followed that change too.
    const scaling = layer.current?.getAnimations?.().some(animation => animation.playState !== "finished" && animation.playState !== "idle"
      && animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => "scale" in frame));
    if (!arrival.current.pending && !scaling) return;
    // Ordinary, already-seen marks need no extra drawing layer. A new mark gets one before its first paint.
    if (!layer.current) { setLayered(true); return; }
    // The SVG glyph's former fill-box centre, in the same coordinates: only the HTML layer scales now.
    const box = own.current.getBBox();
    layer.current.style.transformOrigin = `${box.x + box.width / 2}px ${box.y + box.height / 2}px`;
    if (arrival.current.pending) { arrival.current.pending = false; arrive(layer.current); }
  }, [event.key, event.at, layered, x, y, kind, pin]);
  const glyph = <StripPress glyph={own} style={{ transformBox: "fill-box", transformOrigin: "center" }} onPress={onPick}
    point={event} probe={probe} ring={{ x, y, tone, pointed: pin ? 8 : 8.5 }} attributes={{ "aria-label": label, "data-mark": event.key, "data-pin": pin || undefined }}>
    {pin ? <g className={TONE.turn}>
      <rect x={x - 9} y={y - 8} width={18} height={16} rx={8} fill="currentColor" className="stroke-[var(--row-ground,var(--bg))]" strokeWidth={2} paintOrder="stroke" />
      <Icon name={icon} x={x - 6} y={y - 6} width={12} height={12} strokeWidth={2.2} className="size-3 text-bg" />
    </g> : <MarkShape kind={kind} tone={tone} x={x} y={y} surface="text-[var(--row-ground,var(--bg))]" />}
  </StripPress>;
  return layered ? <EdgeLayer layer={layer}>{glyph}</EdgeLayer> : glyph;
}

/** The reader's turn on a row: when it began, what it waits on, and the History record that asks it. */
export type RowTurn = { at: number; why: "question" | "review"; key: string };
/**
 * A row's turn as its ball says it. The ball is sent with the row, so the turn is known whether or not the record that
 * asks it is read yet; the line's colour and the edge note both take it from here.
 */
export function rowTurn(task: { id: string; ball: Ball | null }): RowTurn | null {
  const turn = userTurn(task.ball);
  return turn?.reason === "question" || turn?.reason === "review"
    ? { at: Date.parse(turn.at), why: turn.reason, key: logKey(task.id, turn.key) } : null;
}

/**
 * A turn begun before the strip's left edge, standing there: what it waits on as the small state icon the other edge
 * notes have, in the turn's colour, and when it began. It opens History at the record that asks it, as its mark does.
 */
export function TurnEdge({ turn, x, y, words, heard, onPick, probe }: { turn: RowTurn; x: number; y: number;
  /** Beside the icon, or "" where the strip has no room for it. */
  words: string;
  /** What it is named and pointed at by (its title): what it waits on, and since when. */
  heard: string; onPick: () => void; probe?: MarkProbe }) {
  return <EdgeLayer><StripPress onPress={onPick} point={turn} probe={probe} ring={{ x, y, tone: "turn", pointed: 8 }}
    attributes={{ "data-mark": turn.key, "data-edge": "turn" }} className="group/edge">
    <title>{heard}</title>
    <EdgeGround from={x - 16} to={x + 8 + (words ? 2 + wordsW(words, textScale()) + 4 : 0)} y={y} />
    <Icon name={turn.why} x={x - 6} y={y - 6} width={12} height={12} className={cn("size-3", TONE.turn)} />
    {words && <text x={x + 10} y={y + 4} strokeWidth={EDGE_HALO} paintOrder="stroke" strokeLinejoin="round"
      className="fill-trail stroke-[var(--row-ground,var(--bg))] text-xs tabular-nums group-hover/edge:fill-ink group-focus-visible/edge:fill-ink">{words}</text>}
  </StripPress></EdgeLayer>;
}

/**
 * One row's time: the line, where its estimate said it would end, the way on to that end, and the marks.
 */
export function Lane({ line, marks, scale, level, now, finish, turnFrom, onPick, probe }: {
  line: ReturnType<typeof lineOf>; marks: MarkAt[]; scale: Scale; level: Level; now: number;
  finish: FinishWords | null;
  /** When the reader's turn on this row began (the row's ball), or null when it is not theirs. */
  turnFrom: number | null; onPick: (key: string, id?: string) => void; probe?: MarkProbe;
}) {
  const { x } = scale;
  // The future band owns the estimate's visible words and the way on to them; the past shows only the work past the
  // estimate, in Wave's `late` look.
  const passed = finish?.at && finish.tone === "late" && finish.at <= Math.min(now, scale.to) ? finish.at : null;
  const overFrom = passed === null ? 0 : x(Math.max(passed, scale.from));
  const overTo = x(Math.min(now, scale.to));
  // A clip id that is unique in the page and valid inside url(#…).
  const overId = `over${useId().replace(/[^\w-]/g, "")}`;
  const label = now < scale.to ? futureWords(finish, now) : null;
  const labelX = x(now) + FUTURE_LABEL_PAD;
  return <g>
    <Wave stretches={line.stretches} scale={scale} level={level} drops={line.drops}
      turnFrom={turnFrom} />
    {passed !== null && <g data-overrun>
      <clipPath id={overId}><rect x={overFrom} y={0} width={Math.max(0, overTo - overFrom)} height={level.base + 4} /></clipPath>
      <g clipPath={`url(#${overId})`}><Wave stretches={line.stretches} scale={scale} level={level} drops={line.drops} turnFrom={null} late /></g>
    </g>}
    <Marks marks={marks} scale={scale} y={level.height / 2} onPick={onPick} probe={probe} />
    {label && <FutureLabel words={label} long={finish!.long} x={labelX} y={level.height / 2} height={level.height} over={passed !== null} />}
  </g>;
}

/**
 * The band's words for one row, pressed (a click, Enter or Space) to open what they mean in the reader's words, as the
 * row's other times are (TimeTipPopover); never the strip's own press under it. Its hit area is the row's height over
 * its words, so a press need not land on a glyph, and its focus ring stays inside a phone's short strip. It keeps the
 * page's pointer rule: while another tip is open, a press on it only closes that tip, as on the row's other times.
 */
function FutureLabel({ words, long, x, y, height, over }: { words: FutureWords; long: string; x: number; y: number; height: number; over: boolean }) {
  const { t } = useTranslation("tree");
  const heading = t("status.tip.report");
  const k = textScale();
  const width = wordsW(words.text, k) + (words.days === 0 ? 0 : dayMarkW(words.days, k));
  return <TimeTipPopover heading={heading} body={<p>{long}</p>}>
    <g data-future-tip role="button" tabIndex={0} aria-label={`${heading}: ${long}`}
      className="group/future cursor-pointer outline-none"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }}>
      <rect x={x - 4} y={1} width={width + 8} height={height - 2} rx={3} fill="transparent"
        className="group-focus-visible/future:stroke-ink/40" strokeWidth={2} />
      <text data-future-label x={x} y={y + 4} textAnchor="start"
        className={cn("text-xs tabular-nums decoration-dotted group-hover/future:underline group-data-[state=open]/future:underline",
          over ? "fill-ink font-medium" : "fill-muted")}>
        <FutureText words={words} /></text>
    </g>
  </TimeTipPopover>;
}

/** The visible words and width of the shared future band; only drawn rows contribute to its width. */
const FUTURE_LABEL_PAD = 16, FUTURE_END_PAD = 4;
/** The band's words: the time without a day word, and how many days from today it is (0 today), marked small after it. */
export type FutureWords = { text: string; days: number };
export function futureWords(finish: FinishWords | null, now: number): FutureWords | null {
  if (!finish?.at) return null;
  return (finish.at <= now ? finish.tone === "late" : finish.tone === "quiet") ? { text: finish.brief, days: finish.briefDays } : null;
}
/** The band's words, the day mark raised small right after the clock ("22:35⁺¹以降", "After 22:35⁺¹"). */
function FutureText({ words }: { words: FutureWords }) {
  const clock = words.days === 0 ? null : /\d{1,2}:\d{2}/.exec(words.text);
  if (!clock) return <>{words.text}</>;
  const end = clock.index + clock[0].length, rest = words.text.slice(end);
  return <>{words.text.slice(0, end)}<tspan data-future-day dx={1} dy={-4} className="text-micro font-medium">{dayMark(words.days)}</tspan>
    {rest && <tspan dy={4}>{rest}</tspan>}</>;
}
/** A day other than today, as the small mark after a band's clock: "+1", "+3", "-1". It reads the same in every language. */
const dayMark = (days: number) => `${days > 0 ? "+" : "−"}${Math.abs(days)}`;
/** The small mark's width: about 6px a figure at text-micro, and 1px of air. */
const dayMarkW = (days: number, k: number) => (1 + 6 * dayMark(days).length) * k;
/** The band is as wide as its widest words, a day mark included, and never narrower than a clock. */
export function futureBandWidth(labels: readonly FutureWords[]): number {
  const k = textScale();
  let width = wordsW("00:00", k);
  for (const label of labels) width = Math.max(width, wordsW(label.text, k) + (label.days === 0 ? 0 : dayMarkW(label.days, k)));
  return FUTURE_LABEL_PAD + width + FUTURE_END_PAD;
}

/** About how wide the strip's text-xs words are: CHAR_W a figure or letter, 12px a full-width character, at the reader's size. */
export const wordsW = (text: string, k: number) => {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) < 0x2000 ? CHAR_W : 12;
  return width * k;
};


/** The pointed clock time is independent of detail loading and never opens a card. */
export type Probe = { place: string; row: string; at: number;
  /** How many Runs are at work on the row at that time, as its line and its running count say. */
  runs?: number };
export const useProbe = create<{ probe: Probe | null; set: (probe: Probe | null) => void }>((set) => ({ probe: null, set: (probe) => set({ probe }) }));
if (typeof window !== "undefined") onReaderMove(() => useProbe.getState().set(null));
type MarkProbe = { show: (key: string, at: number) => void; hide: () => void };
export function useStripProbe({ place, row, pieces, stretches, hands, now, back }: {
  place: string; row: string; pieces: Piece[]; stretches: Stretch[]; hands: Segment[]; now: number; back?: () => void;
}) {
  const set = useProbe((state) => state.set);
  // A Run counts from its start up to, not at, its end: pointing at where one ended (a stop's mark) counts it no more.
  // One still going counts at now and after it too, as the row's ■ does.
  const runsAt = (at: number) => { const t = Math.min(at, now); return hands.reduce((count, hand) => hand.from <= t && (t < hand.to || hand.open) ? count + 1 : count, 0); };
  const show = (at: number) => set({ place, row, at, runs: runsAt(at) });
  const hide = () => set(null);
  const steps = useMemo(() => stretches.filter(each => each.count || each.wait), [stretches]);
  return {
    mark: { show: (_key: string, at: number) => show(at), hide },
    enter: (svg: SVGSVGElement) => { svg.focus({ preventScroll: true }); const step = steps.at(-1); if (step) show((step.from + step.to) / 2); },
    strip: {
      "data-probe": place + ":" + row,
      onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => {
        if (event.pointerType !== "mouse") return;
        if (event.buttons) { hide(); return; }
        if ((event.target as Element).closest("[data-mark]")) return;
        show(atOf(pieces, event.clientX - event.currentTarget.getBoundingClientRect().left));
      },
      onPointerLeave: hide, onBlur: hide,
      onKeyDown: (event: ReactKeyboardEvent<SVGSVGElement>) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" || !steps.length) return;
        event.preventDefault(); event.stopPropagation();
        const was = useProbe.getState().probe;
        const index = was?.place === place && was.row === row ? steps.findIndex(each => was.at >= each.from && was.at <= each.to) : -1;
        const next = index < 0 ? steps.length - 1 : index + (event.key === "ArrowRight" ? 1 : -1);
        if (next < 0) { hide(); back?.(); return; }
        const step = steps[Math.min(next, steps.length - 1)]!;
        show((step.from + step.to) / 2);
      },
    },
  };
}

/** The rule down the sheet at the pointed time; hidden where the frozen title column lies over the strip. */
export function ProbeRule({ place, pieces, lead, scroller }: { place: string; pieces: Piece[]; lead: number; scroller: RefObject<HTMLElement | null> }) {
  const probe = useProbe((state) => state.probe);
  if (!probe || probe.place !== place) return null;
  const x = xOf(pieces, probe.at);
  if (x < (scroller.current?.scrollLeft ?? 0)) return null;
  return <div aria-hidden="true" data-probe-rule style={{ left: lead + x }} className="pointer-events-none absolute inset-y-0 z-4 w-px bg-clock-rule" />;
}

/**
 * The band's frame, the same wherever a time strip is drawn (the list's sheet, the detail's History).
 * `TimeClock` is the frozen top: clock times only, a fold as a cut with the times on both sides of it, now as a line
 * with its clock time, and the pointed time when a hand is on a strip. `Ground` is what lies under a line in a row:
 * the past plain, what is still to come under a veil, now a line, the folds as hairlines. `stripKeys` is the
 * keyboard's way to what the hand does on either.
 * What differs by place stays with the place: which lines are drawn, the rows' heights, and what a press opens.
 */
/** The clock's height: its text-xs line and the ticks under it, at the reader's size (`k`, textScale). */
export const clockHeight = (k = textScale()) => 30 * k;

/** `seen`: the stretch on screen; labels under the frozen column or past the screen's end are hidden. */
export function TimeClock({ place, pieces, width, now, onShowAll, seen, inset = 0, insetStart = 0 }: { place: string; pieces: Piece[]; width: number; now: number;
  onShowAll: () => void; seen?: { from: number; to: number } | null; inset?: number; insetStart?: number }) {
  const { t, i18n } = useTranslation("tree");
  const locale = i18n.language;
  const probe = useProbe((state) => state.probe?.place === place ? state.probe.at : null);
  const probeRuns = useProbe((state) => state.probe?.place === place ? state.probe.runs ?? 0 : 0);
  const nowX = xOf(pieces, now);
  const nowLabel = t("timeView.now", { clock: formatClock(new Date(now).toISOString()) });
  // The clock is drawn at the browser's 16px and grows with the reader's text size, its words and the room for them alike.
  const k = textScale(), height = clockHeight(k);
  const nowW = nowLabel.length * NOW_CHAR_W * k;
  const nowRight = nowX + 8 + nowW > width;
  const nowKeep: [number, number] = nowRight ? [nowX - 8 - nowW, nowX] : [nowX, nowX + 8 + nowW];
  const viewFrom = (seen ? xOf(pieces, seen.from) : 0) + insetStart, viewTo = (seen ? xOf(pieces, seen.to) : width) - inset;
  // Now's label, like the times, is not written half under the frozen column.
  const nowCut = [viewFrom, viewTo].some((edge) => nowKeep[0] < edge && nowKeep[1] > edge);
  const labels = useMemo(() => clockLabels(pieces, width, now, nowKeep, locale, [viewFrom, viewTo], k), [pieces, width, now, nowKeep[0], nowKeep[1], viewFrom, viewTo, k, locale]);
  const probeX = probe === null ? null : xOf(pieces, probe);
  const probeText = probe === null ? "" : `${clockText(probe, now, locale)}${probeRuns ? ` ■${probeRuns}` : ""}`;
  const probeW = (probeText.length * CHAR_W + 10) * k;
  const probeLeft = probeX === null ? null : Math.max(viewFrom, Math.min(viewTo - probeW, probeX - probeW / 2));
  // Under the pointed time the clock writes nothing else.
  const probeKeep = probeLeft === null ? null : [probeLeft - 6, probeLeft + probeW + 6];
  const cuts: ReactNode[] = [], shown: ReactNode[] = [];
  for (const piece of pieces) if (piece.gap && ((piece.x0 + piece.x1) / 2 < nowKeep[0] - 6 || (piece.x0 + piece.x1) / 2 > nowKeep[1] + 6))
    cuts.push(<Cut key={piece.from} piece={piece} k={k} />);
  for (const label of labels) {
    if (probeKeep) {
      const [a, b] = labelExtent(label, k);
      if (!(b < probeKeep[0]! || a > probeKeep[1]!)) continue;
    }
    shown.push(<g key={`${label.at}:${label.anchor}`}>
      {label.anchor === "middle" && <line x1={label.x} x2={label.x} y1={26 * k} y2={height} className="stroke-lit-line" />}
      <text x={label.x} y={20 * k} textAnchor={label.anchor} className={cn("text-xs tabular-nums", label.day ? "fill-ink font-semibold" : "fill-muted")}>{label.text}</text>
    </g>);
  }
  return <svg data-time-clock data-time-strip width={width} height={height} className="block flex-none cursor-grab select-none active:cursor-grabbing" role="img" aria-label={t("timeView.time")}
    onDoubleClick={onShowAll}>
    <title>{t("timeView.help")}</title>
    <rect x={nowX} y={0} width={Math.max(0, width - nowX)} height={height} className="fill-future" />
    {cuts}
    {shown}
    {!nowCut && <text x={nowRight ? nowX - 6 : nowX + 6} y={20 * k} textAnchor={nowRight ? "end" : "start"}
      className="fill-ink text-xs font-semibold tabular-nums">{nowLabel}</text>}
    <line x1={Math.min(nowX, width - 0.5)} x2={Math.min(nowX, width - 0.5)} y1={8 * k} y2={height} className="stroke-ink" />
    {probeLeft !== null && <g data-probe-clock>
      <rect x={probeLeft} y={6 * k} width={probeW} height={18 * k} rx={3 * k} className="fill-ink" />
      <text x={probeLeft + probeW / 2} y={19 * k} textAnchor="middle" className="fill-bg text-xs font-semibold tabular-nums">{probeText}</text>
    </g>}
  </svg>;
}

/** A fold on the clock: a cut drawn across the axis, the same shape at every length, the strip's first piece too. */
function Cut({ piece, k }: { piece: Piece; k: number }) {
  const mid = (piece.x0 + piece.x1) / 2, step = 4 * k;
  return <g className="stroke-muted" fill="none">
    <path d={`M${mid - 2.5} ${9 * k}l5 ${step}-5 ${step} 5 ${step}-5 ${step} 5 ${step}`} strokeWidth={1} strokeLinejoin="round" />
  </g>;
}

/** A clock time as the clock says it: "14:12" on the day of `today`, "10/3 14:12" on another. */
function clockText(at: number, today: number, locale: string) {
  const clock = formatClock(new Date(at).toISOString());
  return sameCalendarDay(at, today) ? clock : `${formatCalendarDate(at, today, locale)} ${clock}`;
}

/**
 * The ground under the lines: what is still to come under a veil, now as a rule, and each fold as a dotted hairline.
 * Beside the titles (a wide sheet) it is one layer under every row, heading and gap alike, so now is one rule from the
 * clock to the list's end; `seen` keeps a fold under the frozen title column from showing through the rows' rules there.
 * Under the titles (a narrow sheet) each strip draws its own (`StripGround`), as the titles lie between the strips.
 */
export function Ground({ pieces, width, now, lead, seen }: { pieces: Piece[]; width: number; now: number; lead: number; seen: { from: number; to: number } | null }) {
  const { nowX, folds } = groundOf(pieces, width, now, seen);
  return <div aria-hidden="true" data-time-ground style={{ left: lead, width }} className="pointer-events-none absolute inset-y-0 -z-1 overflow-hidden">
    <div style={{ left: nowX }} className="absolute inset-y-0 right-0 bg-future" />
    {folds.map((x) => <div key={x} style={{ left: x }} className="absolute inset-y-0 border-l border-dotted border-fold" />)}
    <div style={{ left: nowX }} className="absolute inset-y-0 w-px bg-clock-rule" />
  </div>;
}
export function StripGround({ pieces, width, height, now }: { pieces: Piece[]; width: number; height: number; now: number }) {
  const { nowX, folds } = groundOf(pieces, width, now, null);
  return <>
    <rect x={nowX} y={0} width={Math.max(0, width - nowX)} height={height} className="fill-future" />
    {folds.map((x) => <line key={x} x1={x} x2={x} y1={0} y2={height} className="stroke-fold" strokeDasharray="1 2" />)}
    <line x1={nowX} x2={nowX} y1={0} y2={height} className="stroke-clock-rule" />
  </>;
}
function groundOf(pieces: Piece[], width: number, now: number, seen: { from: number; to: number } | null) {
  const from = seen ? xOf(pieces, seen.from) : 0, folds: number[] = [];
  for (const piece of pieces) if (piece.gap && piece.x0 > 0 && (piece.x0 + piece.x1) / 2 >= from) folds.push((piece.x0 + piece.x1) / 2);
  return { nowX: Math.min(xOf(pieces, now), width - 0.5), folds };
}

type StripKey = "closer" | "farther" | "all" | "now" | "scroll";
const STRIP_KEYS: Readonly<Record<string, StripKey>> = {
  "+": "closer", "=": "closer", "-": "farther", "0": "all", n: "now", Home: "now",
  ArrowLeft: "scroll", ArrowRight: "scroll", ArrowUp: "scroll", ArrowDown: "scroll", PageUp: "scroll", PageDown: "scroll", End: "scroll", " ": "scroll",
};
/** One input meaning for the strip handler and edge rest: axis commands never start a native pan.
 * Home is the strip's now command; End retains the browser's native scroll. Modifiers belong to the browser. */
function stripKey(event: Pick<KeyboardEvent, "key" | "target" | "currentTarget" | "ctrlKey" | "metaKey" | "altKey">): StripKey | undefined {
  if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
  return STRIP_KEYS[event.key];
}

/** + and − zoom about `middle` (a clientX), 0 shows everything, N or Home goes to now. Only on the strip's own box, not on a control inside it. */
export function stripKeys(event: ReactKeyboardEvent<HTMLElement>, strip: { zoomBy: (factor: number, clientX: number) => void; toNow: () => void }, showAll: () => void, middle: number) {
  const key = stripKey(event);
  if (key === "closer") strip.zoomBy(1 / 1.5, middle);
  else if (key === "farther") strip.zoomBy(1.5, middle);
  else if (key === "all") showAll();
  else if (key === "now") strip.toNow();
  else return;
  event.preventDefault();
}

const AXIS_ROUND_UNITS: readonly number[] = [5, 10, 15, 30, 60].map((minutes) => minutes * 60_000);

/**
 * The axis: linear pieces where something happened in any drawn history, and fixed-width breaks for longer
 * stretches in which nothing did (`viewMs`, the time one screen shows, decides what counts as long). Waits (for
 * you, for children) are not activity: they run through a break.
 */
export function buildAxis(from: number, to: number, now: number, busy: Busy, width: number, viewMs: number, perMs?: number): Piece[] {
  const pad = axisPad(viewMs);
  const minGap = axisMinGap(viewMs);
  const clipped: [number, number][] = [];
  const appendClipped = (a: number, b: number) => {
    a = Math.max(from, a);
    b = Math.min(to, b);
    if (b > a) clipped.push([a, b]);
  };
  appendClipped(now - pad, to);
  for (const [start, end] of busy) appendClipped(start - pad, (end ?? now) + pad);
  clipped.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of clipped) {
    const last = merged.at(-1);
    if (last && a - last[1] < minGap) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  if (!merged.length) merged.push([from, to]);
  const parts: { from: number; to: number; gap: boolean }[] = [];
  let cursor = from;
  // A fold starts and ends on a round clock time (to an hour at most, coarser when zoomed out, finer when that
  // would leave it too short), so the times written on both sides of it on the clock are times one reads at a glance.
  // A stretch that is only just long enough to fold and has no round times inside it stays unfolded.
  const rounds = AXIS_ROUND_UNITS.filter((unit) => unit <= Math.max(5 * 60_000, viewMs / 48)).reverse();
  const offset = new Date(from).getTimezoneOffset() * 60_000;
  for (const [a, b] of merged) {
    let fit: [number, number] | undefined;
    for (const unit of rounds) {
      const up = Math.ceil((cursor - offset) / unit) * unit + offset;
      const down = Math.floor((a - offset) / unit) * unit + offset;
      if (down - up >= minGap * 0.6) {
        fit = [up, down];
        break;
      }
    }
    const [up, down] = fit ?? [cursor, a];
    if (a - cursor >= minGap && fit) {
      if (up! > cursor) parts.push({ from: cursor, to: up!, gap: false });
      parts.push({ from: up!, to: down!, gap: true });
      if (a > down!) parts.push({ from: down!, to: a, gap: false });
    } else if (a > cursor) parts.push({ from: cursor, to: a, gap: false });
    parts.push({ from: Math.max(a, cursor), to: b, gap: false });
    cursor = b;
  }
  if (to > cursor) parts.push({ from: cursor, to, gap: false });
  // With `perMs` the axis is a strip at that zoom, as long as it needs to be; without it, it is fitted into `width`.
  let scale = perMs;
  if (scale == null) {
    let gaps = 0;
    let linear = 0;
    for (const part of parts) {
      if (part.gap) gaps++;
      else linear = linear + part.to - part.from;
    }
    scale = Math.max(1, width - gaps * BREAK_W) / Math.max(1, linear);
  }
  let px = 0;
  return parts.map((part) => {
    const w = part.gap ? BREAK_W : (part.to - part.from) * scale;
    const piece = { ...part, x0: px, x1: px + w };
    px += w;
    return piece;
  });
}

export function xOf(pieces: Piece[], at: number): number {
  const first = pieces[0], last = pieces.at(-1);
  if (!first || !last) return 0;
  if (at <= first.from) return first.x0;
  if (at >= last.to) return last.x1;
  const piece = pieces.find((each) => at >= each.from && at <= each.to)!;
  return piece.x0 + (at - piece.from) / Math.max(1, piece.to - piece.from) * (piece.x1 - piece.x0);
}

/** The time under a point of the axis: where a press on the line lands. */
export function atOf(pieces: Piece[], px: number): number {
  const piece = pieces.find((each) => px >= each.x0 && px <= each.x1) ?? (px < 0 ? pieces[0] : pieces.at(-1));
  if (!piece) return 0;
  return piece.from + Math.min(1, Math.max(0, (px - piece.x0) / Math.max(1, piece.x1 - piece.x0))) * (piece.to - piece.from);
}

const CLOCK_TICK_STEPS: readonly number[] = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);

type ClockLabel = { at: number; x: number; anchor: "start" | "middle" | "end"; text: string; day: boolean };
/** A character of the clock's text-xs (12px) figures, wide enough that labels measured with it never touch. */
const CHAR_W = 7, NOW_CHAR_W = 7.5, LABEL_AIR = 10;
/**
 * The reader's text size against the browser's 16px (the steps are rem). What is measured here in px for the
 * text-xs words (their widths, the clock's height and the time pointed at) is the size at 16px, times this.
 */
export function textScale() {
  if (typeof document === "undefined") return 1;
  if (heldScale === undefined) watchTextScale();
  return heldScale ?? readTextScale();
}
const readTextScale = () => (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
/**
 * The size is read once and then kept, and read again only when a 1rem box says it changed: reading it in a render
 * that follows a press made the browser restyle everything that press had changed, there and then. Without a body or a
 * ResizeObserver it is read each time.
 */
let heldScale: number | undefined, watching = false;
function watchTextScale() {
  if (watching || typeof ResizeObserver === "undefined" || !document.body) return;
  watching = true;
  const rem = document.createElement("div");
  rem.setAttribute("aria-hidden", "true");
  rem.style.cssText = "position:fixed;top:0;left:0;width:1rem;height:0;visibility:hidden;pointer-events:none;contain:strict";
  document.body.append(rem);
  heldScale = readTextScale();
  new ResizeObserver(() => { heldScale = readTextScale(); }).observe(rem);
}

/** Where a clock word lies along the strip, about, by its anchor. */
function labelExtent(label: Pick<ClockLabel, "x" | "anchor" | "text">, k: number): [number, number] {
  const w = label.text.length * CHAR_W * k;
  return label.anchor === "start" ? [label.x, label.x + w] : label.anchor === "end" ? [label.x - w, label.x] : [label.x - w / 2, label.x + w / 2];
}

/**
 * What the clock writes, all of it clock times. First the times on both sides of every fold (where the time
 * jumps, so they matter most), then the ticks, each kept only where it has room: zooming out thins the ticks, not the
 * fold's times. A midnight tick is the date alone ("10/4", in ink); the first label and the first one on another day
 * than the label before it carry the date ("10/3 22:00"); `keep` is where now is written; `view` is the stretch on screen
 * (a label under the frozen column or past the screen's end is not written, so the first one seen has the date).
 */
export function clockLabels(pieces: Piece[], width: number, now: number, keep: [number, number], locale: string, view: [number, number] = [0, width], k = 1): ClockLabel[] {
  const bounds: [number, number] = [view[0] + 2, view[1] - 2];
  const midnight = (at: number) => { const date = new Date(at); return date.getHours() === 0 && date.getMinutes() === 0; };
  const candidates: ClockLabel[] = [];
  const cuts: number[] = [];
  const candidate = (at: number, x: number, anchor: ClockLabel["anchor"]) => {
    // With nonnegative text width, every label contains its anchor; fits cannot keep an offscreen one.
    if (!(k >= 0) || (x >= bounds[0] && x <= bounds[1])) {
      const day = midnight(at);
      candidates.push({ at, x, anchor, text: day ? formatCalendarDate(at, now, locale) : formatClock(new Date(at).toISOString()), day });
    }
  };
  // A fold's cut is drawn at its middle; no label runs over one (a fold's time sits beside its own cut, and could reach the next).
  pieces.forEach((piece) => {
    if (!piece.gap) return;
    if (piece.x0 > 0) candidate(piece.from, piece.x0 - 3, "end");
    if (piece.x1 < width) candidate(piece.to, piece.x1 + 3, "start");
    cuts.push((piece.x0 + piece.x1) / 2);
  });
  // Add clock ticks directly, at a step that leaves room for a label.
  const tickBounds = k >= 0 ? bounds : undefined;
  for (const piece of pieces) {
    if (piece.gap) continue;
    const perMs = (piece.x1 - piece.x0) / Math.max(1, piece.to - piece.from);
    const step = CLOCK_TICK_STEPS.find((each) => each * perMs >= 58) ?? CLOCK_TICK_STEPS.at(-1)!;
    const offset = new Date(piece.from).getTimezoneOffset() * 60_000;
    const first = Math.ceil((piece.from - offset) / step) * step + offset;
    // With a finite forward scale, every tick anchor lies between the first tick and the piece end.
    // Use the tick formula at both ends: short pieces and rounding need not map exactly to x0/x1.
    if (tickBounds && perMs >= 0 && Number.isFinite(perMs)
      && (piece.x0 + (first - piece.from) * perMs > tickBounds[1]
        || piece.x0 + (piece.to - piece.from) * perMs < tickBounds[0])) continue;
    for (let at = first; at <= piece.to; at += step) {
      const x = piece.x0 + (at - piece.from) * perMs;
      if (!tickBounds || (x >= tickBounds[0] && x <= tickBounds[1])) candidate(at, x, "middle");
    }
  }
  const fits = (placed: ClockLabel[], label: ClockLabel) => {
    const [a, b] = labelExtent(label, k);
    return a >= bounds[0] && b <= bounds[1] && (b + LABEL_AIR <= keep[0] || a - LABEL_AIR >= keep[1])
      && cuts.every((cut) => b + 4 <= cut - 2.5 || a - 4 >= cut + 2.5)
      && placed.every((other) => { const [c, d] = labelExtent(other, k); return b + LABEL_AIR <= c || a - LABEL_AIR >= d; });
  };
  let placed: ClockLabel[] = [];
  for (const label of candidates) if (fits(placed, label) && !placed.some((other) => other.at === label.at && other.anchor === label.anchor)) placed.push(label);
  // The date goes where the day changes; a label that then no longer has room gives way, a fold's time last.
  for (let pass = 0; pass < 3; pass++) {
    placed.sort((a, b) => a.x - b.x);
    // Candidates belong to this call; only the previous label's time is read while rewriting their text.
    placed.forEach((label, i) => {
      const changes = !sameCalendarDay(label.at, i === 0 ? now : placed[i - 1]!.at);
      label.text = label.day ? label.text : changes ? `${formatCalendarDate(label.at, now, locale)} ${formatClock(new Date(label.at).toISOString())}` : formatClock(new Date(label.at).toISOString());
    });
    const kept: ClockLabel[] = [];
    for (const label of [...placed].sort((a, b) => Number(a.anchor === "middle") - Number(b.anchor === "middle"))) if (fits(kept, label)) kept.push(label);
    if (kept.length === placed.length) break;
    placed = kept;
  }
  return placed.sort((a, b) => a.x - b.x);
}
