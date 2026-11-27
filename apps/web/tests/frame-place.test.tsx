import { describe, expect, it } from "vitest";
import { besidePanel, clearlySmaller, FIRST, frameAt, placeFrame, placeMaximized, restoredFrame, SIDE, stayingWhereDrawn, type Frame, type Room } from "@/features/coordinator/frame";

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

describe("a panel at the right put away", () => {
  const whole = room(0, 1600), input = 50;
  const closed = (frame: Frame, panel: number) => {
    const beside = besidePanel(whole, { left: panel }), placed = placeFrame(frame, beside, input, false);
    const kept = stayingWhereDrawn(frame, { placed, room: beside }, whole, false, false) ?? frame;
    return { placed, after: placeFrame(kept, whole, input, false) };
  };
  it("leaves the coordinator where and as wide as it was drawn beside it", () => {
    for (const [frame, panel] of [[FIRST, 900], [{ ...FIRST, side: "right", x: SIDE }, 1000], [{ ...FIRST, side: "right", x: 72 }, 1000],
      [FIRST, 400]] as const) {
      const { placed, after } = closed(frame, panel);
      expect([after.left, after.width]).toEqual([placed.left, placed.width]);
    }
    expect(closed(FIRST, 400).after.width).toBeLessThan(FIRST.width);
  });
  it("still holds it by its side when the window is sized or a panel's edge is held", () => {
    const beside = besidePanel(whole, { left: 900 }), placed = placeFrame(FIRST, beside, input, false);
    expect(stayingWhereDrawn(FIRST, { placed, room: beside }, whole, true, false)).toBeNull();
    expect(stayingWhereDrawn(FIRST, { placed, room: beside }, whole, false, true)).toBeNull();
  });
});
