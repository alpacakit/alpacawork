import { useEffect, useRef, type RefObject } from "react";
import { reducedMotion } from "@/lib/motion";
import { PULL, springValues } from "./pull-feel";

/** How far a finger goes before it is a pull or not one (a tap, or a sideways scroll of the time strips). */
const SLOP = 8;
/** The spinner shows at least this long, so a refresh that is in at once still reads as one. */
const LEAST_MS = 600;
/** How long the done mark rests before the list goes back. */
const DONE_MS = 300;
/** A pull's own release makes no press on what was under the finger. */
const SWALLOW_MS = 500;
type Phase = "rest" | "pull" | "armed" | "refreshing" | "done";

/**
 * The pull, on the list's scroller `box`, moving its sheet `sheet` and drawing `mark` over the room it opens. Only one
 * finger that starts while the list is at its top and goes down more than sideways pulls; a press, a scroll, a
 * sideways scroll and a pinch stay what they are. The scroller's own overscroll is off while it is `on` (the
 * caller's style): in Chromium that keeps the browser's own pull to reload and the list's own bounce out of it. Safari's
 * support of overscroll-behavior differs by version (16.4 fixed it for short pages), so on an iPhone the moves a pull
 * takes are also cancelled; both are still to be seen on a real iPhone (tab and home screen) and Android phone.
 */
export function usePullToRefresh(box: RefObject<HTMLElement | null>, sheet: RefObject<HTMLElement | null>,
  mark: RefObject<HTMLElement | null>, on: boolean, refresh: () => Promise<boolean>) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const scroller = box.current;
    if (!on || !scroller) return;
    const sign = mark.current;
    const turn = sign?.querySelector<HTMLElement>("[data-pull-turn]");
    const arc = sign?.querySelector<SVGCircleElement>("[data-pull-arc]");
    let phase: Phase = "rest", shown = 0, stopSpring = () => {}, swallowUntil = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let touch: { id: number; x: number; y: number; pulling: boolean; trail: [number, number][] } | null = null;
    // Only a touch that began at the top may cancel a move. Ordinary scrolling has no blocking listener.
    const forget = () => { touch = null; scroller.removeEventListener("touchmove", move); };
    const reserve = (moving: boolean) => {
      const page = sheet.current, hint = moving ? "transform" : "";
      if (page && page.style.willChange !== hint) page.style.willChange = hint;
    };
    const draw = (y: number) => {
      shown = y;
      const page = sheet.current;
      if (page) {
        page.style.transform = y === 0 ? "" : `translateY(${y}px)`;
      }
      if (sign) {
        const share = Math.max(0, Math.min(1, y / PULL.threshold));
        if (sign.dataset.phase !== phase) sign.dataset.phase = phase;
        sign.style.opacity = String(phase === "pull" || phase === "armed" ? share : y > 0 ? Math.min(1, y / PULL.hold) : 0);
        // These values belong to one glyph each. Inherited variables would restyle every child of the mark per frame.
        if (turn) turn.style.rotate = `${y * 3}deg`;
        if (arc) arc.style.strokeDashoffset = String(100 - 78 * (phase === "pull" || phase === "armed" ? share : 1));
      }
    };
    const go = (to: number, v: number, then: () => void) => {
      stopSpring();
      const reduced = reducedMotion();
      reserve(!reduced);
      if (reduced) { draw(to); then(); return; }
      const page = sheet.current;
      if (!page) { draw(to); reserve(false); then(); return; }
      // The same spring, sampled at 60Hz once. The compositor owns time between these samples.
      const values = springValues(shown, to, v);
      draw(shown); // Publish the new phase and its constant arc before starting the movement.
      const timing: KeyframeAnimationOptions = { duration: (values.length - 1) * 1000 / 60, fill: "forwards", easing: "linear" };
      const animations = [page.animate(values.map(y => ({ transform: `translateY(${y}px)` })), timing)];
      if (sign) animations.push(sign.animate(values.map(y => ({ opacity: Math.max(0, Math.min(1, y / (phase === "pull" || phase === "armed" ? PULL.threshold : PULL.hold))) })), timing));
      if (turn) animations.push(turn.animate(values.map(y => ({ rotate: `${y * 3}deg` })), timing));
      if (arc && (phase === "pull" || phase === "armed")) animations.push(arc.animate(values.map(y => ({
        strokeDashoffset: String(100 - 78 * Math.max(0, Math.min(1, y / PULL.threshold))),
      })), timing));
      const clear = () => {
        animations[0]!.onfinish = null;
        for (const animation of animations) animation.cancel();
        stopSpring = () => {};
        reserve(false);
      };
      stopSpring = () => {
        // Only interruption reads the rendered position. Never read geometry or write style each frame.
        const transform = getComputedStyle(page).transform;
        const y = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
        clear();
        draw(y);
      };
      animations[0]!.onfinish = () => { clear(); draw(to); then(); };
    };
    const settle = () => go(0, 0, () => { phase = "rest"; draw(0); });
    const release = (v: number) => {
      if (phase !== "armed") { phase = "pull"; go(0, v, () => { phase = "rest"; draw(0); }); return; }
      phase = "refreshing";
      go(PULL.hold, v, () => {});
      const least = new Promise((resolve) => setTimeout(resolve, LEAST_MS));
      void Promise.all([latest.current().catch(() => false), least]).then(([ok]) => {
        if (phase !== "refreshing") return;
        // A tick only for what came in; a refresh that failed goes back without one (the progress line says why).
        if (!ok) { settle(); return; }
        stopSpring();
        phase = "done";
        draw(shown);
        timer = setTimeout(settle, DONE_MS);
      });
    };
    const zoomed = () => document.body.hasAttribute("data-pinch-zoomed");
    // Any touch, wherever on the page it starts (first, before the list hears it): a new press is its own, so only the
    // click of the pull just let go is swallowed; and a second finger (a pinch, or one laid on the bar) undoes the pull,
    // which goes back without refreshing.
    const anywhere = (event: TouchEvent) => {
      swallowUntil = 0;
      if (event.touches.length < 2) return;
      if (touch?.pulling) { phase = "pull"; release(0); }
      forget();
    };
    // A pull begins only with one finger on the list at its top.
    const start = (event: TouchEvent) => {
      forget();
      if (event.touches.length !== 1 || phase !== "rest" || scroller.scrollTop > 0 || zoomed()) return;
      const one = event.touches[0]!;
      touch = { id: one.identifier, x: one.clientX, y: one.clientY, pulling: false, trail: [] };
      scroller.addEventListener("touchmove", move, { passive: false });
    };
    const move = (event: TouchEvent) => {
      if (!touch) return;
      const one = Array.from(event.changedTouches).find((each) => each.identifier === touch!.id);
      if (!one) return;
      const dx = one.clientX - touch.x, dy = one.clientY - touch.y;
      if (!touch.pulling) {
        if (Math.hypot(dx, dy) < SLOP) return;
        // Down more than sideways, from the top: a pull. Anything else is the scroller's for the rest of this touch.
        if (dy <= 0 || dy < Math.abs(dx) * 1.2 || scroller.scrollTop > 0) { forget(); return; }
        touch.pulling = true;
        touch.y += SLOP;
        phase = "pull";
      }
      if (event.cancelable) event.preventDefault();
      const y = PULL.resist(Math.max(0, one.clientY - touch.y));
      touch.trail = [...touch.trail.filter(([at]) => event.timeStamp - at < 100), [event.timeStamp, y]];
      phase = y >= PULL.threshold ? "armed" : "pull";
      reserve(true);
      draw(y);
    };
    const end = (event: TouchEvent) => {
      if (!touch || !Array.from(event.changedTouches).some((each) => each.identifier === touch!.id)) return;
      const was = touch;
      forget();
      if (!was.pulling) return;
      swallowUntil = event.timeStamp + SWALLOW_MS;
      const first = was.trail[0], last = was.trail.at(-1);
      const v = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) * 1000 : 0;
      if (event.type === "touchcancel" && phase === "armed") phase = "pull";
      release(Math.max(-2000, Math.min(2000, v)));
    };
    const click = (event: MouseEvent) => {
      if (event.timeStamp > swallowUntil) return;
      swallowUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("touchstart", anywhere, { capture: true, passive: true });
    scroller.addEventListener("touchstart", start, { passive: true });
    scroller.addEventListener("touchend", end);
    scroller.addEventListener("touchcancel", end);
    scroller.addEventListener("click", click, true);
    return () => {
      stopSpring();
      reserve(false);
      clearTimeout(timer);
      forget();
      phase = "rest";
      draw(0);
      document.removeEventListener("touchstart", anywhere, { capture: true });
      scroller.removeEventListener("touchstart", start);
      scroller.removeEventListener("touchend", end);
      scroller.removeEventListener("touchcancel", end);
      scroller.removeEventListener("click", click, true);
    };
  }, [box, sheet, mark, on]);
}

