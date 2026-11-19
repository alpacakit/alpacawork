/** The grip's release policy, in rendered heights and pointer timestamps (px, ms). */
export const SHEET_LEAST = 160, FLICK_MS = 80;
type Release = { kind: "cancel" } | { kind: "tap" } | { kind: "close" } | { kind: "rest"; height: number };
/** How far a finger may wander on a press that sizes nothing: let go within it, the press was a tap. */
export const SHEET_TAP = 6;
export function sheetRelease({ from, to, far = to === null ? 0 : Math.abs(to - from), trail, at, most, cancelled = false }: {
  /** `far`: the farthest it was taken from `from` while held. */
  from: number; to: number | null; far?: number; trail: readonly (readonly [number, number])[]; at: number; most: number; cancelled?: boolean;
}): Release {
  if (cancelled) return { kind: "cancel" };
  // Pressed and let go never taken past a finger's wander from where it was: a tap, which sizes nothing.
  if (to === null || far < SHEET_TAP) return { kind: "tap" };
  // The finger's speed over its last moves (FLICK_MS before the last, and at least the move before it: a frame slower
  // than that still has a speed), unless it was held still that long before it let go.
  const last = trail.at(-1), recent = last ? trail.filter(([time]) => last[0] - time <= FLICK_MS) : [];
  const first = recent.length > 1 ? recent[0] : trail.at(-2);
  const speed = first && last && at - last[0] <= FLICK_MS && last[0] > first[0] ? (first[1] - last[1]) / (last[0] - first[0]) : 0;
  // A flick is the finger's own: how far it went (the trail's last, not the height it drew, which a place held at the
  // foot doubles) and how fast.
  const went = (last?.[1] ?? to) - from;
  const flick = Math.abs(went) < 12 ? 0 : speed > 0.5 ? -1 : speed < -0.5 ? 1 : 0;
  if (flick < 0 || flick === 0 && to < Math.min(SHEET_LEAST, most, from) - 48) return { kind: "close" };
  return { kind: "rest", height: Math.round(Math.max(Math.min(SHEET_LEAST, most), Math.min(flick > 0 ? most : to, most))) };
}
