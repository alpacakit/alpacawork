import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { arise, drawnShape, duration, easing, reducedMotion, reshape, rise, surfaceShape, sink, type Shape } from "@/lib/motion";
import { useDeviceValue } from "@/lib/device-storage";
import { readerEdgeHeld } from "@/state/screen-settings";
import { shownInReader, useViewStore } from "@/state/view-store";
import { analysisSurfaces } from "@/features/analysis/place";
import { useConversation } from "./coordinator";
import { leastHeight } from "./foot";
import { atLargest, atRight, besidePanel, BETWEEN, clearlySmaller, pushedAcross, pushingPanel, ceilingOf, EDGE, FIRST, keptAt, keptFrame, keptWithin, placeFrame, placeMaximized, pulledOut, restoredFrame, smallerFrame, type Frame, type Pull, type Room } from "./frame";
import { cancelFrameGesture, groundPress, moveFrame, type FrameHand } from "./frame-hand";
import { conversationExtent } from "./PhoneSheet";

/**
 * What stands at the foot as the coordinator's input, of the two that take each other's place reshaped: its one line,
 * or its input brought up (the input's frame). The conversation is a surface of its own over it (`arise`, `sink`).
 */
function footSurface(card: HTMLElement | null): { kind: "line" | "input"; element: HTMLElement } | null {
  const element = card?.querySelector<HTMLElement>("[data-coordinator-capsule], [data-composer-frame]");
  return element ? { kind: element.hasAttribute("data-coordinator-capsule") ? "line" : "input", element } : null;
}

/** Publishing an unchanged custom property still needlessly touches its inline declaration. */
function setLength(style: CSSStyleDeclaration, name: string, value: number) {
  const px = `${value}px`;
  if (style.getPropertyValue(name) !== px) style.setProperty(name, px);
}

/**
 * The room the coordinator may cover on a computer (frame.ts): the whole window, the panel at its right edge too,
 * less `ceiling` at the top for the input (the conversation open over it reaches EDGE under the window's top), less the keyboard (what the visual viewport does not show at the foot; not while
 * pinch-zoomed, when the page is the browser's to pan). What of it a frame stands in left of that panel is besidePanel's.
 */
function workingRoom(ceiling: number, widest: number): Room {
  const view = window.visualViewport;
  const seen = view && view.scale <= 1.01 ? Math.min(innerHeight, view.offsetTop + view.height) : innerHeight;
  return { left: 0, right: innerWidth, top: ceiling, reach: EDGE, bottom: seen, widest };
}
/**
 * The panels docked on a computer's page: the reader, a file or diff read beside it (not a still copy leaving), and what
 * a number of the analysis opens (its list of tasks, the share card).
 */
const DOCKED = 'aside[data-reader-mode="docked"], [data-viewer-place="page"]:not([data-still-copy]), aside[data-analysis-panel="docked"]';
/** The panel standing at the window's right edge (atRight), as laid out (not as a move draws it): its left edge and width. */
const docked = () => [...document.querySelectorAll<HTMLElement>(DOCKED)];
const panelAtRight = (panels: HTMLElement[]) => atRight(panels.map(element => ({ element, left: element.offsetLeft })));
/** An element's left edge and width in the window as laid out: without the transforms a move draws it with. */
function laidOutAcross(element: HTMLElement) {
  let left = 0;
  for (let at: HTMLElement | null = element; at; at = at.offsetParent as HTMLElement | null) left += at.offsetLeft;
  return { left, width: element.offsetWidth };
}
/**
 * A docked panel the coordinator stands clear of keeps no room for it at its foot (styles.css): the page's
 * --coordinator-dock is 0 on it. Where the input or the conversation over it reaches across into the panel (a window
 * too narrow for both side by side, besidePanel), it keeps the page's. `across` is null where nothing stands at the
 * foot on a computer, and every panel goes back to the page's.
 */
function clearOf(panels: HTMLElement[], across: { left: number; width: number } | null) {
  // Every panel read before any is written, so one layout serves them all.
  const clear = panels.map(panel => {
    const box = across && laidOutAcross(panel);
    return !!box && (across!.left + across!.width <= box.left || box.left + box.width <= across!.left);
  });
  panels.forEach((panel, at) => clear[at] ? setLength(panel.style, "--coordinator-dock", 0) : panel.style.removeProperty("--coordinator-dock"));
}
/**
 * The coordinator's widest (frame.ts): the reading column at its widest as the style sheet resolves it now (the type
 * size changes it), with the edges of the surface it is read in.
 */
