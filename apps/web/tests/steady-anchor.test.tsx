import { describe, expect, it } from "vitest";
import { steadyAnchor } from "@/lib/steady-anchor";

/** A trigger whose box the test sets, as layout would. */
function trigger(x: number, y: number, width: number, height = 24) {
  const at = { x, y, width, height };
  return { at, element: { getBoundingClientRect: () => ({ ...at, left: at.x, top: at.y, right: at.x + at.width, bottom: at.y + at.height }) as DOMRect } };
}

describe("a popover's steady anchor", () => {
  it("stays where it opened when its trigger's label grows, and follows the trigger when the page moves it", () => {
    const { at, element } = trigger(600, 700, 90);
    const anchor = steadyAnchor(() => element);
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 600, y: 700, width: 90 });
    // A longer model name: right-aligned, the button grows to the left and onto the line above.
    Object.assign(at, { x: 540, y: 670, width: 150 });
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 600, y: 700, width: 90 });
    // The page scrolls by 40: the card goes with the button.
    Object.assign(at, { y: 630 });
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 600, y: 660, width: 90 });
    // Opened again, it is placed against the button as it is then.
    anchor.reset();
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 540, y: 630, width: 150 });
  });
});
