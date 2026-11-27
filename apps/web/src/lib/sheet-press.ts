import { LONG_PRESS_MS } from "./long-press";
import { duration, easing } from "./motion";

/**
 * A finger or a mouse that moves a sheet (the task's sheet on a phone, the coordinator's conversation on a phone), from
 * its press to its lift, on its grip or from the top of what it shows. One rule for every sheet: where a pull from what
 * it shows may start and which way the finger must go for the sheet to take it (down, before it is a scroll, a
 * selection or a long press), and what the browser takes back (a second finger, its own gesture). Taken, a pull is the
 * grip's own hand: each sheet sizes itself and lets itself go by its grip's rule, from wherever the finger began.
 * How a sheet is drawn as it moves and goes away belongs to `sheet-motion`.
 */

/** A move this fast (px/ms) decides by its way alone. */
export const FLICK = 0.6;
/** How far a finger goes before it moves the sheet (a finger is never quite still). */
const SLOP = 6;
/** The finger's speed is read over its last moves this long (ms); held still longer before it lets go, it has none. */
const RECENT = 100;

/** A press is only a candidate until its first qualifying move takes a hand at the sheet's current geometry. */
export type SheetPress = {
  /** Content pulls must go down more than sideways, before selection or a long press. Grips take either vertical way, more than sideways. */
  pull: boolean;
  take(): SheetHand;
};

/** Only an acquired hand may follow or release a sheet. Heights grow upward. */
type SheetHand = {
  /** The finger is `rise` px above where it was pressed (below it, negative), as of the move at `at` (its timeStamp). */
  follow(rise: number, at: number): void;
  /** Let go at `speed` px/ms (up is positive); with none, ownership was cancelled. */
  release(speed?: number): void;
};

/**
 * Listens on `surface` for presses, the one place a sheet hears them: `start` says what a press holds (or nothing, and
 * the press is what it is on). One press at a time: a new one ends the one under way. The press ends wherever it is let
 * go (over a menu it opened, too), and a later move of the pointer does not carry the sheet. While a press moves the
 * sheet, the browser does not also scroll or fling with the finger: it is told so on every move, listened to all along
 * (the browser asks before its first scroll only if someone was listening when the finger came down). Returns what
 * stops listening, and ends the press under way (the sheet gone with it held).
 */
export function listenSheetPress(surface: HTMLElement, start: (event: PointerEvent, target: Element) => { press: SheetPress; capture: HTMLElement } | null) {
  let current: { moved: boolean; stop: () => void } | null = null;
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
    const taken = start(event, event.target);
    if (!taken) return;
    current?.stop();
    const press = follow(event, taken.press, taken.capture, () => { if (current === press) current = null; });
    current = press;
  };
  const keep = (event: TouchEvent) => { if (current?.moved && event.cancelable) event.preventDefault(); };
  surface.addEventListener("pointerdown", down);
  surface.addEventListener("touchmove", keep, { passive: false });
  return () => {
    current?.stop();
    surface.removeEventListener("pointerdown", down);
    surface.removeEventListener("touchmove", keep);
  };
}

function follow(event: PointerEvent, intent: SheetPress, capture: HTMLElement, done: () => void) {
  const id = event.pointerId, startX = event.clientX, startY = event.clientY;
  const trail: { y: number; t: number }[] = [{ y: startY, t: event.timeStamp }];
  // One lifetime: a pending press has no hand, an acquired one has exactly one, and a finished press is gone.
  let current: { hand: SheetHand | null } | null = { hand: null };
  const stop = (speed?: number) => {
    if (!current) return;
    const hand = current.hand;
    current = null;
    done();
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", end);
    removeEventListener("pointercancel", end);
    removeEventListener("lostpointercapture", end);
    removeEventListener("touchstart", second, true);
    if (capture.hasPointerCapture(id)) capture.releasePointerCapture(id);
    hand?.release(speed);
  };
  const press = { get moved() { return current?.hand != null; }, stop };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id || !current) return;
    let hand = current.hand;
    if (!hand) {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.hypot(dx, dy) < SLOP) return;
      // A press going sideways first is not the sheet's, from its grip either: it is what the sheet shows (a swipe).
      if ((intent.pull ? dy : Math.abs(dy)) <= Math.abs(dx)
        || intent.pull && (!!getSelection()?.toString() || e.timeStamp - event.timeStamp >= LONG_PRESS_MS)) { stop(); return; }
      current.hand = hand = intent.take();
      capture.setPointerCapture(id);
    }
    trail.push({ y: e.clientY, t: e.timeStamp });
    while (trail.length > 2 && trail[0]!.t < e.timeStamp - RECENT) trail.shift();
    hand.follow(startY - e.clientY, e.timeStamp);
  };
  // Every interruption returns the same acquired hand exactly once, including capture taken by the browser.
  const second = (e: TouchEvent) => { if (e.touches.length > 1) stop(); };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    // Touch first captures its original target implicitly; transferring it to our surface also loses that old capture.
    if (e.type === "lostpointercapture" && capture.hasPointerCapture(id)) return;
    if (e.type !== "pointerup" || !current?.hand) return stop();
    // The press that moved the sheet is not also a press on what it started on (a button, a link).
    addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallowClick, { capture: true }), 0);
    const first = trail[0]!, last = trail.at(-1)!;
    stop(e.timeStamp - last.t > RECENT ? 0 : (first.y - last.y) / Math.max(1, last.t - first.t));
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
  addEventListener("lostpointercapture", end);
  addEventListener("touchstart", second, { capture: true, passive: true });
  return press;
}

const swallowClick = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };

/**
 * Whether a press may pull `sheet` down from what it shows: a finger, on something that would scroll nothing first if it
 * went down (every scroller between it and the sheet stands at its top), and that takes no finger's moves for itself
 * (a field, a player, a frame, an element that lets the browser no vertical pan of its own). A press on a scroller that
 * is scrolled down is its scroll, even once it reaches the top: what is read back is not pulled away. Nor is a part
 * still reading in what comes above it (`data-reading-above`): its top is not the top yet.
 */
export function pullsFrom(event: PointerEvent, target: Element, sheet: Element) {
  if (event.pointerType !== "touch" || target.closest("input, textarea, select, [contenteditable=true], video, audio, iframe")) return false;
  for (let node: Element | null = target; node && node !== sheet; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/auto|manipulation|pan-y/.test(style.touchAction) || node.hasAttribute("data-reading-above")) return false;
    if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight && node.scrollTop > 0.5) return false;
  }
  return true;
}

/**
 * How a sheet let go slides `distance` px into place: the farther, the longer, never longer than a sheet's rise. Let go
 * by a finger (`speed`: px/ms toward where it goes), it goes on at the finger's own speed and slows into place, so a
 * sheet let go still does not leap and a flick is not slowed at once; otherwise it eases out.
 */
export function letGo(distance: number, speed?: number) {
  const way = Math.abs(distance), time = Math.min(duration("slow"), Math.max(duration("fast"), way * 0.9));
  return { duration: time, easing: speed === undefined ? easing("out") : carried(speed, way, time) };
}

/**
 * The curve of a slide `distance` px long over `time` ms that starts at `speed` px/ms (none if the finger went the other
 * way) and eases out into place as --ease-out does; from a still finger it starts from rest.
 */
function carried(speed: number, distance: number, time: number) {
  const slope = distance > 0 ? Math.max(0, speed) * time / distance : 0;
  return `cubic-bezier(0.3, ${Math.min(1, 0.3 * slope).toFixed(3)}, 0.36, 1)`;
}
