import { useEffect, useLayoutEffect, useRef, type DependencyList, type RefObject } from "react";
import { continuesDrawing, type DrawingSource } from "./drawing";

/**
 * The motion rules for what script moves: the same steps and curves styles.css names, read from it, so a Web
 * Animation and a class are timed alike and reduced motion changes both in one place.
 */
type Step = "fast" | "base" | "slow" | "tint" | "read" | "stamp" | "fling";
type Curve = "out" | "in" | "in-out" | "pop" | "stamp" | "fling" | "move";

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** A step's length in ms (reduced motion has already shortened it); the built sheet may say it in seconds (".2s"). */
export function duration(step: Step) {
  const value = token(`--motion-${step}`);
  const amount = Number.parseFloat(value) || 0;
  return value.endsWith("ms") || !value.endsWith("s") ? amount : amount * 1000;
}
export const easing = (curve: Curve) => token(`--ease-${curve}`) || "ease";
/** A distance things travel, none under reduced motion (said here too: a script cannot wait for the sheet's rule). */
export const distance = (name: "shift" | "shift-far") => reducedMotion() ? 0 : Number.parseFloat(token(`--motion-${name}`)) || 0;
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** How a jump scrolls: glides, or goes at once under reduced motion (a script's smooth scroll ignores the CSS rule). */
export const scrollMotion = (): ScrollBehavior => reducedMotion() ? "auto" : "smooth";

const canAnimate = (element: Element | null): element is HTMLElement | SVGElement =>
  !!element && typeof element.animate === "function" && !element.ownerDocument.hidden;

/** How much of its colour a tint lays over the element's own ground. */
const TINT = { changed: ["--changed", 15], turn: ["--turn", 22] } as const;
const tints = new WeakMap<Element, Animation>();
/**
 * "This changed here": the element's ground takes a little of the tone, holds it, then lets it go, over --motion-tint.
 * Only the background colour is animated, so a ring or shadow the element has (the selected row's) stays drawn; `ring`
 * also draws the tone 3px round the outside (a reference the reader jumped to, which has no shadow of its own). A
 * second change while it shows starts it again.
 */
export function tint(element: Element | null, tone: keyof typeof TINT, ring = false) {
  if (!canAnimate(element)) return;
  tints.get(element)?.cancel();
  const [name, share] = TINT[tone];
  const ground = getComputedStyle(element).backgroundColor;
  const colour = `color-mix(in oklch, var(${name}) ${share}%, ${ground})`;
  const off: Keyframe = { backgroundColor: ground, ...ring && { boxShadow: "0 0 0 3px transparent" } };
  const on: Keyframe = { backgroundColor: colour, ...ring && { boxShadow: `0 0 0 3px ${colour}` } };
  const total = duration("tint");
  const animation = element.animate([off, { ...on, offset: Math.min(0.5, duration("fast") / total) }, { ...on, offset: 0.6 }, off],
    { duration: total, easing: "linear" });
  tints.set(element, animation);
  void animation.finished.then(() => tints.delete(element), () => {});
}

/** The value each tinted thing was last drawn with, kept past its element: a row moved to another group is drawn anew. */
type Drawing = { value: string; source: DrawingSource };
const lastSeen = new Map<string, Drawing>();
/** Tints the element whenever `key`'s `value` changes after it was first drawn (a task saved or reported on elsewhere). */
export function useTint(element: RefObject<Element | null>, key: string, value: string, source: DrawingSource) {
  const seen = useRef<{ key: string; drawing: Drawing } | null>(null);
  useEffect(() => {
    const scoped = JSON.stringify([source.root, key]);
    // Each mounted copy observes its own changes; the shared memory is only for a row mounted anew.
    const was = seen.current?.key === scoped ? seen.current.drawing : lastSeen.get(scoped);
    const drawing = { value, source };
    seen.current = { key: scoped, drawing };
    lastSeen.set(scoped, drawing);
    if (was && was.value !== value && continuesDrawing(was.source, source)) tint(element.current, "changed");
  }, [element, key, value, source.root, source.restoredAt]);
}

/** When the page was opened: what happened before it is not new to the eye, whatever the server says. */
const opened = Date.now();
const greeted = new Set<string>();
/**
 * Whether something that happened at `at` has just happened (since the page opened, in the last few seconds) and has
 * not been shown arriving yet. A row scrolled back into view, or redrawn, is not arriving again.
 */
export function justHappened(key: string, at: string | number) {
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!(time >= opened && Date.now() - time < 15_000) || greeted.has(key)) return false;
  greeted.add(key);
  return true;
}

/** A mark on a time line that just happened: it grows from its point. */
export function arrive(element: SVGElement | HTMLElement | null) {
  if (!canAnimate(element)) return;
  element.animate([{ opacity: 0, scale: reducedMotion() ? 1 : 0.4 }, { opacity: 1, scale: 1 }],
    { duration: duration("base"), easing: easing(reducedMotion() ? "out" : "pop") });
}

/**
 * A surface rising into place after `delay` ms (animate-rise, for what comes in later than it is drawn); reduced motion
 * only fades it in. Risen again before it has finished, it starts again (one rise at a time).
 */
const rising = new WeakMap<Element, Animation>();
export function rise(element: Element | null, delay = 0) {
  if (!canAnimate(element)) return;
  rising.get(element)?.cancel();
  const shift = distance("shift");
  rising.set(element, element.animate(shift ? [{ opacity: 0, translate: `0 ${shift}px` }, { opacity: 1, translate: "0 0" }] : [{ opacity: 0 }, { opacity: 1 }],
    { duration: duration(shift ? "base" : "fast"), delay, easing: easing("out"), fill: "both" }));
}

/**
 * A still copy of `element` as it is drawn now, scrolled where it is, for what is gone from the page as it moves: a
 * picture of it. What is on its way somewhere (a fade, a move, a placeholder coming in, another copy fading) is held
 * where it is seen now, and nothing in it moves by the sheet's rules (styles.css). It keeps what draws it (its classes
 * and styles, the attributes the style sheets select on) and nothing that finds it (no ids, no other data-* marks, a
 * plain div at its root), so whatever looks for the original, a script or a check, finds the original alone. No
 * frames or players in it, nothing pressable, unseen by assistive technology. The caller places it.
 * Only what is seen is copied whole: what a scroller in it holds a screen or more past where it is scrolled to, which the
 * copy never shows, stays as its own empty box of the same size, so the copy is laid out and scrolled as the original
 * while a long history is not styled and laid out a second time for one screen of it.
 */
