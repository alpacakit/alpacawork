import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { TAB, TabLabel, TabMarker } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { subscribeStep } from "@/state/history-step";
import { comparison, parts, type Kind } from "./format";
import type { Bucket } from "./contract";

/**
 * How the analysis is drawn, kept while the page stands (not in the URL: Back does not undo them): the step of time
 * on the charts, how each look is broken down, which value the use chart draws, whether a table shows every row and
 * whether the counting rules are open. `grow` says the next drawing of the charts grows their bars.
 */
export type TaskGroup = "model" | "agent" | "project";
export type UsageGroup = "model" | "agent" | "skill" | "tool" | "mcp";
export type UsageMetric = "launches" | "runMs" | "newConversations" | "output" | "input" | "cache";
type Choices = { bucket: Bucket; taskGroup: TaskGroup; usageGroup: UsageGroup; metric: UsageMetric; all: boolean; rules: boolean; grow: number };
export const useChoices = create<Choices & { choose: (next: Partial<Choices>) => void }>((set) => ({
  bucket: "day", taskGroup: "model", usageGroup: "model", metric: "launches", all: false, rules: false, grow: 0,
  choose: (next) => set(next),
}));

/**
 * One shape for every switch here, the app's own tab row: 28px high, 6px corners, the chosen one bold on the grey
 * ground that slides to it.
 */
export function Seg<K extends string>({ label, items, value, onChange, onAgain, className }: {
  label: string; items: readonly (readonly [K, string])[]; value: K; onChange: (next: K) => void;
  /** What pressing the chosen one does, when it does something. */
  onAgain?: () => void; className?: string;
}) {
  // Where it does not fit (a phone, a longer language) it scrolls sideways inside itself, as the app's tab rows do.
  return <div role="group" aria-label={label} className={cn("relative flex max-w-full min-w-0 flex-none items-center gap-0.5 overflow-x-auto [scrollbar-width:none]", className)}>
    <TabMarker current='[aria-current="true"]' />
    {items.map(([key, name]) => <button key={key} type="button" aria-current={key === value ? "true" : undefined}
      onClick={() => key !== value ? onChange(key) : onAgain?.()}
      className={cn(TAB, "aria-[current=true]:font-semibold aria-[current=true]:text-ink")}><TabLabel>{name}</TabLabel></button>)}
  </div>;
}

/** A small square of a chart's colour before a name: the legend and the name at once. */
export const Square = ({ className }: { className: string }) =>
  <i aria-hidden className={cn("me-1.5 inline-block size-2 flex-none rounded-xs", className)} />;

/** A value with its unit drawn small beside it; pressed, it opens the tasks behind it. */
export function Value({ kind, value, big, onOpen }: { kind: Kind; value: number | null; big?: boolean; onOpen?: () => void }) {
  const written = value === null ? { value: "—", unit: "" } : parts(kind, value);
  const body = <>
    <b className={cn("font-semibold", big ? "text-display" : "text-xl")}>{written.value}</b>
    {written.unit && <span className="text-muted">{written.unit}</span>}
  </>;
  const shape = "inline-flex items-baseline gap-0.5 whitespace-nowrap rounded-sm";
  if (!onOpen || !value) return <span className={shape}>{body}</span>;
  // A number that opens its tasks says so at rest, on a phone and at first sight alike: underlined, and the chevron the
  // list's headings open with after its unit. Pointed at, the line takes the ink.
  return <button type="button" onClick={onOpen}
    className={cn(shape, "group/open underline decoration-lit-line decoration-1 underline-offset-5 transition-[text-decoration-color] hover:decoration-ink active:translate-y-px")}>
    {body}<Icon name="right" className={cn("self-center text-soft group-hover/open:text-ink", big ? "size-4" : "size-3")} /></button>;
}

/** The line under a number: the same span just before, and the gap. */
export function Compare({ kind, value, previous, length, children }: { kind: Kind; value: number; previous: number | null; length: number; children?: ReactNode }) {
  const line = comparison(kind, value, previous, length);
  // The span before and the gap each stay whole; where a language makes them long, the gap goes under.
  return <div className="flex flex-wrap gap-x-2.5 text-xs text-soft">
    <span className="whitespace-nowrap">{children ?? line.before}</span>{line.gap && <b className="font-normal whitespace-nowrap text-muted">{line.gap}</b>}
  </div>;
}

/** A number: its name, the value, and the span before on one line. */
export function Num({ label, square, kind, value, previous, length, onOpen, after }: {
  label: string; square?: string; kind: Kind; value: number | null; previous: number | null; length: number; onOpen?: () => void; after?: ReactNode;
}) {
  return <div className="w-43 min-w-0 narrow:w-auto">
    <div className="flex items-center text-xs whitespace-nowrap text-muted">{square && <Square className={square} />}{label}</div>
    <Value kind={kind} value={value} onOpen={value ? onOpen : undefined} />
    {value === null ? <div className="text-xs text-soft">&nbsp;</div> : <Compare kind={kind} value={value} previous={previous} length={length} />}
    {after}
  </div>;
}

