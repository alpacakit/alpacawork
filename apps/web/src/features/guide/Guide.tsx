import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useDialogStore } from "@/state/dialog-store";
import { notify } from "@/lib/notify";
import { closeGuide, guideStage, moveGuide, putAway, type GoingStage } from "./guide-state";
import { PARTS, type GuideAlign, type GuideEntry, type GuideSide } from "./guide-definition";
import { useGoingGuide, useGuide, useGuideRestartFromUrl, useGuideStage, useGuideStart } from "./use-guide";

/** The guide's close mark (×): it ends the guide on this browser, and says where settings show it again, with a way straight back. */
function CloseGuide({ className }: { className?: string }) {
  const { t } = useTranslation("tree");
  const close = () => {
    // Closed by one press, it comes back by one press: where it was, while the notice that says so stands.
    const before = guideStage.get();
    closeGuide();
    notify.info(t("guide.closed", { settings: t("chrome:appBar.settings"), guide: t("panels:settings.personal.guide") }),
      { id: "guide-closed", action: { label: t("guide.reopen"), run: () => { moveGuide({ stage: "done" }, before ?? { stage: "done" }); notify.hide("guide-closed"); } } });
  };
  return <Button variant="quiet" size="icon" data-guide-close aria-label={t("guide.close")} title={t("guide.close")} onClick={close}
    className={cn("flex-none narrow:size-11 narrow:min-h-11", className)}>
    <Icon name="close" className="size-4" />
  </Button>;
}

type Box = { left: number; top: number; width: number; height: number };
type Placed = { target: Box; x: number; y: number; side: GuideSide; arrow: number };
const MARGIN = 8, GAP = 12, ARROW_ROOM = 16;
const OPPOSITE: Record<GuideSide, GuideSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const ACROSS: Record<GuideSide, GuideSide[]> = { top: ["right", "left"], bottom: ["right", "left"], left: ["top", "bottom"], right: ["top", "bottom"] };
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where a balloon of `size` stands in a view of `view`, pointing at `target`: outside `by` (the target itself, or the
 * box round it and the parts the balloon stands clear of), on the side asked for if it fits there, else the opposite one,
 * else either side across; lined up with the target as `align` says, kept inside the view whatever happens, its arrow
 * on the target's middle. With no room on any side of `by` (a detail taking the whole screen), it stands by the target
 * alone: never pushed back over the very part it points at.
 */
export function placeBalloon(target: Box, size: { width: number; height: number }, view: { width: number; height: number }, asked: GuideSide,
  align: GuideAlign = "middle", by: Box = target): Placed {
  const room: Record<GuideSide, boolean> = {
    top: by.top - GAP - size.height >= MARGIN,
    bottom: by.top + by.height + GAP + size.height <= view.height - MARGIN,
    left: by.left - GAP - size.width >= MARGIN,
    right: by.left + by.width + GAP + size.width <= view.width - MARGIN,
  };
  const fits = [asked, OPPOSITE[asked], ...ACROSS[asked]].find(each => room[each]);
  if (!fits && by !== target) return placeBalloon(target, size, view, asked, align);
  const side = fits ?? asked;
  const middleX = target.left + target.width / 2, middleY = target.top + target.height / 2;
  if (side === "top" || side === "bottom") {
    const along = align === "start" ? target.left : align === "end" ? target.left + target.width - size.width : middleX - size.width / 2;
    const x = clamp(along, MARGIN, view.width - size.width - MARGIN);
    const y = clamp(side === "top" ? by.top - GAP - size.height : by.top + by.height + GAP, MARGIN, view.height - size.height - MARGIN);
    return { target, x, y, side, arrow: clamp(middleX - x, ARROW_ROOM, size.width - ARROW_ROOM) };
  }
  const down = align === "start" ? target.top : align === "end" ? target.top + target.height - size.height : middleY - size.height / 2;
  const y = clamp(down, MARGIN, view.height - size.height - MARGIN);
  const x = clamp(side === "left" ? by.left - GAP - size.width : by.left + by.width + GAP, MARGIN, view.width - size.width - MARGIN);
  return { target, x, y, side, arrow: clamp(middleY - y, ARROW_ROOM, size.height - ARROW_ROOM) };
}

/**
 * The first element marked as `selector` that is seen: laid out and shown, and at its middle it (or what is in it) is
 * what stands in front, so not scrolled out of its pane, under a fixed heading or under another surface. The balloon and
 * its ring take no press, so they never stand in front.
 */
function shownPart(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest("[inert], [aria-hidden=true]")) continue;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    const front = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!front || !element.contains(front)) continue;
    return element;
  }
  return null;
}
const boxOf = (element: Element): Box => {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
};
/** The smallest box round all of `boxes`. */
const around = (boxes: Box[]): Box => {
  const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top));
  return { left, top, width: Math.max(...boxes.map(box => box.left + box.width)) - left, height: Math.max(...boxes.map(box => box.top + box.height)) - top };
};
const same = (a: Placed | null | undefined, b: Placed | null) => a === b || !!a && !!b && a.x === b.x && a.y === b.y && a.side === b.side && a.arrow === b.arrow
  && a.target.left === b.target.left && a.target.top === b.target.top && a.target.width === b.target.width && a.target.height === b.target.height;