export function stillCopy(element: HTMLElement) {
  const all = [...element.querySelectorAll<HTMLElement>("*")];
  const scrolled = all.filter((each) => each.scrollTop > 0).map((each) => [pathIn(element, each), each.scrollTop] as const);
  const moving = [...new Set((element.getAnimations?.({ subtree: true }) ?? []).map((each) => (each.effect as KeyframeEffect | null)?.target)
    .filter((each): each is Element => each instanceof Element))].map((each) => {
    const drawn = getComputedStyle(each);
    return [pathIn(element, each), { opacity: drawn.opacity, transform: drawn.transform, translate: drawn.translate, scale: drawn.scale }] as const;
  });
  const copy = document.createElement("div");
  for (const { name, value } of element.attributes) copy.setAttribute(name, value);
  const unseen = unseenPast(element, all);
  const holding = holders(unseen);
  copy.append(...[...element.childNodes].map((each) => copySeen(each, unseen, holding)));
  // Found before anything is taken out of it, so each is the one that was scrolled or held.
  const at = (path: number[]) => path.reduce<Element | undefined>((node, index) => node?.children[index], copy);
  const scrolls = scrolled.map(([path, top]) => [at(path), top] as const);
  for (const [path, drawn] of moving) { const each = at(path); if (each instanceof HTMLElement || each instanceof SVGElement) Object.assign(each.style, drawn); }
  const drawing = styledAttributes();
  for (const each of [copy, ...copy.querySelectorAll("*")]) for (const { name } of [...each.attributes])
    if (name === "id" || name.startsWith("data-") && !drawing.has(name)) each.removeAttribute(name);
  // What moves inside it by the sheet's rules (a placeholder's pulse) stands still, rather than start again (styles.css).
  copy.setAttribute("data-still-copy", "");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.style.pointerEvents = "none";
  copy.querySelectorAll("iframe, video, audio").forEach((each) => each.remove());
  // Scrolled as the original only once it is on the page.
  const place = () => { for (const [each, top] of scrolls) if (each instanceof HTMLElement) each.scrollTop = top; };
  return { copy, place };
}
/**
 * What the scrollers among `elements` hold wholly a screen or more past where they are scrolled to, outermost first, each
 * with its laid-out height: a copy never scrolls, so none of it shows. Measured in layout (offsets), not as drawn, so a
 * card carried and turned by a finger is measured the same. A screen of margin keeps what draws outside its own box
 * (a rail, a shadow) where it shows. Only boxes stacked one under another (block flow, or a single column of flex
 * items) are left empty, under boxes as wide as what holds them: what a table, grid, flex row or a box sized to its
 * content lays out from all it holds (a column's width from every row) is copied whole, so what shows of it is laid
 * out as before.
 */
function unseenPast(root: HTMLElement, elements: readonly HTMLElement[]) {
  const unseen = new Map<Element, string>();
  for (const scroller of elements) {
    if (scroller.clientHeight <= 0 || scroller.scrollHeight <= scroller.clientHeight + 1) continue;
    const style = getComputedStyle(scroller);
    if (style.overflowY === "visible" || !stacks(style) || !fillsUpTo(root, scroller)) continue;
    const end = scroller.scrollTop + 2 * scroller.clientHeight;
    const top = topIn(scroller);
    // `box` lays out what `parent` holds (itself, or the box around a parent that draws no box of its own).
    const visit = (parent: Element, box: HTMLElement) => {
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement) || unseen.has(child)) continue;
        const drawn = getComputedStyle(child);
        if (drawn.display === "contents") { visit(child, box); continue; }
        if (!stacked(drawn, getComputedStyle(box))) continue;
        const at = top(child);
        if (at === null) continue;
        if (at >= end) unseen.set(child, drawn.height);
        else if (at + child.offsetHeight > end && stacks(drawn) && fills(child, getComputedStyle(box))) visit(child, child);
      }
    };
    visit(scroller, scroller);
  }
  return unseen;
}
/**
 * Every box from `root` down to `box` is stacked in what holds it and fills it, so nothing between takes its width from
 * what `box` holds (a scroller inside a box sized to its content counts in that box's width).
 */
function fillsUpTo(root: HTMLElement, box: HTMLElement) {
  for (let at = box; at !== root;) {
    let around = at.parentElement;
    while (around && around !== root && getComputedStyle(around).display === "contents") around = around.parentElement;
    if (!around) return false;
    const style = getComputedStyle(at), held = getComputedStyle(around);
    if (!stacks(held) || !stacked(style, held) || !fills(at, held)) return false;
    at = around;
  }
  return true;
}
const BLOCK_FLOW = new Set(["block", "flow-root", "list-item"]);
/** A box that stacks what it holds one under another, each as wide as it leaves room for: block flow, or one flex column. */
const stacks = (style: CSSStyleDeclaration) => BLOCK_FLOW.has(style.display)
  || style.display === "flex" && style.flexDirection.startsWith("column") && style.flexWrap === "nowrap";
/** A box stacked in what holds it (`around`, which stacks): in its flow as a block, neither floated nor taken out of it. */
const stacked = (style: CSSStyleDeclaration, around: CSSStyleDeclaration) => style.display !== "none" && style.float === "none"
  && style.position !== "absolute" && style.position !== "fixed" && (around.display === "flex" || !style.display.startsWith("inline"));
/**
 * A box as wide as what holds it (`around`, which stacks) leaves room for, by how its width is set, not by what it holds:
 * no width sized to its content (fit-content, min-content, max-content), and stretched across a flex column (where an
 * auto side margin takes the stretch away). Read from the computed values, not the drawn width, which a box grown to its
 * limit by a long line would match too.
 */
function fills(element: HTMLElement, around: CSSStyleDeclaration) {
  const sizes = element.computedStyleMap?.();
  if (!sizes) return false;
  if (["width", "min-width", "max-width"].some((name) => String(sizes.get(name)).includes("content"))) return false;
  if (around.display !== "flex") return true;
  if (["margin-left", "margin-right"].some((name) => String(sizes.get(name)) === "auto")) return false;
  const self = String(sizes.get("align-self"));
  return ["stretch", "normal"].includes(self === "auto" ? around.alignItems : self);
}
/** Where `element` starts in what `scroller` holds, from the offsets layout gave it; null when it has none (contents, fixed). */
function topIn(scroller: HTMLElement) {
  const base = scroller.offsetParent, known = new Map<Element, number | null>();
  const top = (element: HTMLElement): number | null => {
    if (known.has(element)) return known.get(element)!;
    const parent = element.offsetParent;
    const at = !(parent instanceof HTMLElement) ? null
      : parent === scroller ? element.offsetTop
      : parent === base ? element.offsetTop - scroller.offsetTop - scroller.clientTop
      : scroller.contains(parent) ? (top(parent) === null ? null : top(parent)! + parent.clientTop + element.offsetTop) : null;
    known.set(element, at);
    return at;
  };
  return top;
}
/** A deep copy of `node`, but what is unseen as its own empty box, as high as it is laid out (its computed height). */
function copySeen(node: Node, unseen: ReadonlyMap<Element, string>, holding = holders(unseen)): Node {
  const height = node instanceof Element ? unseen.get(node) : undefined;
  if (height !== undefined) {
    const box = node.cloneNode(false) as HTMLElement;
    box.style.height = height;
    return box;
  }
  if (!holding.has(node)) return node.cloneNode(true);
  const copy = node.cloneNode(false);
  for (const child of node.childNodes) copy.appendChild(copySeen(child, unseen, holding));
  return copy;
}
/** Every element with something unseen inside it. */
function holders(unseen: ReadonlyMap<Element, string>) {
  const holding = new Set<Node>();
  for (const each of unseen.keys()) for (let at = each.parentElement; at && !holding.has(at); at = at.parentElement) holding.add(at);
  return holding;
}
const pathIn = (root: Element, node: Element) => {
  const path: number[] = [];
  for (let at: Element | null = node; at && at !== root; at = at.parentElement) path.unshift([...at.parentElement!.children].indexOf(at));
  return path;
};
/** The attributes the page's style sheets select on or draw from (`attr()`: a table cell's floor, TableFrame), read again when a sheet is added. */
let styled: { sheets: number; names: Set<string> } | undefined;
function styledAttributes() {
  if (styled?.sheets === document.styleSheets.length) return styled.names;
  const names = new Set<string>();
  const read = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if ("selectorText" in rule) for (const [, name] of String(rule.selectorText).matchAll(/\[\s*([\w-]+)/g)) names.add(name!.toLowerCase());
      if ("style" in rule) for (const [, name] of String((rule as CSSStyleRule).style.cssText).matchAll(/attr\(\s*([\w-]+)/g)) names.add(name!.toLowerCase());
      if ("cssRules" in rule) read(rule.cssRules as CSSRuleList);
    }
  };
  // A sheet from another origin cannot be read; the page's own are.
  for (const sheet of document.styleSheets) { try { read(sheet.cssRules); } catch { /* unreadable */ } }
  styled = { sheets: document.styleSheets.length, names };
  return names;
}

