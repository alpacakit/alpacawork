import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBar } from "@/state/bar";
import { useReaderPanel } from "./reader-panel";

/**
 * Where the related-task panel stands (ReaderPanel draws it there): its place in the page, its place inside the reader, and
 * its place beside the reader, measured from what the reader draws.
 */

/**
 * An element of the panel's own, marked `mark`, kept from `active` to its end and put where it belongs by `attach`, so
 * what is drawn in it is drawn anew by none of the moves in between.
 */
function useOwnElement(active: boolean, mark: string, attach?: (element: HTMLElement) => void) {
  const [place, setPlace] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const element = document.createElement("div");
    element.setAttribute(mark, "");
    attach?.(element);
    setPlace(element);
    return () => { element.remove(); setPlace(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one element from its opening to its closing
  }, [active]);
  return active ? place : null;
}

/** The panel's place in the page, from its opening to its closing: an element of its own at the end of the page then. */
export const useOpenPlace = (open: boolean) => useOwnElement(open, "data-reader-panel-place", element => document.body.append(element));

/**
 * The place the panel stands in inside the reader: one element of its own, kept from its opening to its closing and
 * moved into the reader's slot of the moment (`ReaderPanelSlot`), so moving from task to task does not draw the panel anew.
 */
export function useUnderPlace(active: boolean) {
  const place = useOwnElement(active, "data-reader-panel-under");
  const slot = useReaderPanel((state) => state.slot);
  useLayoutEffect(() => {
    if (place && slot && place.parentElement !== slot) slot.append(place);
  }, [place, slot]);
  return place;
}

/** The computer's panel beside the reader: its widest, its narrowest, and its distance from what it stands by. */
const BESIDE_WIDTH = 384, BESIDE_LEAST = 280, BESIDE_GAP = 12;
/** The computer's panel's top, in every form: this far under the reader's slot, right under the entry. */
export const OPEN_GAP = 4;

/**
 * Where the computer's panel stands beside the reader, or null when there is no room for it. It stands just left of what
 * the reader shows: beside the reader's window, over the list, when the reader stands beside the list; in the reader's
 * own margin, left of its reading column, when the reader is the whole screen. Its top is where it would stand under the
 * entry (the reader's slot, as the reader is at its top), so it opens on the same line beside the reader as in it, and
 * reading on does not move it; it reaches down as far as the reader allows. It follows the reader as it is widened,
 * narrowed or turned to the whole screen, its title as it wraps, the bar as it grows (a notice), and the window as it is resized.
 */
type Beside = { left: number; top: number; width: number; height: number };
export function useBesidePlace(active: boolean): Beside | null {
  const [beside, setBeside] = useState<Beside | null>(null);
  const watched = useRef<Element[]>([]);
  const watch = useRef<ResizeObserver | null>(null);
  useBar((state) => state.hidden ? 0 : state.height);   // the bar changing draws the panel again, which measures again
  const measure = () => setBeside((before) => {
    const next = besidePlace();
    return before && next && before.left === next.left && before.top === next.top && before.width === next.width
      && before.height === next.height ? before : next;
  });
  useEffect(() => {
    if (!active) return;
    addEventListener("resize", measure);
    if (typeof ResizeObserver !== "undefined") watch.current = new ResizeObserver(measure);
    return () => {
      removeEventListener("resize", measure);
      watch.current?.disconnect();
      watch.current = null;
      watched.current = [];
    };
  }, [active]);
  // Each time the reader draws (another task, another form of the reader), the elements it is measured by are watched.
  useLayoutEffect(() => {
    if (!active) return;
    const now = [...readerParts(), useReaderPanel.getState().slot?.parentElement ?? null].filter((element) => element !== null);
    if (watch.current && (now.length !== watched.current.length || now.some((element, at) => element !== watched.current[at]))) {
      watch.current.disconnect();
      for (const element of now) watch.current.observe(element);
      watched.current = now;
    }
    measure();
  });
  return active ? beside : null;
}

/** The reader, its reading column, and what scrolls it: the same in every face of the reader (a task, a task looked up). */
const readerParts = () => {
  const reader = document.querySelector<HTMLElement>("aside[data-reader-mode]");
  const column = reader?.querySelector<HTMLElement>("[data-reading-column]") ?? null;
  return [reader, column, column?.parentElement ?? null] as const;
};

function besidePlace(): Beside | null {
  const [reader, column, content] = readerParts();
  if (!reader) return null;
  const box = reader.getBoundingClientRect();
  // What the reader shows starts at its reading column, with the margin of what scrolls it before it (reading-column.ts).
  const shown = column && content ? Math.max(box.left, column.getBoundingClientRect().left - (parseFloat(getComputedStyle(content).paddingLeft) || 0)) : box.left;
  const right = shown - BESIDE_GAP;
  const outside = right <= box.left;
  const from = outside ? 0 : box.left;
  const width = Math.min(BESIDE_WIDTH, right - from - BESIDE_GAP);
  if (width < BESIDE_LEAST) return null;
  const bar = useBar.getState(), under = bar.hidden ? 0 : bar.height;
  // The slot's place with what scrolls it at rest and at its top: scrolled, the slot moves up and the panel stays; turned
  // to another task, what scrolls it moves a moment (motion.ts crossfade) and the panel does not.
  const slot = useReaderPanel.getState().slot;
  const line = !content ? box.top
    : restingTop(content) + (slot ? slot.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop : 0);
  // Over the list it stays under the list's bar (its search and buttons stay in reach); in the reader's margin the bar is under the reader.
  const top = Math.max(line + OPEN_GAP, box.top, outside ? under : 0);
  const bottom = outside ? box.bottom : box.bottom - BESIDE_GAP;
  return { left: Math.round(right - width), top: Math.round(top), width: Math.round(width), height: Math.max(0, Math.round(bottom - top)) };
}

/** Where an element stands in its place, without a move it is making (a translate): its offset in what holds it. */
function restingTop(element: HTMLElement) {
  const holder = element.offsetParent;
  return holder ? holder.getBoundingClientRect().top + holder.clientTop + element.offsetTop : element.getBoundingClientRect().top;
}