/**
 * The guide's balloon, put once on the page: for the step that holds now (guide-definition.ts), beside the part it
 * names, with an arrow to it and a quiet ring round it. Nothing covers the page and nothing is held: only its buttons
 * take a press, so what is under the balloon stays pressable. It follows the part as the window is resized, scrolled or
 * redrawn, and is not drawn while that part is not seen or a dialog is over the page. Read out as a status; it never
 * takes the focus. It also starts the guide (useGuideStart, or over again from the address: useGuideRestartFromUrl)
 * and stores the stage as it moves (useGuideStage); while no guide goes on, nothing else is read for it.
 */
export function GuideBalloon() {
  useGuideRestartFromUrl();
  useGuideStart();
  const stage = useGoingGuide();
  return stage && <GoingBalloon stage={stage} />;
}

function GoingBalloon({ stage }: { stage: GoingStage }) {
  const entry = useGuide(stage);
  useGuideStage(stage, entry);
  const dialog = useDialogStore((state) => state.dialog);
  const part = entry?.part && !(dialog && dialog.kind !== "input") ? PARTS[entry.part] : null;
  const balloon = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    if (!part || !entry) { setPlaced(null); return; }
    // Not looked at yet for this step: its first look is always kept, so a step whose part is not on the screen never
    // stands where the step before it stood.
    let last: Placed | null | undefined;
    const update = () => {
      const target = shownPart(part);
      const own = balloon.current?.getBoundingClientRect();
      // Each part stood clear of is the one holding the part pointed at, else the one of its kind seen beside it.
      const clear = target ? (entry.clear ?? []).flatMap(name => {
        const element = target.closest(PARTS[name]) ?? shownPart(PARTS[name]);
        return element ? [boxOf(element)] : [];
      }) : [];
      const next = target && own ? placeBalloon(boxOf(target), { width: own.width, height: own.height }, { width: innerWidth, height: innerHeight }, entry.side ?? "top",
        entry.align, clear.length ? around([boxOf(target), ...clear]) : undefined) : null;
      if (!same(last, next)) { last = next; setPlaced(next); }
    };
    update();
    // A part comes and goes with the data, and moves with layout and motion no event reports, so it is looked at again
    // a few times a second too.
    const timer = setInterval(update, 250);
    addEventListener("resize", update);
    addEventListener("scroll", update, true);
    return () => { clearInterval(timer); removeEventListener("resize", update); removeEventListener("scroll", update, true); };
  }, [part, entry?.id, entry?.side, entry?.align]);
  if (!entry || !part) return null;
  return createPortal(<>
    {placed && <div aria-hidden="true" data-guide-ring className="pointer-events-none fixed z-(--layer-guide) rounded-md ring-2 ring-turn ring-offset-2 ring-offset-bg transition-[left,top,width,height] duration-(--motion-fast) motion-reduce:transition-none"
      style={{ left: placed.target.left, top: placed.target.top, width: placed.target.width, height: placed.target.height }} />}
    <div ref={balloon} data-guide-balloon={entry.id} data-guide-side={placed?.side}
      className={cn("pointer-events-none fixed z-(--layer-guide) w-max max-w-[min(31rem,calc(100vw-16px))]", !placed && "invisible")}
      style={placed ? { left: placed.x, top: placed.y } : { left: 0, top: 0 }}>
      <BalloonBody entry={entry} placed={placed} />
    </div>
  </>, document.body);
}

function BalloonBody({ entry, placed }: { entry: GuideEntry; placed: Placed | null }) {
  const { t } = useTranslation("tree");
  const side = placed?.side ?? "top";
  // Read and put away, by "Got it" or by doing what the step offers: the guide goes on, and what the step settles is settled.
  const read = () => { putAway(entry.id); entry.settle?.(); };
  // The arrow on the edge facing the part, a square turned to a point, as the balloon's own colour.
  const arrow: CSSProperties = side === "top" ? { top: "100%", left: placed?.arrow } : side === "bottom" ? { bottom: "100%", left: placed?.arrow }
    : side === "left" ? { left: "100%", top: placed?.arrow } : { right: "100%", top: placed?.arrow };
  return <div role="status" className="relative rounded-lg bg-ink py-2 pr-1 pl-3 text-bg shadow-float">
    <i aria-hidden="true" style={arrow} className={cn("absolute size-3 rotate-45 bg-ink",
      side === "top" || side === "bottom" ? "-translate-x-1/2" : "-translate-y-1/2", side === "top" ? "-translate-y-1/2" : side === "bottom" ? "translate-y-1/2" : side === "left" ? "-translate-x-1/2" : "translate-x-1/2")} />
    <div className="flex items-start gap-1">
      <p className="m-0 flex-1 py-1.5 text-sm text-pretty [word-break:auto-phrase] narrow:py-2.5">{entry.say(t as TFunction)}</p>
      <CloseGuide className="pointer-events-auto text-bg/75 hover:bg-bg/15 hover:text-bg" />
    </div>
    {(entry.next || entry.action) && <div className="mt-1.5 flex justify-end gap-2 pr-1">
      {entry.action && <Button variant="outline" data-guide-action className="pointer-events-auto border-bg/40 bg-transparent text-bg hover:bg-bg/15"
        onClick={() => { read(); entry.action!.run(); }}>{entry.action.label(t as TFunction)}</Button>}
      {entry.next && <Button variant="outline" data-guide-next className="pointer-events-auto border-bg/40 bg-transparent text-bg hover:bg-bg/15" onClick={read}>{t("guide.next")}</Button>}
    </div>}
  </div>;
}
