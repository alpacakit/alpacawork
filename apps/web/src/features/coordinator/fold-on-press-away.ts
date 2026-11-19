import { useEffect, useRef } from "react";
import { ESCAPE_LAYER, escapeLayerOver } from "@/lib/escape-layer";
import { LONG_PRESS_MS, SLOP_PX } from "@/lib/long-press";
import { useConversation } from "./coordinator";
import { INPUT_OWN, OVER_FOOT } from "./foot";

/** Where words are selected in a node's document (nothing when none are): its ends, not its words, which recur. */
type Selected = Pick<Selection, "anchorNode" | "anchorOffset" | "focusNode" | "focusOffset"> | null;
function selected(target: EventTarget | null): Selected {
  const selection = target instanceof Node ? (target.ownerDocument ?? document).getSelection() : null;
  return selection && !selection.isCollapsed ? { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode, focusOffset: selection.focusOffset } : null;
}
/** What the browser runs its own controls on, taking a finger's tap without the mouse events that follow it elsewhere. */
const BROWSER_CONTROLS = "video[controls], audio[controls]";
const sameSelection = (one: Selected, other: Selected) => !!one && !!other && one.anchorNode === other.anchorNode
  && one.anchorOffset === other.anchorOffset && one.focusNode === other.focusNode && one.focusOffset === other.focusOffset;

/**
 * A tap on what the coordinator stands over (a list, a task's report) is a wish to see it: the coordinator goes one
 * step down, as Esc takes it (`away`): the conversation open, it folds and the input under it stays as it is (its
 * words, files, task, sending and recording); folded, the input goes down to its one line with its words kept. The
 * tap goes on to what it is on, as it would without the coordinator (nothing is laid over the screen to catch it).
 * Only a tap counts: let go where it was pressed, soon, by the one finger or the mouse's main button, not taken by the
 * browser meanwhile, and selecting nothing (a short drag over words selects them within a finger's slop). A finger
 * that scrolls, swipes or pulls, a press held to select words, a key's click, and a press that starts in the
 * conversation or the input (or in what they open, which is a surface over the coordinator and takes the press first,
 * as it takes Esc), a press on what stands over its foot (OVER_FOOT: the conversation's notice), on a control of
 * how the input sends (INPUT_OWN: the reader's pin, outside it on a computer), and a press on a toast (its Try again may be the input's own), leave it as it is. `away` is told once the tap's own handlers have run, and whether the tap turned to the
 * coordinator after all (moved it itself, or wrote into the input, as an answer's choice does, on a computer asking for
 * its focus).
 * A finger on what the browser runs its own controls on (a video or a sound with its controls) gets neither the
 * mouse's press nor its click, so the focus would stay in the input and the keyboard up. A tap on the picture is told
 * at its lift; one on the controls' buttons reaches the page as nothing but what it did to the player (it plays,
 * its sound changes), told while the person's gesture is live and the focus is still where words are written. A seek
 * is not heard: a player seeks by itself as it loads (to its first frame), and the browser gives its bar the focus
 * itself. Either way the focus goes to the player, as the browser gives it for the mouse, and the tap is a tap away
 * from there.
 * What opens over the coordinator and closes the same way (the conversation's queue, ThreadQueue) passes its own Esc
 * `layer` (a surface over that one keeps the press) and the document it is drawn in (`at`, its own window too).
 */
export function useFoldOnPressAway(on: boolean, within: (node: Node) => boolean, away: (turned: boolean) => void,
  { layer = ESCAPE_LAYER.coordinator, at = document }: { layer?: number; at?: Document } = {}) {
  const latest = useRef({ within, away });
  latest.current = { within, away };
  useEffect(() => {
    if (!on) return;
    // The press now (or just let go, for its click), and whether it began on what the conversation stands over.
    // A tap waiting for its own handlers to run, watched until then for turning to the input; called, it is let go.
    let pending: (() => void) | undefined;
    const isAway = (target: EventTarget | null) => target instanceof Element && !latest.current.within(target)
      && !target.closest(`${OVER_FOOT}, ${INPUT_OWN}, [data-toaster]`) && !escapeLayerOver(layer, target.ownerDocument);
    let press: { id: number; x: number; y: number; at: number; away: boolean; up: boolean; selected: Selected; kept: HTMLElement | null } | null = null;
    const down = (event: PointerEvent) => {
      // A second finger makes it no tap (a pinch), and its own press is none either.
      if (!event.isPrimary || event.button !== 0) { press = null; return; }
      const target = event.target;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, away: isAway(target), up: false,
        selected: selected(target),
        kept: event.pointerType === "mouse" || !(target instanceof Element) ? null : target.closest<HTMLElement>(BROWSER_CONTROLS) };
    };
    const move = (event: PointerEvent) => {
      if (press?.id === event.pointerId && !press.up && Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP_PX) press = null;
    };
    const up = (event: PointerEvent) => {
      if (press?.id !== event.pointerId) return;
      press.up = true;
      const was = press;
      if (!was.kept || !tapped(was, event)) return;
      press = null;
      take(was.kept, was.away);
    };
    const take = (player: HTMLElement, tappedAway: boolean) => {
      player.focus({ preventScroll: true });
      if (tappedAway) away();
    };
    const operated = (event: Event) => {
      const player = event.target, writing = at.activeElement;
      if (!(player instanceof HTMLMediaElement) || !player.controls || !navigator.userActivation?.isActive
        || !(writing instanceof HTMLElement) || !(writing.isContentEditable || writing.matches("input, textarea"))) return;
      press = null;
      take(player, isAway(player));
    };
    // The browser took the finger for its own (a scroll, a pull, a zoom).
    const lost = (event: PointerEvent) => { if (press?.id === event.pointerId) press = null; };
    // Let go where it was pressed, soon, selecting nothing new (a selection it found and left alone is not its own).
    const tapped = (was: NonNullable<typeof press>, event: MouseEvent) => {
      if (event.timeStamp - was.at > LONG_PRESS_MS || Math.hypot(event.clientX - was.x, event.clientY - was.y) > SLOP_PX) return false;
      const now = selected(event.target);
      return !now || sameSelection(now, was.selected);
    };
    const click = (event: MouseEvent) => {
      const was = press;
      press = null;
      if (was?.away && was.up && event.detail !== 0 && tapped(was, event)) away();
    };
    const away = () => {
      pending?.();
      let turned = false;
      const watch = useConversation.subscribe((next, before) => {
        if (next.focusRequested && !before.focusRequested || next.written !== before.written || next.open !== before.open || next.expanded !== before.expanded) turned = true;
      });
      const timer = setTimeout(() => { pending?.(); latest.current.away(turned); });
      pending = () => { clearTimeout(timer); watch(); pending = undefined; };
    };
    const listeners = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", lost], ["click", click],
      ["play", operated], ["volumechange", operated]] as const;
    for (const [type, listener] of listeners) at.addEventListener(type, listener as EventListener, { capture: true, passive: true });
    return () => {
      pending?.();
      for (const [type, listener] of listeners) at.removeEventListener(type, listener as EventListener, { capture: true });
    };
  }, [on, layer, at]);
}
