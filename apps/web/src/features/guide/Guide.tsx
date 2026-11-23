import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Sentences } from "@/components/ui/sentences";
import { cn } from "@/lib/utils";
import { useDialogStore } from "@/state/dialog-store";
import { notify } from "@/lib/notify";
import { closeGuide, guideStage, moveGuide, putAway, type GoingStage } from "./guide-state";
import { GUIDE, PARTS, doneOnShowing, type GuideAlign, type GuideEntry, type GuideSide } from "./guide-definition";
import { useGoingGuide, useGuide, useGuideShown, useGuideStage, useGuideStart } from "./use-guide";

/** Where settings show the guide again: named in the notice that it is over, however it ended. */
const shownAgainAt = (t: TFunction) => ({ settings: t("chrome:appBar.settings"), tab: t("panels:settings.tabs.general"), guide: t("panels:settings.personal.guide") });

/** The guide's close mark (×): it ends the guide on this browser, and says where settings show it again, with a way straight back. */
function CloseGuide({ className }: { className?: string }) {
  const { t } = useTranslation("tree");
  const close = () => {
    // Closed by one press, it comes back by one press: where it was, while the notice that says so stands.
    const before = guideStage.get();
    closeGuide();
    notify.info(t("guide.closed", shownAgainAt(t as TFunction)),
      { id: "guide-closed", action: { label: t("guide.reopen"), run: () => { moveGuide({ stage: "done" }, before ?? { stage: "done" }); notify.hide("guide-closed"); } } });
  };
  return <Button variant="quiet" size="icon" data-guide-close aria-label={t("guide.close")} title={t("guide.close")} onClick={close}
    className={cn("flex-none", className)}>
    <Icon name="close" className="size-4" />
  </Button>;
}

type Box = { left: number; top: number; width: number; height: number };
type Placed = { target: Box; x: number; y: number; side: GuideSide; arrow: number };
const MARGIN = 8, GAP = 12, ARROW_ROOM = 16;
/** How long a balloon is on the screen before it has stood there: one that came and went within a blink was not shown. */
const STOOD_MS = 150;
/** How much of a part's top counts as its head: where a tall part is looked for when its middle is out of sight. */
const HEAD = 40;
const OPPOSITE: Record<GuideSide, GuideSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const ACROSS: Record<GuideSide, GuideSide[]> = { top: ["right", "left"], bottom: ["right", "left"], left: ["top", "bottom"], right: ["top", "bottom"] };
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** Where a balloon stands on one side of its part, and how far it had to move away from it (`away`) to stand clear. */
type Standing = { x: number; y: number; side: GuideSide; away: number; inView: boolean };
const overlaps = (x: number, y: number, size: { width: number; height: number }, box: Box) =>
  x < box.left + box.width && x + size.width > box.left && y < box.top + box.height && y + size.height > box.top;
/**
 * A balloon of `size` on `side` of `target`, lined up with it as `align` says and kept inside the view along that side:
 * right by the target, then moved off each box of `clear` it would stand over, along the target where its arrow still
 * lands on it, else away from it, until it stands over none.
 */
