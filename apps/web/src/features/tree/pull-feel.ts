/**
 * How a phone's list pulled down from its top feels: a straight follow and a calm stop, a little heavy. The list goes 0.45 of the finger's way (at most 160px), letting go past 60px of it reads the
 * latest again while the list rests at 52px, and it goes back on a spring that does not bounce (c just over 2√k).
 */
export const PULL = {
  resist: (finger: number) => Math.min(finger * 0.45, 160),
  threshold: 60,
  hold: 52,
  /** The spring's stiffness and damping, per second. */
  k: 300,
  c: 35,
} as const;

/**
 * One frame of the spring, `dt` seconds long (a slow frame counts as 32ms), in four steps: `off` is how far from where
 * it goes, `speed` its px/s. True once it is as good as there.
 */
export function springStep(state: { off: number; speed: number }, dt: number) {
  const h = Math.min(0.032, dt) / 4;
  for (let i = 0; i < 4; i++) { state.speed += (-PULL.k * state.off - PULL.c * state.speed) * h; state.off += state.speed * h; }
  return Math.abs(state.off) < 0.4 && Math.abs(state.speed) < 8;
}

/** The pull's existing spring sampled at 60Hz, including the exact starting and resting positions. */
export function springValues(from: number, to: number, speed: number): number[] {
  const state = { off: from - to, speed };
  const values = [from];
  while (!springStep(state, 1 / 60)) values.push(to + state.off);
  values.push(to);
  return values;
}
