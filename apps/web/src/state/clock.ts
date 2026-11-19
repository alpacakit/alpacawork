import { useSyncExternalStore } from "react";

/**
 * One shared clock for elapsed times ("43m"). It ticks every 30 seconds while
 * something reads it; the rules and their source times stay in the backend
 * projection, only the difference to now is drawn here.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => { now = Date.now(); listeners.forEach((each) => each()); }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; }
  };
}
export const useNow = () => useSyncExternalStore(subscribe, () => now);
/** What just happened happened now: without this, the tip of a time line stays up to one tick behind the count beside it. */
export function advanceNow() {
  const at = Date.now();
  if (at === now) return;
  now = at;
  listeners.forEach((each) => each());
}
/** Today's start: what reads only the day (a timeline's day dividers) is drawn again when the day turns, not at each tick. */
export const useToday = () => useSyncExternalStore(subscribe, () => new Date(now).setHours(0, 0, 0, 0));