/** The mark in the room the pull opens: a ring that fills as the list is pulled, turns while it refreshes, then a tick. */
export function PullMark({ mark }: { mark: RefObject<HTMLDivElement | null> }) {
  return <div ref={mark} aria-hidden data-pull-mark data-phase="rest" style={{ opacity: 0 }}
    className="group/pull pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3">
    <span className="grid size-8 place-items-center rounded-full border-hairline border-lit-line bg-bg text-muted shadow-float transition-[color,scale] duration-(--motion-fast) group-data-[phase=armed]/pull:scale-110 group-data-[phase=armed]/pull:text-ink group-data-[phase=refreshing]/pull:text-ink group-data-[phase=done]/pull:text-ink">
      <span data-pull-turn className="block size-5 group-data-[phase=done]/pull:hidden group-data-[phase=refreshing]/pull:animate-spin"
        style={{ rotate: "0deg" }}>
      <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-2 [stroke-linecap:round]">
        <circle data-pull-arc cx="12" cy="12" r="8" pathLength="100" strokeDasharray="100"
          style={{ strokeDashoffset: 100 }} />
      </svg>
      </span>
      <svg viewBox="0 0 24 24" className="hidden size-5 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round] group-data-[phase=done]/pull:block">
        <path d="m7 12.5 3.5 3.5 6.5-7" />
      </svg>
    </span>
  </div>;
}