function standing(target: Box, size: { width: number; height: number }, view: { width: number; height: number }, side: GuideSide, align: GuideAlign,
  clear: readonly Box[]): Standing {
  const middleX = target.left + target.width / 2, middleY = target.top + target.height / 2;
  const upright = side === "top" || side === "bottom";
  let x: number, y: number;
  if (upright) {
    const along = align === "start" ? target.left : align === "end" ? target.left + target.width - size.width : middleX - size.width / 2;
    x = clamp(along, MARGIN, view.width - size.width - MARGIN);
    y = side === "top" ? target.top - GAP - size.height : target.top + target.height + GAP;
  } else {
    const down = align === "start" ? target.top : align === "end" ? target.top + target.height - size.height : middleY - size.height / 2;
    y = clamp(down, MARGIN, view.height - size.height - MARGIN);
    x = side === "left" ? target.left - GAP - size.width : target.left + target.width + GAP;
  }
  const from = upright ? y : x;
  const over = (atX: number, atY: number) => clear.find(box => overlaps(atX, atY, size, box));
  // Along the target, as far as its arrow still lands on it: to one end of the box in its way or the other, the nearer.
  const along = (box: Box): number | null => {
    const [at, length, low, span, start, end, room] = upright
      ? [x, size.width, box.left, box.width, target.left, target.left + target.width, view.width]
      : [y, size.height, box.top, box.height, target.top, target.top + target.height, view.height];
    const reach = Math.min(2 * ARROW_ROOM, end - start);
    const fits = (each: number) => each >= MARGIN && each + length <= room - MARGIN && Math.min(each + length, end) - Math.max(each, start) >= reach
      && !(upright ? over(each, y) : over(x, each));
    const nearest = (places: number[]) => places.filter(fits).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0] ?? null;
    // A gap from the box where there is room for one, else right against it.
    return nearest([low - GAP - length, low + span + GAP]) ?? nearest([low - length, low + span]);
  };
  // Each move takes it clear of one box it stood over: along the target where that is enough, else away from it, past
  // that box; so it is clear of them all within as many moves as there are boxes.
  for (let moves = 0; moves <= clear.length; moves++) {
    const box = over(x, y);
    if (!box) break;
    const slid = along(box);
    if (slid !== null) { if (upright) x = slid; else y = slid; break; }
    if (side === "top") y = box.top - GAP - size.height;
    else if (side === "bottom") y = box.top + box.height + GAP;
    else if (side === "left") x = box.left - GAP - size.width;
    else x = box.left + box.width + GAP;
  }
  const inView = side === "top" ? y >= MARGIN : side === "bottom" ? y + size.height <= view.height - MARGIN
    : side === "left" ? x >= MARGIN : x + size.width <= view.width - MARGIN;
  return { x, y, side, away: Math.abs((upright ? y : x) - from), inView: inView && !clear.some(box => overlaps(x, y, size, box)) };
}

/**
 * Where a balloon of `size` stands in a view of `view`, pointing at `target`: beside it, clear of every box of `clear`
 * (the parts whose content stays read), on the side where it stands nearest the target; the side asked for when it is
 * as near there as anywhere, then the opposite one, then either side across. Lined up with the target as `align` says,
 * kept inside the view whatever happens, its arrow on the target's middle. With no side to stand clear on (a detail
 * taking the whole screen), it stands by the target alone: never pushed back over the very part it points at.
 */
export function placeBalloon(target: Box, size: { width: number; height: number }, view: { width: number; height: number }, asked: GuideSide,
  align: GuideAlign = "middle", clear: readonly Box[] = []): Placed {
  const sides = [asked, OPPOSITE[asked], ...ACROSS[asked]];
  const stands = (boxes: readonly Box[]) => sides.map(side => standing(target, size, view, side, align, boxes)).filter(each => each.inView)
    .reduce<Standing | null>((best, each) => best && best.away <= each.away ? best : each, null);
  const stood = stands(clear) ?? stands([]) ?? standing(target, size, view, asked, align, []);
  const x = clamp(stood.x, MARGIN, view.width - size.width - MARGIN), y = clamp(stood.y, MARGIN, view.height - size.height - MARGIN);
  const middleX = target.left + target.width / 2, middleY = target.top + target.height / 2;
  return stood.side === "top" || stood.side === "bottom"
    ? { target, x, y, side: stood.side, arrow: clamp(middleX - x, ARROW_ROOM, size.width - ARROW_ROOM) }
    : { target, x, y, side: stood.side, arrow: clamp(middleY - y, ARROW_ROOM, size.height - ARROW_ROOM) };
}

