import { useLayoutEffect, useRef, type RefObject } from "react";
import { duration, easing, reducedMotion, rise } from "@/lib/motion";

/** Past this long after the list mounts, what it reads has kept the person waiting: it is drawn as it comes, unmoved. */
const LATE_MS = 1000;
/** No more lines than a tall screen holds are moved: the rest are out of sight anyway. */
const MOST_LINES = 40;

/**
 * The list coming back in place of the analysis (`entering`): once it is `ready` (its rows, and the time drawn on their
 * strips where strips are shown), the lines in sight come in from the top in turn, each title rising into place as its
 * strip draws its time from the left to the edge of the screen. It runs once, before the list is first painted, and
 * only on that change of face: the list drawn any other way, and every redraw after, moves nothing and costs nothing.
 * Titles already painted (the time read after them) stay where they are: only the strips, drawn just now, come in.
 */
export function useListEntrance(box: RefObject<HTMLElement | null>, entering: boolean, ready: boolean, lead: number) {
  const since = useRef(entering ? performance.now() : null);
  // Set as the first frame is drawn: a frame asked for before it is painted runs just before that paint.
  const painted = useRef(false);
  useLayoutEffect(() => {
    if (since.current === null) return;
    const frame = requestAnimationFrame(() => { painted.current = true; });
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    if (since.current === null || !ready) return;
    const late = performance.now() - since.current > LATE_MS;
    since.current = null;
    if (!late && box.current) enterLines(box.current, lead, !painted.current);
  }, [ready]);
}

/**
 * The lines (section headings and rows) of `root` in sight come in one after another, all started within --motion-slow:
 * a heading or a row's title rises into place (lib/motion.ts rise; not when `titles` is false), and a row's strip
 * uncovers its time from its left edge in sight to its right one. Only what the compositor draws moves, and nothing is
 * held once it lands, so the list is left exactly as it was drawn. Reduced motion: the strips only fade in, as the titles.
 */
function enterLines(root: HTMLElement, lead: number, titles: boolean) {
  const bounds = root.getBoundingClientRect();
  const lines: HTMLElement[] = [];
  for (const line of root.querySelectorAll<HTMLElement>("[data-section], li[data-row]")) {
    const place = line.getBoundingClientRect();
    if (place.bottom <= bounds.top || place.height === 0) continue;
    if (place.top >= bounds.bottom || lines.length === MOST_LINES) break;
    lines.push(line);
  }
  const step = Math.min(duration("fast") / 4, duration("slow") / Math.max(1, lines.length));
  lines.forEach((line, at) => {
    const delay = at * step;
    if (titles) rise(line.matches("[data-section]") ? line.firstElementChild : line.querySelector("[data-row-label]"), delay);
    const strip = line.querySelector<SVGSVGElement>("svg[data-time-strip]");
    if (reducedMotion()) rise(strip, delay);
    else if (strip) uncover(strip, bounds.left + lead, bounds.right, delay);
  });
}

/** A strip uncovers its time from `from` to `to` on the screen (clipped to the strip), over slow ×2, out. */
function uncover(strip: SVGSVGElement, from: number, to: number, delay: number) {
  const place = strip.getBoundingClientRect(), width = place.width;
  const left = Math.min(width, Math.max(0, from - place.left));
  const right = Math.min(width, Math.max(left, to - place.left));
  if (right <= left) return;
  strip.animate([{ clipPath: `inset(0 ${width - left}px 0 0)` }, { clipPath: `inset(0 ${width - right}px 0 0)` }],
    { duration: duration("slow") * 2, delay, easing: easing("out"), fill: "backwards" });
}
