import { createContext, useContext, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { FIRST, frameAt, keptAt, SIDE, SNAP, LEAST_HEIGHT, nearerEdge, reachAcross, tallest, widthWithin, type Edge, type Frame, type Placed, type Pull, type Room } from "./frame";

/* Hallmark · component: the coordinator's frame (moved and sized by hand) · genre: modern-minimal · theme: the app's own tokens
 * states: at rest (nothing over it) · pointed at (the grip on its far side and the edge under the pointer show) · moving
 * (held by its grip or its ground) · sized (an edge held, or the grip's Alt + arrow keys) · let go to fold (its far
 * edge pulled in past half its least: the conversation fades, and folds when let go)
 */

/**
 * What the hand reaches the frame through. The card owns the frame and what is drawn; the hand only says what it asks
 * for (`hold` while it holds, with the side it holds and the width it asks of it; `keep` when it lets go, null for where it
 * first stood; `drop` to give up what it held), from what was drawn when it took hold (`at`: the input, the room, and
 * the whole's top and foot).
 */
export type FrameHand = {
  at: () => { placed: Placed; room: Room; input: number; top: number; foot: number } | null;
  frame: () => Frame;
  hold: (frame: Frame, pull?: Pull | null) => void;
  keep: (frame: Frame | null) => void;
  drop: () => void;
  expanded: () => boolean;
  setExpanded: (expanded: boolean) => void;
};
export const FrameHandContext = createContext<FrameHand | null>(null);

/** Moved further than this, a press on the one line (a button too) is a move, not a press. */
const PRESS = 4;
/** Pulled this far out from the folded input's far edge, the conversation opens to be sized. */
const PULL = 24;

/**
 * The one gesture on the frame at a time: let go (`pointerup`) it is kept; cancelled (`pointercancel`, or the frame
 * going away under it: a phone's width, its own window, the card taken away) what it held is given up, and a
 * conversation it opened is folded again.
 */
let gesture: { cancel: () => void } | null = null;
export const cancelFrameGesture = () => gesture?.cancel();

function follow(view: Window, id: number, move: (event: PointerEvent) => void, done: () => void, undo: () => void) {
  gesture?.cancel();
  const root = document.documentElement;
  const finish = (keep: boolean) => {
    view.removeEventListener("pointermove", onMove); view.removeEventListener("pointerup", onUp); view.removeEventListener("pointercancel", onCancel);
    view.removeEventListener("keydown", onKey, { capture: true });
    root.removeAttribute("data-coordinator-held"); root.removeAttribute("data-coordinator-sizing"); root.removeAttribute("data-coordinator-cursor"); root.style.userSelect = ""; root.style.cursor = "";
    if (gesture === session) gesture = null;
    if (keep) done(); else undo();
  };
  const onMove = (event: PointerEvent) => { if (event.pointerId === id) move(event); };
  const onUp = (event: PointerEvent) => { if (event.pointerId === id) finish(true); };
  const onCancel = (event: PointerEvent) => { if (event.pointerId === id) finish(false); };
  // Esc while it is held gives up what it held, and is that alone (nothing under it takes the key).
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(false); } };
  const session = { cancel: () => finish(false) };
  gesture = session;
  view.addEventListener("pointermove", onMove, { passive: false }); view.addEventListener("pointerup", onUp); view.addEventListener("pointercancel", onCancel);
  view.addEventListener("keydown", onKey, { capture: true });
  // Held, the page says so: the grip or the edge's handle stays shown, its pointer stays wherever the hand goes, and
  // nothing is selected on the way.
  return { hold: (sizing?: Side, cursor?: string) => {
    root.setAttribute("data-coordinator-held", ""); root.style.userSelect = "none";
    if (sizing) root.setAttribute("data-coordinator-sizing", sizing);
    if (cursor) { root.style.cursor = cursor; root.setAttribute("data-coordinator-cursor", ""); }
  } };
}

/** A press that moved the frame is not also a press on what it started on (the one line's own press). */
function swallowClick(view: Window) {
  const stop = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
  view.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => view.removeEventListener("click", stop, { capture: true }), 0);
}

/**
 * What is kept across of `frame`, the hand having left the frame's sides where they were drawn: as it was kept (its side,
 * how far from it, its width), though drawn narrower beside the reader.
 */
