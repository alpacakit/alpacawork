import { describe, expect, it } from "vitest";
import { clearlySmaller, FIRST, frameAt, placeFrame, placeMaximized, restoredFrame, SIDE, type Room } from "@/features/coordinator/frame";

const room = (left: number, right: number): Room => ({ left, right, top: 60, reach: 12, bottom: 900, widest: 770 });

describe("where the coordinator first stands on a computer", () => {
  it("stands in the middle of its working room, beside a docked reader too", () => {
    const whole = placeFrame(FIRST, room(0, 1440), 50, false);
    expect(whole.left + whole.width / 2).toBe(720);
    const beside = placeFrame(FIRST, room(0, 860), 50, false);
    expect(beside.left + beside.width / 2).toBe(430);
  });
  it("narrows inside a narrow room, and once moved by the hand is kept by the nearer side", () => {
    const narrow = placeFrame(FIRST, room(0, 500), 50, false);
    expect([narrow.left, narrow.width]).toEqual([SIDE, 500 - 2 * SIDE]);
    const placed = placeFrame(FIRST, room(0, 1440), 50, false);
    expect(frameAt({ ...placed, left: placed.left + 200 }, room(0, 1440), "bottom", FIRST.height).side).toBe("right");
  });
});

describe("the conversation made smaller from its largest", () => {
  it("visibly shrinks after the hand sized it to the full height", () => {
    const at = room(0, 760), input = 50;
    // Dragged to the full height, then maximized (only its width was left to grow): the frame it had is nearly as large.
    const dragged = { ...FIRST, height: placeMaximized(placeFrame(FIRST, at, input, true), at).height };
    const most = placeMaximized(placeFrame(dragged, at, input, true), at);
    const back = placeFrame(restoredFrame({ ...dragged, width: most.width }, dragged, at, input), at, input, true);
    expect(clearlySmaller(back, at)).toBe(true);
    expect(back.height).toBeLessThan(most.height * 0.8);
  });
});
