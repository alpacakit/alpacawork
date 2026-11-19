/** The direction of reading, shared by the list bar and the reader header. */
type ReadingWay = "down" | "up" | "top";
/** A finger's tremble does not change the reading direction. */
export const READING_THRESHOLD = 16;
/** `size`: the scroller's own observed dimensions; `room`: space reserved by a separate overlaid layer. */
type ReadingLayout = { size: readonly number[]; room?: readonly number[] };

/**
 * One direction tracker: bounces do not count, changes to layout establish a baseline, and only accepted steps add
 * to the run. The caller names the dimensions that can move its reading position: an overlaid header measures its
 * reserved room, so incoming report text can grow while read.
 * A document delegates to matching scrollers; an element starts with its current position already known.
 */
export function followReading({ source, accepts, topRoom, turn, layoutSize }: {
  source: Document | HTMLElement;
  accepts: (list: HTMLElement) => boolean;
  topRoom: () => number;
  turn: (way: ReadingWay) => void;
  layoutSize: (list: HTMLElement, height: number) => ReadingLayout;
}) {
  const last = new WeakMap<Element, { top: number; layout: ReadingLayout }>();
  let run = 0;
  const reset = (list?: HTMLElement) => {
    run = 0;
    if (list) last.set(list, { top: list.scrollTop, layout: layoutSize(list, list.clientHeight) });
  };
  const different = (before: readonly number[] = [], after: readonly number[] = []) => before.length !== after.length || before.some((size, at) => size !== after[at]);
  const changed = (before: ReadingLayout, after: ReadingLayout) => different(before.size, after.size) || different(before.room, after.room);
  const showAtTop = (top: number, extent: number, height: number) => {
    if (top > topRoom() && extent > height + 1) return false;
    run = 0; turn("top"); return true;
  };
  // A resize can move the baseline without a scroll event. Refresh it now, so the next real step is still counted.
  const resized = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const list = target as HTMLElement;
      if (!list.isConnected) { resized.unobserve(list); last.delete(list); continue; }
      const previous = last.get(list), top = list.scrollTop, height = list.clientHeight;
      const layout = layoutSize(list, height);
      // A layer changing its reserved room can emit this observer without resizing the scrollport. Keep that old
      // room until its anchoring scroll rebases; otherwise that first layout movement would be counted as reading.
      if (previous && different(previous.layout.size, layout.size)) { run = 0; last.set(list, { top, layout }); }
      showAtTop(top, list.scrollHeight, height);
    }
  });
  const scroll = (event: Event) => {
    const list = event.target;
    if (!(list instanceof HTMLElement) || !accepts(list)) return;
    // One scrollport sample feeds bounds, layout and visibility; no writes occur between these reads.
    const top = list.scrollTop, extent = list.scrollHeight, height = list.clientHeight;
    if (top < 0 || top > Math.max(0, extent - height)) return;
    const previous = last.get(list), layout = layoutSize(list, height);
    if (!previous) resized.observe(list);
    last.set(list, { top, layout });
    if (showAtTop(top, extent, height)) return;
    if (!previous || changed(previous.layout, layout)) { run = 0; return; }
    const step = top - previous.top;
    if (step === 0) return;
    run = Math.sign(step) === Math.sign(run) ? run + step : step;
    if (run > READING_THRESHOLD) turn("down");
    else if (run < -READING_THRESHOLD) turn("up");
  };
  if (source instanceof HTMLElement) { reset(source); resized.observe(source); }
  source.addEventListener("scroll", scroll, { capture: true, passive: true });
  return { reset, stop: () => { resized.disconnect(); source.removeEventListener("scroll", scroll, { capture: true }); } };
}
