import { test, expect } from "vitest";
import { PULL, springStep } from "../src/features/tree/pull-feel";

/** The spring from `from` to rest at 60 frames a second: how many times it goes past rest, and how long it takes. */
function back(from: number) {
  const state = { off: from, speed: 0 };
  let ms = 0, crossings = 0, side = Math.sign(from);
  while (!springStep(state, 1 / 60)) {
    ms += 1000 / 60;
    if (Math.sign(state.off) !== side && state.off !== 0) { crossings++; side = Math.sign(state.off); }
    if (ms > 5000) throw new Error("never rests");
  }
  return { crossings, ms };
}

test("the list follows the finger in a straight line, at less than its way, and refreshes past 142px of finger", () => {
  // Straight: each pixel of the finger moves the list the same.
  expect(PULL.resist(150) - PULL.resist(100)).toBeCloseTo(PULL.resist(100) - PULL.resist(50));
  // However far it is pulled, the list goes at most 160px.
  expect(PULL.resist(1000)).toBe(160);
  // With the 8px that tell a pull from a tap first, the line is 142px of finger (A2).
  let finger = 0; while (PULL.resist(finger) < PULL.threshold) finger++;
  expect(finger + 8).toBe(142);
  expect(PULL.hold).toBeLessThan(PULL.threshold);
});

test("from where it rests while refreshing, it goes back without going past and stops in under half a second", () => {
  const { crossings, ms } = back(PULL.hold);
  expect(crossings).toBe(0);
  expect(ms).toBeLessThan(500);
});
