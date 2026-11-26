import { useLayoutEffect, useRef, type RefObject } from "react";
import { distance, duration, easing, reducedMotion } from "@/lib/motion";

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
 * a heading or a row's title rises into place (unless `titles` is false), a row's strip uncovers its time from the strip's
 * left edge in sight to its right one in sight. Only what the compositor draws moves (translate, opacity, clip-path), and nothing is held once it
 * lands (fill: backwards), so the list is left exactly as it was drawn. Reduced motion: each only fades in.
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
  if (!lines.length) return;
  const still = reducedMotion(), shift = distance("shift");
  const step = Math.min(duration("fast") / 4, duration("slow") / lines.length);
  const rising: Keyframe[] = shift ? [{ opacity: 0, translate: `0 ${shift}px` }, { opacity: 1, translate: "0 0" }] : [{ opacity: 0 }, { opacity: 1 }];
  lines.forEach((line, at) => {
    const delay = at * step;
    const words = !titles ? null : line.matches("[data-section]") ? line.firstElementChild : line.querySelector("[data-row-label]");
    words?.animate(rising, { duration: duration(shift ? "base" : "fast"), delay, easing: easing("out"), fill: "backwards" });
    const strip = line.querySelector<SVGSVGElement>("svg[data-time-strip]");
    if (!strip) return;
    if (still) {
      strip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration("fast"), delay, easing: easing("out"), fill: "backwards" });
      return;
    }
    // In the strip's own width: from the edge the title column leaves in sight to the right edge of the list.
    const place = strip.getBoundingClientRect(), width = place.width;
    const left = Math.min(width, Math.max(0, bounds.left + lead - place.left));
    const right = Math.min(width, Math.max(left, bounds.right - place.left));
    if (right <= left) return;
    strip.animate([{ clipPath: `inset(0 ${width - left}px 0 0)` }, { clipPath: `inset(0 ${width - right}px 0 0)` }],
      { duration: duration("slow") * 2, delay, easing: easing("out"), fill: "backwards" });
  });
}
