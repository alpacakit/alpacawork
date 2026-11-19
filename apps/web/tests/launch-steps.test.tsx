import { expect, test } from "vitest";
import { stepColumns, stepOrder } from "../src/features/forms/launch-steps";

test("a row's buttons stand shallow to deep with none first, and values outside the scale keep their written order after", () => {
  expect(stepOrder(["high", "low", "medium", "xhigh", "max", "minimal", "off"])).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  expect(stepOrder([null, "fast"])).toEqual([null, "fast"]);
  expect(stepOrder(["turbo", "high", "eco", "low"])).toEqual(["low", "high", "turbo", "eco"]);
});

test("a row too long for one line fills its lines evenly", () => {
  expect([5, 7].map(stepColumns)).toEqual([5, 4]);
});
