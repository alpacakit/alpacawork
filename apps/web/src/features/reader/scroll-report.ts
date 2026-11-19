import { reducedMotion } from "@/lib/motion";

/** How fast a moved goal is caught up with (per second): a critically damped approach, soft and never overshooting. */
const CATCH = 20;
/** A glide's length grows with the square root of its distance, within these bounds (ms). */
const SHORTEST = 280, LONGEST = 800;
const inOut = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;

/**
 * A jump's glide from `from` toward a goal that is read again every frame. The goal it set out for is crossed on an
 * ease-in-out curve; whatever the goal moves by on the way (the phone's header leaving as the column scrolls down,
 * rows above changing height) is caught up with alongside it, softly, so the path bends instead of ending where the
 * old goal was and jumping. `moved` carries a move someone else made to the column (rows kept in place as records
 * arrive above), which shifts the glide and its goal alike. Times are in ms; `at` returns where to stand and whether
 * the glide is over (standing on the goal).
 */
export function glide(from: number, goal: number, now: number, instant = false) {
  const span = Math.min(Math.max(Math.sqrt(Math.abs(goal - from)) * 16, SHORTEST), LONGEST);
  let start = from, aim = goal, began = now, last = now, gap = 0, speed = 0;
  return {
    moved(by: number) { start += by; aim += by; },
    at(goal: number, now: number) {
      if (instant) return { at: goal, over: true };
      // The catch-up's step, solved exactly for the frame's length, so a slow frame does not overshoot.
      const seconds = Math.min(now - last, 100) / 1000, off = gap - (goal - aim), pull = speed + CATCH * off, decay = Math.exp(-CATCH * seconds);
      gap = goal - aim + (off + pull * seconds) * decay;
      speed = (speed - CATCH * pull * seconds) * decay;
      last = now;
      // A glide with no way to go (the row was already there) has nothing to cross.
      const progress = aim === start ? 1 : Math.min((now - began) / span, 1);
      const caught = Math.abs(gap - (goal - aim)) < 0.5 && Math.abs(speed) < 20;
      if (progress === 1 && caught) return { at: goal, over: true };
      return { at: start + (aim - start) * inOut(progress) + gap, over: false };
    },
  };
}

const px = (value: string) => Number.parseFloat(value) || 0;
/**
 * The scrollTop that brings `target` to `block` in `area` as the page lays out now, by the same CSS rules a native
 * jump follows (the target's scroll-margin, the area's scroll-padding), within the area's scroll range.
 */
function landing(area: HTMLElement, target: HTMLElement, block: "start" | "center") {
  const box = target.getBoundingClientRect(), port = area.getBoundingClientRect();
  const own = getComputedStyle(target), room = getComputedStyle(area);
  const top = port.top + area.clientTop + px(room.scrollPaddingTop);
  const bottom = port.top + area.clientTop + area.clientHeight - px(room.scrollPaddingBottom);
  const from = box.top - px(own.scrollMarginTop), to = box.bottom + px(own.scrollMarginBottom);
  const shift = block === "center" ? (from + to - top - bottom) / 2 : from - top;
  return Math.min(Math.max(area.scrollTop + shift, 0), area.scrollHeight - area.clientHeight);
}

const pending = new WeakMap<HTMLElement, () => void>();
/**
 * Brings a report in its reading column to `block`: it glides there (at once under reduced motion) and stands still on
 * the goal for a frame before it is over, so whatever moves the goal on the way is followed to its end. A person's
 * input takes the scroll over; a later jump replaces this one. `landed` is told once, when the jump is over in any of
 * these ways.
 */
export function scrollReport(target: HTMLElement, block: "start" | "center", landed?: () => void) {
  const area = target.closest<HTMLElement>("[data-reader-content]");
  if (!area) { landed?.(); return; }
  pending.get(area)?.();
  let path: ReturnType<typeof glide> | null = null, written = area.scrollTop, stood = Number.NaN, frame = 0, over = false, clock = Number.NEGATIVE_INFINITY, began = 0;
  const stop = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) area.removeEventListener(event, stop);
    pending.delete(area);
    landed?.();
  };
  const step = (time: number) => {
    if (!target.isConnected) { stop(); return; }
    // Each frame is a frame later, even where frames are called with no time between them.
    const now = clock = time > clock ? time : clock + 1000 / 60;
    const goal = landing(area, target, block);
    // It stood on the goal last frame, and the goal stayed there: the jump is over.
    if (Math.abs(goal - stood) < 0.5 && Math.abs(area.scrollTop - goal) < 1) { stop(); return; }
    // The glide sets out from where the column is at its first frame, so what moved it before then is already in it.
    if (!path) { path = glide(area.scrollTop, goal, now, reducedMotion()); began = now; }
    // Something else moved the column since the last frame (rows kept in place as records arrive above): the glide and
    // its goal move with it.
    else if (Math.abs(area.scrollTop - written) >= 1) path.moved(area.scrollTop - written);
    // A goal that never stays put (nothing known does this) does not keep the column gliding: it stops where it is.
    if (now - began > LONGEST + 1000) { stop(); return; }
    const next = path.at(goal, now);
    stood = next.over ? goal : Number.NaN;
    area.scrollTop = next.at;
    written = area.scrollTop;
    frame = requestAnimationFrame(step);
  };
  pending.set(area, stop);
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) area.addEventListener(event, stop, { once: true, passive: true });
  frame = requestAnimationFrame(step);
}