/**
 * The first element marked as `selector` that is seen: laid out and shown, and at its middle or at its head (a tall part
 * whose middle is below the fold) it (or what is in it) is what stands in front, so not scrolled out of its pane, under
 * a fixed heading or under another surface. The balloon and its ring take no press, so they never stand in front.
 */
const shownPart = (selector: string): HTMLElement | null => shownParts(selector)[0] ?? null;
/** Every element marked as `selector` that is seen (shownPart). */
function shownParts(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => {
    if (element.closest("[inert], [aria-hidden=true]")) return false;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return false;
    const across = box.left + box.width / 2;
    return [box.top + box.height / 2, box.top + Math.min(box.height, HEAD) / 2].some(down => inFront(element, across, down));
  });
}
/** The nearest box `element` (itself included) scrolls in: one that lets its content overflow and scroll. */
function scrollerOf(element: Element | null): HTMLElement | null {
  for (let at = element instanceof HTMLElement ? element : element?.parentElement ?? null; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
}
/** Whether `element` (or what is in it) is what stands in front at this point of the screen. */
const inFront = (element: Element, across: number, down: number) => {
  const front = document.elementFromPoint(across, down);
  return !!front && element.contains(front);
};
/**
 * Where what a pane scrolls is seen in it: its box, less the room it keeps clear at its ends for what stands over them
 * there (its scroll padding: the list's head, the input and its row over a detail's foot).
 */
function seenArea(pane: HTMLElement) {
  const box = pane.getBoundingClientRect(), room = getComputedStyle(pane);
  return { top: box.top + (parseFloat(room.scrollPaddingTop) || 0), bottom: box.bottom - (parseFloat(room.scrollPaddingBottom) || 0) };
}
/**
 * What of a part (`box`) is seen in the pane it scrolls in (`seen`, seenArea): the ring goes round that and the balloon
 * points at it, never over what stands at the pane's ends. All of the part where none of it is seen there.
 */
export function seenPart(box: Box, seen: { top: number; bottom: number }): Box {
  const top = Math.max(box.top, seen.top), bottom = Math.min(box.top + box.height, seen.bottom);
  return bottom > top ? { ...box, top, height: bottom - top } : box;
}
/** `element`'s box as seen in the pane it scrolls in (seenPart); its whole box where it scrolls in none. */
function seenBoxOf(element: HTMLElement): Box {
  const pane = scrollerOf(element.parentElement);
  return pane ? seenPart(boxOf(element), seenArea(pane)) : boxOf(element);
}
/**
 * The first element marked as `selector` that is laid out and shown in a box it scrolls in, but out of sight there
 * (seenArea): its head scrolled out of it, within the room the part keeps clear at its top for what stays there (its
 * scroll margin: a heading that stays at the top takes no press, so it is not seen by what stands in front), or not in
 * front; or, where it would fit there whole, reaching past its end. A part to bring into view; one taller than that is
 * left where the person has it while its head is seen.
 */
function outOfPane(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest("[inert], [aria-hidden=true]")) continue;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const scroller = scrollerOf(element.parentElement);
    if (!scroller) continue;
    const box = element.getBoundingClientRect(), pane = seenArea(scroller);
    const kept = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    const head = box.top + Math.min(box.height, HEAD) / 2;
    const seen = box.top >= pane.top + kept - 1 && head <= pane.bottom && inFront(element, box.left + box.width / 2, head);
    if (!seen || fitsIn(box.height, pane) && box.bottom > pane.bottom + 1) return element;
  }
  return null;
}
/** Brings `element` into what the box it scrolls in shows (seenArea): whole where it fits there, else from its head. */
function bringIn(element: HTMLElement) {
  const pane = scrollerOf(element.parentElement);
  element.scrollIntoView({ block: bringInAt(element.getBoundingClientRect().height, pane ? seenArea(pane) : null) });
}
/** Whether a part of `height` fits whole in what its pane shows (`seen`, seenArea). */
const fitsIn = (height: number, seen: { top: number; bottom: number }) => height <= seen.bottom - seen.top;
/** Where a part of `height` is brought in its pane (`seen`, seenArea; none where it scrolls in none): whole where it fits, else from its head. */
export const bringInAt = (height: number, seen: { top: number; bottom: number } | null): ScrollLogicalPosition =>
  seen && !fitsIn(height, seen) ? "start" : "nearest";