/** The still copies fading over each surface, newest first; and the move under way on each part that settles. */
const fading = new WeakMap<Element, HTMLElement[]>();
const settling = new WeakMap<Element, Animation>();
/**
 * A surface turning to show something else in the same place (the reader on another task): a still copy of what it
 * showed lies over it and fades away over --motion-base (in-out), so the one dissolves into the other, while what it
 * shows now is there, live and pressable, under it at once. Its `content` (what it holds, under its own head) moves in
 * the same turn, on the same time: the copy's sinks by --motion-shift as it fades, and the live one rises the same way
 * into place as it shows, so the one hands over to the other halfway. Turned again while a copy fades, the new
 * copy goes under the older one, so what is seen never jumps; past two, the oldest (all but gone) goes at once, and the
 * live content starts its move again.
 * Reduced motion: nothing moves; it only fades, at --motion-fast.
 * The copy takes the surface's place among its siblings, so it stands where and as the surface stands; `ready` takes
 * from it what makes it the surface (what finds it, what names it), keeping its look, and what of it should not be
 * seen; `find` gives the copy's own of what a selector finds in the surface (the copy keeps few of the attributes that
 * find things).
 */
export function crossfade(surface: HTMLElement | null, { content, ready }: { content: string; ready: (copy: HTMLElement, find: (selector: string) => HTMLElement | null) => void }) {
  if (!canAnimate(surface)) return;
  const timing = { duration: duration("base"), easing: easing("in-out"), fill: "forwards" } as const;
  const opacity = getComputedStyle(surface).opacity || 1, shift = distance("shift");
  const copy = pinnedCopy(surface, (copy) => surface.after(copy));
  const find = (selector: string) => {
    const live = surface.querySelector(selector);
    const found = live && pathIn(surface, live).reduce<Element | undefined>((node, index) => node?.children[index], copy);
    return found instanceof HTMLElement ? found : null;
  };
  ready(copy, find);
  // The surface's own shadow stays drawn under it: doubled, it would darken and fade back.
  copy.style.boxShadow = "none";
  const copies = [copy, ...fading.get(surface) ?? []];
  for (const old of copies.splice(2)) old.remove();
  fading.set(surface, copies);
  // From as much of it as shows (a reader still coming in shows less).
  const fade = copy.animate([{ opacity }, { opacity: 0 }], timing);
  const left = find(content), live = surface.querySelector<HTMLElement>(content);
  if (shift && left && live) {
    // The copy's from where it was seen (a move it was still making is held in it), the live one afresh: one move each.
    left.animate([{ translate: left.style.translate || "0 0" }, { translate: `0 ${shift}px` }], timing);
    settling.get(live)?.cancel();
    const settle = live.animate([{ translate: `0 ${shift}px` }, { translate: "0 0" }], { ...timing, fill: "none" });
    settling.set(live, settle);
    void settle.finished.then(() => { if (settling.get(live) === settle) settling.delete(live); }, () => {});
  }
  const gone = () => {
    copy.remove();
    const left = fading.get(surface)?.filter((each) => each !== copy) ?? [];
    if (left.length) fading.set(surface, left); else fading.delete(surface);
  };
  void fade.finished.then(gone, gone);
}

/**
 * A panel coming in from the side it lives on (`side`, the reader) or up from below on a phone (`below`): it travels
 * --motion-shift-far over --motion-slow, ease-out, solid by the first half of the way, so it is seen arriving rather than
 * fading (styles.css, Panel).
 */
export function appear(element: HTMLElement | null, from: "side" | "below") {
  if (!canAnimate(element)) return;
  element.animate([{ opacity: 0, translate: offPlace(element, from) }, { opacity: 1, offset: distance("shift-far") ? 0.5 : 1 }, { opacity: 1, translate: "0 0" }],
    { duration: duration("slow"), easing: easing("out") });
}
/** Where a panel comes in from and goes back to: --motion-shift-far toward the screen's edge it stands by (`side`), or down. */
function offPlace(element: HTMLElement, way: "side" | "below") {
  const far = distance("shift-far");
  if (way === "below") return `0 ${far}px`;
  const box = element.getBoundingClientRect();
  return `${box.left + box.width / 2 < innerWidth / 2 ? -far : far}px 0`;
}
/**
 * A still copy of `element` (stillCopy) that, where the element is fixed on the screen, is pinned at the box it is drawn
 * in now: what placed it (the page's --window-fit, data-view-beside) may change under the copy, and a move it was making
 * is held in that box, so the copy moves from there alone. `put` places it among the page's elements.
 */
