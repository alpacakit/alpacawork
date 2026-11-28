import { cn } from "@/lib/utils";
import { duration, easing, reducedMotion, stillCopy } from "@/lib/motion";
import { unnameReader } from "./reader-copy";
import type { Answer } from "./next-question";
import { stampInk, stampPaper, stampWords } from "./stamp";

/** Where the answered card leaves for, as x and y in its own sizes and a turn in degrees. */
const AWAY: Record<Answer, [number, number, number]> = { send: [1.15, -0.08, 16], done: [1.15, -0.08, 16], stop: [0, 1.1, 5], hold: [-1.15, 0.15, -12] };

/** A stamped copy still holding: `leave` sends it off now. */
export type Flight = { leave: (forward: boolean) => void; untilLeaving: () => number };
/** The one stamped copy that has not yet started to leave: stamping another sends it off at once. */
let holding: Flight | null = null;

/**
 * The answered card is copied where it stands, stamped, and held still until the stamp's words are read: it is pressed
 * on (stamp), stays for --motion-read, and only then is the copy flung off the way the answer went (fling), while the
 * real reader under it already shows the next card, which comes forward from the deck as the copy goes (styles.css,
 * Stamp). Every way of answering leaves through here, so the words are always shown for the same time and in the same
 * rhythm; nothing waits on delivery. The submission was saved locally before this copy was made. A
 * card whose stamp was previewed with the finger goes on at once from that release pose, at the finger's speed. With reduced motion the stamp fades in, holds the same, and the copy fades. The copy
 * is decoration: it takes no input and removes itself; while it holds, it keeps presses from reaching the next card it
 * covers: a second click of the same button does nothing, and a press after the stamp has landed, or a key outside a
 * field, sends the copy off at once.
 * Returns the hold, to cut short (`leave`: the card was left, `forward` false).
 */
let flights = 0;
/** Whether an answered card's copy is on the page now, held or flying: the reader has already shown it leaving. */
export const cardFlying = () => flights > 0;

/**
 * The finger's speed (px/ms) as it let go of the card it carries, or undefined when no finger carries it (swipe-answer
 * writes it in `data-carried`). Captured when submission starts, before the gesture releases the live panel's pose.
 */
export const departureRelease = () => {
  const speed = document.querySelector('aside[data-reader-mode][data-carried]')?.getAttribute('data-carried');
  return speed == null ? undefined : Number(speed) || 0;
};

