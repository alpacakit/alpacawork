import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

/** How long a press is held to be a long one, and how far it may wander (a finger is not still) before it is a drag. */
export const LONG_PRESS_MS = 500;
export const SLOP_PX = 10;
/** The click a held press ends in, which is not a press on what is under it. */
const SWALLOW_MS = 600;

/**
 * A press held still: `held` once it has been held long enough, and `onLong` when it is let go then, over what was
 * pressed. It is done at the release because that is what lets a page write the clipboard for a finger: a touch's
 * pointerdown gives no user activation, its pointerup does (HTML's activation-triggering events); a mouse is held to
 * the same rule. Anything else that happens meanwhile makes it no long press: it moves (a scroll takes it over as
 * pointercancel, a page scrolls, a mouse that drags selects words), another finger comes anywhere, the window loses
 * the focus or is hidden, it is let go elsewhere, or the page is pinch-zoomed (`guardPinchZoom`: the page is then the
 * browser's). Let go sooner it is an ordinary press, for what it is on. While held, the phone's own long-press menu
 * does not open, and the click its release makes opens nothing under it; the next press is its own.
 */
export function useLongPress(onLong: () => void) {
  const [held, setHeld] = useState(false);
  const press = useRef<{ held: boolean; stop: () => void } | null>(null);
  const swallow = useRef(0);
  const latest = useRef(onLong);
  latest.current = onLong;
  const end = () => {
    press.current?.stop();
    press.current = null;
    setHeld(false);
  };
  useEffect(() => () => press.current?.stop(), []);
  return { held, props: {
    onPointerDown: (event: PointerEvent) => {
      swallow.current = 0;
      const area = event.currentTarget, at = area.ownerDocument, view = at.defaultView ?? window;
      const zoomed = () => at.body.hasAttribute("data-pinch-zoomed");
      if (press.current || event.button !== 0 || !event.isPrimary || zoomed()) { end(); return; }
      const id = event.pointerId;
      const mine = (next: Event) => (next as globalThis.PointerEvent).pointerId === id;
      const move = (next: Event) => {
        const { clientX, clientY } = next as globalThis.PointerEvent;
        if (mine(next) && Math.hypot(clientX - event.clientX, clientY - event.clientY) > SLOP_PX) end();
      };
      const up = (next: Event) => {
        if (!mine(next)) return;
        // Where it is let go (a finger's events all go to where it was pressed, so its target does not say).
        const { clientX, clientY } = next as globalThis.PointerEvent;
        // Off the screen there is nothing there (null), which is not over the message.
        const over = typeof at.elementFromPoint === "function" ? at.elementFromPoint(clientX, clientY) : next.target as Element | null;
        const long = press.current?.held && !zoomed() && !!over && area.contains(over);
        end();
        if (!long) return;
        swallow.current = Date.now() + SWALLOW_MS;
        latest.current();
      };
      const other = (next: Event) => { if (!mine(next)) end(); };
      const cancel = () => end();
      // The window's own blur; a press moves the focus off an element (the input) too, which is no reason to end it.
      const away = (next: Event) => { if (next.target === view) end(); };
      const hidden = () => { if (at.visibilityState === "hidden") end(); };
      const listeners: [EventTarget, string, (next: Event) => void][] = [[at, "pointermove", move], [at, "pointerup", up],
        [at, "pointercancel", cancel], [at, "pointerdown", other], [at, "scroll", cancel], [view, "blur", away], [at, "visibilitychange", hidden]];
      const timer = window.setTimeout(() => {
        if (!press.current) return;
        if (zoomed()) { end(); return; }
        press.current.held = true;
        setHeld(true);
      }, LONG_PRESS_MS);
      for (const [target, type, listener] of listeners) target.addEventListener(type, listener, true);
      press.current = { held: false, stop: () => {
        window.clearTimeout(timer);
        for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true);
      } };
    },
    onContextMenu: (event: MouseEvent) => { if (press.current || Date.now() < swallow.current) event.preventDefault(); },
    onClickCapture: (event: MouseEvent) => {
      // A key's click (Enter, Space, a screen reader) has no press behind it.
      if (Date.now() >= swallow.current || event.detail === 0) return;
      swallow.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  } };
}
