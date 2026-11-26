import { flushSync } from "react-dom";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { deviceValue, jsonCodec, useDeviceValue, type DeviceValue } from "@/lib/device-storage";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { duration, easing, reducedMotion } from "@/lib/motion";
import { listenSheetPress, pullsFrom } from "@/lib/sheet-press";

import { leaveSheet } from "@/lib/sheet-motion";
import { sheetRelease, SHEET_LEAST as LEAST, FLICK_MS } from "./sheet-release";

/* Hallmark · component: coordinator sheet (phone) · genre: modern-minimal · theme: the app's own tokens (the card's paper)
 * states: resting (the height the hand gave it) · sizing (its grip held) · letting go (pulled under its least: it fades as
 * it shrinks, and let go there it closes) · keyboard up (the same height, or the whole room above the keyboard when that is less)
 */

/** An arrow key's step. */
const STEP = 24;
/** The height a sheet starts at, of the screen without the keyboard. */
const FIRST = 0.6;

/**
 * The screen's height without the keyboard: the tallest the window has been at this width. With the keyboard up the
 * window is shorter (the page is laid out above it), and the sheet's first height is not taken from that.
 */
let roomy = { width: 0, height: 0 };
function roomyHeight() {
  roomy = innerWidth !== roomy.width ? { width: innerWidth, height: innerHeight } : { width: roomy.width, height: Math.max(roomy.height, innerHeight) };
  return roomy.height;
}
/** Where a phone sheet keeps the height the hand gave it, with what stands below it: one per sheet. */
export const sheetExtent = (key: `alpacawork.${string}`) => deviceValue<number | null>(key, jsonCodec<number | null>((value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null), null);
/** A height kept only while one sheet stays open, so each opening starts at its first height. */
function openingExtent(): DeviceValue<number | null> {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  const set = (next: number | null) => { value = next; listeners.forEach(each => each()); return "memory" as const; };
  return { get: () => value, set, remove: () => set(null),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
// One saved vertical budget includes the input below the conversation. Its top stays put when context wraps the input.
export const conversationExtent = sheetExtent("alpacawork.coordinatorExtent");

const HALF_SCREEN = "alpacawork:coordinator-half-screen";
/** How long a tap's words on how a sheet is sized stay: two short lines, read through. */
const HINT_MS = 4000;
/** Ask the mounted phone sheet to keep the conversation and input in the lower half. */
export function fitPhoneSheetToLowerHalf() {
  dispatchEvent(new Event(HALF_SCREEN));
}

/**
 * The coordinator's conversation on a phone: a sheet standing `below` px over the screen's foot (over the input), as tall
 * as the hand made it by its grip at the top (or any part of what it holds marked `data-card-grab`; a button there is
 * still a button). The keyboard coming up does not shrink it: it keeps its height, and only where that is more than the
 * room above the keyboard does it take all that room, under
 * the bar over the list while it is shown (--bar-in). Pulled down past its least it follows the hand and fades.
 * Let go, the way the hand flicked decides first, whatever the height: flicked down it is closed (`onLetGo`, from the
 * height it was let go at), flicked up it opens to its tallest. Else let go LET_GO under its least (or under the
 * height it was taken at, when a low screen draws it shorter) it is closed, and
 * anywhere else it keeps the height it was let go at (its least at the least). Its grip at the top is as tall as the head
 * the sheet declares (--pane-head, the conversation's), else 20px, and is also a separator the keys reach: up and down
 * change the height by a step. A tap sizes nothing; only a tap on what it holds marked `data-sheet-tip` (the place that
 * shows it is sized by the hand) says, in a tip over it, how the sheet is sized.
 * From the top of what it shows, a finger going down (sheet-press, as on the task's sheet) is the grip's hand: it sizes
 * the sheet and lets it go by the same rule.
 */
export const PhoneSheet = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  label: string; below: number; room: number; expanded: boolean; onLetGo: () => void;
  /**
   * Where its height is kept (`sheetExtent`): the coordinator's conversation unless another sheet names its own. `null`:
   * kept only while it is open, for a sheet whose contents do not change from one opening to the next.
   */
  store?: DeviceValue<number | null> | null;
  /** The height it starts at before the hand gives it one, of the screen without the keyboard. */
  first?: number;
  /** Takes off its copy, as it slides away once closed, the marks that name the live surface (leaveSheet). */
  unname?: (copy: HTMLElement) => void;
}>(function PhoneSheet({ className, children, style, label, below, room, expanded, onLetGo, store: given = conversationExtent, first = FIRST, unname, ...props }, ref) {
  const { t } = useTranslation("ui");
  const own = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => own.current!, []);
  const [opening] = useState(openingExtent);
  const store = given ?? opening;
  const extent = useDeviceValue(store);
  const [roomyScreen, setRoomyScreen] = useState(roomyHeight);
  // Keep the same keyboard-free height basis as the sheet's default. Only rendering is capped by the current room.
  // Only the conversation is asked to keep to the lower half.
  useLayoutEffect(() => {
    if (store !== conversationExtent) return;
    const half = () => conversationExtent.set(Math.round(roomyScreen / 2));
    addEventListener(HALF_SCREEN, half);
    return () => removeEventListener(HALF_SCREEN, half);
  }, [roomyScreen, store]);
  const [held, setHeld] = useState<number | null>(null);
  // Where a tap on what it marks `data-sheet-tip` was (in the sheet), its words shown over it for a moment: how it is sized.
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!hint) return;
    const gone = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(gone);
  }, [hint]);
  // Held, what it is let go under: its least, or the height it was taken at when that is less (a low screen draws it
  // shorter than its least), so it is always pulled down clearly before it fades and closes.
  const [floor, setFloor] = useState(LEAST);
  const unnamed = useRef(unname);
  unnamed.current = unname;
  useLayoutEffect(() => () => { if (own.current) leaveSheet(own.current, undefined, unnamed.current); }, []);
  // Each time it is folded: a press begun before it, on the conversation as it was, does not move it once opened again.
  const folds = useRef(0);
  useLayoutEffect(() => { if (!expanded) folds.current++; }, [expanded]);
  useEffect(() => {
    const resize = () => setRoomyScreen(roomyHeight());
    addEventListener("resize", resize); return () => removeEventListener("resize", resize);
  }, []);
  const most = room;
  const within = (height: number) => Math.round(Math.max(Math.min(LEAST, most), Math.min(height, most)));
  // The height it keeps, as the hand gave it (or its first), before the room draws it shorter.
  const kept = extent === null ? roomyScreen * first : extent - below;
  const resting = within(kept);
  // Held, it follows the hand under its least too (down to nothing), so letting go there is seen before it happens.
  const height = held === null ? resting : Math.round(Math.max(0, Math.min(held, most)));
  const least = Math.min(LEAST, most);
  // As tall as it is drawn for a height: no more than the room over the input, under the entrance's room and the bar over the
  // list (while it is shown), so neither stands over the other's controls.
  const cap = (h: number) => `${Math.min(h, most)}px`;
  const latest = useRef({ least, most, onLetGo, cap, resting, expanded, below, store });
  latest.current = { least, most, onLetGo, cap, resting, expanded, below, store };
  // The glide under way to a height it keeps (let go by the hand): the hand taking it ends it.
  const settling = useRef<Animation | undefined>(undefined);
  // Every height it is given to keep (by the grip, the keys) goes through here: a glide under way ends.
  const saveHeight = (height: number) => {
    settling.current?.cancel();
    latest.current.store.set(height + latest.current.below);
  };
  // What it holds is drawn into it from elsewhere in the tree (a portal), so React's handlers here never hear a press
  // on a part of it marked to size it: the sheet listens on its own element.
  useEffect(() => {
    const sheet = own.current!;
    // Where the hand has been lately (time, height), for how fast it went as it let go.
    // `pull`: taken from what it shows, its moves come through sheet-press (which took it on a move this sheet had already heard).
    // `gain`: how far the height goes for the finger's way (a place that stays put under the finger, the foot, sizes it
    // faster than the edge the finger carries); `far` and the trail are the finger's own way, so a tap and a flick are
    // the same gestures from anywhere.
    // `tip`: pressed on what says how it is sized (`data-sheet-tip`), so a tap there says it.
    let drag: { id: number; x: number; y: number; from: number; to: number | null; far: number; gain: number; trail: [number, number][]; opening: number; pull: boolean; tip: boolean } | null = null;
    // What it fades under as it is held (`floor`).
    let fade = LEAST;
    // Whether the conversation a press began on is still the one open (folded since, it is going: sink owns it).
    const live = (opening: number) => folds.current === opening && latest.current.expanded;
    // Taken by the hand at the height it is drawn at, fading under `under`.
    const take = (drawn: number, under: number) => {
      settling.current?.cancel();
      setHint(null);
      fade = under; setFloor(under);
      setHeld(drawn);
    };
    // The hand that lets the conversation go takes the focus too: touch drags do not synthesize the mouse focus a tap
    // would, and focus left in the editor would keep it "being written in" even after the conversation was let go.
    const handOver = () => sheet.querySelector<HTMLElement>("[data-sheet-grip]")!.focus({ preventScroll: true });
    // Let go held at `to`, it comes to rest at `next` from there, its fading undone.
    const rest = (to: number, next: number, glide: KeyframeAnimationOptions = { duration: duration("base"), easing: easing("out") }) => {
      const { cap } = latest.current, opacity = Math.min(1, Math.max(0, to) / fade);
      if (Math.abs(next - to) > 2) settling.current = sheet.animate(reducedMotion()
        ? [{ opacity }, { opacity: 1 }]
        : [{ height: cap(Math.max(0, to)), opacity }, { height: cap(next), opacity: 1 }], glide);
      setHeld(null);
    };
    // The one hand that sizes it, for a pointer pressed at `y` (at `at`): taken from the height it is drawn at (under the
    // entrance's room and the bar it may be shorter than the height it keeps), so the hand moves it from where it is seen.
    // It takes the focus: a keyboard dismissed by that can enlarge the room, and it keeps following the height it took.
    const begin = (id: number, x: number, y: number, at: number, pull = false, gain = 1, tip = false) => {
      const drawn = sheet.offsetHeight;
      drag = { id, x, y, from: drawn, to: null, far: 0, gain, trail: [[at, drawn]], opening: folds.current, pull, tip };
      take(drawn, Math.min(latest.current.least, drawn));
      handOver();
    };
    // One pointer sizes it from its press to its lift; another finger meanwhile neither takes it over nor ends it. Folded
    // and going (sink), it is no longer the hand's. The grip owns its gesture from the press.
    const down = (event: PointerEvent) => {
      const target = event.target as Element;
      if (drag || !latest.current.expanded || event.button !== 0 || !target.closest("[data-card-grab]") || target.closest("button")) return;
      begin(event.pointerId, event.clientX, event.clientY, event.timeStamp, false, Number(target.closest('[data-grab-gain]')?.getAttribute('data-grab-gain')) || 1,
        !!target.closest("[data-sheet-tip]"));
      sheet.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    // The finger at `y` as of `at`: the height follows it, and its trail says how fast it went.
    const follow = (y: number, at: number) => {
      if (!drag || !live(drag.opening)) return;
      const way = drag.y - y, to = drag.from + way * drag.gain;
      drag.to = to; drag.far = Math.max(drag.far, Math.abs(way)); drag.trail = [...drag.trail.filter(([time], index, all) => at - time <= FLICK_MS || index === all.length - 1), [at, drag.from + way]];
      // Drawn at once, in the move that asked for it: left to React's own time it could come a frame late, or two moves
      // in one frame, and what it holds would step unevenly under the finger.
      flushSync(() => setHeld(to));
    };
    const move = (event: PointerEvent) => { if (drag?.id === event.pointerId && !drag.pull) follow(event.clientY, event.timeStamp); };
    const up = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      const { to, from, far, trail, opening, x, y, tip } = drag, { most } = latest.current;
      drag = null;
      if (!live(opening)) return;
      const result = sheetRelease({ from, to, far, trail, at: event.timeStamp, most, cancelled: event.type !== "pointerup" });
      if (result.kind === "cancel") { setHeld(null); return; }
      // Tapped, it stays as it was; tapped on what says how it is sized, it says so, over where it was tapped.
      if (result.kind === "tap") { setHeld(null); if (tip) { const box = sheet.getBoundingClientRect(); setHint({ x: x - box.left, y: y - box.top }); } return; }
      // Held where it was released, so closing begins from that rendered height.
      if (result.kind === "close") { latest.current.onLetGo(); return; }
      saveHeight(result.height);
      rest(to!, result.height);
    };
    // A finger anywhere else in it, from the top of what it shows, once it goes down (sheet-press decides that), is the
    // grip's hand from where it was pressed: it sizes the conversation and lets it go as the grip does (follow, up). Only a
    // press sheet-press ends on its own (a second finger, the browser taking it) is the hand's to cancel here.
    const stopPull = listenSheetPress(sheet, (event, target) => {
      if (drag || !latest.current.expanded || target.closest("[data-card-grab]") || !pullsFrom(event, target, sheet)) return null;
      const id = event.pointerId, x = event.clientX, y = event.clientY, at = event.timeStamp;
      return { capture: sheet, press: { pull: true, take: () => {
        begin(id, x, y, at, true);
        return {
          follow: (rise, when) => { if (drag?.id === id) follow(y - rise, when); },
          release: (speed) => { if (speed === undefined && drag?.id === id) { drag = null; setHeld(null); } },
        };
      } } };
    });
    sheet.addEventListener("pointerdown", down); sheet.addEventListener("pointermove", move);
    sheet.addEventListener("pointerup", up); sheet.addEventListener("pointercancel", up);
    return () => {
      stopPull();
      settling.current?.cancel();
      sheet.removeEventListener("pointerdown", down); sheet.removeEventListener("pointermove", move);
      sheet.removeEventListener("pointerup", up); sheet.removeEventListener("pointercancel", up);
    };
  }, []);
  // The room is also held by the style itself, so the keyboard coming up never shows it taller than the room for a frame.
  // The height it rests at is published for what keeps room under it (the coordinator's dock), which follows that, not
  // each height the hand draws.
  return <div ref={own} {...props} data-sheet-sizing={held !== null || undefined} data-sheet-rest={resting}
    style={{ ...style, bottom: below, height: cap(height), maxHeight: room, opacity: held !== null && height < floor ? Math.max(0.2, height / floor) : undefined }}
    className={cn("fixed inset-x-0 flex flex-col overflow-hidden", className)}>
    <div role="separator" aria-orientation="horizontal" aria-label={label} aria-valuenow={height} aria-valuemin={Math.min(LEAST, most)} aria-valuemax={most}
      tabIndex={0} data-card-grab data-sheet-grip data-sheet-handle
      onKeyDown={event => {
        const sign = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
        if (!sign) return;
        event.preventDefault(); saveHeight(within(own.current!.offsetHeight + sign * STEP));
      }}
      className="group/grip absolute top-0 left-1/2 z-20 grid h-(--pane-head,1.25rem) w-40 -translate-x-1/2 cursor-ns-resize touch-none place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink">
      <i aria-hidden="true" className="h-1 w-9 rounded-full bg-lit-line group-hover/grip:bg-muted group-focus-visible/grip:bg-muted" />
    </div>
    {children}
    {/* The tip's look is the app's (PopoverContent, as the list's time tip); it takes no focus from what has it. */}
    <Popover open={hint !== null} onOpenChange={open => { if (!open) setHint(null); }}>
      <PopoverAnchor asChild><span aria-hidden="true" className="pointer-events-none absolute size-0" style={hint ? { left: hint.x, top: hint.y } : undefined} /></PopoverAnchor>
      <PopoverContent data-sheet-hint role="status" side="top" align="center" sideOffset={26} collisionPadding={16}
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        className="pointer-events-none w-auto max-w-72 px-3 py-2 text-sm whitespace-pre-line">{t("coordinatorCard.sheetHint")}</PopoverContent>
    </Popover>
  </div>;
});