/** The link that opens the counting rules under the first number of a look. */
export function RulesToggle() {
  const { t } = useTranslation("analysis");
  const open = useChoices(state => state.rules);
  return <button type="button" aria-expanded={open} onClick={() => useChoices.getState().choose({ rules: !open })}
    className="ms-2.5 text-xs whitespace-nowrap text-soft underline decoration-line underline-offset-4 hover:text-ink hover:decoration-ink aria-expanded:text-ink aria-expanded:decoration-ink">
    {t("tasks.howCounted")}
  </button>;
}
export function RulesBox({ children }: { children: ReactNode }) {
  return <div className="mt-3 mb-1 max-w-[44em] animate-rise rounded-lg border border-line px-3.5 py-3 text-xs text-muted [&_b]:font-semibold [&_b]:text-ink [&_p+p]:mt-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:ps-[1.4em]">{children}</div>;
}

/** A section under a rule, its name on the left and its switch on the right. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="mt-12 border-t border-rule pt-6">
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2"><h2 className="me-auto text-md font-semibold">{title}</h2>{aside}</div>
    {children}
  </section>;
}

/** A mark says its value in a small window under the pointer (`PointerTip`), and the same words to a screen reader. */
export const tip = (words: string) => ({ "data-tip": words, "aria-label": words });

/** The small window under the pointer, for every mark inside the analysis that says its value (`tip`). */
export function PointerTip({ root }: { root: HTMLElement | null }) {
  const [shown, setShown] = useState<{ words: string; x: number; top: number; bottom: number } | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root) return;
    // A move to another step (Back, a row opened) takes away what it said: it was about what is no longer shown.
    const stopStep = subscribeStep(() => setShown(null));
    const place = (mark: HTMLElement) => {
      const box = mark.getBoundingClientRect();
      setShown({ words: mark.dataset.tip!, x: box.left + box.width / 2, top: box.top, bottom: box.bottom });
    };
    // Under a finger there is no pointing: a mark that says only its value (`data-tip-tap`) says it when pressed.
    if (matchMedia("(hover: none)").matches) {
      const press = (event: MouseEvent) => {
        const mark = (event.target as Element | null)?.closest?.<HTMLElement>("[data-tip-tap][data-tip]");
        if (mark) place(mark); else setShown(null);
      };
      root.addEventListener("click", press);
      return () => { stopStep(); root.removeEventListener("click", press); };
    }
    const over = (event: MouseEvent) => {
      const mark = (event.target as Element | null)?.closest?.<HTMLElement>("[data-tip]");
      if (!mark?.dataset.tip) { setShown(null); return; }
      place(mark);
    };
    // Leaving for the window itself (to scroll one too tall for the screen) keeps it.
    const out = (event: MouseEvent) => { if (!tip.current?.contains(event.relatedTarget as Node | null)) setShown(null); };
    root.addEventListener("mouseover", over);
    root.addEventListener("mouseleave", out);
    return () => { stopStep(); root.removeEventListener("mouseover", over); root.removeEventListener("mouseleave", out); };
  }, [root]);
  return shown && <TipBox {...shown} tipRef={tip} onLeave={() => setShown(null)} />;
}
/**
 * Where a small window stands, the one rule for all of them (the time band, the calendar, the charts): above its mark
 * where it fits, else under it, else on the side with more room, its height held to that room (the rest scrolls inside
 * it). It never reaches past the screen.
 */
export function tipPlace({ top, bottom, height, screen, margin = 4, gap = 6 }: { top: number; bottom: number; height: number; screen: number; margin?: number; gap?: number }) {
  const above = top - gap - margin, below = screen - bottom - gap - margin;
  if (height <= above) return { top: top - gap - height, maxHeight: null };
  if (height <= below) return { top: bottom + gap, maxHeight: null };
  return above > below ? { top: margin, maxHeight: Math.max(0, above) } : { top: bottom + gap, maxHeight: Math.max(0, below) };
}
function TipBox({ words, x, top, bottom, tipRef, onLeave }: { words: string; x: number; top: number; bottom: number;
  tipRef: React.RefObject<HTMLDivElement | null>; onLeave: () => void }) {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const self = tipRef.current;
    if (!self) return;
    self.style.maxHeight = "";
    const width = self.offsetWidth, place = tipPlace({ top, bottom, height: self.offsetHeight, screen: innerHeight });
    self.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, x - width / 2))}px`;
    self.style.top = `${place.top}px`;
    if (place.maxHeight !== null) self.style.maxHeight = `${place.maxHeight}px`;
    setScrolls(place.maxHeight !== null);
  }, [words, x, top, bottom, tipRef]);
  // One that scrolls takes the pointer and the finger, so what is past its height can be read.
  return <div ref={tipRef} role="presentation" style={{ left: x, top }} onMouseLeave={onLeave}
    className={cn("fixed z-(--layer-popover) max-w-[calc(100vw-8px)] overflow-y-auto overscroll-contain rounded-md border border-line bg-raised px-2 py-1 text-xs whitespace-pre-line shadow-float",
      !scrolls && "pointer-events-none")}>{words}</div>;
}

/**
 * Where an answer is drawn: one not read for what is chosen now (`Answer.current`) is dimmed and out of reach until the
 * current one comes, so a press never opens something other than what is shown.
 */
export function Shown({ current, className, children }: { current: boolean; className?: string; children: ReactNode }) {
  return <div inert={!current} data-answer={current ? "current" : "other"}
    className={cn("transition-opacity duration-(--motion-base)", !current && "opacity-60", className)}>{children}</div>;
}