const keptAcross = (frame: Frame, { side, x, width }: Frame): Frame => ({ ...frame, side, x, width });

/** The frame drawn at `start` and kept as `was` when the hand took it, moved by dx, dy and held whole inside its room. */
export function moved(hand: FrameHand, start: NonNullable<ReturnType<FrameHand["at"]>>, dx: number, dy: number, was = hand.frame()) {
  const { placed, room } = start;
  const left = Math.max(room.left, Math.min(placed.left + dx, room.right - placed.width));
  // The input stays under the room's top; the conversation open over it, under its reach.
  const by = Math.max(room.top - placed.top, room.reach - start.top, Math.min(dy, room.bottom - start.foot));
  const top = placed.top + by, foot = placed.foot + by;
  // Open, the conversation stays on the side it is on; folded, it will open away from the nearer end.
  const edge = hand.expanded() ? placed.edge : nearerEdge(top, foot, room);
  const frame = frameAt({ left, width: placed.width, top, foot }, room, edge, hand.frame().height);
  // Moved across, it is kept as it is drawn (narrower beside the reader too), so it goes on from under the hand.
  return left === placed.left ? keptAcross(frame, was) : frame;
}

/**
 * Moves the frame with the pointer pressed at `event`, once it has gone `press` px (0: at once). The whole stays in its
 * working room as it goes; let go, the place is kept.
 */
export function moveFrame(hand: FrameHand, event: PointerEvent | ReactPointerEvent, press: number) {
  const start = hand.at(), was = hand.frame(), target = event.target as Element | null;
  if (!start || !target) return;
  const view = target.ownerDocument.defaultView ?? window;
  const x = event.clientX, y = event.clientY;
  let moving = false;
  const session = follow(view, event.pointerId, (next) => {
    const dx = next.clientX - x, dy = next.clientY - y;
    if (!moving) {
      if (Math.hypot(dx, dy) < press) return;
      moving = true; session.hold(undefined, "grabbing");
    }
    next.preventDefault();
    hand.hold(moved(hand, start, dx, dy, was));
  }, () => { if (moving) { hand.keep(hand.frame()); swallowClick(view); } }, () => { if (moving) hand.drop(); });
}

/**
 * Where a press moves the frame: the one line's own press (a button too, so only once moved past PRESS) and its
 * ground, and the ground of the input and of the conversation (`data-frame-ground`: the input's row of moves where none
 * is, the conversation's head line where its ∨ is not). Words, what is written, files, the waiting list and every
 * other control (the line's conversation mark and microphone among them) are not ground.
 */
export function groundPress(target: Element): number | null {
  const control = target.closest("button, a, input, textarea, select, [contenteditable], [role=separator]");
  if (target.closest("[data-coordinator-capsule]")) return !control || control.hasAttribute("data-coordinator-write") ? PRESS : null;
  if (target.hasAttribute("data-frame-ground-self")) return 0;
  return target.closest("[data-frame-ground]") && !control ? 0 : null;
}

/** The frame sized from `start` by a hand that moved dx, dy on `edge`'s side(s); `asked`, the conversation's height it asks. */
export function sized(hand: FrameHand, start: NonNullable<ReturnType<FrameHand["at"]>>, sides: "left" | "right" | null, far: boolean, opened: boolean, dx: number, dy: number) {
  const { placed, room } = start;
  let { left, width } = placed;
  // The side held moves; the other stays. Where the side held meets the room it first stands at from that edge (the
  // room it snaps to, SIDE) it stops, never pushing the other side away; within SNAP of it, it goes to it, as a
  // frame put down does, unless that would be wider than the most it can be.
  const most = widthWithin(Infinity, room), reach = reachAcross(placed, room);
  if (sides === "right") {
    width = Math.min(widthWithin(placed.width + dx, room), reach.right - placed.left);
    const snapped = room.right - SIDE - placed.left;
    if (room.right - placed.left - width < SNAP && snapped <= most) width = Math.max(width, snapped);
  }
  if (sides === "left") {
    width = Math.min(widthWithin(placed.width - dx, room), placed.left + placed.width - reach.left);
    const snapped = placed.left + placed.width - room.left - SIDE;
    if (placed.left + placed.width - width - room.left < SNAP && snapped <= most) width = Math.max(width, snapped);
    left = placed.left + placed.width - width;
  }
  // The far edge goes away from the input: up by the foot, down by the top.
  const asked = (opened ? placed.height : 0) + (placed.edge === "bottom" ? -dy : dy);
  const height = far ? Math.max(LEAST_HEIGHT, Math.min(asked, tallest(placed, room))) : hand.frame().height;
  // Sizing never moves it, up and down or across.
  const sizedAt = keptAt({ ...placed, left, width, height }, room, hand.frame());
  const frame = sides ? sizedAt : keptAcross(sizedAt, hand.frame());
  const wanted = sides === "right" ? placed.width + dx : placed.width - dx;
  return { frame, asked, pull: sides ? { side: sides, wanted } : null };
}

