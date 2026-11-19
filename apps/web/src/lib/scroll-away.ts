import { followReading } from "./reading-scroll";

/**
 * Tells `measured` a layer's laid-out height now and whenever it changes, for the room kept for it under it. The height
 * is the layout's own, never rounded to whole pixels (offsetHeight): a rounded room leaves up to half a pixel between
 * the layer and what stands under it, a seam a phone's fractional pixel ratio draws as a line of screen pixels.
 * Nor is it as drawn: a layer inside something scaled for a moment (a card arriving) keeps its room. `kept` is the room
 * already kept for it, if any: the same height is not told again, since writing a room restyles all that stands under
 * it.
 */
export function watchLayerHeight(layer: HTMLElement, measured: (height: number) => void, kept?: number) {
  let last = kept;
  const tell = (height: number) => {
    // Within a layout unit (1/64px) it is the same height, however it was read.
    if (last !== undefined && Math.abs(height - last) < 0.01) return;
    last = height;
    measured(height);
  };
  tell(layoutHeight(layer));
  const resized = new ResizeObserver(([entry]) => tell(entry!.borderBoxSize[0]!.blockSize));
  resized.observe(layer, { box: "border-box" });
  return () => resized.disconnect();
}

/** A box's border-box height as laid out, before any transform on it or around it (as a ResizeObserver reads it). */
function layoutHeight(box: HTMLElement) {
  const style = getComputedStyle(box), height = Number.parseFloat(style.height);
  if (!Number.isFinite(height)) return box.getBoundingClientRect().height;
  if (style.boxSizing === "border-box") return height;
  const sides = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const;
  return sides.reduce((sum, side) => sum + Number.parseFloat(style[side]), height);
}

/** The bar and reader header share visibility policy; reading-scroll alone owns direction, thresholds and baselines. */
export function watchScrollAway({ source, accepts, height, hidden, setHidden, controls }: {
  source: Document | HTMLElement;
  accepts: (element: HTMLElement) => boolean;
  height: () => number;
  hidden: () => boolean;
  setHidden: (hidden: boolean) => void;
  controls: () => ParentNode | null;
}) {
  const protectedControl = () => controls()?.querySelector('[aria-expanded="true"], :focus-visible, form');
  const tracking = followReading({ source, accepts, topRoom: height,
    // Reserved space can anchor the position; report text growing while the person reads is still reading.
    layoutSize: (list, viewportHeight) => {
      const style = getComputedStyle(list);
      // Its own foot padding changes the content box while a coordinator is resized, even if it does not scroll.
      // The header's room, instead, must survive until its following anchoring scroll has been excluded.
      return { size: [viewportHeight, Number.parseFloat(style.paddingBottom) || 0],
        room: [height(), Number.parseFloat(style.paddingTop) || 0] };
    },
    turn: way => {
      if (way === "down") {
        // Hidden controls are recalled by focus/expansion observers. Only a transition to hidden needs this check.
        if (hidden()) return;
        if (protectedControl()) tracking.reset();
        else setHidden(true);
      } else if (hidden()) setHidden(false);
    },
  });
  const keepVisible = () => { if (protectedControl()) { tracking.reset(); if (hidden()) setHidden(false); } };
  const guard = controls();
  const opened = new MutationObserver(keepVisible);
  if (guard) {
    opened.observe(guard, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-expanded"] });
    guard.addEventListener("focusin", keepVisible);
  }
  keepVisible();
  return { rebase: tracking.reset, reset: (list: HTMLElement) => { tracking.reset(list); if (hidden()) setHidden(false); }, stop: () => {
    tracking.stop(); opened.disconnect(); guard?.removeEventListener("focusin", keepVisible);
  } };
}
