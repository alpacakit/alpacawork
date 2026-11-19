import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { notify, shownOf, useToasts, type Toast, type ToastKind, type ToastTime } from "@/lib/notify";

import { useSurfaceDocument } from "@/lib/surface";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { Button } from "./button";
import { Icon, type IconName } from "./icon";
import { useToastSwipe } from "./toast-swipe";
import { pinchZoomed } from "@/lib/pinch-zoom";

/** Each kind's mark, so a kind is told by its shape too, not by colour alone; only a failure takes a colour. */
const MARK: Record<ToastKind, { icon: IconName; className: string }> = {
  success: { icon: "check", className: "text-ink" },
  error: { icon: "error", className: "text-error" },
  info: { icon: "info", className: "text-muted" },
  pending: { icon: "pending", className: "text-muted animate-spin" },
};

/**
 * Draws notify's toasts at the visible viewport's top centre in every window and on every screen (pinch-zoomed, the
 * layout viewport's, magnified with the page). Shared CSS owns
 * the gap, safe area and width; only a keyboard panning the visual viewport at normal scale needs its geometry read here.
 * notify owns lifetime, count, window routing and what stays waiting while a dialog or image viewer is open.
 * Each card announces itself without taking focus. Pointer or focus holds the window's clocks; Escape closes the
 * focused toast through the shared Escape layers and returns focus to its opener.
 */
export function Toaster({ name }: { name?: string }) {
  const { t } = useTranslation();
  const at = useSurfaceDocument();
  useLayoutEffect(() => notify.attach(at, name), [at, name]);
  const toasts = useToasts(useShallow(state => shownOf(state, at)));
  const host = useRef<HTMLElement>(null);
  const visible = toasts.length > 0;
  useLayoutEffect(() => {
    const win = at.defaultView, view = win?.visualViewport, element = host.current;
    if (!visible || !win || !view || !element) return;
    // Fixed CSS uses the layout viewport. At normal scale, keep the visible viewport's origin and width, which a
    // phone's keyboard can pan. Pinch-zoomed, the page is the browser's (lib/pinch-zoom.ts): the toasts stay in the
    // layout viewport and are magnified with the rest of the page, rather than squeezed into the few CSS pixels the
    // zoomed view spans, where their words broke a line every few characters. No page, header, column or
    // overlay contributes geometry.
    const place = () => {
      const geometry = pinchZoomed(win) ? null : { top: view.offsetTop, left: view.offsetLeft, width: view.width };
      for (const side of ["top", "left", "width"] as const) {
        if (geometry) element.style.setProperty(`--toast-view-${side}`, `${geometry[side]}px`);
        else element.style.removeProperty(`--toast-view-${side}`);
      }
    };
    place();
    view.addEventListener("resize", place); view.addEventListener("scroll", place);
    return () => { view.removeEventListener("resize", place); view.removeEventListener("scroll", place); };
  }, [at, visible]);
  // Held while the pointer is over a card or the focus is in the list: either keeps it, and only both gone lets it go. A
  // focused toast that goes (closed, replaced) fires no blur, so the focus is read again after every change; the list
  // gone, the pointer is off it too (a card gone under the pointer leaves it over the list, and its next move says so).
  const list = useRef<HTMLOListElement>(null);
  const [pointed, setPointed] = useState(false), [focused, setFocused] = useState(false);
  useEffect(() => {
    // A replaced action can disappear under the pointer. Its React leave event then has no mounted target;
    // the document still receives the new target, so read the window's actual pointer boundary here.
    const point = (event: PointerEvent) => {
      const target = event.type === "pointerout" ? event.relatedTarget : event.target;
      setPointed(!!target && list.current?.contains(target as Node) === true);
    };
    at.addEventListener("pointerover", point, true); at.addEventListener("pointerout", point, true);
    return () => { at.removeEventListener("pointerover", point, true); at.removeEventListener("pointerout", point, true); };
  }, [at]);
  useLayoutEffect(() => {
    if (pointed && !list.current) setPointed(false);
    if (focused && !list.current?.contains(at.activeElement)) setFocused(false);
  });
  useEffect(() => { notify.hold(at, pointed || focused); }, [at, pointed, focused]);
  // A new toast comes first, at the top: when the list scrolls, it is brought into view, unless the person is on it.
  const newest = toasts.at(-1)?.id;
  useLayoutEffect(() => {
    const element = list.current;
    if (element && !pointed && !focused) element.scrollTop = 0;
  }, [newest]);
  // Where the focus came from: closing the toast it is on gives it back there (an input, a button), not to the page.
  const came = useRef<HTMLElement | null>(null);
  const close = (id: string) => {
    notify.hide(id);
    const back = came.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  useEffect(() => () => notify.hold(at, false), [at]);
  useEscapeLayer(focused, ESCAPE_LAYER.toast, () => {
    const id = (at.activeElement?.closest("[data-toast]") as HTMLElement | null)?.dataset.toastId;
    const toast = toasts.find(each => each.id === id);
    if (toast) close(toast.id);
  });
  const leave = (event: FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); };
  // aria-live="off": not read as a region (each card is), yet kept in reach while a dialog hides the rest of the page.
  // Only each card takes presses; the column and its gaps let the page behind take them. When many stay, the column
  // scrolls rather than covering the screen.
  return <section ref={host} data-toaster aria-label={t("toast.label")} aria-live="off">
    {!!toasts.length && <ol ref={list}
      onFocus={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) came.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
        setFocused(true);
      }} onBlur={leave}
      className="pointer-events-none -my-2 flex max-h-[50dvh] list-none flex-col items-center gap-2 overflow-x-hidden overflow-y-auto overscroll-contain py-2">
      {[...toasts].reverse().map(toast => <li key={toast.id} className="flex max-w-full justify-center"><ToastCard toast={toast} held={pointed || focused} close={() => close(toast.id)} /></li>)}
    </ol>}
  </section>;
}

