import { useLayoutEffect, useRef, type RefObject } from "react";
import { duration, easing, reducedMotion } from "@/lib/motion";

/**
 * A finger or a pen takes a toast sideways, and letting go far or fast enough sends it off that way. A press on the
 * toast is the toast's own, on its action too, so what lies under it does not also swipe. The list keys cards by ID, so
 * content updates keep the card and the person's swipe, including its departure; only unmount ends the gesture's
 * lifetime. Completion closes the current content through `close`, as it is at that moment.
 */
export function useToastSwipe(card: RefObject<HTMLDivElement | null>, close: () => void) {
  const latestClose = useRef(close), suppressClick = useRef(false);
  latestClose.current = close;
  useLayoutEffect(() => {
    const element = card.current!, view = element.ownerDocument.defaultView;
    if (!view) return; // A detached document has no screen or pointer gestures yet.
    let start: { id: number; x: number; y: number } | null = null;
    let sideways = false, departing = false, dx = 0, lastMovement = 0;
    let trail: { x: number; t: number }[] = [];
    let animation: Animation | null = null;
    const clear = () => { element.style.transform = ""; element.style.opacity = ""; };
    const stopAnimation = () => { const old = animation; animation = null; old?.cancel(); };
    const release = () => {
      const id = start?.id;
      start = null;
      // Clear the gesture before releasing: lostpointercapture must not undo its departure.
      if (id !== undefined && element.hasPointerCapture(id)) element.releasePointerCapture(id);
    };
    const settle = (away: boolean) => {
      release();
      departing = away;
      if (reducedMotion()) {
        clear();
        if (away) latestClose.current();
        return;
      }
      // Relative lengths stay current if the card grows or the viewport rotates during departure.
      const end = away ? `translateX(calc(${Math.sign(dx)} * (100vw + 100%)))` : "translateX(0px)";
      const move = element.animate([
        { transform: `translateX(${dx}px)`, opacity: element.style.opacity || "1" },
        { transform: end, opacity: away ? 0.4 : 1 },
      ], { duration: duration("base"), easing: easing(away ? "in" : "out"), fill: "forwards" });
      animation = move;
      void move.finished.then(() => {
        if (animation !== move) return;
        if (away) latestClose.current();
        else { stopAnimation(); clear(); }
      }, () => { /* Cancelled by a new gesture or unmount; this completion no longer owns the card. */ });
    };
    const cancel = () => {
      if (!start) return;
      if (sideways) settle(false); else release();
    };
    const down = (event: PointerEvent) => {
      if (event.isPrimary && !start) suppressClick.current = false;
      if ((event.pointerType !== "touch" && event.pointerType !== "pen") || !event.isPrimary) return;
      // A toast owns a touch begun on it, including one on its action: no answer card underneath may also swipe.
      event.stopPropagation();
      if (start || departing) return;
      stopAnimation(); clear();
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      sideways = false; suppressClick.current = false; dx = 0; lastMovement = 0;
      trail = [{ x: event.clientX, t: event.timeStamp }];
    };
    const sample = (event: PointerEvent) => {
      trail.push({ x: event.clientX, t: event.timeStamp });
      trail = trail.filter(point => event.timeStamp - point.t <= 80);
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const x = event.clientX - start.x, y = event.clientY - start.y;
      if (!sideways) {
        if (Math.hypot(x, y) < 10) return;
        if (Math.abs(x) <= Math.abs(y)) { release(); return; }
        sideways = true; suppressClick.current = true;
        element.setPointerCapture(event.pointerId);
      }
      event.stopPropagation(); event.preventDefault();
      if (x !== dx) lastMovement = x - dx;
      dx = x; sample(event);
      element.style.transform = `translateX(${dx}px)`;
      element.style.opacity = String(1 - 0.6 * Math.min(1, Math.abs(dx) / element.offsetWidth));
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      if (!sideways) { release(); return; }
      event.stopPropagation();
      const x = event.clientX - start.x;
      if (x !== dx) lastMovement = x - dx;
      dx = x; sample(event);
      element.style.transform = `translateX(${dx}px)`;
      const first = trail[0]!, last = trail.at(-1)!;
      const speed = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      // Returning toward the origin never dismisses, even if the finger had already crossed the distance line.
      const returning = lastMovement * dx < 0;
      settle(!returning && (Math.abs(dx) >= element.offsetWidth * 0.38 || Math.abs(dx) >= 24 && speed * Math.sign(dx) >= 0.5));
    };
    const interrupted = (event: PointerEvent) => {
      if (event.pointerId === start?.id && (event.type !== "lostpointercapture" || event.target === element)) cancel();
    };
    const click = (event: MouseEvent) => {
      // A new press resets this flag. Keyboard activation (detail=0) remains available after an abandoned swipe.
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false; event.preventDefault(); event.stopImmediatePropagation();
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move, { passive: false });
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", interrupted);
    element.addEventListener("lostpointercapture", interrupted);
    element.addEventListener("click", click, true);
    view.addEventListener("resize", cancel); view.visualViewport?.addEventListener("resize", cancel);
    return () => {
      element.removeEventListener("pointerdown", down); element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up); element.removeEventListener("pointercancel", interrupted);
      element.removeEventListener("lostpointercapture", interrupted); element.removeEventListener("click", click, true);
      view.removeEventListener("resize", cancel); view.visualViewport?.removeEventListener("resize", cancel);
      stopAnimation(); release(); clear();
    };
  }, []);
}
