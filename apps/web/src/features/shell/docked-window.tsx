import { ResizeEdge } from "@/components/ui/resize-edge";
import { useViewStore } from "@/state/view-store";
import { draggedReaderWidth, holdReaderEdge, maxDockedReaderWidth, windowMargin } from "@/state/screen-settings";

/**
 * The window at the page's right, on a computer: one margin from the screen's edges all round (`window`), over the page
 * (the reader, readerBox; what a number of the analysis opens beside its charts, AnalysisLayers). Its width is the
 * caller's: the reader's own, or the room the page keeps beside it.
 */
export const DOCKED_WINDOW = "fixed top-window right-window bottom-window z-(--layer-reader) flex min-w-0 flex-col overflow-hidden rounded-pane border-hairline border-lit-line bg-lit shadow-float";

/**
 * The inner edge of the window at the page's right (the reader, or what a number of the analysis opens beside its
 * charts), marked `data-window` where it is drawn: its left one over the page, dragging resizes it over the page. Both
 * windows have one width, the person's (`setReaderWidth`), so the one opened next stands as the last was left. Past the
 * docked limit the reader takes the full width (`fills`), and stays available there so the same drag can bring it back;
 * a window that may go no wider than `widest` for the screen's width (the reader beside a diff, the analysis's list beside its charts) stops
 * there. While a diff stands beside the reader the edge is its right one, in the gap toward the diff. Arrow keys move it
 * 24px; a double press gives the default width back.
 */
export function WindowWidthHandle({ label, taskId = null, widest, fills = true }: {
  label: string; taskId?: string | null; widest?: (viewport: number) => number; fills?: boolean;
}) {
  const full = useViewStore((state) => state.readerFull) && fills;
  const setReaderWidth = useViewStore((state) => state.setReaderWidth), setWindowWidth = useViewStore((state) => state.setWindowWidth);
  type Width = Parameters<typeof setReaderWidth>[0];
  // The width kept is the one drawn: a window that stopped at its widest gives that back, not as far as the pointer went.
  // One that never fills the screen keeps its width only, and leaves the reader full or not as it was.
  const set = (width: Width) => {
    const most = widest?.(innerWidth);
    const kept = most === undefined ? width : width === "full" ? fills ? width : most : typeof width === "number" ? Math.min(width, most) : width;
    if (fills) setReaderWidth(kept);
    else setWindowWidth(kept === "full" ? most ?? null : kept);
  };
  // A change by the keys or a double press is the person's too, as one held for that change alone.
  const once = (width: Width) => { holdReaderEdge(true); set(width); holdReaderEdge(false); };
  // The edge's side is the page's (data-view-beside), read as it is used: on the right, it is the window's left edge
  // mirrored, so a drag and the arrows widen the window toward where the edge goes.
  const right = () => document.querySelector("[data-view-beside]") !== null;
  // On the right it stands in the gap between the reader and the diff, fixed on the screen, so it covers neither's
  // scrollbar (a fixed box is not clipped by the reader's frame).
  return <ResizeEdge label={label} data-window-width data-input-view={taskId ?? undefined}
    className="in-data-view-beside:fixed in-data-view-beside:inset-y-window in-data-view-beside:left-[calc(var(--window-fit)+var(--spacing-window))] in-data-view-beside:w-window"
    onPointer={(clientX) => set(draggedReaderWidth(right() ? innerWidth - clientX : clientX, innerWidth))} onHold={holdReaderEdge}
    onReset={() => once(null)}
    onStep={(sign, edge) => {
      if (full) {
        if (sign > 0) once(maxDockedReaderWidth(innerWidth));
        return;
      }
      // The window owns the width; the handle can sit inside a display:contents surface.
      const next = edge.closest<HTMLElement>("[data-window]")!.offsetWidth + (right() ? sign : -sign) * 24;
      once(draggedReaderWidth(innerWidth - windowMargin() - next, innerWidth));
    }} />;
}