/** `letGo`: the finger's speed as it let go of a card it carried (departureRelease); a card let go is not held. */
export function flyAway(answer: Answer, stamp: string, letGo?: number): Flight | null {
  const previewed = letGo !== undefined;
  const card = document.querySelector<HTMLElement>("aside[data-reader-mode]");
  if (!card) return null;
  holding?.leave(false);
  if (document.visibilityState === 'hidden') return null;
  const style = getComputedStyle(card);
  const transform = style.transform || "none";
  const width = card.offsetWidth, height = card.offsetHeight;
  // The phone's sheet is a positioned ancestor. Convert the transformed card to viewport coordinates before
  // placing its decorative copy in body; offsetTop/Left belong to that ancestor, not to the screen.
  const rect = card.getBoundingClientRect();
  const [ox, oy] = (style.transformOrigin || "0 0").split(" ").map(Number.parseFloat);
  const matrix = transform === "none" ? null : new DOMMatrix(transform);
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) =>
    matrix ? new DOMPoint(x! - ox!, y! - oy!).matrixTransform(matrix) : { x: x! - ox!, y: y! - oy! });
  // Where it is laid out: the drawn box without its transform, nor its own translate (a card still coming in from the
  // side), which the copy keeps as it was drawn and lets go of as it arrives.
  const [tx = 0, ty = 0] = style.translate === "none" ? [] : style.translate.split(" ").map(Number.parseFloat);
  const box = { left: rect.left - Math.min(...corners.map(p => p.x + ox!)) - tx,
    top: rect.top - Math.min(...corners.map(p => p.y + oy!)) - ty, width, height };
  // Copied as it is seen, what was still moving in it (its column coming into place) held where it was.
  const { copy: ghost, place } = stillCopy(card);
  unnameReader(ghost);
  ghost.setAttribute("data-flying-card", answer);
  Object.assign(ghost.style, { position: "fixed", inset: "auto", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`,
    height: `${box.height}px`, margin: "0", transform, transition: "none", borderRadius: style.borderRadius, borderColor: style.borderColor, boxShadow: style.boxShadow, zIndex: "var(--layer-flying-card)", transformOrigin: style.transformOrigin });
  const mark = document.createElement("div");
  mark.setAttribute("data-stamp", "");
  // The same paper and operation ink as the swipe preview (stamp.ts).
  mark.className = cn("absolute top-[34%] left-1/2 z-50", stampInk[answer], stampPaper);
  const words = document.createElement("span");
  words.className = stampWords;
  words.textContent = stamp;
  mark.append(words);
  ghost.append(mark);
  document.body.append(ghost);
  place();
  flights++;
  // A card still coming in (opened a moment ago) goes on coming in as its copy: from as it was seen to whole and in
  // place, in the time the card had left, so its stamp is read on the whole card and it leaves from there.
  const coming = Math.max(0, ...(card.getAnimations?.() ?? []).map(each => Number(each.effect?.getComputedTiming().endTime ?? 0) - Number(each.currentTime ?? 0))
    .filter(Number.isFinite));
  const arrival = coming > 0 ? ghost.animate([{ opacity: ghost.style.opacity || 1, translate: ghost.style.translate || "none" }, { opacity: 1, translate: "none" }],
    { duration: coming, easing: easing("out"), fill: "forwards" }) : null;
  if (arrival) void arrival.finished.catch(() => {}); // Freezing the arrival cancels its owned animation.
  /** As much of the copy as shows now: what it leaves from, its arrival ended where it is. */
  const shown = () => {
    if (arrival && arrival.playState !== 'finished') {
      // Freeze only the properties this arrival owns. commitStyles can throw after a surface has been detached.
      const drawn = getComputedStyle(ghost);
      ghost.style.opacity = drawn.opacity;
      ghost.style.translate = drawn.translate;
      arrival.cancel();
    }
    const opacity = Number.parseFloat(getComputedStyle(ghost).opacity);
    return Number.isNaN(opacity) ? 1 : opacity;
  };
  // Departure starts at local submission; this hold only makes a button's stamp readable.
  const reduced = reducedMotion();
  const tilt = "translateX(-50%) rotate(-10deg)";
  const land = duration("stamp"), cross = duration("fling");
  mark.style.transform = tilt;
  const landing = mark.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `${tilt} scale(1.6)` }, { opacity: 1, transform: `${tilt} scale(1)` }],
    { duration: land, easing: easing(reduced ? "out" : "stamp"), fill: "both" });
  const hold = previewed ? 0 : land + duration("read"), called = performance.now();
  // Counted on the landing's own time line: a stamp that starts landing late (the next card being drawn first) is
  // still held for the whole read once it has landed; before it starts, all of the hold is still to come. (Something
  // with no time line, such as a test's stand-in, is counted from now.)
  const left = () => landing.startTime === undefined ? hold - (performance.now() - called)
    : landing.startTime === null ? hold : hold - (Number(document.timeline.currentTime) - Number(landing.startTime));
  const shield = hold ? document.createElement("div") : null, landed = () => left() <= hold - land;
  if (shield) {
    shield.setAttribute("aria-hidden", "true");
    Object.assign(shield.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
      zIndex: "var(--layer-flying-card)", touchAction: "none" });
    for (const kind of ["pointerdown", "pointerup", "click", "dblclick", "contextmenu"]) shield.addEventListener(kind, event => {
      event.preventDefault(); event.stopPropagation();
      // A press once the stamp has landed is the person moving on: the copy goes now. One before is the same click again.
      if (kind === "pointerdown" && landed()) handle.leave(true);
    });
    document.body.append(shield);
  }
  // A key that acts (a letter such as H, Space, Enter, Escape, Delete) is not taken by the next card hidden under the
  // stamp: like a press, it sends the copy off once the stamp has landed. Typing in a field, moving the focus (Tab,
  // Shift+Tab) and the browser's own keys go on as they are.
  const key = (event: KeyboardEvent) => {
    const acts = event.key.length === 1 || ["Enter", "Escape", "Backspace", "Delete"].includes(event.key);
    if (!acts || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.target instanceof Element
      && event.target.closest("input, textarea, select, [contenteditable=true], [contenteditable='']")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (landed()) handle.leave(true);
  };
  if (shield) window.addEventListener("keydown", key, true);
  let gone: Animation | null = null, timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let removed = false;
  const visibility = () => { if (document.visibilityState === 'hidden') remove(); };
  /** The stamp's hold ends: the next card takes presses and keys again, whether the copy flies off or is taken away. */
  const release = () => {
    clearTimeout(timer);
    shield?.remove();
    window.removeEventListener("keydown", key, true);
    if (holding === handle) holding = null;
  };
  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(deadline);
    release();
    window.removeEventListener('pagehide', remove);
    document.removeEventListener('visibilitychange', visibility);
    flights--;
    arrival?.cancel(); landing.cancel(); gone?.cancel();
    ghost.remove();
  };
  const end = (animation: Animation) => {
    release();
    gone = animation;
    void animation.finished.then(remove, remove);
  };
  const [x, y, turn] = AWAY[answer];
  const radians = turn * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const endCorners = [[0, 0], [width, 0], [0, height], [width, height]].map(([px, py]) => ({
    x: (px! - ox!) * cos - (py! - oy!) * sin, y: (px! - ox!) * sin + (py! - oy!) * cos }));
  const minX = Math.min(...endCorners.map(p => p.x + ox!)), maxX = Math.max(...endCorners.map(p => p.x + ox!));
  const minY = Math.min(...endCorners.map(p => p.y + oy!));
  const awayX = x > 0 ? Math.max(x * box.width, innerWidth - box.left - minX + 8)
    : x < 0 ? Math.min(x * box.width, -box.left - maxX - 8) : 0;
  const awayY = x === 0 ? Math.max(y * box.height, innerHeight - box.top - minY + 8) : y * box.height;
  const handle: Flight = {
    untilLeaving: () => gone ? 0 : Math.max(0, left()),
    leave(forward: boolean) {
      if (removed || gone) return;
      const from = shown();
      // Let go by a finger, it starts at the finger's speed (the fling curve starts at its mean speed), within fast/2..fling.
      const way = Math.abs(awayX - (matrix?.m41 ?? 0));
      const time = letGo && awayX ? Math.min(cross, Math.max(duration("fast") / 2, way / Math.abs(letGo))) : cross;
      end(ghost.animate(reduced ? [{ opacity: from }, { opacity: 0 }]
        : [{ transform, opacity: from }, { opacity: from, offset: 0.5 }, { transform: `translate(${awayX}px, ${awayY}px) rotate(${turn}deg)`, opacity: 0 }],
        { duration: reduced ? cross : time, easing: easing(reduced ? "out" : "fling"), fill: "forwards" }));
      if (forward && !reduced && card.isConnected) card.animate([{ transform: "translateY(10px) scale(.965)", opacity: 0.85 }, { transform: "none", opacity: 1 }],
        { duration: cross, easing: easing("out"), fill: "backwards" });
    },

  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', remove);
  // Decoration has a bounded lifetime even if its animation is cancelled, paused or never acquires a timeline.
  const recovery = cross + duration('slow');
  const guard = () => {
    clearTimeout(deadline);
    deadline = setTimeout(remove, coming + Math.max(0, left()) + recovery);
  };
  guard();
  // The native landing can acquire its timeline after creation. Its bounded recovery follows the same clock as
  // the hold, rather than collecting a still-readable copy while the hold is legitimately waiting for that landing.
  void landing.ready?.then(() => { if (!removed) guard(); }, remove);
  void landing.finished.catch(remove);
  if (!hold) handle.leave(true);
  else {
    holding = handle;
    const wait = () => { if (removed) return; const rest = left(); if (rest > 0) timer = setTimeout(wait, rest); else handle.leave(true); };
    timer = setTimeout(wait, hold);
  }
  return handle;
}

/** How long until the stamped copy on screen starts to leave (0 when none holds): what follows it waits as long. */
export const untilLeaving = () => holding?.untilLeaving() ?? 0;

/** A resting copy shields the next reader action, including controls outside its panel. A carried swipe holds none. */
export const readerActionsHeld = () => untilLeaving() > 0;