/**
 * The grip on the frame's far side: shown where the frame is pointed at (and on a touch screen while the conversation
 * is open, as a sheet's), reached by Tab, held while it moves. It moves the frame by the hand or the arrow keys (shift:
 * further), sizes it by Alt and the arrow keys (across: the width; up and down: the conversation, out from the input
 * opening it), and gives back where it first stood on a double press or Home. The edges are the pointer's alone.
 */
export function FrameGrip({ className, touch }: { className?: string; touch?: boolean }) {
  const { t } = useTranslation("ui");
  const hand = useContext(FrameHandContext)!;
  const key = (event: React.KeyboardEvent) => {
    const start = hand.at();
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (event.key === "Home") { event.preventDefault(); hand.keep(null); return; }
    if (!dir || !start) return;
    event.preventDefault();
    if (!event.altKey) { const by = event.shiftKey ? 64 : 16; hand.keep(moved(hand, start, dir[0]! * by, dir[1]! * by)); return; }
    const by = event.shiftKey ? 96 : 24;
    if (dir[0]) { hand.keep(sized(hand, start, "right", false, hand.expanded(), dir[0] * by, 0).frame); return; }
    const out = (start.placed.edge === "bottom" ? -dir[1]! : dir[1]!) > 0;
    if (!hand.expanded()) { if (out) hand.setExpanded(true); return; }
    hand.keep(sized(hand, start, null, true, true, 0, dir[1]! * by).frame);
  };
  return <button type="button" data-frame-grip aria-label={t("coordinatorCard.move")} title={t("coordinatorCard.moveHint")}
    onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); moveFrame(hand, event, 0); }}
    onDoubleClick={() => hand.keep(null)} onKeyDown={key}
    className={cn("group/grip absolute left-1/2 z-20 grid h-4 w-12 -translate-x-1/2 cursor-grab touch-none place-items-center rounded-full outline-none",
      "opacity-0 transition-opacity duration-150 group-hover/frame:opacity-100 focus-visible:opacity-100 [[data-coordinator-held]_&]:cursor-grabbing [[data-coordinator-held]_&]:opacity-100",
      // An edge pointed at or held shows its own handle; the grip steps back.
      "[:root:has([data-frame-edge]:hover)_&]:opacity-0 [[data-coordinator-sizing]_&]:opacity-0!",
      touch && "pointer-coarse:opacity-100", className)}>
    <span className="h-1 w-9 rounded-full bg-lit-line group-hover/grip:bg-muted group-focus-visible/grip:bg-ink" />
  </button>;
}

type Side = "left" | "right" | "far" | "far-left" | "far-right";
const CURSOR = (side: Side, edge: Edge) => ({ left: "cursor-ew-resize", right: "cursor-ew-resize", far: "cursor-ns-resize",
  "far-left": edge === "bottom" ? "cursor-nwse-resize" : "cursor-nesw-resize", "far-right": edge === "bottom" ? "cursor-nesw-resize" : "cursor-nwse-resize" }[side]);
/**
 * Where each edge's band lies: a strip 8px outside the surface (the room its handle is drawn in) and over its border,
 * so the pointer going from the edge out to the handle stays on the band, and little of what is round it is covered;
 * wider for a finger. A side's band runs from the far corner's curve (the pane's rounding, tokens.css); a corner's
 * band is the rest, round the curve: as far out as a side's and in to where the straight edges start, cut along the
 * pane's curve so nothing inside the surface is covered (CORNER_BAND). Each corner is the top right one turned over
 * (FLIP), so its band and handle are drawn once.
 */