function pinnedCopy(element: HTMLElement, put: (copy: HTMLElement) => void) {
  const box = element.getBoundingClientRect(), fixed = getComputedStyle(element).position === "fixed";
  const { copy, place } = stillCopy(element);
  if (fixed) Object.assign(copy.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`,
    height: `${box.height}px`, right: "auto", bottom: "auto", margin: "0", transform: "none", translate: "none", scale: "none" });
  put(copy);
  place();
  return copy;
}

/**
 * A panel fixed on the screen going, called as it is closed, before it is taken off the page: a still copy of it, pinned
 * where it is drawn (pinnedCopy), goes the way it came over --motion-base while what comes next is already under it
 * (styles.css, Panel). `side` or `below`: back out the way `appear` brought it, ease-in; `sink`: down as a surface that
 * rose (sink).
 */
export function leave(element: HTMLElement | null, to: "side" | "below" | "sink") {
  if (!canAnimate(element) || !element.isConnected) return;
  const away = to === "sink" ? "" : offPlace(element, to);
  // In the page's frame: what held it (the reader's own frame) may be taken off the page with it.
  const copy = pinnedCopy(element, (copy) => (element.closest("[data-page]") ?? document.body).append(copy));
  const going = to === "sink" ? sink(copy)
    : copy.animate([{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: away }], { duration: duration("base"), easing: easing("in"), fill: "forwards" });
  if (!going) return copy.remove();
  void going.finished.then(() => copy.remove(), () => copy.remove());
}

/**
 * A panel moving to another place on the screen (styles.css, Panel): laid out once where it now stands, it is drawn
 * from where it stood (`fromLeft`, laid out) and glides there over --motion-slow, ease-move, by transform alone, with
 * nothing left on it once it has. While it moves, the page says so (data-panel-moving: what it moves over stays seen
 * until it is over it). With reduced motion it is there at once.
 */
export function moveAcross(element: HTMLElement | null, fromLeft: number) {
  if (!element) return;
  const page = element.closest("[data-page]");
  const landed = () => page?.removeAttribute("data-panel-moving");
  if (!canAnimate(element)) return landed();
  // Turned back on the way, it goes on from where it is drawn: the move under way, off the place it stood.
  const moving = element.getAnimations().filter((each) => each.id === "panel-move");
  const drawn = moving.length ? new DOMMatrixReadOnly(getComputedStyle(element).transform).m41 : 0;
  moving.forEach((each) => each.cancel());
  const by = fromLeft + drawn - element.getBoundingClientRect().left;
  if (reducedMotion() || Math.abs(by) < 1) return landed();
  page?.setAttribute("data-panel-moving", "");
  void element.animate([{ transform: `translateX(${by}px)` }, { transform: "none" }], { id: "panel-move", duration: duration("slow"), easing: easing("move") })
    .finished.then(landed, () => {});
}

/**
 * Reading moved by `by` pixels at once (its scroll position set): what is read glides there from where it stood, on
 * the compositor. A glide still under way goes on from where it is drawn. Nothing moves under reduced motion. `curve`:
 * the one it glides on, a disclosure's (in-out) where something unfolds with it.
 */
export function glideReading(element: HTMLElement, by: number, curve: Curve = "move") {
  if (!canAnimate(element)) return;
  const moving = element.getAnimations().filter((each) => each.id === "reading-glide");
  const drawn = moving.length ? new DOMMatrixReadOnly(getComputedStyle(element).transform).m42 : 0;
  moving.forEach((each) => each.cancel());
  const from = by + drawn;
  if (reducedMotion() || Math.abs(from) < 1) return;
  element.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { id: "reading-glide", duration: duration("base"), easing: easing(curve) });
}

/** What a surface looks like, for the one that takes its place: its height and its corners (top left, top right, bottom
 * right, bottom left), as laid out. */
export type Shape = { height: number; radii: number[] };
export function surfaceShape(element: HTMLElement): Shape {
  const height = element.getBoundingClientRect().height, style = getComputedStyle(element);
  // As drawn: a round end (rounded-full) is half the height, not the huge length it is written as, so it can change smoothly.
  return { height, radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map(value => Math.min(Number.parseFloat(value) || 0, height / 2)) };
}
/** What a surface still reshaping is drawn as now (taken away on the way, too), or null once it is its own shape. */
export const drawnShape = (element: HTMLElement): Shape | null => reshaping.get(element)?.drawn() ?? null;
const corners = (radii: number[]) => radii.map(radius => `${radius}px`).join(" ");

/**
 * A surface taking another's place at the same place (the coordinator's one line, its input): it is laid out as it now
 * is at once, and drawn starting at the height and corners the other had, growing or shrinking to its own over
 * --motion-base (out), so the one seems to become the other. It keeps the edge it is placed by (`anchor`: its foot, or
 * its top when it stands by the screen's top) and its other edge moves; what it holds is where it now is, shown as the
 * moving edge uncovers it, from the first frame (faded in, the surface would show empty as it starts to move, a
 * flicker). Only a clip moves, so the page is laid out once and the compositor draws the way (it goes on smoothly while
 * script runs): the surface's look is lent to a skin behind what it holds, as tall as the taller of the two from the
 * edge it keeps (styles.css `[data-reshaping]`), and the clip shows as much of it as the shape is now. Its shadow,
 * outside the clip, comes with the shape it lands on. What stands on its top (`riders`) rides on that edge as it moves.
 * Reduced motion: it only fades in.
 */
/** The reshape under way on each surface: what it is drawn as now, and ending it, which gives back what it lent at once. */
const reshaping = new WeakMap<HTMLElement, { drawn: () => Shape; stop: () => void }>();
export function reshape(element: HTMLElement | null, from: Shape, { anchor = "bottom", riders = [] }: { anchor?: "top" | "bottom"; riders?: (Element | null)[] } = {}) {
  if (!canAnimate(element)) return;
  // Turned back on the way (the input opened again while it shrinks), it goes on from what it is drawn as (`drawnShape`).
  reshaping.get(element)?.stop();
  if (reducedMotion()) { element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration("fast"), easing: easing("out") }); return; }
  const to = surfaceShape(element), rise = to.height - from.height;
  if (Math.abs(rise) < 2) return;
  const style = element.style, drawn = getComputedStyle(element), position = style.position;
  // The skin stands from the edge kept: the surface is what it is placed from.
  if (drawn.position === "static") style.position = "relative";
  style.setProperty("--reshape-tall", `${Math.max(from.height, to.height)}px`);
  style.setProperty("--reshape-edge", drawn.borderBottomWidth);
  // As round as the less round of the two at each corner: the clip, rounder, draws the corner the shape has now.
  style.setProperty("--reshape-radius", corners(to.radii.map((radius, at) => Math.min(radius, from.radii[at] ?? radius))));
  element.setAttribute("data-reshaping", anchor);
  // The edge that moves, from the other's height to its own (past its own edge while it shrinks, where only the skin is).
  const clip = (by: number, radii: number[]) => `inset(${anchor === "bottom" ? `${by}px 0px 0px` : `0px 0px ${by}px`} round ${corners(radii)})`;
  const timing = { duration: duration("base"), easing: easing("out") };
  const move = element.animate([{ clipPath: clip(rise, from.radii) }, { clipPath: clip(0, to.radii) }], timing);
  // Its top moves only when it keeps its foot.
  const rides = anchor === "bottom" ? riders.filter(canAnimate).map(rider => rider.animate([{ translate: `0 ${rise}px` }, { translate: "0 0" }], timing)) : [];
  const stop = () => {
    if (reshaping.get(element)?.stop !== stop) return;
    reshaping.delete(element);
    move.cancel();
    for (const ride of rides) ride.cancel();
    element.removeAttribute("data-reshaping");
    for (const name of ["--reshape-tall", "--reshape-edge", "--reshape-radius"]) style.removeProperty(name);
    style.position = position;
  };
  const drawnNow = (): Shape => {
    const done = Number(move.effect?.getComputedTiming().progress ?? 1), mix = (a: number, b: number) => a + (b - a) * done;
    return { height: mix(from.height, to.height), radii: to.radii.map((radius, at) => mix(from.radii[at] ?? radius, radius)) };
  };
  reshaping.set(element, { drawn: drawnNow, stop });
  void move.finished.then(stop, stop);
}

/**
 * A surface coming up over what is under it rises a little into place and fades in over --motion-base (out): the
 * coordinator's conversation over its input; the diff into the room the reader leaves, over --motion-slow (`step`)
 * after `delay` (styles.css, Panel); going, it sinks back the same way from wherever it is drawn (in-out) and stays
 * gone until it is taken away. Reduced motion: it only fades.
 */
export function arise(element: HTMLElement | null, { step = "base", delay = 0 }: { step?: "base" | "slow"; delay?: number } = {}) {
  if (!canAnimate(element)) return;
  const far = distance("shift-far");
  // Called back while it sinks, it rises from where it is drawn, not from nothing again.
  const moving = element.getAnimations?.() ?? [], drawn = getComputedStyle(element), going = moving.length > 0;
  // From a height something was drawing it at (a phone sheet settling), it comes back to its own as it rises.
  const sized = going && far && sizing(moving);
  const from: Keyframe = going ? { opacity: drawn.opacity, ...far && { translate: drawn.translate, scale: drawn.scale }, ...sized && { height: drawn.height } }
    : far ? { opacity: 0, translate: `0 ${far}px`, scale: "0.98" } : { opacity: 0 };
  moving.forEach(move => move.cancel());
  const to: Keyframe = far ? { opacity: 1, translate: "0 0", scale: "1", ...sized && { height: getComputedStyle(element).height } } : { opacity: 1 };
  element.animate([from, to], { duration: duration(step), delay, easing: easing("out"), fill: "backwards" });
}
/** Whether any of these moves draws a height: only then does what takes over from them hold one (a size is otherwise set
 * once, by layout, and what moves is what the compositor draws alone). */
const sizing = (moves: Animation[]) => moves.some(move => move.effect instanceof KeyframeEffect && move.effect.getKeyframes().some(frame => "height" in frame));
export function sink(element: HTMLElement | null): Animation | null {
  if (!canAnimate(element)) return null;
  const far = distance("shift-far");
  const drawn = getComputedStyle(element), moving = element.getAnimations();
  // Taken from a height something else was drawing it at (a phone sheet settling), it keeps that height as it goes.
  // Otherwise it moves only what the compositor draws, so it goes smoothly whatever script runs meanwhile.
  const held = sizing(moving) ? { height: drawn.height } : {};
  const from = { opacity: drawn.opacity, translate: drawn.translate, scale: drawn.scale, ...held };
  moving.forEach(move => move.cancel());
  return element.animate(far ? [from, { opacity: 0, translate: `0 ${far}px`, scale: "0.98", ...held }] : [{ opacity: from.opacity }, { opacity: 0 }],
    { duration: duration("base"), easing: easing("in-out"), fill: "forwards" });
}

/** More items than this appearing at once is the view being redrawn (a filter, a group opened), not news. */
const MOST_ARRIVING = 8;
/** A list still filling in after it is first drawn (its later pages, its notices) is settling, not changing. */
const SETTLING_MS = 1000;
/** The keys an item answers to: one, or several for an item standing for several (a group of rows). */
const keysOf = (item: HTMLElement) => item.dataset.motionKey!.split(" ");

/** A list's moves under way, by the keys of what they move: a row drawn anew under a key it had (React made it again)
 * still knows how far it is drawn from its place. `by` is where the move started from its place (it ends at none). */
type Moves = Map<string, { animation: Animation; by: number }>;
/**
 * How far each key's item is drawn from its place now, read from its move's eased progress (0 while it waits, drawn as
 * it starts; none once it is over). Read for every key before anything ends, so a row parting into two, or two joining,
 * each keep what was drawn under their own keys; `stop` then ends every move, so the list is measured where it stands.
 */
const drawnOffs = (moves: Moves, stop: boolean) => {
  const offs = new Map<string, number>();
  for (const [key, { animation, by }] of moves) {
    const over = animation.playState === "finished" || animation.playState === "idle";
    offs.set(key, over ? 0 : by * (1 - (animation.effect?.getComputedTiming().progress ?? 0)));
  }
  if (stop) { for (const { animation } of new Set(moves.values())) animation.cancel(); moves.clear(); }
  return offs;
};
/** A move that waits (`delay`) is drawn as it starts until then: where the item stood, or not yet there. */
const move = (moves: Moves, item: HTMLElement, by: number, keyframes: Keyframe[], timing: KeyframeAnimationOptions) => {
  const animation = item.animate(keyframes, timing);
  const under = { animation, by };
  for (const key of keysOf(item)) moves.set(key, under);
  void animation.finished.then(() => { for (const [key, each] of moves) if (each === under) moves.delete(key); }, () => {});
};
/**
 * How much longer the surface a list stands in is moving (the reader coming in or turning to another task, a sheet
 * rising): a change in the list waits for it, so the one is seen after the other and never both at once.
 */
const surfaceMoving = (root: HTMLElement) => {
  let left = 0;
  for (let at = root.parentElement; at; at = at.parentElement) for (const animation of at.getAnimations?.() ?? []) {
    const { endTime, localTime } = animation.effect?.getComputedTiming() ?? {};
    if (animation.playState === "running" && Number.isFinite(Number(endTime)))
      left = Math.max(left, Number(endTime) - Number(localTime ?? 0));
  }
  return left;
};
/**
 * What a change set going inside the items it moves (a report folding as a newer one opens above it) ends at once: the
 * list's move is that change's one motion. Only what this change set going ends: a transition not yet started (it
 * starts with the frame this change is drawn in). One already under way (a row the reader pressed open or closed) goes
 * on to its end, and the items under it move with it as it does. It says whether anything ended, so the list is
 * measured again.
 */
const endInside = (items: HTMLElement[]) => {
  let ended = false;
  for (const item of items) for (const animation of item.getAnimations?.({ subtree: true }) ?? [])
    if ("transitionProperty" in animation && (animation.pending || animation.startTime === null)) { animation.finish(); ended = true; }
  return ended;
};

/** The id of a reveal: an item's new part shown from its foot down as the item under it makes room. */
const REVEAL = "list-reveal";
/** How much of an item's foot its reveal hides now, as drawn (its clip is `inset(top sides foot)`). */
const clipped = (item: HTMLElement) => {
  const inset = /inset\(([^)]*)\)/.exec(getComputedStyle(item).clipPath)?.[1]?.split(/\s+/);
  return inset ? Number.parseFloat(inset[inset.length >= 3 ? 2 : 0]!) || 0 : 0;
};
/**
 * A reveal's frames, or none when nothing is hidden. Over a move's progress p (the glides' step and curve), the item's
 * foot is drawn `closing * (1 - p) - gap` past the top of the item under it: `closing` is how much further the item is
 * drawn down than that one at the start, and `gap` how far apart the two stand once still. That much of its new part
 * (`grown`, at most) is hidden, and the rest shows.
 */
function revealFrames(closing: number, gap: number, grown: number): Keyframe[] | null {
  const hidden = (p: number) => Math.min(grown, Math.max(0, closing * (1 - p) - gap));
  if (hidden(0) < 1) return null;
  // Where the hidden part stops being all of the new part and where it reaches none, between which it shrinks evenly.
  const turns = closing > 0 ? [1 - (gap + grown) / closing, 1 - gap / closing] : [];
  const offsets = [...new Set([0, ...turns.filter(at => at > 0 && at < 1), 1])].sort((a, b) => a - b);
  return offsets.map(offset => ({ offset, clipPath: `inset(-100vh -100vw ${hidden(offset)}px -100vw)` }));
}
/** The boxes whose height moves by itself inside `at` now: a height transition, or an animation that draws one. */
const heightMoving = (at: Element) => new Set((at.getAnimations?.({ subtree: true }) ?? []).filter(each => each.playState === "running"
  && ("transitionProperty" in each ? each.transitionProperty === "height" : sizing([each])))
  .map(each => (each.effect as KeyframeEffect | null)?.target).filter((box): box is Element => !!box));

/** Where an item stands, from the list's top, and how tall it is; stuck when it is held to the top (sticky). */
type Spot = { top: number; height: number; stuck: boolean };
/** A list's change, as its `news` reads it: whether the list has settled, and the items that were there before it. */
type ListChange = { settled: boolean; stayed: HTMLElement[] };

/**
 * A list whose items change places (a task moving to another group, a report arriving above the others): each item
 * marked `data-motion-key` inside `box` glides from where it was to where it now is, and an item that was not there
 * settles from a little above into where it lands as it fades in; a later change takes over where it is drawn, and the
 * fade runs to its end. An item that is taller than it was drawn (one arriving grew from nothing) shows its new part
 * only where the first item under it that was there has gone by, on the glides' step and curve, so no new words are
 * drawn over old ones however many items arrive or grow at once. A change is each change of `deps`, and each change
 * drawn into the list that adds or takes away an item or redraws one at another height than a box inside it moved it
 * by itself (a row appearing at its top, a row's words growing): either is measured and moves alike. A height moving
 * by itself (a disclosure opening) or the window resizing is taken quietly, as no move. Only a list that asks for it
 * (`watchesDrawing`) watches what is drawn into it: one whose items change without its `deps` saying so (parts that
 * read and draw their own facts, a row above the others appearing, words growing). Watching costs a read of the list
 * on every redraw, so a list whose `deps` say every change of its places does not ask, and moves on `deps` alone.
 * A change is shown moving when it brings news, or once the list has settled; `news` says which arriving items are
 * news (by default any, once settled), and one that is not still appears at once. Nothing moves while the list first
 * fills in, for items out of sight, when many arrive at once, or under reduced motion (arrivals only fade); while the
 * surface the list stands in is still moving, the change waits for it to end.
 * An item may name several keys, space-separated: one standing for several rows (a group of them) is the item that was
 * there under any of them, so rows joining into a group, or a group taking in another row, move rather than arrive.
 * An item marked `data-motion-sticky` (an opened parent's head, first in its row) is placed by its row, and does not
 * move while it is stuck to the top: there it stands still whatever moves under it.
 */
export function useListMotion(box: RefObject<HTMLElement | null>, deps: DependencyList,
  news: (item: HTMLElement, change: ListChange) => boolean = (_, { settled }) => settled,
  reflows: (root: HTMLElement) => boolean = () => true, { watchesDrawing = false }: { watchesDrawing?: boolean } = {}) {
  const spots = useRef<Map<string, Spot> | null>(null);
  const width = useRef(0);
  const drawnAt = useRef(0);
  const decide = useRef(news);
  decide.current = news;
  const reflow = useRef(reflows);
  reflow.current = reflows;
  const moves = useRef<Moves>(new Map()).current;
  // The items still showing their new part, by key: their foot is clipped (`clipShown`) until the item under them passes.
  const reveals = useRef(new Map<string, HTMLElement>()).current;
  const watcher = useRef<MutationObserver | null>(null);
  // The heights of the boxes whose height moved by itself when the list was last measured: what such a box has moved
  // since is its own motion, not a change drawn into the list.
  const boxes = useRef(new Map<Element, number>());
  // What the list holds and where, without moving anything: so a change of size between changes is not read as a move.
  // Places are from the list's top (scrolling moves none), without the part of a move still being drawn.
  const measure = (root: HTMLElement, stop: boolean) => {
    const base = root.getBoundingClientRect().top - root.scrollTop;
    const items = [...root.querySelectorAll<HTMLElement>("[data-motion-key]")];
    const offsets = drawnOffs(moves, stop);
    const now = new Map<string, Spot>();
    for (const item of items) {
      const keys = keysOf(item);
      if (now.has(keys[0]!)) continue;
      // A move under way is under each of its item's keys alike.
      const drawn = item.getBoundingClientRect().top - (stop ? 0 : offsets.get(keys[0]!) ?? 0);
      const flow = item.hasAttribute("data-motion-sticky") ? item.parentElement!.getBoundingClientRect().top : drawn;
      const { height } = item.getBoundingClientRect();
      for (const key of keys) now.set(key, { top: flow - base, height, stuck: Math.abs(drawn - flow) >= 1 });
    }
    if (watchesDrawing) boxes.current = new Map([...heightMoving(root)].map(box => [box, box.getBoundingClientRect().height]));
    return { items, offsets, now, base };
  };
  // One change of what the list holds, from any cause: measured, planned, and shown moving or taken quietly.
  const changed = (root: HTMLElement) => {
    // What has been drawn into the list until now is measured here: the mutations it made are this change, not another.
    watcher.current?.takeRecords();
    // How much of each item still showing its new part is hidden now. Every reveal ends here and is planned again from
    // what is drawn, so none outlives the change: an item that shrank, or a change that moves nothing, keeps no clip.
    const hidden = new Map<string, number>();
    for (const [key, item] of reveals) hidden.set(key, clipped(item));
    for (const item of new Set(reveals.values())) for (const each of item.getAnimations()) if (each.id === REVEAL) each.cancel();
    reveals.clear();
    // A list that does not reflow by motion now (read below its top) moves nothing, so where its items stand is not
    // read: a long list would read every item on every change. Its next change starts afresh, as a first draw does.
    if (!reflow.current(root)) { spots.current = null; return; }
    let { items, offsets, now, base } = measure(root, true);
    const was = spots.current;
    const sameWidth = width.current === root.clientWidth;
    spots.current = now;
    width.current = root.clientWidth;
    // The page's own clock, not the wall clock: it runs on whatever the date says.
    if (!was) drawnAt.current = performance.now();
    if (!was || !sameWidth || !canAnimate(root)) return;
    const change = { settled: performance.now() - drawnAt.current >= SETTLING_MS, stayed: items.filter(item => keysOf(item).some(key => was.has(key))) };
    const seen = (top: number) => top + base > -120 && top + base < window.innerHeight + 120;
    const plan = () => {
      const arriving: HTMLElement[] = [], glides: [HTMLElement, number][] = [], grows: [HTMLElement, number, string][] = [];
      const grow = (item: HTMLElement, by: number) => { if (by >= 1 && by < window.innerHeight) grows.push([item, by, keysOf(item)[0]!]); };
      for (const item of items) {
        // An item standing for several comes from where the first of them that was there was drawn (keys go top down):
        // its place and the part of a move it was drawn off by, both under that one key.
        const keys = keysOf(item), to = now.get(keys[0]!)!, { stuck } = to;
        const key = keys.find(each => was.has(each));
        // Arriving, it grew from nothing: all of it is new, and shows as the items under it make room.
        if (key === undefined) { if (seen(to.top) && decide.current(item, change)) { arriving.push(item); grow(item, to.height); } continue; }
        const from = was.get(key)!;
        const by = from.top + (offsets.get(key) ?? 0) - to.top;
        if (!stuck && !from.stuck && Math.abs(by) >= 1 && Math.abs(by) < window.innerHeight && (seen(from.top) || seen(to.top)))
          glides.push([item, by]);
        // Taller than it is drawn, it shows its new part as the items under it make room, so neither covers the other.
        if (!stuck && seen(to.top)) grow(item, to.height - (from.height - (hidden.get(key) ?? 0)));
      }
      return { arriving, glides, grows };
    };
    let { arriving, glides, grows } = plan();
    if (!change.settled && !arriving.length || arriving.length > MOST_ARRIVING) return;
    // A caller retaining its reading position already compensates reflow through its scrollport.
    const glide = reflow.current(root) && !reducedMotion();
    if (glide && endInside(glides.map(([item]) => item))) {
      // Measured again where the ended changes left them; a move already under way keeps where it was drawn from.
      ({ now, base } = measure(root, true));
      spots.current = now;
      ({ arriving, glides, grows } = plan());
    }
    const wait = surfaceMoving(root);
    // Read the shared tokens before starting any moves: reading style between row writes flushes it for each row.
    const rise = distance("shift");
    const timing: KeyframeAnimationOptions = { duration: duration("base"), delay: wait, easing: easing("out"), fill: "backwards" };
    if (glide) for (const [item, by] of glides) move(moves, item, by, [{ transform: `translateY(${by}px)` }, { transform: "none" }], timing);
    // A new part shows only where the item under it has gone by: the first item below it that was there before (what
    // could be drawn over it) is where its foot is cut, on the glides' own step and curve. With nothing below that was
    // there, nothing can be drawn over it. Only its foot is clipped: what stands out of its sides or top (a mark on the
    // rail) stays drawn.
    if (glide) {
      const shift = new Map<HTMLElement, number>(glides);
      for (const item of arriving) shift.set(item, -rise);
      const stayed = new Set(change.stayed);
      for (const [item, grown, key] of grows) {
        const under = items.slice(items.indexOf(item) + 1).find(each => stayed.has(each) && !item.contains(each));
        if (!under) continue;
        const spot = now.get(key)!, gap = now.get(keysOf(under)[0]!)!.top - (spot.top + spot.height);
        const frames = revealFrames((shift.get(item) ?? 0) - (shift.get(under) ?? 0), gap, grown);
        if (!frames) continue;
        item.animate(frames, { ...timing, id: REVEAL });
        for (const each of keysOf(item)) reveals.set(each, item);
      }
    }
    // Arriving is two facts: it appears, which runs to its end whatever comes next, and it settles from a little above
    // into its place, a move like the glides that a later change takes over from where it is drawn.
    for (const item of arriving) {
      item.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      if (rise) move(moves, item, -rise, [{ transform: `translateY(${-rise}px)` }, { transform: "none" }], timing);
    }
  };
  useLayoutEffect(() => {
    const root = box.current;
    // A list not drawn now (an editor in its place) starts afresh when it is drawn again.
    if (!root) { spots.current = null; return; }
    changed(root);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // In a list that watches what is drawn (`watchesDrawing`), what the list holds changes without a change of `deps` too (a row standing at its top appears, a report's words grow
  // with new facts): a change drawn into the list that moves its items is one change like any other. It moves them when
  // it adds or takes away an item, or changes what holds the items (the list, a day), or leaves an item it redraws
  // another height than it was measured at, past what a box inside it moved by itself meanwhile (that is the motion's).
  // A change the layout effect has already measured is not read again (`changed` takes the records it covers). Read as
  // the change is drawn (a mutation is reported before the frame is
  // painted), so no frame shows the items at their new places before they glide. Only what was drawn counts, each item
  // by itself: words redrawn at the same height read that one item's height and move nothing, and a height moving by
  // itself (a disclosure's transition, words folding as a row opens) or the window resizing redraws nothing, and is
  // taken quietly below. Watched again with `deps`, so a list drawn anew is the one watched.
  useEffect(() => {
    const root = box.current;
    if (!watchesDrawing || !root || typeof MutationObserver === "undefined") return;
    const holdsItems = (node: Node) => node instanceof Element && (node.matches("[data-motion-key]") || !!node.querySelector("[data-motion-key]"));
    // What a box inside it moved by itself since it was measured (a disclosure's transition, words folding) is that
    // motion's; the rest of its change of height is the redraw's. A box moving inside another is counted in that one.
    const resized = (item: HTMLElement) => {
      const spot = spots.current?.get(keysOf(item)[0]!);
      if (!spot) return true;
      const inside = new Set([...heightMoving(item), ...[...boxes.current.keys()].filter(box => item.contains(box))]);
      let own = 0;
      for (const box of inside) if (![...inside].some(other => other !== box && other.contains(box)) && box.isConnected)
        own += box.getBoundingClientRect().height - (boxes.current.get(box) ?? box.getBoundingClientRect().height);
      return Math.abs(item.getBoundingClientRect().height - spot.height - own) >= 0.5;
    };
    const observer = new MutationObserver((records) => {
      const redrawn = new Set<HTMLElement>();
      for (const record of records) {
        const at = record.target instanceof Element ? record.target : record.target.parentElement;
        const item = at?.closest<HTMLElement>("[data-motion-key]");
        if (!item || !root.contains(item) || [...record.addedNodes, ...record.removedNodes].some(holdsItems)) { changed(root); return; }
        redrawn.add(item);
      }
      for (const item of redrawn) if (resized(item)) { changed(root); return; }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    watcher.current = observer;
    return () => { observer.disconnect(); if (watcher.current === observer) watcher.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // A height moving by itself or the window resizing moves items with nothing changed in the list: take their new
  // places quietly. Only a change of height moves them; a wider list (the time strip zoomed) is not measured again.
  useEffect(() => {
    const root = box.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    // The first report of each size only says what it is: the layout effect has just measured the list.
    const heights = new WeakMap<Element, number>();
    const observer = new ResizeObserver((entries) => {
      let taller = false;
      for (const entry of entries) {
        const was = heights.get(entry.target);
        if (was !== undefined && was !== entry.contentRect.height) taller = true;
        heights.set(entry.target, entry.contentRect.height);
      }
      if (taller && spots.current) spots.current = measure(root, false).now;
      width.current = root.clientWidth;
    });
    observer.observe(root);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * The shape a surface growing out of a button shows now: where it is, its corners, and how much of the button's
 * face shows over it. Each open and fold starts from the shape on screen, so a press during one turns it back from
 * where it is, never from the button or the surface at rest.
 */
type GrowShape = { rect: DOMRect; radius: string; face: number };
/** The button's face over each button's surface while it grows (`growOut`), and the fold under way (`growBack`). */
const faces = new WeakMap<Element, HTMLElement>();
const folds = new WeakMap<Element, { ghost: HTMLElement; face: HTMLElement; animation: Animation }>();
const opacityOf = (element: Element | undefined) => element?.isConnected ? Number(getComputedStyle(element).opacity) : 0;

/** The shape `button`'s surface shows now: its fold under way, or `surface` (the open one), or else the button itself. */
export function shapeOf(button: Element, surface?: Element): GrowShape {
  const fold = folds.get(button);
  const shown = fold?.ghost ?? surface;
  if (!shown) { const rect = button.getBoundingClientRect(); return { rect, radius: `${rect.height / 2}px`, face: 1 }; }
  return { rect: shown.getBoundingClientRect(), radius: getComputedStyle(shown).borderRadius, face: opacityOf(fold?.face ?? faces.get(button)) };
}

/** The button drawn again over a surface growing out of it (its face, without what makes it a control), at `at`. */
function faceOf(button: Element, at: DOMRect, parent: Element, origin: DOMRect, opacity: number) {
  const face = parent.ownerDocument.createElement("div");
  face.className = button.className;
  face.innerHTML = button.innerHTML;
  face.setAttribute("aria-hidden", "true");
  Object.assign(face.style, { position: "absolute", left: `${at.left - origin.left}px`, top: `${at.top - origin.top}px`,
    width: `${at.width}px`, height: `${at.height}px`, margin: "0", pointerEvents: "none", opacity: `${opacity}` });
  parent.appendChild(face);
  return face;
}

/** A box as the left, top, width and height it is drawn at, from `origin`'s top left. */
const placed = (rect: DOMRect, origin: DOMRect, borderRadius: string) => ({ left: `${rect.left - origin.left}px`,
  top: `${rect.top - origin.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius });
/** `rect` cut out of `box`: a clip-path that shows only it, with its corners. */
const cutOut = (rect: DOMRect, box: DOMRect, radius: string) =>
  `inset(${rect.top - box.top}px ${box.right - rect.right}px ${box.bottom - rect.bottom}px ${rect.left - box.left}px round ${radius})`;

/**
 * A surface growing out of the button that opened it: from the shape on screen (`shapeOf`: the button, or a fold
 * still under way), it spreads to where it stands over --motion-slow, out, from the corner it shares with the button
 * (Popup places it so). What it holds is laid out where it ends and shown only inside the surface as it spreads (cut
 * out with the surface's own box and corners, in step), fading in as it is uncovered: no word moves or stretches.
 * `surface` is drawn behind `content` and fills its parent once still; the button's face fades as the surface leaves
 * it. Under reduced motion the content only fades in.
 */
export function growOut(surface: HTMLElement, content: HTMLElement, button: Element) {
  const from = shapeOf(button);
  // Opened again while it was still folding back: the fold is over, and the surface goes on from where it was.
  endFold(button);
  if (!canAnimate(surface) || !canAnimate(content)) return;
  if (reducedMotion()) { content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration("fast"), easing: easing("out") }); return; }
  const parent = surface.offsetParent ?? surface.parentElement!;
  // What is placed absolutely is placed from the parent's padding box.
  const outer = parent.getBoundingClientRect();
  const origin = new DOMRect(outer.left + parent.clientLeft, outer.top + parent.clientTop, outer.width, outer.height);
  const to = surface.getBoundingClientRect(), radius = getComputedStyle(surface).borderRadius;
  const timing = { duration: duration("slow"), easing: easing("out") };
  surface.animate([placed(from.rect, origin, from.radius), placed(to, origin, radius)], timing);
  const box = content.getBoundingClientRect();
  content.animate([{ clipPath: cutOut(from.rect, box, from.radius), opacity: 0 }, { opacity: 0, offset: 0.5 },
    { clipPath: cutOut(box, box, radius), opacity: 1 }], timing);
  const face = faceOf(button, button.getBoundingClientRect(), parent, origin, from.face);
  faces.set(button, face);
  // Gone before what the surface holds shows (it would sit over the form's last button).
  void face.animate([{ opacity: from.face }, { opacity: 0 }], { duration: duration("slow") * 0.2 * from.face, easing: easing("out"), fill: "forwards" })
    .finished.then(() => face.remove(), () => face.remove());
}

