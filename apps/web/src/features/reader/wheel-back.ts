import { useEffect, type RefObject } from "react";
import { browserBack } from "@/state/reader-position";

/**
 * A sideways trackpad swipe over the reader is the browser's Back. The reader is a window fixed over the page and
 * scrolls nothing of its own sideways, so the reader had no part in such a swipe: whether it went back was left to the
 * browser's own gesture, which on the person's computer did not go back (why, in that browser, is not known here). The
 * reader takes the swipe itself and goes back by the browser's history, as the browser's Back does: what the URL then
 * names is shown, as for every Back (lib/history.ts). A swipe something inside can still scroll toward its start (a
 * wide table or code) or that starts in a field stays the browser's; so do up and down, Shift with a wheel (a mouse's
 * sideways scrolling) and zooming. A touch screen sends no wheel: its finger is the card's (swipe-answer).
 */

/** Wheel events further apart than this begin another gesture (a trackpad's momentum comes in steady small steps). */
const GESTURE_GAP = 200;
/** How far a swipe goes before it is Back: a deliberate swipe, not a drift while reading. */
const BACK_REACH = 100;

export type WheelGesture = { at: number; mine: boolean; sum: number; done: boolean };
type Wheel = { deltaX: number; deltaY: number; keys: boolean; cancelable: boolean; scrollsBack: () => boolean; at: number };

/**
 * One wheel event of a gesture. The gesture's first event that moves decides whose it is: going back (scrolled toward
 * the start, more sideways than up or down), with nothing under it scrolling that way, no key held and the browser still
 * letting the page take it (`cancelable`), it is the reader's. Its every event is then the reader's (`prevent`), and once
 * it has gone `BACK_REACH` it is Back, once.
 */
export function wheelBackStep(gesture: WheelGesture | null, wheel: Wheel): { gesture: WheelGesture | null; prevent: boolean; back: boolean } {
  const going = gesture && wheel.at - gesture.at <= GESTURE_GAP ? gesture : null;
  // A step that moves nothing (a trackpad's touch beginning) decides nothing.
  if (!going && wheel.deltaX === 0 && wheel.deltaY === 0) return { gesture: null, prevent: false, back: false };
  const mine = going ? going.mine : wheel.cancelable && wheel.deltaX < 0 && Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)
    && !wheel.keys && !wheel.scrollsBack();
  if (!mine) return { gesture: { at: wheel.at, mine: false, sum: 0, done: false }, prevent: false, back: false };
  const sum = (going?.sum ?? 0) - wheel.deltaX;
  const back = !going?.done && sum >= BACK_REACH;
  return { gesture: { at: wheel.at, mine, sum, done: !!going?.done || back }, prevent: true, back };
}

/** Whether something between the target and the reader can still scroll toward the start sideways, or takes typing. */
function scrollsBack(target: EventTarget | null, area: Element) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return true;
  for (let node: Element | null = target; node && node !== area; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollLeft > 0) return true;
  }
  return false;
}

const PIXELS = [1, 16, 800];

export function useWheelBack(box: RefObject<HTMLElement | null>, on: boolean) {
  useEffect(() => {
    const area = box.current;
    if (!on || !area) return;
    let gesture: WheelGesture | null = null;
    // Gone back, the reader may close under the rest of the swipe (its momentum): that rest stays the reader's too, so
    // it neither moves the page nor goes back once more by the browser's own gesture.
    const rest = (event: WheelEvent) => {
      if (!gesture?.done || event.timeStamp - gesture.at > GESTURE_GAP) { removeEventListener("wheel", rest); return; }
      gesture = { ...gesture, at: event.timeStamp };
      event.preventDefault();
    };
    const wheelOf = (event: WheelEvent): Wheel => {
      const unit = PIXELS[event.deltaMode] ?? 1;
      return { deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, keys: event.ctrlKey || event.metaKey || event.shiftKey,
        cancelable: event.cancelable, scrollsBack: () => scrollsBack(event.target, area), at: event.timeStamp };
    };
    const wheel = (event: WheelEvent) => {
      const step = wheelBackStep(gesture, wheelOf(event));
      gesture = step.gesture;
      if (step.prevent) event.preventDefault();
      if (step.back) { addEventListener("wheel", rest, { passive: false }); browserBack(); }
    };
    area.addEventListener("wheel", wheel, { passive: false });
    return () => area.removeEventListener("wheel", wheel);
  }, [box, on]);
}