function widestOf(card: HTMLElement): number {
  const column = card.querySelector<HTMLElement>("[data-reading-column]"), surface = footSurface(card)?.element;
  const most = column ? Number.parseFloat(getComputedStyle(column).maxWidth) : Number.NaN;
  if (!Number.isFinite(most)) return Infinity;
  const edges = surface ? getComputedStyle(surface) : null;
  return Math.ceil(most + (edges ? Number.parseFloat(edges.borderLeftWidth) + Number.parseFloat(edges.borderRightWidth) : 0));
}

/**
 * How tall the input `element` is laid out `width` wide (what is written in it wrapped at that width), measured at once:
 * over a glide under way too (an important declaration outranks what an animation draws).
 */
const inputAt = (element: HTMLElement) => (width: number) => {
  const was = element.style.width;
  element.style.setProperty("width", `${width}px`, "important");
  const height = element.getBoundingClientRect().height;
  element.style.width = was;
  return Math.round(height);
};

/**
 * Where the coordinator's surfaces stand: the one owner of what is measured and written for them (placeFoot), of the
 * hand on the frame, and of the conversation coming and going. The frame the hand holds comes from the card, which
 * consumes the draft's focus before anything is measured here.
 */
export function useFramePlacement({ surfaces, frame, setHeld, open, expanded, own, narrow, bar }: {
  surfaces: { card: RefObject<HTMLDivElement | null>; panel: RefObject<HTMLDivElement | null>; outline: RefObject<HTMLDivElement | null>; entrance: RefObject<HTMLDivElement | null> };
  frame: Frame; setHeld: (next: Frame | null) => void; open: boolean; expanded: boolean; own: Window | null; narrow: boolean; bar: number;
}) {
  const { card, panel, outline, entrance } = surfaces;
  const selectedTask = useViewStore(shownInReader);
  // What decides which panels stand docked on the page (Workbench): a file or diff read beside the reader, and the
  // reader taken to the whole window or back.
  const docking = useViewStore((state) => `${state.view !== null}|${state.readerFull}|${analysisSurfaces(state.analysis).length > 0}`);
  const cappedEditor = useRef<HTMLElement | null>(null);
  const frameNow = useRef(frame);
  frameNow.current = frame;
  // The side the hand holds and the width it asks, while it holds it (placeFoot draws how it gives, in the room as it is
  // now); where it was last drawn given way, to go back from when let go; and that going back, while it is under way.
  const holding = useRef(false);
  // The panel at the window's right when last placed (null: none then): the one whose left edge coming in pushes the
  // frame across (pushingPanel), and the one a new panel there takes the place of (what stands left of it glides).
  const panelWas = useRef<{ element: HTMLElement; left: number } | null>(null);
  // The docked panels watched for their size (placeFoot keeps this to those on the page).
  const watched = useRef<HTMLElement[]>([]);
  const pullNow = useRef<Pull | null>(null), gave = useRef<{ left: number; width: number } | null>(null);
  const landing = useRef<{ to: string; moves: Animation[] } | null>(null);
  const endLanding = () => { for (const move of landing.current?.moves ?? []) move.cancel(); landing.current = null; };
  const drawnAt = useRef<ReturnType<FrameHand["at"]>>(null);
  // How far over the screen's foot the input stands, for the conversation to stand clear over it.
  const [footSize, setFootSize] = useState({ height: 0, room: innerHeight });
  // Folded, the conversation sinks away (`sink`) before it is taken away; opened again meanwhile, it stays and rises.
  const [shown, setShown] = useState(expanded);
  if (expanded && !shown) setShown(true);
  // Whether the conversation is drawn as large as the hand could size it (the head's ↗↙ says so), and whether the next
  // frame drawn was asked for by a press (the head's ↗↙ and ↙↗), not followed by the hand: what moves glides there.
  const [maximized, setMaximized] = useState(false);
  const glide = useRef(false);
  // Whether the conversation was in the frame last drawn (placeFoot moves the input from where it was).
  const drawnShown = useRef(shown);
  // The line and input take each other's place from the last rendered shape (or, taken away while it still reshaped,
  // from what it was drawn as as it went), keeping the edge it stands by, the row over it riding on its top. The
  // conversation rises separately.
  const shape = useRef<{ kind: string; element: HTMLElement; shape: Shape } | null>(null);
  useLayoutEffect(() => {
    const now = footSurface(card.current), was = shape.current;
    if (now && was && now.kind !== was.kind)
      reshape(now.element, drawnShape(was.element) ?? was.shape, { anchor: drawnAt.current?.placed.edge === "top" ? "top" : "bottom",
        riders: [entrance.current?.querySelector("[data-coordinator-fold-row]") ?? null] });
  }, [open, expanded, own]);
  useLayoutEffect(() => {
    if (expanded) { arise(panel.current); return; }
    if (!shown) return;
    // Phone sheets depart with the same inert copy as the task sheet.
    if (narrow) { setShown(false); return; }
    // Not cancelled here: opened again on the way, `arise` takes it over from where it is drawn (a cancelled sink never
    // takes the conversation away).
    const move = sink(panel.current);
    if (!move) { setShown(false); return; }
    void move.finished.then(() => setShown(false), () => {});
  }, [expanded]);
  // One owner measures the two actual surfaces and publishes all geometry derived from them. Position-only changes
  // are measured after a committed layout; size changes between commits come from ResizeObserver, not a frame loop.
  const placeFoot = () => {
    const element = card.current, root = document.documentElement.style;
    if (!element || own) {
      cappedEditor.current?.style.removeProperty("--coordinator-editor-room");
      cappedEditor.current = null;
      root.removeProperty("--coordinator-dock");
      clearOf(docked(), null);
      for (const name of ["--coordinator-input-top", "--coordinator-left", "--coordinator-width"]) entrance.current?.style.removeProperty(name);
      panel.current?.style.removeProperty("--coordinator-panel-room");
      drawnAt.current = null;
      shape.current = null;
      return;
    }
    // Both floating faces share one vertical budget. Keep a readable head/close target above
    // them; the input gives up excess height by scrolling its editor, rather than consuming the conversation's room.
    // That room (its head line, h-11 at most, and the room between) is kept whether the conversation is open or not,
    // so opening or folding it never resizes the input, nor the conversation leaving over it; but only out of what is
    // over the input at its least (all it holds as it needs, and one line of its editor), so its words, its files and
    // its controls stay usable however low the screen or large the type. What is over that is its editor's, the one part
    // that scrolls (--coordinator-editor-room): so the input fits without squeezing its other parts, which give way
    // only where the screen has less than its least.
    // The head's fold and the foot's queue/Done occupy separate rows, including on a low screen.
    const head = Math.max(96, 5.5 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
    // The entrance keeps the same measured room while hidden by the open conversation. Opening it therefore
    // changes neither the frame's upper bound nor the input's position. Its actual type size sets that room.
    const notice = entrance.current?.querySelector<HTMLElement>("[data-coordinator-fold-row]");
    if (notice) watch.current?.observe(notice);
    // The row has a CSS height of its own. Its used height is still readable with display:none, keeping
    // hidden controls out of both hit testing and the reader's calculations of what covers its choices.
    const noticeHeight = notice ? notice.getBoundingClientRect().height || Number.parseFloat(getComputedStyle(notice).height) || 0 : 0;
    const surfaceCeiling = ceilingOf(narrow, bar);
    const noticeRoom = noticeHeight ? noticeHeight + BETWEEN : 0;
    // The folded row and the conversation replace each other above the input. Its upper bound keeps the row;
    // the input's height budget reserves the larger of them, rather than charging for both faces at once.
    const ceiling = surfaceCeiling + noticeRoom;
    // On a computer, where the hand put it, held in the working room (frame.ts), is written here and only here: the
    // input's left, width and the end it stands by, then the conversation on its far side. On a phone it is the
    // screen's foot, full width (its classes), with the conversation over it.
    const widest = narrow ? Infinity : widestOf(element);
    // Left of the panel at the window's right as besidePanel has it: where it is drawn, and where the hand moves and sizes it.
    const panels = docked(), right = panelAtRight(panels), whole = narrow ? null : workingRoom(ceiling, widest);
    // Watched as they are now: a panel come or gone (a file opened, the reader to the whole window and back) is measured.
    const observer = watch.current;
    if (observer) {
      const gone = watched.current.filter(each => !panels.includes(each));
      for (const each of gone) observer.unobserve(each);
      clearOf(gone, null);
      for (const each of panels) if (!watched.current.includes(each)) observer.observe(each);
      watched.current = panels;
    }
    // Another panel come to the window's right (a file opened beside the reader, or closed): it glides to its new room
    // as the reader moves across (Reader's moveAcross).
    const was = panelWas.current;
    if (right && was && right.element !== was.element) glide.current = true;
    const roomNow = whole && besidePanel(whole, right);
    // Placed as open while the conversation is drawn, its sinking away too: what leaves stays where it stood.
    const kept = roomNow && placeFrame(frameNow.current, roomNow, element.getBoundingClientRect().height, shown);
    // Pushed by the panel to the room's left (not by the hand), it is kept by the left from now on.
    const pushing = !!right && pushingPanel(readerEdgeHeld.get(), right.left, was?.left);
    panelWas.current = right;
    const across = kept && !holding.current ? pushedAcross(frameNow.current, kept, roomNow, pushing) : null;
    if (across) { keptFrame.set(across); frameNow.current = across; }
    // As large as the hand could size it from where it is drawn, in the room the hand sizes it in (frame.ts).
    setMaximized(!!(kept && shown && atLargest(kept, roomNow!)));
    // Sized by a press, or the conversation come or gone, what moves goes from where it was drawn to where it now is:
    // the input always, the conversation and the outline as they are sized by the press.
    const sheet = panel.current, ring = outline.current;
    const laidOut = (surface: HTMLElement | null) => surface && { left: surface.offsetLeft, width: surface.offsetWidth, top: surface.offsetTop, height: surface.offsetHeight };
    const sized = glide.current;
    const redrawn = sized || drawnShown.current !== shown ? { input: laidOut(element), sheet: sized ? laidOut(sheet) : null, ring: sized ? laidOut(ring) : null } : null;
    glide.current = false; drawnShown.current = shown;
    const placed = kept && pullNow.current ? pulledOut(kept, pullNow.current, roomNow!) : kept;
    const byTop = placed?.edge === "top";
    const at = placed ? { left: `${placed.left}px`, width: `${placed.width}px` } : { left: "", width: "" };
    // Let go past the widest, it goes back to it (the input, the conversation and their outline as one), landing. That
    // ends where it is drawn next otherwise (held again, moved by the keys, the window sized): never drawn on to where it
    // no longer goes.
    const back = !pullNow.current && gave.current && placed ? gave.current : null;
    gave.current = pullNow.current && placed && placed !== kept ? { left: placed.left, width: placed.width } : null;
    const to = `${at.left} ${at.width}`;
    if (landing.current && (back || landing.current.to !== to)) endLanding();
    Object.assign(element.style, at, { top: byTop ? `${placed.top}px` : "", bottom: placed && !byTop ? `${innerHeight - placed.foot}px` : "" });
    const editor = element.querySelector<HTMLElement>('[data-label-editor]');
    if (cappedEditor.current !== editor) cappedEditor.current?.style.removeProperty("--coordinator-editor-room");
    cappedEditor.current = editor;
    // Its one line (no editor) needs all of its own height, wherever it stands.
    const least = editor ? leastHeight(element, editor, part => watch.current?.observe(part)) : narrow ? 0 : element.scrollHeight;
    // The room it grows into: away from the end it stands by.
    const space = byTop ? Math.max(0, roomNow!.bottom - EDGE - placed.top)
      : Math.max(0, innerHeight - surfaceCeiling - (Number.parseFloat(getComputedStyle(element).bottom) || 0));
    const inputRoom = Math.min(space, Math.max(least, space - Math.max(head + BETWEEN, noticeRoom)));
    const maxHeight = `${inputRoom}px`;
    if (element.style.maxHeight !== maxHeight) element.style.maxHeight = maxHeight;
    if (editor) {
      const line = Number.parseFloat(getComputedStyle(editor).minHeight) || 0;
      setLength(editor.style, "--coordinator-editor-room", Math.round(Math.max(line, inputRoom - least + line)));
    }
    const surface = footSurface(element);
    shape.current = surface && { ...surface, shape: surfaceShape(surface.element) };
    // Read the composer edges with the other geometry, before publishing inherited layout variables.
    const box = element.getBoundingClientRect();
    // Across, as laid out (not as a glide under way draws it): what stands over it is placed where it comes to rest.
    const inputBox = laidOutAcross(surface?.element ?? element);
    const foot = Math.max(0, Math.round(innerHeight - box.top));
    const panelBottom = foot + BETWEEN;
    const panelTop = Math.round(box.bottom + BETWEEN);
    // Over the input, a computer's conversation reaches its room's `reach` (over the bar); a phone's sheet stays under the bar.
    const room = Math.max(0, byTop ? roomNow!.bottom - EDGE - panelTop : innerHeight - (roomNow?.reach ?? surfaceCeiling) - panelBottom);
    // Only the phone sheet consumes React geometry. The desktop faces are placed below in this same pass;
    // publishing their animated height to state would redraw the card without placing anything new.
    if (narrow) setFootSize(was => was.height === foot && was.room === room ? was : { height: foot, room });
    // The panel uses its own room above the input; placeFrame's upper bound also reserves the folded row.
    const tall = placed ? Math.min(frameNow.current.height, room) : 0;
    if (placed && sheet) Object.assign(sheet.style, at, { top: byTop ? `${panelTop}px` : "", bottom: byTop ? "" : `${panelBottom}px`, height: `${tall}px` });
    // The conversation's layout edge, independent of the transform temporarily drawing its arrival or departure. It
    // counts while it is open, not while it leaves (sink only draws it going). On a computer it is where it was just
    // placed: its height cap (--coordinator-panel-room) is published only below, so what is laid out now may be short.
    const sheetTop = placed ? (byTop ? panelTop : innerHeight - panelBottom - tall) : sheet?.offsetTop;
    const top = expanded ? sheetTop : undefined;
    if (placed && roomNow) drawnAt.current = { placed: { ...placed, top: Math.round(box.top), foot: Math.round(box.bottom), height: tall }, room: roomNow,
      input: Math.round(box.height), top: Math.round(Math.min(box.top, top ?? Infinity)), foot: Math.round(expanded && byTop ? panelTop + tall : box.bottom) };
    // The frame's outline: the whole of it, input and conversation as one, which its edges and their handles stand round.
    if (placed && ring && drawnAt.current) {
      const { top: from, foot: to } = drawnAt.current;
      Object.assign(ring.style, { left: at.left, width: at.width, top: `${from}px`, height: `${Math.max(0, to - from)}px` });
    }
    if (back && !reducedMotion()) {
      const moves = [element, sheet, ring].filter(surface => !!surface).map(surface =>
        surface.animate([{ left: `${back.left}px`, width: `${back.width}px` }, { left: at.left, width: at.width }], { duration: duration("base"), easing: easing("pop") }));
      const now = landing.current = { to, moves };
      void Promise.all(moves.map(move => move.finished)).then(() => { if (landing.current === now) landing.current = null; }, () => {});
    }
    if (redrawn && placed && drawnAt.current && !reducedMotion()) {
      const glide = { id: "frame-glide", duration: duration("base"), easing: easing("out") };
      // One glide at a time on each surface: a new one takes over from the one under way, whichever properties it moved.
      const glideOn = (surface: HTMLElement, frames: Keyframe[]) => {
        surface.getAnimations().forEach(each => { if (each.id === glide.id) each.cancel(); });
        return surface.animate(frames, glide);
      };
      type Box = { left: number; width: number; top: number; height: number };
      // From the box it was drawn in to the one it now has: by transform alone where only its place changes (a file
      // opened or closed beside the reader, styles.css Light), so nothing is laid out on the way; by its box where its size does.
      const glideFrom = (surface: HTMLElement, was: Box, now: Box) => was.width === now.width && was.height === now.height
        ? glideOn(surface, [{ translate: `${was.left - now.left}px ${was.top - now.top}px` }, { translate: "0 0" }])
        : glideOn(surface, [was, now].map(box => ({ left: `${box.left}px`, width: `${box.width}px`, top: `${box.top}px`, height: `${box.height}px` })));
      // To where they were placed above (not as laid out yet: the conversation's height cap is published below).
      const across = { left: placed.left, width: placed.width }, { top: from, foot: to } = drawnAt.current;
      if (sheet && redrawn.sheet) glideFrom(sheet, redrawn.sheet, { ...across, top: sheetTop!, height: tall });
      if (ring && redrawn.ring) glideFrom(ring, redrawn.ring, { ...across, top: from, height: Math.max(0, to - from) });
      // The input glides across only, as it lands (the conversation is placed from where it is laid out, so nothing may
      // draw it elsewhere up or down); moved up or down, it fades in where it now stands.
      const was = redrawn.input, moved = was && Math.abs(was.top - element.offsetTop) > 2;
      if (was && !moved && was.width === across.width && was.left !== across.left)
        glideOn(element, [{ translate: `${was.left - across.left}px 0` }, { translate: "0 0" }]);
      else if (was && (moved || was.left !== across.left || was.width !== across.width)) glideOn(element, [{ left: `${was.left}px`, width: `${was.width}px`, ...moved && { opacity: 0 } },
        { left: `${across.left}px`, width: `${across.width}px`, ...moved && { opacity: 1 } }]);
    }
    // Finish every geometry read before changing the page's scroll room (which invalidates layout).
    // How much of the screen's foot the coordinator stands over as it rests, where it rests standing on the foot: open,
    // up to its conversation's top; folded, the input and the row over it (the way in, the task's moves). Put higher, it
    // stands over what scrolls as a window does, and the foot is the page's. What scrolls keeps its own gap over it
    // (styles.css). As it rests: on a computer the frame as kept, not as the hand holds it; on a phone the sheet's
    // resting height (PhoneSheet's data-sheet-rest), not the one its grip draws or it glides through. The room is on the
    // page's root, so following every drawn height would restyle the whole page on every frame of a drag, where a
    // phone's task sheet keeps its own room (--sheet-cover) at the height it rests at.
    const resting = keptFrame.get() ?? FIRST;
    const rest = roomNow && (resting === frameNow.current ? kept
      : placeFrame(resting, roomNow, box.height, shown));
    const onFoot = !rest || rest.edge === "bottom" && roomNow!.bottom - rest.foot <= FIRST.y + 16;
    const input = rest ? innerHeight - rest.top : foot;
    const over = !expanded ? 0 : rest ? input + BETWEEN + rest.height : panelBottom + (Number(sheet?.dataset.sheetRest) || 0);
    clearOf(panels, onFoot && placed ? inputBox : null);
    setLength(root, "--coordinator-dock", onFoot ? Math.max(input + (expanded ? 0 : noticeRoom), over) : 0);
    if (entrance.current) setLength(entrance.current.style, "--coordinator-input-top", foot);
    // Only the folded entrance consumes the composer edges; the panel owns its height cap.
    // Keep these changing dimensions off the page root, whose inherited variables reach the whole list.
    if (entrance.current) {
      setLength(entrance.current.style, "--coordinator-left", inputBox.left);
      setLength(entrance.current.style, "--coordinator-width", inputBox.width);
    }
    if (sheet) setLength(sheet.style, "--coordinator-panel-room", room);
  };
  // What the foot is: the conversation open over it or not, its line or its input, in this window or its own. When that
  // changes and what stands over the foot is put somewhere else at once (not carried there by a reshape under way), it
  // rises in where it now stands as the conversation has mostly come or gone: never shown over what is leaving, nor
  // jumping in sight. One rule for opening and folding, the input up and down, its own window and reduced motion.
  const footState = `${open}|${expanded}|${own !== null}`, wasFootState = useRef(footState);
  // The phone sheet's kept height: let go where it then rests, its size does not change, and only this says so.
  const sheetKept = useDeviceValue(conversationExtent);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    const before = root.getPropertyValue("--coordinator-dock");
    placeFoot();
    if (wasFootState.current === footState) return;
    wasFootState.current = footState;
    const after = root.getPropertyValue("--coordinator-dock");
    const moved = after !== before && !(Math.abs(Number.parseFloat(after) - Number.parseFloat(before)) <= 2);
    const surface = footSurface(card.current)?.element;
    if (moved && !(surface && drawnShape(surface))) rise(entrance.current?.querySelector("[data-coordinator-fold-row]") ?? null, duration("base") / 2);
  }, [footState, frame, sheetKept, own, narrow, bar, selectedTask, shown, docking]);
  // What placeFoot measures, watched: the two surfaces and (added as placeFoot reads them) the parts the
  // input's least is made of.
  const watch = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const element = card.current;
    if (!element || own) return;
    const observer = watch.current = new ResizeObserver(placeFoot);
    observer.observe(element); if (panel.current) observer.observe(panel.current);
    // The panels docked beside it bound its working room (watched as placeFoot finds them); the keyboard coming up, its foot.
    watched.current = docked();
    for (const each of watched.current) observer.observe(each);
    addEventListener("resize", placeFoot); window.visualViewport?.addEventListener("resize", placeFoot);
    return () => { observer.disconnect(); watch.current = null; watched.current = []; removeEventListener("resize", placeFoot); window.visualViewport?.removeEventListener("resize", placeFoot); };
    // These values change which elements exist or count, not the dimensions that should trigger a measurement.
  }, [own, shown, expanded, narrow, selectedTask, bar]);
  // The hand on the frame (frame-hand.tsx): it asks, and the frame drawn follows (placeFoot).
  const hand = useMemo<FrameHand>(() => ({
    at: () => drawnAt.current, frame: () => frameNow.current,
    // Whatever the hand does next ends a landing under way: it holds, keeps or gives up the frame as it is.
    hold: (next, pull = null) => { endLanding(); holding.current = true; frameNow.current = next; pullNow.current = pull; setHeld(next); },
    // Kept never past its widest as the room has it now (what it was asked for may be from before: a frame kept wider, a
    // type size changed while it was held). The frame it had, if clearly smaller than its largest (drawn open), is what
    // ↙↗ puts back (restoredFrame).
    keep: next => {
      const at = drawnAt.current, kept = next && at ? keptWithin(next, at.room) : next, was = keptFrame.get();
      endLanding(); holding.current = false;
      if (!was) smallerFrame.remove();
      else if (!at || clearlySmaller(placeFrame(was, at.room, at.input, true), at.room)) smallerFrame.set(was);
      if (kept) keptFrame.set(kept); else keptFrame.remove();
      frameNow.current = kept ?? FIRST; pullNow.current = null; setHeld(null);
    },
    // Given up (Esc, a cancelled press), it is at once where it was: nothing lands from the way it gave.
    drop: () => { endLanding(); holding.current = false; frameNow.current = keptFrame.get() ?? FIRST; pullNow.current = null; gave.current = null; setHeld(null); },
    expanded: () => useConversation.getState().expanded, setExpanded: next => useConversation.getState().setExpanded(next),
  }), []);
  // The head's ↗↙: kept as large as the hand could size it from where it is drawn, as if the hand had pulled it so;
  // ↙↗: always clearly smaller (restoredFrame). Either glides there.
  const toggleMaximized = () => {
    const at = drawnAt.current, element = card.current;
    if (!at || !element) return;
    glide.current = true;
    hand.keep(maximized ? restoredFrame(frameNow.current, smallerFrame.get(), at.room, at.input) : keptAt(placeMaximized(at.placed, at.room, inputAt(element)), at.room, frameNow.current));
  };
  // A press on the ground of either surface (frame-hand.tsx's groundPress) moves it; on a phone it stays at the foot.
  useEffect(() => {
    if (narrow || own) return;
    const press = (event: PointerEvent) => {
      const at = event.button === 0 && event.target instanceof Element ? groundPress(event.target) : null;
      if (at === null) return;
      if (at === 0) event.preventDefault();
      moveFrame(hand, event, at);
    };
    // A double press on the ground (not the one line: that is its own press twice) puts it back where it first stood.
    const back = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-coordinator-capsule]") && groundPress(event.target) === 0) hand.keep(null);
    };
    const held = [card.current, panel.current].filter(surface => !!surface);
    for (const surface of held) { surface.addEventListener("pointerdown", press); surface.addEventListener("dblclick", back); }
    return () => { for (const surface of held) { surface.removeEventListener("pointerdown", press); surface.removeEventListener("dblclick", back); } };
  }, [narrow, own, shown, hand]);
  // What the hand holds is given up when the frame goes from under it: a phone's width, its own window, the card gone.
  useEffect(() => cancelFrameGesture, [narrow, own]);
  useEffect(() => () => {
    cappedEditor.current?.style.removeProperty("--coordinator-editor-room");
    document.documentElement.style.removeProperty("--coordinator-dock");
    clearOf(docked(), null);
  }, []);
  return { shown, footSize, maximized, toggleMaximized, hand };
}
