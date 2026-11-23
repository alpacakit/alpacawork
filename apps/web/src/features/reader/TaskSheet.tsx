/* Hallmark · component: task sheet · genre: modern-minimal · theme: the app's own tokens
 * states: rising (from below, slow, ease-out) · resting at the kept share · held by a finger (follows it by transform
 * alone; past the top it gives way slowly) · whole (its tallest: square corners, no gap) · leaving (down, base, ease-in)
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { duration, easing, reducedMotion } from "@/lib/motion";
import { listenSheetPress, pullsFrom } from "@/lib/sheet-press";
import { leaveSheet, sheetHand, sheetMotion } from "@/lib/sheet-motion";
import { fingerMark, offerWhileFree, playSteps, sheetShowWay, SHOW_STEPS } from "@/lib/show-how";
import { setSheetShare, SHARE_RANGE, sheetShare } from "@/state/sheets";
import { useDeviceValue } from "@/lib/device-storage";
import { useTaskActionSlot } from "@/features/coordinator/task-action-slot";
import { useNarrow } from "@/state/view-store";
import { unnameReader } from "./reader-copy";

/**
 * A sheet from the bottom on a phone: one element at every height, so going whole replaces nothing. It stands at
 * the share of the screen the person last left a sheet at; its grip (and the header under it, and what it shows when a finger goes down from its top) follow a finger. Let go,
 * the finger's speed carries it on a little; a clear flick up makes it whole, down takes it away, and a slower pull
 * leaves it where it stops (that height is kept on this device), or closes it under the least it can stand at. Motion is the screen's: it rises at
 * --motion-slow ease-out, settles at most as slowly, and leaves at --motion-base ease-in.
 */

/** Window height changes on resize, not on every parent commit. Reading it can flush pending layout. */
export function useScreenHeight() {
  const [height, setHeight] = useState(() => innerHeight);
  useLayoutEffect(() => {
    const resized = () => setHeight(innerHeight);
    addEventListener("resize", resized);
    // A concurrent mount may have yielded between its initial read and subscribing.
    resized();
    return () => removeEventListener("resize", resized);
  }, []);
  return height;
}

export type SheetControl = {
  frame: RefObject<HTMLDivElement | null>;
  /** Mark a visible heading as a grip: sheet-press owns the gesture, and styles.css reserves it from browser panning. */
  grip: { "data-task-sheet-grab": "" };
  /** The whole-screen control: whole, or back to the kept share. */
  toggleWhole: () => void;
};

/**
 * The sheet's motion. What scrolls behind it leaves room for it (`--sheet-cover`). `rising`: it rises as it is first drawn (a press opened it; a URL or Back does not). Taken away (unmounted) it goes
 * back down, from where a finger let it go at the finger's speed. `on`: the frame is a sheet (the reader's is one only on a phone; on a
 * wider screen the same frame holds the window, so what is typed in it survives a change of width).
 */
