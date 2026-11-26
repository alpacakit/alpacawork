import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * One motion rule for every disclosure (History's reports, a Run's steps): its height goes from where it is drawn to its body's height, or
 * back to nothing, over --motion-base in-out, and open it follows its body's height. The height itself moves, so what
 * it shows is always all of its height: a grid row's fr did not, and left a band with nothing in it under the words on
 * the way. It moves as a transition, so the reader keeps its place by its events (reading-position). With `least`,
 * folded it still shows that many pixels of its top, read and pressed as they are (the Working row's lines, LeadNote).
 * With `swap`, open, what it holds taking another's place (a wait's placeholder giving way to what was read) moves its
 * height the same way, from the one to the other, rather than at once.
 */
export function DisclosureBody({ open, least, swap, className, children }: { open: boolean; least?: number; swap?: string; className?: string;
  children: ReactNode }) {
  const [seen, setSeen] = useState(open);
  // Latch before committing: the body's first opening must not cause a second commit just to remember it was seen.
  if (open && !seen) setSeen(true);
  const peeks = least !== undefined, hidden = !open && !peeks;
  const body = useRef<HTMLDivElement>(null), shown = useRef(open);
  // The height drawn last, kept only where what it holds can take another's place.
  const drawn = useRef(0), swapped = useRef(swap);
  useLayoutEffect(() => {
    const box = body.current;
    if (swap === undefined || !box || typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(() => { drawn.current = box.getBoundingClientRect().height; });
    sizes.observe(box);
    return () => sizes.disconnect();
  }, [swap === undefined]); // eslint-disable-line react-hooks/exhaustive-deps -- observed once for a body that swaps
  useLayoutEffect(() => {
    const box = body.current;
    if (!box || swapped.current === swap) return;
    swapped.current = swap;
    if (!open || shown.current !== open || reducedMotion()) return;
    const from = drawn.current, to = box.scrollHeight;
    if (!from || Math.abs(to - from) < 1 || box.getAnimations().some(move => move.playState === "running")) return;
    box.style.height = `${from}px`;
    void box.offsetHeight;
    box.style.height = `${to}px`;
  }, [swap, open]);
  useLayoutEffect(() => {
    const box = body.current;
    if (!box) return;
    const folded = `${least ?? 0}px`;
    const moving = shown.current !== open;
    shown.current = open;
    // Not turned: folded, it keeps to what it still shows, at once (first measured, or its words changed), as words in
    // a row change; a fold under way goes on to it. Open, it follows its body.
    if (!moving) {
      if (open || box.style.height === folded) return;
      // First drawn, it stands at its own height (auto), which nothing glides from: no reflow to hold the glide back.
      // History draws a hundred of these at once, and a reflow for each laid the whole reader out that many times.
      if (box.style.height === "") { box.style.height = folded; return; }
      const folding = box.getAnimations().some(move => move.playState === "running");
      if (!folding) box.style.transition = "none";
      box.style.height = folded;
      if (!folding) { void box.offsetHeight; box.style.transition = ""; }
      return;
    }
    // From where it is drawn, a move turned back on the way included.
    const from = box.getBoundingClientRect().height, to = open ? box.scrollHeight : least ?? 0;
    if (reducedMotion() || Math.abs(to - from) < 1) { box.style.height = open ? "" : folded; return; }
    box.style.height = `${from}px`;
    void box.offsetHeight;
    box.style.height = `${to}px`;
  }, [open, least]);
  // Arrived open (or stopped on the way while open), it follows its body again.
  const arrived = (event: React.TransitionEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    if (event.target !== box || event.propertyName !== "height" || !shown.current) return;
    // A move stopped because it was turned back is taken over by the move that turned it.
    if (event.type === "transitioncancel" && box.getAnimations().some(move => move.playState === "running")) return;
    box.style.height = "";
  };
  // The clip reaches 12px past the body's right edge (the reader's own room there), so a press ending on that edge is whole.
  return <div ref={body} data-disclosure-body data-open={open} aria-hidden={hidden} inert={hidden} onTransitionEnd={arrived} onTransitionCancel={arrived}
    className={cn("-mr-3 overflow-hidden pr-3 transition-[height] duration-(--motion-base)", className)}>
    {open || seen || peeks ? children : null}
  </div>;
}
