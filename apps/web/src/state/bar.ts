import { useEffect } from "react";
import { create } from "zustand";
import { watchScrollAway } from "@/lib/scroll-away";

/**
 * The bar over the list: the header, the phone's search row and the workspace notice are one layer laid over
 * the list, not a row above it. Every list scroller under it is marked `UNDER_BAR`, keeps the bar's height at its top
 * (`--bar-h`) and keeps its frozen top under what is left of the bar (`--bar-in`), so hiding the bar moves nothing but
 * the bar and no scroll position changes. On a phone reading down hides it and any move up shows it; the top always
 * shows it. Scrolling anywhere else (the task sheet, the coordinator, the strips sideways) leaves it as it is.
 */
type BarState = { hidden: boolean; height: number;
  setHidden: (hidden: boolean) => void; setHeight: (height: number) => void };
export const useBar = create<BarState>((set) => ({ hidden: false, height: 0,
  setHidden: (hidden) => set({ hidden }), setHeight: (height) => set({ height }) }));

/** Marks a scroller as a list under the bar. */
export const UNDER_BAR = { "data-under-bar": "" } as const;

/**
 * The page's custom properties for what lies under the bar, and how it and what follows it (the list's frozen heads)
 * move: stepping aside for reading starts and ends softly (in-out), so it does not snap away from under the
 * eye (with `out` it went three quarters of the way in its first 50ms); called back by reading up it comes at once and
 * settles (out). Both take `--motion-base`, so reduced motion shortens them with everything else.
 */
export function barVars(height: number, hidden: boolean): Record<string, string> {
  return { "--bar-h": `${height}px`, "--bar-in": hidden ? "0px" : `${height}px`,
    "--bar-ease": hidden ? "var(--ease-in-out)" : "var(--ease-out)" };
}

/**
 * The one listener for every list under the bar. `pinned` (the search open, the reader covering the list) shows it,
 * and when the pin goes the bar is as it was before, so the row a sheet was opened from is where it was. A control of
 * the bar with something open, or keyboard focus in the bar, keeps it from hiding.
 */
export function useBarAutoHide(enabled: boolean, pinned: boolean) {
  useEffect(() => {
    const { setHidden } = useBar.getState();
    if (!enabled) { setHidden(false); return; }
    if (pinned) {
      const was = useBar.getState().hidden;
      setHidden(false);
      return () => setHidden(was);
    }
    return watchScrollAway({
      source: document, accepts: list => list.matches("[data-under-bar]"),
      height: () => useBar.getState().height, hidden: () => useBar.getState().hidden, setHidden,
      controls: () => document.querySelector("[data-bar]"),
    }).stop;
  }, [enabled, pinned]);
}