export function useSheetMotion({ whole, onWhole, onAway, rising, on = true }: {
  whole: boolean; onWhole: (whole: boolean) => void; onAway: () => void; rising: boolean; on?: boolean;
}): SheetControl {
  const share = useDeviceValue(sheetShare);
  const screen = useScreenHeight();
  const frame = useRef<HTMLDivElement>(null);
  /** How fast the finger that sent the sheet away was going (px/ms, taller is positive): it leaves at that speed. */
  const sent = useRef<number | undefined>(undefined);
  const rest = whole ? screen : Math.round(share * screen);
  const latest = useRef({ onWhole, onAway, on, whole });
  latest.current = { onWhole, onAway, on, whole };
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    if (rising && on) el.animate(reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], { duration: duration("slow"), easing: easing("out") });
    return () => { if (latest.current.on) leaveSheet(el, sent.current, unnameReaders); motion.current?.stop(); };
  }, []);
  // At rest it is as tall as it stands; a finger moves it by transform alone (hold).
  useLayoutEffect(() => {
    const el = frame.current;
    if (el && el.dataset.sheetHeld === undefined) { el.style.height = on ? `${rest}px` : ""; el.style.transform = ""; }
  }, [rest, on]);
  useEffect(() => {
    if (!on) return;
    document.documentElement.style.setProperty("--sheet-cover", `${rest}px`);
    return () => { document.documentElement.style.removeProperty("--sheet-cover"); };
  }, [rest, on]);

  const stand = () => latest.current.whole ? innerHeight : sheetShare.get() * innerHeight;
  const motion = useRef<ReturnType<typeof sheetMotion> | null>(null);
  const moving = () => motion.current ??= sheetMotion(frame.current!, { most: () => innerHeight, bottom: () => innerHeight, stand });
  const settle = (height: number, then: () => void, fit: () => number = () => height, speed?: number) => moving().settle(height, then, fit, speed);
  const toWhole = (speed?: number) => settle(innerHeight, () => latest.current.onWhole(true), () => innerHeight, speed);
  const toShare = (height: number, remember = true, speed?: number) => {
    // The hand commits the destination now; a following gesture or reload may cancel the animation.
    if (remember) setSheetShare(height / innerHeight);
    settle(height, () => latest.current.onWhole(false), () => sheetShare.get() * innerHeight, speed);
  };
  // Sent away, the sheet is closed at once, as × closes it, and goes down as it leaves (leave): what is pressed next
  // (a row behind it) opens anew, untouched by the sheet still going.
  const away = (speed?: number) => { sent.current = speed; latest.current.onAway(); };

  /** Every marked grip sizes the sheet, and so does a finger going down from the top of what it shows (`pull`). */
  const press = (pull = false) => sheetHand(moving(), { pull, stand, rests: () => [innerHeight * SHARE_RANGE[0], innerHeight * SHARE_RANGE[1]],
    land: (landing, speed) => landing.to === "whole" ? toWhole(speed) : landing.to === "away" ? away(speed) : toShare(landing.height, true, speed) });

  // Every press on the sheet comes here, the one place it is listened to (what a portal draws over it is not the
  // sheet's). On the grip or the header (`grip`), a finger or a mouse sets its height; anywhere else, a finger that goes
  // down from the top of what it shows (pullsFrom) sets it the same way.
  useEffect(() => {
    const el = frame.current;
    if (!el || !on) return;
    const stop = listenSheetPress(el, (event, target) => {
      const grab = target.closest<HTMLElement>("[data-task-sheet-grab]");
      // Held, the press is the sheet's alone: captured by the sheet, what it shows (the card's swipe) hears no more of it.
      if (grab) return target.closest("input, textarea, [contenteditable=true]") ? null : { press: press(), capture: el };
      // From what it shows, a finger going down from its top is the grip's hand too, once it goes down (pull).
      return pullsFrom(event, target, el) ? { press: press(true), capture: el } : null;
    });
    return () => { stop(); motion.current?.stop(); };
  }, [on]);

  // Showing how its height is changed (show-how): held as a finger holds it, it grows (or, with no room over it,
  // shrinks) and comes back where it stands, a finger mark on its grip; then back at rest at the height kept, which it
  // never changes. Offered while no finger is on the sheet; withdrawn, and stopped if it plays, as the sheet goes or
  // stops being one.
  useEffect(() => {
    const el = frame.current;
    if (!on || !el) return;
    let playing: (() => void) | undefined;
    const withdraw = offerWhileFree("sheet", el, ended => {
      const grip = el.querySelector("[data-task-sheet-grip]");
      if (!grip) { ended(); return () => {}; }
      const hand = moving(), from = hand.shown(), way = sheetShowWay(from, innerHeight), finger = fingerMark();
      const bar = grip.getBoundingClientRect();
      hand.hold(from);
      const stop = playSteps(SHOW_STEPS.sheet, reach => {
        hand.follow(from + way * reach);
        finger.at(bar.left + bar.width / 2, bar.top + bar.height / 2 - way * reach);
      }, () => { finger.remove(); if (el.dataset.sheetHeld !== undefined) hand.stop(); playing = undefined; ended(); });
      playing = stop;
      return stop;
    });
    return () => { playing?.(); withdraw(); };
  }, [on]);

  return { frame, grip: GRIP, toggleWhole: () => whole ? toShare(share * innerHeight, false) : toWhole() };
}

const GRIP = { "data-task-sheet-grab": "" } as const;

/** The readers a sheet's copy carries down are no readers any more (reader-copy.ts): the one opened meanwhile is the only one found. */
const unnameReaders = (copy: HTMLElement) => copy.querySelectorAll<HTMLElement>("[data-reader-mode]").forEach(unnameReader);

/**
 * A surface covering the whole screen (the overlay, a phone's sheet pulled whole) leaves what it covers inert: Tab from
 * its last control goes round to its first (and Shift+Tab back), so the keyboard never leaves it until it closes. The
 * task's actions are the reader's own though drawn in the conversation's row over the input (TaskActions): they
 * come after its last control, and their keys come here through the reader.
 */