const boxOf = (element: Element): Box => {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
};
const same = (a: Placed | null | undefined, b: Placed | null) => a === b || !!a && !!b && a.x === b.x && a.y === b.y && a.side === b.side && a.arrow === b.arrow
  && a.target.left === b.target.left && a.target.top === b.target.top && a.target.width === b.target.width && a.target.height === b.target.height;

/**
 * The guide's balloon, put once on the page: for the step that holds now (guide-definition.ts), beside the part it
 * names, with an arrow to it and a quiet ring round it. Nothing covers the page and nothing is held: only its buttons
 * take a press, so what is under the balloon stays pressable. It follows the part as the window is resized, scrolled or
 * redrawn, and is not drawn while that part is not seen or a dialog is over the page. Read out as a status; it never
 * takes the focus. It also starts the guide (useGuideStart) and stores the stage as it moves (useGuideStage); while no
 * guide goes on, nothing else is read for it.
 */
export function GuideBalloon() {
  useGuideStart();
  const stage = useGoingGuide();
  // Started on a phone too (its stage kept for a computer), it is drawn on a computer's screen alone (useGuideShown).
  const shown = useGuideShown();
  return stage && shown && <GoingBalloon stage={stage} />;
}

/**
 * The steps passed over while what they point at is not seen (`passable` and `skipped`, guide-definition.ts): one is
 * passed over when its part has not been seen for a moment (`pass`), and comes back as soon as its part is seen.
 */
function useSkipped() {
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const pass = (id: string) => setSkipped(was => was.has(id) ? was : new Set(was).add(id));
  useEffect(() => {
    if (!skipped.size) return;
    const look = () => {
      const back = [...skipped].filter(id => { const part = GUIDE.find(each => each.id === id)?.part; return !part || shownPart(PARTS[part]); });
      if (back.length) setSkipped(was => new Set([...was].filter(id => !back.includes(id))));
    };
    const timer = setInterval(look, 250);
    return () => clearInterval(timer);
  }, [skipped]);
  return { skipped, pass };
}