/** A toast's control: pressed, its --press (styles.css); on a phone, a finger's height around its middle (its width: each). */
const PRESS = "relative active:bg-(--press) narrow:after:absolute narrow:after:top-1/2 narrow:after:left-1/2 narrow:after:h-11 narrow:after:-translate-1/2 narrow:after:content-['']";

function ToastCard({ toast, held, close }: { toast: Toast; held: boolean; close: () => void }) {
  const { t } = useTranslation();
  const mark = MARK[toast.kind];
  const time = useToasts(state => state.time.get(toast.id));
  const card = useRef<HTMLDivElement>(null);
  // How long it stands follows the words it is drawn with (lib/notify's lifeOf), whatever made them.
  const words = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { notify.read(toast.id, words.current?.textContent?.length ?? 0); }, [toast]);
  useHeldInPlace(card, held && !!toast.kept);
  useToastSwipe(card, close);
  // One row, every part on its middle line: the mark, the words, the way back and × (a toast of two lines too). The way
  // back runs something (Check, Try again, Undo), so it is a button and looks like one whatever its state; what is
  // pointed at in a toast takes the toast's own --hover (styles.css), a step from its paper toward its ink, and
  // what is pressed its --press, a step further and edged, so a press shows under a finger too (where nothing is
  // pointed at). On a phone each takes a finger's 44px around its middle, drawn as small as on a computer: the way
  // back as wide as it is, × as wide as the gap before it and the card's edge after it leave, so the two never meet.
  return <div ref={card} data-toast data-toast-id={toast.id} data-kind={toast.kind} data-stays={toast.stays || undefined} data-kept={toast.kept || undefined}
    role={toast.kind === "error" ? "alert" : "status"}
    className="pointer-events-auto relative flex min-h-11 w-max animate-drop items-center gap-2.5 rounded-md bg-(--toast) py-1.5 pr-2 pl-3 text-sm text-ink shadow-float">
    <Icon data-toast-pin="mark" name={mark.icon} className={cn("flex-none", mark.className)} />
    <div ref={words} className="min-w-0 flex-1 py-1">
      <p data-toast-text className="[overflow-wrap:anywhere]">{toast.text}</p>
      {toast.detail && <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{toast.detail}</p>}
    </div>
    {toast.action && <Button variant="outline" data-toast-action data-toast-pin="action" className={cn(PRESS, "min-h-control-xs flex-none border-(--toast-line) bg-transparent px-2.5 font-medium active:border-(--press-line) narrow:after:w-[max(100%,--spacing(11))]")}
      onClick={() => toast.action?.run()}>{toast.action.label}</Button>}
    <button type="button" data-toast-pin="close" aria-label={t("toast.close")} onClick={close}
      className={cn(PRESS, "grid size-7 flex-none cursor-pointer place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink active:text-ink narrow:after:w-11")}><Icon name="close" className="size-3.5" /></button>
    {time && <TimeLeft key={time.drawn} time={time} />}
  </div>;
}

