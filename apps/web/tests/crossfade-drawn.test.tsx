import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { crossfade } from "../src/lib/motion";

// The reader turning to another task hands over to it once it is drawn, not to a surface still filling in: until then
// the copy of what was shown stays over it, for at most the wait given. Here an animation runs to its end at once when
// it runs, and not while it is paused, so the copy is there exactly as long as its fade has not run.
const prototypeAnimate = Element.prototype.animate;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
  Element.prototype.animate = function () {
    let state = "running", end!: () => void;
    const finished = new Promise<void>(resolve => { end = resolve; });
    queueMicrotask(() => { if (state === "running") { state = "finished"; end(); } });
    return { finished, cancel() { state = "idle"; }, pause() { state = "paused"; }, play() { state = "finished"; end(); },
      get playState() { return state; } } as unknown as Animation;
  };
});
afterEach(() => { Element.prototype.animate = prototypeAnimate; document.body.innerHTML = ""; vi.useRealTimers(); });

function reader() {
  const box = document.createElement("aside");
  box.innerHTML = "<div data-content>T1</div>";
  document.body.append(box);
  return box;
}
const copies = () => document.querySelectorAll("[data-still-copy]").length;
const frames = async (ms: number) => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); };
const turn = (box: HTMLElement, done: () => boolean) => crossfade(box, { content: "[data-content]", ready: () => {}, drawn: { done, within: 150 } });

test("what was shown stays over the reader until what it turned to is drawn, then goes", async () => {
  const box = reader();
  let drawn = false;
  turn(box, () => drawn);
  await frames(100);
  expect(copies()).toBe(1);
  drawn = true;
  await frames(20);
  expect(copies()).toBe(0);
});

test("a reader still not drawn after the wait is shown as it stands", async () => {
  turn(reader(), () => false);
  await frames(100);
  expect(copies()).toBe(1);
  await frames(80);
  expect(copies()).toBe(0);
});

test("turned again while what was shown still stays, the newest turn is waited for, on the first turn's time", async () => {
  const box = reader();
  let shown = "T1";
  turn(box, () => shown === "T2");
  await frames(60);
  turn(box, () => shown === "T3");
  // No copy is taken of a turn never seen.
  expect(copies()).toBe(1);
  shown = "T2";
  await frames(20);
  expect(copies()).toBe(1);
  shown = "T3";
  await frames(20);
  expect(copies()).toBe(0);
  // The wait is the first turn's: a reader never drawn is shown 150 ms after the first press, not after the last.
  turn(box, () => false);
  await frames(100);
  turn(box, () => false);
  await frames(60);
  expect(copies()).toBe(0);
});
