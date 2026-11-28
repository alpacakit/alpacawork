import { expect, test } from "vitest";
import { SPEED_LANE, speedLane } from "@/features/tree/token-speed";

test("the time strip gives up its room before the speed column loses its bars, then its number", () => {
  // A list beside an open detail on a 1440px screen, and one on a 1050px screen: the bars stand.
  expect(speedLane(833)).toBe(SPEED_LANE);
  expect(speedLane(570)).toBe(SPEED_LANE);
  // Narrower, the number alone, until even it would squeeze the strip under its floor.
  expect(speedLane(520)).toBeGreaterThan(0);
  expect(speedLane(520)).toBeLessThan(SPEED_LANE);
  expect(speedLane(480)).toBe(0);
});
