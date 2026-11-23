import { create } from "zustand";
import { reducedMotion } from "./motion";

/**
 * Showing how a part of the screen is used (the guide's "show how"): a short motion played by the part's own owner of
 * motion (the task sheet's height, the card's swipe), never by anyone else, while a balloon says what it is. It changes
 * nothing: no answer is sent, no state reported, no height kept. An owner offers it only while it can be played there
 * (offerWhileFree): not while a finger is on its part, nor while the part cannot do it. It does not play where motion
 * is reduced, and any finger on the screen, motion turned to reduced or the screen resized ends it at once.
 */
export type ShowHowKind = "sheet" | "swipe";

/** One step of a motion: to `to` (px, in the part's own measure) over `ms`, eased in and out (`to` unchanged: still). */
export type ShowStep = { to: number; ms: number };
/** The sheet grows (or shrinks) about 48 px and back, twice; the card goes about 64 px right and back, then left and back. */
const SHEET: readonly ShowStep[] = [{ to: 48, ms: 600 }, { to: 48, ms: 300 }, { to: 0, ms: 500 }, { to: 0, ms: 1200 },
  { to: 48, ms: 600 }, { to: 48, ms: 300 }, { to: 0, ms: 500 }];
const RIGHT: readonly ShowStep[] = [{ to: 64, ms: 600 }, { to: 64, ms: 500 }, { to: 0, ms: 400 }];
const LEFT: readonly ShowStep[] = [{ to: 0, ms: 300 }, { to: -64, ms: 600 }, { to: -64, ms: 500 }, { to: 0, ms: 400 }];
export const SHOW_STEPS = { sheet: SHEET, swipeRight: RIGHT, swipeLeft: LEFT } as const;
const SHEET_REACH = Math.max(...SHEET.map(step => step.to));
/** How far up or down a kind's motion may take the part it is played on: a balloon by that part stands clear of it. */
export const showHowReach = (kind: ShowHowKind) => kind === "sheet" ? SHEET_REACH : 0;
/**
 * Which way the sheet is shown: growing (1) where the screen has room over it (`shown` px tall of `most`), else
 * shrinking (-1), so its grip and the finger on it stay on the screen.
 */
export const sheetShowWay = (shown: number, most: number): 1 | -1 => most - shown >= SHEET_REACH ? 1 : -1;

/** Starts a kind's motion; `ended` is called once when it ends, however it ends. Returns what stops it. */
export type ShowHow = (ended: () => void) => () => void;
/** The motions offered now, each by the one owner that can play it (while its part is on the screen). */
export const useShowHow = create<Partial<Record<ShowHowKind, ShowHow>>>(() => ({}));
/** Offers a kind's motion while its owner is there; returns what withdraws it (only if it is still the one offered). */
function offerShowHow(kind: ShowHowKind, play: ShowHow): () => void {
  useShowHow.setState({ [kind]: play });
  return () => { if (useShowHow.getState()[kind] === play) useShowHow.setState({ [kind]: undefined }); };
}
/**
 * Offers a kind's motion from its owner while no finger (or pointer) is down on the owner's own `surface`: one going
 * down there is the person's own press, so the motion is withdrawn until every one is lifted. Returns what withdraws it
 * for good (the owner gone, or its part no longer able to do it).
 */
export function offerWhileFree(kind: ShowHowKind, surface: HTMLElement, play: ShowHow): () => void {
  const down = new Set<number>();
  let withdraw = offerShowHow(kind, play);
  const press = (event: PointerEvent) => { if (!down.size) withdraw(); down.add(event.pointerId); };
  const lift = (event: PointerEvent) => { if (down.delete(event.pointerId) && !down.size) withdraw = offerShowHow(kind, play); };
  surface.addEventListener("pointerdown", press, true);
  addEventListener("pointerup", lift, true);
  addEventListener("pointercancel", lift, true);
  return () => {
    surface.removeEventListener("pointerdown", press, true);
    removeEventListener("pointerup", lift, true);
    removeEventListener("pointercancel", lift, true);
    withdraw();
  };
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
 * Plays `steps` frame by frame through `apply`, then calls `end` (also when stopped: by the returned function, by any
 * finger or pointer pressing anywhere, which then goes on to do what it does, by motion turned to reduced, or by the
 * screen resized). Where motion is reduced already, nothing plays and `end` is called at once. `end` is called once.
 */
export function playSteps(steps: readonly ShowStep[], apply: (at: number) => void, end: () => void): () => void {
  if (reducedMotion()) { end(); return () => {}; }
  let frame = 0, over = false;
  const start = performance.now();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const changed = () => { if (reduced.matches) stop(); };
  const stop = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    removeEventListener("pointerdown", stop, true);
    removeEventListener("resize", stop);
    reduced.removeEventListener("change", changed);
    end();
  };
  const tick = () => {
    const at = showAt(steps, performance.now() - start);
    if (at === null) return stop();
    apply(at);
    frame = requestAnimationFrame(tick);
  };
  addEventListener("pointerdown", stop, true);
  addEventListener("resize", stop);
  reduced.addEventListener("change", changed);
  frame = requestAnimationFrame(tick);
  return stop;
}

/** The finger of a motion: a half-clear circle over the part, following it, kept whole on the screen; nothing presses through it. */
/** Half the finger mark's size (size-10), with its border. */
const FINGER_HALF = 22;
export function fingerMark() {
  const mark = document.createElement("div");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-show-how-finger", "");
  mark.className = "pointer-events-none fixed z-(--layer-guide) -mt-5 -ml-5 size-10 rounded-full border-2 border-bg/90 bg-ink/25 shadow-float";
  document.body.append(mark);
  return {
    at: (x: number, y: number) => {
      const inside = (v: number, size: number) => Math.min(Math.max(v, FINGER_HALF), size - FINGER_HALF);
      mark.style.left = `${inside(x, innerWidth)}px`; mark.style.top = `${inside(y, innerHeight)}px`;
    },
    remove: () => mark.remove(),
  };
}
