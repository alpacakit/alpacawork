import { create } from "zustand";

/**
 * Showing how a part of the screen is used (the guide's "show how"): a short motion played by the part's own owner of
 * motion (the task sheet's height, the card's swipe), never by anyone else, while a balloon says what it is. It changes
 * nothing: no answer is sent, no state reported, no height kept. Any finger on the screen ends it at once.
 */
export type ShowHowKind = "sheet" | "swipe";

/** One step of a motion: to `to` (px, in the part's own measure) over `ms`, eased in and out (`to` unchanged: still). */
export type ShowStep = { to: number; ms: number };
/** The sheet grows about 48 px and back, twice; the card goes about 64 px right and back, then left and back. */
const SHEET: readonly ShowStep[] = [{ to: 48, ms: 600 }, { to: 48, ms: 300 }, { to: 0, ms: 500 }, { to: 0, ms: 1200 },
  { to: 48, ms: 600 }, { to: 48, ms: 300 }, { to: 0, ms: 500 }];
const RIGHT: readonly ShowStep[] = [{ to: 64, ms: 600 }, { to: 64, ms: 500 }, { to: 0, ms: 400 }];
const LEFT: readonly ShowStep[] = [{ to: 0, ms: 300 }, { to: -64, ms: 600 }, { to: -64, ms: 500 }, { to: 0, ms: 400 }];
export const SHOW_STEPS = { sheet: SHEET, swipeRight: RIGHT, swipeLeft: LEFT } as const;
/** How far up a kind's motion takes the part it is played on: a balloon over that part stands clear of all of it. */
export const showHowRise = (kind: ShowHowKind) => kind === "sheet" ? Math.max(...SHEET.map(step => step.to)) : 0;

/** Starts a kind's motion; `ended` is called once when it ends, however it ends. Returns what stops it. */
export type ShowHow = (ended: () => void) => () => void;
/** The motions offered now, each by the one owner that can play it (while its part is on the screen). */
export const useShowHow = create<Partial<Record<ShowHowKind, ShowHow>>>(() => ({}));
/** Offers a kind's motion while its owner is there; returns what withdraws it (only if it is still the one offered). */
export function offerShowHow(kind: ShowHowKind, play: ShowHow): () => void {
  useShowHow.setState({ [kind]: play });
  return () => { if (useShowHow.getState()[kind] === play) useShowHow.setState({ [kind]: undefined }); };
}

const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
/** Where a run of `steps` stands `elapsed` ms after it began (from 0), or null once it is over. */
export function showAt(steps: readonly ShowStep[], elapsed: number): number | null {
  let from = 0, at = 0;
  for (const step of steps) {
    if (elapsed < at + step.ms) return from + (step.to - from) * ease((elapsed - at) / step.ms);
    at += step.ms; from = step.to;
  }
  return null;
}

/**
 * Plays `steps` frame by frame through `apply`, then calls `end` (also when stopped: by the returned function, or by any
 * finger or pointer pressing anywhere, which then goes on to do what it does). `end` is called once.
 */
export function playSteps(steps: readonly ShowStep[], apply: (at: number) => void, end: () => void): () => void {
  let frame = 0, over = false;
  const start = performance.now();
  const stop = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    removeEventListener("pointerdown", stop, true);
    end();
  };
  const tick = () => {
    const at = showAt(steps, performance.now() - start);
    if (at === null) return stop();
    apply(at);
    frame = requestAnimationFrame(tick);
  };
  addEventListener("pointerdown", stop, true);
  frame = requestAnimationFrame(tick);
  return stop;
}

/** The finger of a motion: a half-clear circle over the part, following it; nothing presses through it. */
export function fingerMark() {
  const mark = document.createElement("div");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-show-how-finger", "");
  mark.className = "pointer-events-none fixed z-(--layer-guide) -mt-5 -ml-5 size-10 rounded-full border-2 border-bg/90 bg-ink/25 shadow-float";
  document.body.append(mark);
  return {
    at: (x: number, y: number) => { mark.style.left = `${x}px`; mark.style.top = `${y}px`; },
    remove: () => mark.remove(),
  };
}