function useHeldInPlace(card: RefObject<HTMLDivElement | null>, holding: boolean) {
  // What its owner keeps changes under the pointer (the undo frame: its count, its button gone at its time). While
  // the window is held it does not shrink, its mark, way back and × stay where they stood, and it grows only leftward
  // (as far as the screen's edge), so its right edge, and the way back and × along it, do not move.
  const lock = useRef<{ right: number; tops: Map<string, number> } | null>(null);
  useLayoutEffect(() => {
    const element = card.current!, pins = [...element.querySelectorAll<HTMLElement | SVGElement>(":scope > [data-toast-pin]")];
    if (!holding) {
      if (!lock.current) return;
      lock.current = null;
      Object.assign(element.style, { minWidth: "", minHeight: "", maxWidth: "", translate: "" });
      for (const pin of pins) Object.assign(pin.style, { alignSelf: "", marginTop: "" });
      return;
    }
    if (element.style.transform) return; // a swipe under way moves it by itself
    const view = element.ownerDocument.defaultView!, style = view.getComputedStyle(element);
    if (!lock.current) {
      if (!element.offsetWidth) return;
      const box = element.getBoundingClientRect(), content = box.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
      const host = element.closest<HTMLElement>("[data-toaster]")!;
      const edge = host.getBoundingClientRect().left + (parseFloat(view.getComputedStyle(host).paddingLeft) || 0);
      lock.current = { right: box.right, tops: new Map(pins.map(pin => [pin.dataset.toastPin!, pin.getBoundingClientRect().top - content])) };
      Object.assign(element.style, { minWidth: `${box.width}px`, minHeight: `${box.height}px`, maxWidth: `min(var(--toast-widest), ${box.right - edge}px)` });
    }
    // Each part where it stood when the hold began (one that comes back meanwhile, where it stood then too).
    for (const pin of pins) {
      const top = lock.current.tops.get(pin.dataset.toastPin!);
      if (top !== undefined && !pin.style.alignSelf) Object.assign(pin.style, { marginTop: `${top}px`, alignSelf: "flex-start" });
    }
    element.style.translate = "";
    const shift = lock.current.right - element.getBoundingClientRect().right;
    if (Math.abs(shift) >= 0.5) element.style.translate = `${shift}px 0`;
  });
}

/**
 * The one line for the time a toast has left (lib/notify's ToastTime), with no count of seconds: along the card's foot,
 * it runs out as its time does and stands still where it is while that time stops. Its time is notify's clock for what
 * goes by itself (stopped while pointed at, focused, its window hidden), or its owner's for a way back open only until
 * then (an undo: never stopped). It is the toast's time, not a motion of its own, so it runs where motion is reduced
 * too.
 */
function TimeLeft({ time }: { time: ToastTime }) {
  return <span aria-hidden data-toast-time data-running={time.running || undefined}
    style={{ "--time-left": time.left / time.life, "--time-left-ms": `${time.left}ms` } as CSSProperties} />;
}