function GoingBalloon({ stage }: { stage: GoingStage }) {
  const { skipped, pass } = useSkipped();
  const { t } = useTranslation("tree");
  const { entry, again, facts, fresh, ready } = useGuide(stage, skipped);
  // The steps whose balloon has stood on this page, in this guide (begun again, none has): one stands once it has been
  // on the screen for a moment without a break (STOOD_MS).
  const began = stage.stage === "started" ? stage.at : null;
  const stood = useRef({ began, ids: new Set<string>() });
  if (began !== null && stood.current.began !== began) stood.current = { began, ids: new Set() };
  useGuideStage(stage, entry, facts, fresh, ready, id => stood.current.ids.has(id),
    () => notify.info(t("guide.over", shownAgainAt(t as TFunction)), { id: "guide-closed" }));
  const dialog = useDialogStore((state) => state.dialog);
  const part = entry?.part && !(dialog && dialog.kind !== "input") ? PARTS[entry.part] : null;
  const balloon = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    if (!part || !entry) { setPlaced(null); return; }
    // Not looked at yet for this step: its first look is always kept, so a step whose part is not on the screen never
    // stands where the step before it stood.
    let last: Placed | null | undefined;
    // A part not wholly in its pane is brought into view once, when its step begins and the part is there; after that
    // the person scrolls.
    let settled = false;
    // The box the balloon stands over and scrolls (its room, below).
    let roomed: HTMLElement | null = null;
    // Looks in a row that did not see the part: a passable step is passed over after two (half a second).
    let missed = 0;
    // Counts the balloon as having stood once it has been on the screen, in a tab the person is looking at, for a
    // moment without a break.
    let standing: ReturnType<typeof setTimeout> | null = null;
    const stoodNow = () => {
      standing = null;
      stood.current.ids.add(entry.id);
      if (doneOnShowing(entry, true)) putAway(entry.id);
    };
    const update = () => {
      let target = shownPart(part);
      if (!settled) {
        const away = outOfPane(part);
        if (away) { bringIn(away); target = shownPart(part); }
        settled = !!away || !!target;
      }
      missed = target ? 0 : missed + 1;
      if (entry.passable && missed >= 2 && !skipped.has(entry.id)) pass(entry.id);
      const own = balloon.current?.getBoundingClientRect();
      // Each part stood clear of is the one holding the part pointed at, else those of its kind seen beside it.
      const clear = target ? (entry.clear ?? []).flatMap(name => {
        const holder = target.closest(PARTS[name]);
        return (holder ? [holder] : shownParts(PARTS[name])).map(boxOf);
      }) : [];
      const next = target && own ? placeBalloon(seenBoxOf(target), { width: own.width, height: own.height }, { width: innerWidth, height: innerHeight }, entry.side ?? "top",
        entry.align, clear) : null;
      const looked = !!next && document.visibilityState === "visible";
      if (!looked && standing) { clearTimeout(standing); standing = null; }
      if (looked && !standing && !stood.current.ids.has(entry.id)) standing = setTimeout(stoodNow, STOOD_MS);
      if (!same(last, next)) { last = next; setPlaced(next); }
      roomed = keepRoom(roomed, next && own ? own : null);
    };
    update();
    // A part comes and goes with the data, and moves with layout and motion no event reports, so it is looked at again
    // a few times a second too.
    const timer = setInterval(update, 250);
    addEventListener("resize", update);
    addEventListener("scroll", update, true);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer); removeEventListener("resize", update); removeEventListener("scroll", update, true);
      document.removeEventListener("visibilitychange", update);
      if (standing) clearTimeout(standing);
      keepRoom(roomed, null);
    };
  }, [part, entry?.id, entry?.side, entry?.align, skipped]);
  if (!entry || !part) return null;
  return createPortal(<>
    {placed && <div aria-hidden="true" data-guide-ring className="pointer-events-none fixed z-(--layer-guide) rounded-md ring-2 ring-turn ring-offset-2 ring-offset-bg transition-[left,top,width,height] duration-(--motion-fast) motion-reduce:transition-none"
      style={{ left: placed.target.left, top: placed.target.top, width: placed.target.width, height: placed.target.height }} />}
    <div ref={balloon} data-guide-balloon={entry.id} data-guide-again={again || undefined} data-guide-side={placed?.side}
      className={cn("pointer-events-none fixed z-(--layer-guide) w-max max-w-[min(31rem,calc(100vw-16px))]", !placed && "invisible")}
      style={placed ? { left: placed.x, top: placed.y } : { left: 0, top: 0 }}>
      <BalloonBody entry={entry} again={again} placed={placed} />
    </div>
  </>, document.body);
}

/**
 * While the balloon (at `balloon`, or none) stands over a box that scrolls, that box gets room at its end as tall as
 * the balloon reaches into it (`data-guide-room`, parts.css), so what the balloon covers can be scrolled out from under
 * it. The room leaves the box it was in (`before`) as soon as the balloon moves off it or is gone. Returns the box that
 * has the room now.
 */
