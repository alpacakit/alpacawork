import { useLayoutEffect, useState, type RefObject } from "react";
import { readerEdgeHeld } from "@/state/screen-settings";

/**
 * A width of the list's: as its box is now, and the width its time strip's zoom is for. `letGo`: read as the reader's edge
 * was let go after a drag that changed them, so what is laid out for it moves there from what was held.
 */
export type ListWidth = { width: number; zoomWidth: number; letGo: boolean };

/**
 * The list's width, kept in step with its box, and the width its time strip's zoom is for: the box's, with what a reader
 * past half the screen hides of the strip (`--strip-hidden`, Workbench) given back. Both are read at once, so a reader
 * resized never shows one without the other; while its edge is dragged they stay as they were and are read once let go.
 */
export function useListWidth(box: RefObject<HTMLElement | null>, initial: number): ListWidth {
  const [width, setWidth] = useState<ListWidth>({ width: initial, zoomWidth: initial, letGo: false });
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let before = element.clientWidth;
    const measure = (letGo = false) => {
      const width = element.clientWidth;
      // While the reader's edge is held the list keeps its widths, so the time strip keeps its layout and is not
      // drawn again for each pixel; a strip that was at its right end (now, the reports expected) is only kept there.
      if (readerEdgeHeld.get()) {
        if (element.scrollLeft + before >= element.scrollWidth - 2) element.scrollLeft = element.scrollWidth;
        before = width;
        return;
      }
      before = width;
      const zoomWidth = width + (Number.parseFloat(getComputedStyle(element).getPropertyValue("--strip-hidden")) || 0);
      setWidth((was) => was.width === width && was.zoomWidth === zoomWidth ? was : { width, zoomWidth, letGo });
    };
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    // A screen of another width changes what is hidden even where the list keeps its width (at its least).
    observer.observe(document.documentElement);
    measure();
    // Let go, it is read once the page has its last width (the drag's last move may still be on its way to the screen).
    let release = 0;
    const stop = readerEdgeHeld.subscribe(() => { if (!readerEdgeHeld.get()) release = requestAnimationFrame(() => measure(true)); });
    return () => { observer.disconnect(); stop(); cancelAnimationFrame(release); };
  }, [box]);
  return width;
}
