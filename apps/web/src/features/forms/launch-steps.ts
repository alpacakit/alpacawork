/**
 * How a launch row's values stand as buttons. Settings write a row's default first (its order is the choice order of
 * admission), which reads as a jumble for a scale ("high, low, medium, xhigh, max"). Shown, values that name a step of
 * how hard to think stand shallow to deep; "none" (null) leads, and a value outside the scale keeps its written place
 * after them. Any row is read the same way, so a row a setting adds (fast, tier…) needs nothing here.
 */
const SCALE = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const rank = (value: string | null) => value === null ? -1 : SCALE.indexOf(value.toLowerCase());

export function stepOrder<T extends string | null>(values: readonly T[]): T[] {
  const known = values.filter(value => rank(value) >= 0 || value === null).sort((a, b) => rank(a) - rank(b));
  return [...known, ...values.filter(value => value !== null && rank(value) < 0)];
}

/** Buttons a row of the menu holds at most: more go on below, every line filled evenly (7 → 4 and 3, never 6 and 1). */
export const STEPS_PER_LINE = 5;
export function stepColumns(count: number): number {
  return Math.ceil(count / Math.ceil(count / STEPS_PER_LINE));
}
