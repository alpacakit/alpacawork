import { useEffect, useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";
import { useSurfaceDocument } from "@/lib/surface";
import { shownInReader, useViewStore } from "@/state/view-store";

/* Hallmark · component: hover card · genre: modern-minimal · theme: the app's own tokens (bg-lit, lit-line, ink, muted)
 * states: resting (a task reference opens after REST_MS) · open · on the way to it (other cards wait) · leaving (closes after LEAVE_MS)
 */

/**
 * The one rule for every card that a pointer resting on a task reference opens: how long the pointer rests on a title or a task's name before its card opens, how long
 * a card stays after the pointer leaves, and how it stays reachable while the pointer moves onto it.
 *
 * On the way from what opened it to the card, the pointer crosses other things that have cards of their own (the
 * row's line, the next title) or nothing at all. While it is inside the shape between where it left and the card,
 * however slowly it goes or long it pauses, those wait and the card stays: they open, or the card closes, only once
 * the pointer leaves that shape.
 */
const REST_MS = 300;
const LEAVE_MS = 180;
type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
/** Whether `point` is in `box`, its edge included. */
const inBox = (box: Box, point: Point) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
/** Pointer coordinates and open cards belong to the document that draws them (including a conversation's own window). */
type PointerState = { cards: HTMLElement[]; from: Point | null; last: Point | null; waiting: (() => void) | null };
const pointers = new WeakMap<Document, PointerState>();
function pointerState(at: Document): PointerState {
  let state = pointers.get(at);
  if (!state) { state = { cards: [], from: null, last: null, waiting: null }; pointers.set(at, state); }
  return state;
}
const on = (each: HTMLElement, point: Point) => each.style.visibility !== "hidden" && inBox(each.getBoundingClientRect(), point);
const inside = (point: Point, cards: HTMLElement[]) => cards.some((each) => {
  const box = each.getBoundingClientRect();
  return each.style.visibility !== "hidden" && point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
});
/** Where the pointer rested on the reference, kept fixed while it travels to the card. */
export function pointerOn(point: Point | null, at = document) { pointerState(at).from = point; }
export function dropWaiting(at = document) { pointerState(at).waiting = null; }

/**
 * Whether the pointer at `point` is on its way to the open card: it has come toward the card from where it left
 * (`from`), on a ray from there that reaches the card. Moving along a line beside the card, or away, is not.
 */
export function onTheWay(point: Point, at = document): boolean {
  const { cards, from } = pointerState(at);
  const card = cards.at(-1);
  if (!card?.isConnected || !from || card.style.visibility === "hidden") return false;
  const box = card.getBoundingClientRect();
  // A card not yet laid out (or with nothing in it) is not somewhere to go.
  if (!box.width || !box.height) return false;
  if (inBox(box, point)) return true;
  // Where it left is under the card now: there is no way to it to keep.
  if (inBox(box, from)) return false;
  const dx = point.x - from.x, dy = point.y - from.y;
  const toward = from.y < box.top ? dy : from.y > box.bottom ? -dy : from.x < box.left ? dx : -dx;
  if (toward <= 0) return false;
  // The ray from + s·(point − from), s ≥ 1, meets the box (slab test).
  let near = 1, far = Infinity;
  for (const [start, step, low, high] of [[from.x, dx, box.left, box.right], [from.y, dy, box.top, box.bottom]] as const) {
    if (!step) { if (start < low || start > high) return false; continue; }
    const a = (low - start) / step, b = (high - start) / step;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  return near <= far;
}

/**
 * Whether `own` (an open card) stays when it would close now: the pointer is on it or on a card opened over it (a task's
 * card opened from inside it), or, when it is the top card, on its way to it. Being on a card under it does not keep it.
 */
function stillOnTheWay(own: Element | null): boolean {
  if (!own) return false;
  const { cards, last } = pointerState(own.ownerDocument);
  const at = cards.findIndex((each) => each === own);
  if (!last || at < 0) return false;
  return cards.slice(at).some((each) => on(each, last!)) || at === cards.length - 1 && onTheWay(last, own.ownerDocument);
}

/**
 * Another card is asked for by the pointer at `point`. When the pointer is on its way to the open card, the ask waits
 * (the latest one wins) and this returns true; otherwise the caller opens it now.
 */
export function waitOnTheWay(point: Point, run: () => void, at = document): boolean {
  const state = pointerState(at);
  // Asked for from inside a card (a task named in it): that is where the pointer went, not a stop on its way.
  if (inside(point, state.cards) || !onTheWay(point, at)) { dropWaiting(at); return false; }
  state.waiting = run;
  return true;
}

/** Moving the reader dismisses task-reference cards and anything waiting to open. */
export function onReaderMove(run: () => void) {
  return useViewStore.subscribe((state, before) => { if (shownInReader(state) !== shownInReader(before)) run(); });
}
/** The shared hover lifecycle for task references and ancestor previews. */
export function useHoverCardInteraction<T extends HTMLElement>({ enabled, shown, card, open, close }: {
  enabled: boolean; shown: boolean; card: RefObject<HTMLElement | null>;
  open: (anchor: T) => void; close: () => void;
}) {
  const at = useSurfaceDocument();
  const latest = useRef({ open, close, shown });
  latest.current = { open, close, shown };
  const pending = useRef<() => void>(() => {});
  const cancel = () => { pending.current(); pending.current = () => {}; };
  const later = (run: () => void, ms: number) => { cancel(); const timer = setTimeout(run, ms); pending.current = () => clearTimeout(timer); };
  const shut = () => { cancel(); dropWaiting(at); latest.current.close(); };
  const leave = () => {
    if (!latest.current.shown) { cancel(); return; }
    later(() => stillOnTheWay(card.current) ? leave() : shut(), LEAVE_MS);
  };
  useEffect(() => { const stop = onReaderMove(shut); return () => { stop(); cancel(); }; }, []);
  useEffect(() => { if (!enabled) cancel(); }, [enabled]);
  useEffect(() => {
    if (!shown) return;
    const moved = (event: Event) => { if (!card.current?.contains(event.target as Node)) shut(); };
    at.addEventListener('scroll', moved, true);
    return () => at.removeEventListener('scroll', moved, true);
  }, [shown, at]);
  return {
    cancel,
    handlers: enabled ? {
      onPointerEnter: (event: PointerEvent<T>) => {
        if (event.pointerType !== 'mouse') return;
        cancel();
        if (latest.current.shown) return;
        const target = event.currentTarget, point = { x: event.clientX, y: event.clientY };
        const show = () => { cancel(); pointerOn(point, at); latest.current.open(target); };
        if (!waitOnTheWay(point, show, at)) later(show, REST_MS);
      },
      onPointerLeave: leave,
    } : {},
    leave,
  };
}

/** Register a card with the shared pointer corridor, including cards opened by a label. */
export function useHoverCardTarget(own: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const element = own.current;
    if (!enabled || !element) return;
    const at = element.ownerDocument, state = pointerState(at);
    const moved = (event: globalThis.PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      state.last = point;
      if (!state.waiting) return;
      if (state.cards.some(each => each.contains(event.target as Node))) dropWaiting(at);
      else if (!onTheWay(point, at)) { const run = state.waiting; dropWaiting(at); run(); }
    };
    state.cards = [...state.cards, element];
    at.addEventListener('pointermove', moved, true);
    return () => {
      const wasTop = state.cards.at(-1) === element;
      state.cards = state.cards.filter(each => each !== element);
      if (wasTop) { state.from = null; dropWaiting(at); }
      at.removeEventListener('pointermove', moved, true);
    };
  }, [enabled]);
}