function keepRoom(before: HTMLElement | null, balloon: DOMRect | null): HTMLElement | null {
  // What is under its middle, the balloon's own buttons aside, is what it stands over.
  const under = balloon ? scrollerOf(document.elementsFromPoint(balloon.left + balloon.width / 2, balloon.top + balloon.height / 2)
    .find(element => !element.closest("[data-guide-balloon]")) ?? null) : null;
  const room = under && balloon ? roomUnder(under.getBoundingClientRect(), balloon) : 0;
  if (before && (before !== under || !room)) { before.removeAttribute("data-guide-room"); before.style.removeProperty("--guide-room"); }
  if (!under || !room) return null;
  under.setAttribute("data-guide-room", "");
  under.style.setProperty("--guide-room", `${room}px`);
  return under;
}
/** The room a box needs at its end for what a balloon over it covers to be scrolled clear: from the balloon's top to the box's foot. */
export const roomUnder = (box: Pick<DOMRect, "top" | "bottom">, balloon: Pick<DOMRect, "top" | "bottom">) =>
  balloon.bottom > box.top && balloon.top < box.bottom ? Math.round(box.bottom - balloon.top) : 0;

/** The balloon's words and buttons: the step's first words, or (`again`) its words for coming round again, which wait for no "Got it". */
function BalloonBody({ entry, again, placed }: { entry: GuideEntry; again: boolean; placed: Placed | null }) {
  const { t } = useTranslation("tree");
  const side = placed?.side ?? "top";
  const say = (again && entry.again || entry.say)(t as TFunction);
  const next = !!entry.next && !again;
  // The balloon is as wide as its longest line: words broken at a sentence's or a phrase's end (Sentences) leave no
  // empty room at their right.
  const words = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const lines = words.current;
      if (!lines) return;
      lines.style.maxWidth = "";
      const boxes = [...lines.querySelectorAll("span")].flatMap(sentence => {
        const range = document.createRange();
        range.selectNodeContents(sentence);
        return [...range.getClientRects()];
      });
      if (boxes.length) lines.style.maxWidth = `${Math.ceil(Math.max(...boxes.map(box => box.right)) - Math.min(...boxes.map(box => box.left)))}px`;
    };
    fit();
    // The lines break anew when the window's width or the font changes.
    let live = true;
    void document.fonts?.ready.then(() => { if (live) fit(); });
    addEventListener("resize", fit);
    return () => { live = false; removeEventListener("resize", fit); };
  }, [say]);
  // Read and put away, by "Got it" or by doing what the step offers: the guide goes on.
  const read = () => { putAway(entry.id); };
  // The arrow on the edge facing the part, a square turned to a point, as the balloon's own colour.
  const arrow: CSSProperties = side === "top" ? { top: "100%", left: placed?.arrow } : side === "bottom" ? { bottom: "100%", left: placed?.arrow }
    : side === "left" ? { left: "100%", top: placed?.arrow } : { right: "100%", top: placed?.arrow };
  return <div role="status" className="relative rounded-lg bg-ink py-2 pr-1 pl-3 text-bg shadow-float">
    <i aria-hidden="true" style={arrow} className={cn("absolute size-3 rotate-45 bg-ink",
      side === "top" || side === "bottom" ? "-translate-x-1/2" : "-translate-y-1/2", side === "top" ? "-translate-y-1/2" : side === "bottom" ? "translate-y-1/2" : side === "left" ? "-translate-x-1/2" : "translate-x-1/2")} />
    <div className="flex items-start gap-1">
      <p ref={words} className="m-0 flex-1 py-1.5 text-sm">
        <Sentences words={say} />
      </p>
      <CloseGuide className="pointer-events-auto text-bg/75 hover:bg-bg/15 hover:text-bg" />
    </div>
    {(next || entry.action) && <div className="mt-1.5 flex justify-end gap-2 pr-1">
      {entry.action && <Button variant="outline" data-guide-action className="pointer-events-auto border-bg/40 bg-transparent text-bg hover:bg-bg/15"
        onClick={() => { read(); entry.action!.run(t as TFunction); }}>{entry.action.label(t as TFunction)}</Button>}
      {next && <Button variant="outline" data-guide-next className="pointer-events-auto border-bg/40 bg-transparent text-bg hover:bg-bg/15" onClick={read}>{t("guide.next")}</Button>}
    </div>}
  </div>;
}