const BAND = (side: Side, edge: Edge) => {
  const far = edge === "bottom" ? "-top-2 pointer-coarse:-top-5" : "-bottom-2 pointer-coarse:-bottom-5";
  // A side's band starts where the far corner's band ends; at the near end, which has no corner handle, it keeps 12px
  // clear, so the folded input's low sides still have room to be taken.
  const along = edge === "bottom" ? "top-(--radius-pane) bottom-3" : "top-3 bottom-(--radius-pane)";
  return {
    left: cn(along, "-left-2 w-2.5 pointer-coarse:-left-5 pointer-coarse:w-5.5"),
    right: cn(along, "-right-2 w-2.5 pointer-coarse:-right-5 pointer-coarse:w-5.5"),
    far: cn(far, "left-(--radius-pane) right-(--radius-pane) h-2.5 pointer-coarse:h-5.5"),
    "far-left": cn(far, "-left-2 pointer-coarse:-left-5", CORNER_BAND, FLIP("far-left", edge)),
    "far-right": cn(far, "-right-2 pointer-coarse:-right-5", CORNER_BAND, FLIP("far-right", edge)),
  }[side];
};
/** A corner's band, drawn as the top right one: its square reaches 8px (20px under a finger) out from both edges and
 * the pane's rounding in, and is cut along the pane's curve, whose centre is the square's bottom left corner. */
const CORNER_BAND = "size-(--corner) [--edge-out:8px] pointer-coarse:[--edge-out:20px] [--corner:calc(var(--radius-pane)+var(--edge-out))] " +
  "[clip-path:polygon(0_0,100%_0,100%_100%,var(--radius-pane)_100%,calc(var(--radius-pane)*0.9659)_calc(100%-var(--radius-pane)*0.2588),calc(var(--radius-pane)*0.866)_calc(100%-var(--radius-pane)*0.5),calc(var(--radius-pane)*0.7071)_calc(100%-var(--radius-pane)*0.7071),calc(var(--radius-pane)*0.5)_calc(100%-var(--radius-pane)*0.866),calc(var(--radius-pane)*0.2588)_calc(100%-var(--radius-pane)*0.9659),0_calc(100%-var(--radius-pane)))]";
/** The other corners are the top right one turned over: across for a left corner, upside down for the bottom ones. */
const FLIP = (side: "far-left" | "far-right", edge: Edge) => cn(side === "far-left" && "-scale-x-100", edge === "top" && "-scale-y-100");
/**
 * The handle each edge shows outside the frame when it is pointed at, and holds while it is held: in the middle of the
 * edge, a short, thin, quiet bar 4px off a side or the far edge (across it for the far edge); round a corner, the same
 * stroke as an arc as far off the frame, about the corner's own centre (the pane's rounding plus that distance), so it
 * follows the corner. Thin to the eye; what the hand takes is the whole band. The frame has one edge of each
 * side (its outline, round the input and the conversation as one), so one handle at a time.
 */
const HANDLE = (side: Side, edge: Edge) => {
  const farSide = edge === "bottom" ? "top-px pointer-coarse:top-3" : "bottom-px pointer-coarse:bottom-3";
  return {
    left: "left-px top-1/2 h-14 max-h-full w-[3px] -translate-y-1/2 rounded-full pointer-coarse:left-3",
    right: "right-px top-1/2 h-14 max-h-full w-[3px] -translate-y-1/2 rounded-full pointer-coarse:right-3",
    far: cn(farSide, "left-1/2 h-[3px] w-14 max-w-full -translate-x-1/2 rounded-full"),
    "far-left": ARC,
    "far-right": ARC,
  }[side];
};
/** A corner's arc, drawn in the top right band (turned over with it): a quarter circle as wide as the pane's rounding
 * and the 7px (8px under a finger) the handle stands off the frame, its centre the corner's; only its middle 50° shows,
 * its ends softened as a bar's round ends are. */
const ARC = "top-px right-px pointer-coarse:top-3 pointer-coarse:right-3 size-(--arc) rounded-tr-(--arc) border-t-3 border-r-3 bg-transparent! border-muted/45 " +
  "[--arc:calc(var(--radius-pane)+7px)] pointer-coarse:[--arc:calc(var(--radius-pane)+8px)] " +
  "[mask-image:conic-gradient(at_0%_100%,transparent_18deg,#000_22deg_68deg,transparent_72deg)]";
