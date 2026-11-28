import { afterEach, expect, test, vi } from "vitest";
import { crossfade } from "../src/lib/motion";

// The reader turning to another task hands over to it once it is drawn, not to a surface still filling in: until then
// the copy of what was shown stands still over it, for at most the wait given.
type Played = { state: "running" | "paused"; plays: number };
let animations: Played[] = [];
const prototypeAnimate = Element.prototype.animate;
afterEach(() => { Element.prototype.animate = prototypeAnimate; animations = []; document.body.innerHTML = ""; vi.useRealTimers(); });

function surface() {
  Element.prototype.animate = function () {
    const played: Played = { state: "running", plays: 0 };
    animations.push(played);
    return { finished: new Promise(() => {}), cancel() {}, pause() { played.state = "paused"; }, play() { played.state = "running"; played.plays++; },
      get playState() { return played.state; } } as unknown as Animation;
  };
  const box = document.createElement("aside");
  box.innerHTML = "<div data-content>shown</div>";
  document.body.append(box);
  return box;
}

test("the hand-over waits, still, until the surface is drawn, then every part of it starts together", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
  let drawn = false;
  crossfade(surface(), { content: "[data-content]", ready: () => {}, drawn: { done: () => drawn, within: 150 } });
  expect(animations.length).toBeGreaterThan(0);
  expect(animations.every(each => each.state === "paused")).toBe(true);
  vi.advanceTimersByTime(50);
  expect(animations.every(each => each.state === "paused")).toBe(true);
  drawn = true;
  vi.advanceTimersByTime(20);
  expect(animations.every(each => each.state === "running" && each.plays === 1)).toBe(true);
});

test("a surface still not drawn after the wait is handed over as it stands", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
  crossfade(surface(), { content: "[data-content]", ready: () => {}, drawn: { done: () => false, within: 150 } });
  vi.advanceTimersByTime(100);
  expect(animations.every(each => each.state === "paused")).toBe(true);
  vi.advanceTimersByTime(80);
  expect(animations.every(each => each.state === "running")).toBe(true);
});

test("a surface already drawn hands over at once", () => {
  crossfade(surface(), { content: "[data-content]", ready: () => {}, drawn: { done: () => true, within: 150 } });
  expect(animations.every(each => each.state === "running" && each.plays === 0)).toBe(true);
});
