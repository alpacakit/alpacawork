import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { useDialogStore } from "@/state/dialog-store";
import { closeGuide, putAway } from "./guide-state";
import { PARTS, STEPS, type GuideAlign, type GuideEntry, type GuideSide } from "./guide-definition";
import { useGuide, useGuideStage } from "./use-guide";

const STEP_NUMBERS = [1, 2, 3] as const;

/** The guide's close mark (×): it ends the guide on this browser; settings can show it again. */
function CloseGuide({ className }: { className?: string }) {
  const { t } = useTranslation("tree");
  return <Button variant="quiet" size="icon" data-guide-close aria-label={t("guide.close")} title={t("guide.close")} onClick={closeGuide}
    className={cn("flex-none narrow:size-11 narrow:min-h-11", className)}>
    <Icon name="close" className="size-4" />
  </Button>;
}

/**
 * On an empty scope's welcome, how using alpacawork goes, in three numbered steps (send a request, AI works on it,
 * your turn), the step the guide is at (its entry's `step`) stressed and the ones behind it checked. On a phone only the
 * current step keeps its line of detail, so the examples under it stay on the first screen.
 */
export function GuideSteps({ entry }: { entry: GuideEntry }) {
  const { t } = useTranslation("tree");
  const narrow = useNarrow();
  const current = entry.step ?? 4;
  const tt = t as TFunction;
  return <div data-guide-steps={current} className="relative mt-5 rounded-lg border-hairline border-rule px-4 pt-2 pb-2.5 narrow:mt-4 narrow:px-3">
    <p className="m-0 mb-1.5 text-xs font-medium text-muted">{t("guide.name")}</p>
    <div className="absolute top-1 right-1"><CloseGuide /></div>
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {STEP_NUMBERS.map(at => {
        const now = at === current, done = at < current;
        return <li key={at} data-guide-step={at} aria-current={now ? "step" : undefined} className="flex items-start gap-3">
          <span aria-hidden="true" className={cn("mt-px flex size-5 flex-none items-center justify-center rounded-full text-xs tabular-nums",
            now ? "bg-ink font-semibold text-bg" : done ? "bg-lit text-muted" : "border-hairline border-line text-soft")}>
            {done ? <Icon name="check" className="size-3" /> : at}
          </span>
          <span className="flex min-w-0 flex-col [word-break:auto-phrase]">
            <span className={cn("text-base", now ? "font-semibold text-ink" : "text-muted")}>
              {done && <span className="sr-only">{t("guide.stepDone")} </span>}{STEPS[at].title(tt)}</span>
            {(now || !narrow) && <span className={cn("text-sm text-pretty", now ? "text-muted" : "text-soft")}>{STEPS[at].detail(tt)}</span>}
          </span>
        </li>;
      })}
    </ol>
  </div>;
}

type Box = { left: number; top: number; width: number; height: number };
type Placed = { target: Box; x: number; y: number; side: GuideSide; arrow: number };
const MARGIN = 8, GAP = 12, ARROW_ROOM = 16;
const OPPOSITE: Record<GuideSide, GuideSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const ACROSS: Record<GuideSide, GuideSide[]> = { top: ["right", "left"], bottom: ["right", "left"], left: ["top", "bottom"], right: ["top", "bottom"] };
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where a balloon of `size` stands by `target` in a view of `view`: on the side asked for if it fits there, else the
 * opposite one, else either side across; lined up with the target as `align` says, kept inside the view whatever
 * happens, its arrow on the target's middle.
 */
export function placeBalloon(target: Box, size: { width: number; height: number }, view: { width: number; height: number }, asked: GuideSide,
  align: GuideAlign = "middle"): Placed {
  const room: Record<GuideSide, boolean> = {
    top: target.top - GAP - size.height >= MARGIN,
    bottom: target.top + target.height + GAP + size.height <= view.height - MARGIN,
    left: target.left - GAP - size.width >= MARGIN,
    right: target.left + target.width + GAP + size.width <= view.width - MARGIN,
  };
  const side = [asked, OPPOSITE[asked], ...ACROSS[asked]].find(each => room[each]) ?? asked;
  const middleX = target.left + target.width / 2, middleY = target.top + target.height / 2;
  if (side === "top" || side === "bottom") {
    const along = align === "start" ? target.left : align === "end" ? target.left + target.width - size.width : middleX - size.width / 2;
    const x = clamp(along, MARGIN, view.width - size.width - MARGIN);
    const y = clamp(side === "top" ? target.top - GAP - size.height : target.top + target.height + GAP, MARGIN, view.height - size.height - MARGIN);
    return { target, x, y, side, arrow: clamp(middleX - x, ARROW_ROOM, size.width - ARROW_ROOM) };
  }
  const down = align === "start" ? target.top : align === "end" ? target.top + target.height - size.height : middleY - size.height / 2;
  const y = clamp(down, MARGIN, view.height - size.height - MARGIN);
  const x = clamp(side === "left" ? target.left - GAP - size.width : target.left + target.width + GAP, MARGIN, view.width - size.width - MARGIN);
  return { target, x, y, side, arrow: clamp(middleY - y, ARROW_ROOM, size.height - ARROW_ROOM) };
}

/** The first element marked as `selector` that is on the screen: laid out, shown and inside the view. */
function shownPart(selector: string): Box | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest("[inert], [aria-hidden=true]")) continue;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) continue;
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }
  return null;
}
const same = (a: Placed | null, b: Placed | null) => a === b || !!a && !!b && a.x === b.x && a.y === b.y && a.side === b.side && a.arrow === b.arrow
  && a.target.left === b.target.left && a.target.top === b.target.top && a.target.width === b.target.width && a.target.height === b.target.height;

