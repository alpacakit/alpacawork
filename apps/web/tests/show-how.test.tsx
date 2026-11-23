import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { useSheetMotion } from "../src/features/reader/TaskSheet";
import { useSwipeAnswer } from "../src/features/reader/swipe-answer";
import { sheetShowWay, useShowHow } from "../src/lib/show-how";
import { sheetShare, setSheetShare } from "../src/state/sheets";

/** The guide's motions (show-how), played by the sheet and the card themselves: they change nothing, and a finger ends them. */
let frames: FrameRequestCallback[] = [], now = 0;
/** Runs the frames due after `ms` more. */
const pass = (ms: number) => act(() => { now += ms; const due = frames; frames = []; due.forEach(frame => frame(now)); });
beforeEach(() => {
  frames = []; now = 0;
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Sheet() {
  const [whole, onWhole] = useState(false);
  const control = useSheetMotion({ whole, onWhole, onAway() {}, rising: false });
  return <div ref={control.frame} data-frame><div data-task-sheet-grip /></div>;
}

test("the sheet is not shown while a finger is on it, grows and comes back once it is lifted, keeps its height, and stops at a touch", () => {
  vi.stubGlobal("innerHeight", 844);
  setSheetShare(0.6);
  render(<Sheet />);
  const frame = document.querySelector<HTMLElement>("[data-frame]")!;
  frame.getAnimations = () => [];
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({ top: 844 - Number.parseFloat(frame.style.height) }) as DOMRect);
  const ended = vi.fn();
  // A finger already on the sheet: nothing is offered to play until it is lifted.
  const finger = (type: string) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerId: 7 }); return event; };
  act(() => { frame.dispatchEvent(finger("pointerdown")); });
  expect(useShowHow.getState().sheet).toBeUndefined();
  act(() => { window.dispatchEvent(finger("pointerup")); });
  act(() => { useShowHow.getState().sheet!(ended); });
  pass(16); pass(600);
  // Grown by about 48 px, held as a finger holds it.
  expect(frame.dataset.sheetHeld).toBe("");
  expect(frame.style.transform).toBe(`translateY(${844 - Math.round(0.6 * 844) - 48}px)`);
  act(() => { window.dispatchEvent(new Event("pointerdown")); });
  expect(ended).toHaveBeenCalledOnce();
  expect([frame.dataset.sheetHeld, frame.style.transform, frame.style.height]).toEqual([undefined, "", `${Math.round(0.6 * 844)}px`]);
  expect(sheetShare.get()).toBe(0.6);
  expect(document.querySelector("[data-show-how-finger]")).toBeNull();
});

const run = vi.fn(() => "retired" as const);
function Card() {
  const card = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null), stamp = useRef<HTMLDivElement>(null);
  useSwipeAnswer(card, content, stamp, true, { answer: { kind: "done", verb: "Done", run }, hold: { kind: "hold", verb: "Hold", run } }, "one");
  return <aside ref={card}><div ref={content} /><div ref={stamp} data-stamp /></aside>;
}

test("the card goes right and left with each side's stamp as it is shown, and nothing is answered", () => {
  render(<Card />);
  const card = document.querySelector("aside")!, stamp = document.querySelector<HTMLElement>("[data-stamp]")!;
  const ended = vi.fn();
  act(() => { useShowHow.getState().swipe!(ended); });
  pass(16); pass(600);
  expect([card.style.transform, stamp.dataset.swipe]).toEqual(["translateX(64px) rotate(1.4222222222222223deg)", "right"]);
  pass(1500);
  expect(stamp.dataset.swipe).toBe("left");
  pass(2000); pass(16);
  expect(ended).toHaveBeenCalledOnce();
  expect([card.style.transform, stamp.dataset.swipe, run.mock.calls.length]).toEqual(["", undefined, 0]);
});

test("the sheet is shown growing where the screen has room over it, else shrinking", () => {
  expect([sheetShowWay(500, 844), sheetShowWay(796, 844), sheetShowWay(797, 844), sheetShowWay(844, 844)]).toEqual([1, 1, -1, -1]);
});
