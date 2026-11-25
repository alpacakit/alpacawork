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
type Choices = { bucket: Bucket; taskGroup: TaskGroup; usageGroup: UsageGroup; all: boolean; rules: boolean; grow: number };
export const useChoices = create<Choices & { choose: (next: Partial<Choices>) => void }>((set) => ({
  bucket: "day", taskGroup: "model", usageGroup: "model", all: false, rules: false, grow: 0,
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

/**
 * Whatever opens tasks says so with one mark everywhere (the lead numbers, a row's numbers, a day's legend, the tables):
 * a faint › after it, at rest too, as a finger has no pointing to find it by. Pointed at or reached with the keys, it
 * stands on a ground and is underlined.
 */
export const OPEN = "group/open inline-flex items-baseline gap-0.5 whitespace-nowrap rounded-sm -mx-1 px-1 decoration-ink underline-offset-4 hover:bg-hover hover:underline focus-visible:underline active:translate-y-px";
/** The › of what opens tasks: faint at rest, in ink while pointed at (`OPEN`'s group). */
export const OpenMark = ({ big }: { big?: boolean }) =>
  <Icon name="right" aria-hidden className={cn("flex-none self-center text-soft opacity-70 group-hover/open:text-ink group-hover/open:opacity-100", big ? "size-4" : "size-3")} />;

/**
 * A value with its unit drawn small beside it; pressed, it opens the tasks behind it. Its sizes are the analysis's
 * steps of type: a lead number (`big`, 36px), a row's number (20px), and one among names (`small`, 13px).
 */
export function Value({ kind, value, big, small, onOpen }: { kind: Kind; value: number | null; big?: boolean; small?: boolean; onOpen?: () => void }) {
  const written = value === null ? { value: "—", unit: "" } : parts(kind, value);
  const body = <>
    <b className={cn("font-semibold tabular-nums decoration-ink underline-offset-4 group-hover/open:underline group-focus-visible/open:underline", big ? "text-display" : small ? "text-sm" : "text-xl")}>{written.value}</b>
    {written.unit && <span className={cn("text-muted", small ? "text-xs" : "text-sm")}>{written.unit}</span>}
  </>;
  // One that could open tasks but has none (0) keeps the room of the mark, so a column of numbers stays one column.
  if (!onOpen || !value) return <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">{body}{onOpen && <i aria-hidden className={cn("inline-block flex-none", big ? "size-4" : "size-3")} />}</span>;
  return <button type="button" onClick={onOpen} className={OPEN}>{body}<OpenMark big={big} /></button>;
}

/** The line under a number: the same span just before, and the gap. */
/**
 * The line under a number: the same span just before, and the gap; nothing when there is no span before to compare with.
 * A gap whose direction says better or worse (`better`: which way is better) is green that way and orange the other.
 */
export function Compare({ kind, value, previous, length, better }: { kind: Kind; value: number; previous: number | null; length: number; better?: "up" | "down" }) {
  const line = comparison(kind, value, previous, length);
  if (!line) return null;
  return <div className="flex flex-wrap gap-x-2.5 text-xs text-soft">
    <span className="whitespace-nowrap">{line.before}</span>{line.gap && <b className={cn("font-normal whitespace-nowrap", gapTone(value, previous!, better))}>{line.gap}</b>}
  </div>;
}
/** The colour of a gap: green toward better, orange toward worse, grey when the direction says neither (or no change). */
export const gapTone = (value: number, previous: number, better?: "up" | "down") =>
  !better || value === previous ? "text-muted" : (value > previous) === (better === "up") ? "text-done" : "text-turn";

/** A number: its name, the value, and the span before on one line. */
export function Num({ label, square, kind, value, previous, length, onOpen, after, className = "w-43 narrow:w-auto" }: {
  label: string; square?: string; kind: Kind; value: number | null; previous: number | null; length: number; onOpen?: () => void; after?: ReactNode; className?: string;
}) {
  return <div className={cn("min-w-0", className)}>
    <div className="mb-1 flex items-center text-sm whitespace-nowrap text-muted">{square && <Square className={square} />}{label}</div>
    <Value kind={kind} value={value} onOpen={value ? onOpen : undefined} />
    {value !== null && <Compare kind={kind} value={value} previous={previous} length={length} />}
    {after}
  </div>;
}

/**
 * The head of a look's charts, under the rule that parts them from the lead numbers: how the numbers are counted on the
 * left (it opens the rules under it), the step of time of every chart on the right, over the charts it steps.
 */
export function ChartHead() {
  const { t } = useTranslation("analysis");
  const { bucket, grow, rules } = useChoices();
  return <div className="mt-8 flex items-center justify-between gap-4 border-t border-rule pt-4">
    {/* It opens the rules under it, as the app's other disclosures do: a chevron that turns as it opens. */}
    <button type="button" aria-expanded={rules} onClick={() => useChoices.getState().choose({ rules: !rules })}
      className="group -ms-2 inline-flex h-7 items-center gap-1 rounded-md ps-2 pe-1.5 text-sm whitespace-nowrap text-muted hover:bg-hover hover:text-ink aria-expanded:text-ink">
      {t("tasks.howCounted")}
      <Icon name="down" aria-hidden className="size-3.5 transition-transform duration-(--motion-base) group-aria-expanded:rotate-180" />
    </button>
    <Seg label={t("bucket.label")} value={bucket} onChange={next => useChoices.getState().choose({ bucket: next, grow: grow + 1 })}
      items={[["day", t("bucket.day")], ["week", t("bucket.week")], ["month", t("bucket.month")]]} />
  </div>;
}
/** The counting rules: a name and what it counts, one to a line, the names in a column of their own. */
export function RulesBox({ children }: { children: ReactNode }) {
  // Japanese breaks between phrases, not inside a word (auto-phrase reads the page's language).
  return <dl className="mt-3 mb-1 grid max-w-[52em] animate-rise grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-1.5 rounded-lg border border-line px-4 py-3.5 text-sm text-muted [word-break:auto-phrase] narrow:grid-cols-1 narrow:gap-y-0.5 [&_dd+dt]:narrow:mt-2 [&_dt]:font-semibold [&_dt]:text-ink [&_ul]:mt-1 [&_ul]:list-disc [&_ul]:ps-[1.4em]">{children}</dl>;
}
/** One counting rule: its name, then what it counts. */
export const Rule = ({ name, children }: { name: string; children: ReactNode }) => <><dt>{name}</dt><dd>{children}</dd></>;

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
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stay = () => { if (leaving.current) clearTimeout(leaving.current); leaving.current = null; };
  // Closing waits a moment, so the pointer can cross from a mark to its window (to scroll a tall one) without losing it.
  const hideSoon = () => { stay(); leaving.current = setTimeout(() => { leaving.current = null; setShown(null); }, TIP_LEAVE_MS); };
  useEffect(() => {
    if (!root) return;
    let mark: HTMLElement | null = null;
    const hide = () => { stay(); mark = null; setShown(null); };
    // A move to another step (Back, a row opened) takes away what it said: it was about what is no longer shown.
    const stopStep = subscribeStep(hide);
    const place = (next: HTMLElement) => {
      stay(); mark = next;
      const box = next.getBoundingClientRect();
      setShown({ words: next.dataset.tip!, x: box.left + box.width / 2, top: box.top, bottom: box.bottom });
    };
    // The screen resized: the window is placed again by its mark where it now stands.
    const resized = () => { if (mark?.isConnected) place(mark); else if (mark) hide(); };
    addEventListener("resize", resized);
    const stop = () => { stay(); stopStep(); removeEventListener("resize", resized); };
    // Under a finger there is no pointing: a mark that says only its value (`data-tip-tap`) says it when pressed.
    if (matchMedia("(hover: none)").matches) {
      const press = (event: MouseEvent) => {
        const next = (event.target as Element | null)?.closest?.<HTMLElement>("[data-tip-tap][data-tip]");
        if (next) place(next); else hide();
      };
      root.addEventListener("click", press);
      return () => { stop(); root.removeEventListener("click", press); };
    }
    const over = (event: MouseEvent) => {
      const next = (event.target as Element | null)?.closest?.<HTMLElement>("[data-tip]");
      if (next?.dataset.tip) place(next); else hideSoon();
    };
    // Leaving for the window itself keeps it (its own enter may come first, so this one must not undo it).
    const leave = (event: MouseEvent) => { if (!tip.current?.contains(event.relatedTarget as Node | null)) hideSoon(); };
    root.addEventListener("mouseover", over);
    root.addEventListener("mouseleave", leave);
    return () => { stop(); root.removeEventListener("mouseover", over); root.removeEventListener("mouseleave", leave); };
  }, [root]);
  return shown && <TipBox {...shown} tipRef={tip} onEnter={stay} onLeave={hideSoon} />;
}
export const TIP_LEAVE_MS = 200;
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
/**
 * Where a day's window stands beside the bar pointed at (the same rule held sideways): right of it where it fits, else
 * left; level with the bar's top, moved up as far as it must to stay on the screen, its height held to the screen.
 */
export function tipBeside({ left, right, top, width, height, screenWidth, screenHeight, margin = 4, gap = 8 }: {
  left: number; right: number; top: number; width: number; height: number; screenWidth: number; screenHeight: number; margin?: number; gap?: number;
}) {
  const x = right + gap + width <= screenWidth - margin ? right + gap : Math.max(margin, left - gap - width);
  const room = screenHeight - 2 * margin;
  const y = Math.max(margin, Math.min(top, screenHeight - margin - Math.min(height, room)));
  return { left: x, top: y, maxHeight: height > room ? room : null };
}
/**
 * Where a pressed bin's window stands: over or under the bin, on the side with more room, centred on it and kept on the
 * screen, so the bins beside it stay in sight; only where neither side holds it, beside the bin (`tipBeside`).
 */
export function tipAround({ left, right, top, bottom, width, height, screenWidth, screenHeight, margin = 4, gap = 8 }: {
  left: number; right: number; top: number; bottom: number; width: number; height: number; screenWidth: number; screenHeight: number; margin?: number; gap?: number;
}) {
  const above = top - gap - margin, below = screenHeight - bottom - gap - margin;
  const x = Math.max(margin, Math.min(screenWidth - margin - width, (left + right) / 2 - width / 2));
  if (height <= Math.max(above, below)) return { left: x, top: above >= below ? top - gap - height : bottom + gap, maxHeight: null };
  return tipBeside({ left, right, top, width, height, screenWidth, screenHeight, margin, gap });
}
function TipBox({ words, x, top, bottom, tipRef, onEnter, onLeave }: { words: string; x: number; top: number; bottom: number;
  tipRef: React.RefObject<HTMLDivElement | null>; onEnter: () => void; onLeave: () => void }) {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const self = tipRef.current;
    if (!self) return;
    // Measured at the screen's left with no height held, so a mark near the right edge keeps the window its own width.
    self.style.maxHeight = ""; self.style.left = "0px";
    const width = self.offsetWidth, place = tipPlace({ top, bottom, height: self.offsetHeight, screen: innerHeight });
    self.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, x - width / 2))}px`;
    self.style.top = `${place.top}px`;
    if (place.maxHeight !== null) self.style.maxHeight = `${place.maxHeight}px`;
    setScrolls(place.maxHeight !== null);
  }, [words, x, top, bottom, tipRef]);
  // One that scrolls takes the pointer and the finger, so what is past its height can be read.
  return <div ref={tipRef} role="presentation" style={{ left: x, top }} onMouseEnter={onEnter} onMouseLeave={onLeave}
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