/** Held, an edge's handle stays shown on whichever surface has that edge now (pulled open, it is the conversation's). */
const SIZING: Record<Side, string> = {
  left: "[[data-coordinator-sizing=left]_&]:opacity-100 [[data-coordinator-sizing=left]_&]:visible!",
  right: "[[data-coordinator-sizing=right]_&]:opacity-100 [[data-coordinator-sizing=right]_&]:visible!",
  far: "[[data-coordinator-sizing=far]_&]:opacity-100 [[data-coordinator-sizing=far]_&]:visible!",
  "far-left": "[[data-coordinator-sizing=far-left]_&]:opacity-100 [[data-coordinator-sizing=far-left]_&]:visible!",
  "far-right": "[[data-coordinator-sizing=far-right]_&]:opacity-100 [[data-coordinator-sizing=far-right]_&]:visible!",
};

/**
 * An edge the frame is sized by. The sides size the input and the conversation together (the other side stays); the
 * far edge (away from the end it stands by) is the conversation's: held while it is open it sizes it, pulled in past
 * half its least it folds when let go, and pulled out from the folded input it opens it to the height the hand gives.
 * A corner is a side and the far edge. A side pulled past the frame's widest gives a little and goes back when let go
 * (frame.ts). A double press gives its first size back. Nothing shows until it is pointed at; the keys size it by the
 * grip.
 */
export function FrameEdge({ side, edge }: { side: Side; edge: Edge }) {
  const hand = useContext(FrameHandContext)!;
  const sides = side === "far" ? null : side.endsWith("left") ? "left" : "right";
  const far = side.startsWith("far");
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = hand.at();
    if (event.button !== 0 || !start) return;
    event.preventDefault(); event.stopPropagation();
    // Followed on the window, not the edge: pulled open from folded, the conversation's edge takes this one's place.
    const view = event.currentTarget.ownerDocument.defaultView ?? window, x = event.clientX, y = event.clientY;
    const wasOpen = hand.expanded(), kept = hand.frame();
    const panel = () => document.querySelector<HTMLElement>("[data-coordinator-panel]");
    let letGo = false;
    const session = follow(view, event.pointerId, (next) => {
      const now = sized(hand, start, sides, far, wasOpen, next.clientX - x, next.clientY - y);
      if (far && !wasOpen && !hand.expanded() && now.asked >= PULL) hand.setExpanded(true);
      letGo = far && wasOpen && now.asked < LEAST_HEIGHT / 2;
      panel()?.toggleAttribute("data-frame-let-go", letGo);
      if (!far || wasOpen || hand.expanded()) hand.hold(now.frame, now.pull);
    }, () => {
      panel()?.removeAttribute("data-frame-let-go");
      // Folded by letting go, it keeps the height it had, to open at again.
      hand.keep(letGo ? { ...hand.frame(), height: kept.height } : hand.frame());
      if (letGo) hand.setExpanded(false);
    }, () => {
      panel()?.removeAttribute("data-frame-let-go");
      hand.drop();
      if (hand.expanded() !== wasOpen) hand.setExpanded(wasOpen);
    });
    session.hold(side, getComputedStyle(event.currentTarget).cursor);
  };
  // Pointed at a while, the browser's own small note names what it does (as the grip's does).
  const { t } = useTranslation("ui");
  return <div aria-hidden data-frame-edge={side} title={t(far && sides ? "coordinatorCard.resizeBoth" : far ? "coordinatorCard.resizeHeight" : "coordinatorCard.resizeWidth")}
    onPointerDown={onPointerDown}
    onDoubleClick={() => hand.keep({ ...hand.frame(), ...(sides ? { width: FIRST.width } : {}), ...(far ? { height: FIRST.height } : {}) })}
    className={cn("group/edge pointer-events-auto absolute z-30 touch-none", CURSOR(side, edge), BAND(side, edge))}>
    {/* While an edge is held, only its handle shows: another edge pointed at on the way does not light. */}
    <span data-frame-handle className={cn("pointer-events-none absolute bg-muted/45 opacity-0 transition-opacity duration-100 group-hover/edge:opacity-100 [[data-coordinator-sizing]_&]:invisible",
      HANDLE(side, edge), SIZING[side])} />
  </div>;
}