export function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
  const box = event.currentTarget, active = event.target as Element;
  // A key in the conversation's own window comes through the reader too; that window keeps its own round.
  if (event.key !== "Tab" || active.ownerDocument !== box.ownerDocument) return;
  const { element: slot, page } = useTaskActionSlot.getState();
  const inside = usableIn(box), actions = slot && page === box.ownerDocument ? usableIn(slot) : [];
  const all = [...inside, ...actions];
  const first = all[0], last = all.at(-1);
  if (!first || !last) return;
  const to = !event.shiftKey ? (active === last ? first : active === inside.at(-1) ? actions[0] : undefined)
    : (active === first ? last : active === actions[0] ? inside.at(-1) : undefined);
  if (to) { event.preventDefault(); to.focus(); }
}

const usableIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
)].filter((control) => control.getClientRects().length > 0 && !control.closest("[inert]"));

/** The sheet's frame: fixed to the bottom, as tall as it stands. What it holds fills it. Off, it is no box of its own. */
export function SheetFrame({ control, whole, layer, on = true, children }: { control: SheetControl; whole: boolean; layer: number; on?: boolean; children: ReactNode }) {
  return <div ref={control.frame} data-sheet={on ? "" : undefined} data-whole={on && whole || undefined} style={on ? { zIndex: layer } : undefined}
    className={on ? "group/sheet fixed inset-x-0 bottom-0" : "contents"}>
    {/* The handle is thin and at the sheet's very edge: a finger that lands just over it still takes it, not the list behind.
        Focusable (out of the Tab order), each is a place a finger may be aimed at, so the browser does not move a press
        here onto a row behind (touch adjustment goes to what a tap would act on). */}
    {on && <div aria-hidden="true" tabIndex={-1} {...control.grip} data-sheet-handle className="absolute bottom-full left-1/2 h-4 w-40 -translate-x-1/2 outline-none group-data-whole/sheet:hidden" />}
    {children}
  </div>;
}

/** The sheet a part stands in (the reader's, for its header's grip and whole-screen control), if any. */
export const SheetControlContext = createContext<(SheetControl & { whole: boolean }) | null>(null);
export const useSheetControl = () => useContext(SheetControlContext);

/** The grip of the sheet this stands in, if it stands in one. */
export function StandingGrip() {
  const control = useSheetControl();
  return control && <SheetGrip control={control} />;
}

/** The grip at the sheet's top edge: a finger on it (or on the header under it) moves the sheet. */
function SheetGrip({ control }: { control: SheetControl }) {
  const { t } = useTranslation("reader");
  return <div {...control.grip} tabIndex={-1} data-sheet-handle data-task-sheet-grip title={t("sheet.grip")} className="flex h-3 flex-none items-end justify-center outline-none">
    <span data-guide-part="grip" className="h-1 w-9 rounded-sm bg-line" />
  </div>;
}

/**
 * The sheet's own surface: a card at the top edge, as wide as the screen and so not rounded (a pane reaching both sides,
 * tokens.css), and edge to edge once whole; held by a finger it keeps its top edge and shadow, whole or not, so a
 * sheet pulled down from the whole screen has them as it moves. It is one layer, as a computer's
 * window is: what stands raised inside it (its reading header) stays inside it, under what lies over the surface (a
 * still copy of it fading away, the swipe's stamp).
 */
export const SHEET_SURFACE = "absolute inset-0 isolate flex flex-col overflow-hidden border-t-hairline border-lit-line bg-lit shadow-float [[data-whole]:not([data-sheet-held])>&]:border-transparent [[data-whole]:not([data-sheet-held])>&]:shadow-none";

/**
 * While the sheet is up, a press on nothing behind it (on the page, not inside the sheet, not a row, a link, a button
 * or a field) takes it away. What is over the page (a menu, a dialog and their backdrops, the coordinator's card) is
 * not behind it: a press there is that surface's own.
 */
export function useCloseOnPressBehind(on: boolean, frame: RefObject<HTMLElement | null>, close: () => void) {
  const narrow = useNarrow();
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!on || !narrow) return;
    const press = (event: MouseEvent) => {
      const at = event.target;
      if (!(at instanceof Element) || frame.current?.contains(at) || !at.closest("[data-page]")) return;
      if (at.closest("button, a, input, textarea, select, label, summary, [role=button], [role=dialog], [role=menu], [contenteditable=true], [data-task-reference], [data-slot=sheet], [data-coordinator-card]")) return;
      latest.current();
    };
    document.addEventListener("click", press, true);
    return () => document.removeEventListener("click", press, true);
  }, [on, narrow, frame]);
}