/**
 * The guide's balloon, put once on the page: for the step that holds now (guide-definition.ts), beside the part it
 * names, with an arrow to it and a quiet ring round it. Nothing covers the page and nothing is held: only its buttons
 * take a press, so what is under the balloon stays pressable. It follows the part as the window is resized, scrolled or
 * redrawn, and is not drawn while that part is not on the screen or a dialog is over the page. Read out as a status; it
 * never takes the focus. It also stores the stage as the guide moves (useGuideStage).
 */
export function GuideBalloon() {
  const entry = useGuide();
  useGuideStage(entry);
  const dialog = useDialogStore((state) => state.dialog);
  const part = entry?.part && !(dialog && dialog.kind !== "input") ? PARTS[entry.part] : null;
  const balloon = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  useLayoutEffect(() => {
    if (!part || !entry) { setPlaced(null); return; }
    let last: Placed | null = null;
    const update = () => {
      const target = shownPart(part);
      const own = balloon.current?.getBoundingClientRect();
      const next = target && own ? placeBalloon(target, { width: own.width, height: own.height }, { width: innerWidth, height: innerHeight }, entry.side ?? "top", entry.align) : null;
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
    {placed && <div aria-hidden="true" data-guide-ring className="pointer-events-none fixed z-[calc(var(--layer-edit-surface)+1)] rounded-md ring-2 ring-turn ring-offset-2 ring-offset-bg transition-[left,top,width,height] duration-(--motion-fast) motion-reduce:transition-none"
      style={{ left: placed.target.left, top: placed.target.top, width: placed.target.width, height: placed.target.height }} />}
    <div ref={balloon} data-guide-balloon={entry.id} data-guide-side={placed?.side}
      className={cn("pointer-events-none fixed z-[calc(var(--layer-edit-surface)+1)] w-[min(31rem,calc(100vw-16px))]", !placed && "invisible")}
      style={placed ? { left: placed.x, top: placed.y } : { left: 0, top: 0 }}>
      <BalloonBody entry={entry} placed={placed} />
    </div>
  </>, document.body);
}

function BalloonBody({ entry, placed }: { entry: GuideEntry; placed: Placed | null }) {
  const { t } = useTranslation("tree");
  const side = placed?.side ?? "top";
  // The arrow on the edge facing the part, a square turned to a point, as the balloon's own colour.
  const arrow: CSSProperties = side === "top" ? { top: "100%", left: placed?.arrow } : side === "bottom" ? { bottom: "100%", left: placed?.arrow }
    : side === "left" ? { left: "100%", top: placed?.arrow } : { right: "100%", top: placed?.arrow };
  return <div role="status" className="relative rounded-lg bg-ink py-2 pr-1 pl-3 text-bg shadow-float">
    <i aria-hidden="true" style={arrow} className={cn("absolute size-3 rotate-45 bg-ink",
      side === "top" || side === "bottom" ? "-translate-x-1/2" : "-translate-y-1/2", side === "top" ? "-translate-y-1/2" : side === "bottom" ? "translate-y-1/2" : side === "left" ? "-translate-x-1/2" : "translate-x-1/2")} />
    <div className="flex items-start gap-2">
      <BalloonHead step={entry.step} />
      <CloseGuide className="pointer-events-auto text-bg/75 hover:bg-bg/15 hover:text-bg" />
    </div>
    <p className="m-0 pr-2 text-sm text-pretty [word-break:auto-phrase]">{entry.say(t as TFunction)}</p>
    {entry.next && <div className="mt-1.5 flex justify-end pr-1">
      <Button variant="outline" data-guide-next className="pointer-events-auto border-bg/40 bg-transparent text-bg hover:bg-bg/15" onClick={() => putAway(entry.id)}>{t("guide.next")}</Button>
    </div>}
  </div>;
}

/**
 * Every balloon's head: the guide's name and its three steps by name, the current one stressed and those behind it
 * checked, so wherever it is the whole of it can be read; on a phone, the current step alone with how far along it is.
 */
function BalloonHead({ step }: { step: GuideEntry["step"] }) {
  const { t } = useTranslation("tree");
  const narrow = useNarrow();
  const tt = t as TFunction;
  if (narrow) return <p className="m-0 flex-1 pt-2 text-xs opacity-80">
    <span className="font-medium">{t("guide.name")}</span>
    {step && <><span className="ml-1.5 tabular-nums">{t("guide.progress", { step })}</span><span className="ml-1.5 font-semibold opacity-100">{STEPS[step].title(tt)}</span></>}
  </p>;
  return <ol aria-label={t("guide.name")} className="m-0 flex flex-1 list-none flex-wrap items-center gap-x-1.5 gap-y-0.5 p-0 pt-2 text-xs">
    <li aria-hidden="true" className="mr-1 font-medium opacity-80">{t("guide.name")}</li>
    {STEP_NUMBERS.map(at => {
      const now = at === step, done = step === null || at < step;
      return <li key={at} aria-current={now ? "step" : undefined} className={cn("flex items-center gap-1.5", now ? "font-semibold" : "opacity-65")}>
        {at > 1 && <span aria-hidden="true" className="opacity-60">›</span>}
        <span aria-hidden="true" className={cn("flex size-4 items-center justify-center rounded-full text-[0.625rem] tabular-nums", now ? "bg-bg text-ink" : "border border-bg/50")}>
          {done ? <Icon name="check" className="size-2.5" /> : at}</span>
        {done && <span className="sr-only">{t("guide.stepDone")}</span>}{STEPS[at].title(tt)}
      </li>;
    })}
  </ol>;
}