/** Ends `button`'s fold now, if it is folding: its surface goes and the button shows again. */
function endFold(button: Element) {
  const fold = folds.get(button);
  if (!fold) return;
  folds.delete(button);
  fold.animation.cancel();
  fold.ghost.remove();
  (button as HTMLElement).style.opacity = "";
}

/**
 * The reverse, once the surface is gone: from the shape it showed (`was`, `shapeOf` taken as it went; drawn like
 * `surface`) it folds back into the button over --motion-base, in-out, and the button's face comes back over it as it
 * lands (over the last of it, or from as much as showed); the button itself is unseen (still there to take the focus)
 * until then. Nothing travels under reduced motion.
 */
export function growBack(was: GrowShape, surface: Element, button: HTMLElement) {
  endFold(button);
  // Drawn in the window the button is in (the coordinator's own window, too), not always the app's.
  const at = button.ownerDocument;
  if (reducedMotion() || !button.isConnected || typeof at.body.animate !== "function" || at.hidden) return;
  const to = button.getBoundingClientRect();
  if (!to.width) return;
  button.style.opacity = "0";
  const ghost = at.createElement("div");
  ghost.className = surface.className;
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.growBack = "";
  Object.assign(ghost.style, { position: "fixed", pointerEvents: "none", zIndex: "var(--layer-popover)" });
  at.body.appendChild(ghost);
  const origin = new DOMRect(0, 0, 0, 0);
  const total = duration("base");
  const animation = ghost.animate([placed(was.rect, origin, was.radius), placed(to, origin, `${to.height / 2}px`)],
    { duration: total, easing: easing("in-out"), fill: "both" });
  const face = faceOf(button, to, ghost, origin, was.face);
  Object.assign(face.style, { position: "fixed" });
  // Shown once the surface is nearly the button again, sooner for a face that still showed.
  const hidden = total * 0.7 * (1 - was.face);
  face.animate([{ opacity: was.face }, { opacity: 1 }], { duration: total - hidden, delay: hidden, easing: easing("out"), fill: "both" });
  folds.set(button, { ghost, face, animation });
  // Ended early (endFold), it was cleaned up there; only the fold still under way lands.
  void animation.finished.then(() => { if (folds.get(button)?.animation === animation) endFold(button); }, () => {});
}
