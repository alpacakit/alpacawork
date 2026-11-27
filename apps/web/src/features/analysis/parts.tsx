import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AgentMark, INLINE_MARK } from "@/components/ui/agent-mark";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { TAB, TabLabel, TabMarker } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ReadFailure, ReadNote } from "@/components/ui/loadable";
import { useOfflineShown } from "@/data/reach";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { Caret, DisclosureSummary } from "@/components/ui/caret";
import { subscribeStep } from "@/state/history-step";
import { useNarrow } from "@/state/view-store";
import { comparison, parts, type Kind } from "./format";
import type { AnalysisModel } from "@alpacawork/contract/analysis";
import type { Bucket } from "./contract";
import { NO_FILTER, type LaunchFilter, type SeriesBy } from "./series";

/**
 * How the analysis is drawn, kept while the page stands (not in the URL: Back does not undo them): the step of time
 * on the charts, how each look is broken down, which value the use chart draws, whether a table shows every row and
 */
export type TaskGroup = "model" | "agent" | "project";
export type UsageGroup = "model" | "agent" | "skill" | "tool" | "mcp";
/** What the calls row of the use counts. */
export type CallsBy = "skill" | "tool" | "mcp";
/**
 * `launchBy`, `launchFilter`: what the launches chart is coloured by, and the model and effort it is filtered to.
 * `callsBy`: whether the calls row counts skills, tools or MCP.
 */
type Choices = { bucket: Bucket; taskGroup: TaskGroup; usageGroup: UsageGroup; all: boolean; launchBy: SeriesBy; launchFilter: LaunchFilter; callsBy: CallsBy };
export const useChoices = create<Choices & { choose: (next: Partial<Choices>) => void }>((set) => ({
  bucket: "day", taskGroup: "model", usageGroup: "model", all: false, launchBy: "model", launchFilter: NO_FILTER, callsBy: "skill",
  choose: (next) => set(next),
}));

/**
 * One shape for every switch here, the app's own tab row: 28px high, 6px corners, the chosen one bold on the grey
 * ground that slides to it.
 */
export function Seg<K extends string>({ label, items, value, onChange, onAgain, className, disabled }: {
  label: string; items: readonly (readonly [K, string])[]; value: K; onChange: (next: K) => void;
  /** What pressing the chosen one does, when it does something. */
  onAgain?: () => void; className?: string;
  /** Those that cannot be chosen now (a number with no value): drawn faint, out of reach. */
  disabled?: readonly K[];
}) {
  // It stays within the width it has: where its choices do not fit on one line (a narrow phone, a longer language) they
  // go on to the next, and the chosen one's ground follows (TabMarker places it by its line too). Nothing scrolls sideways.
  return <div role="group" aria-label={label} className={cn("relative flex max-w-full min-w-0 flex-none flex-wrap items-center gap-x-0.5 gap-y-1", className)}>
    <TabMarker current='[aria-current="true"]' />
    {items.map(([key, name]) => <button key={key} type="button" aria-current={key === value ? "true" : undefined}
      disabled={disabled?.includes(key)}
      onClick={() => key !== value ? onChange(key) : onAgain?.()}
      className={cn(TAB, "text-base aria-[current=true]:font-semibold aria-[current=true]:text-ink disabled:cursor-default disabled:opacity-38 disabled:hover:text-muted")}><TabLabel>{name}</TabLabel></button>)}
  </div>;
}

/**
 * A model as the analysis names it: its name as it is, then the effort it ran at, small and faint as a unit is, with
 * no brackets. The card writes it the same way (card-draw.ts).
 */
export const ModelName = ({ model }: { model: AnalysisModel }) =>
  <><AgentMark model={model.name} className={INLINE_MARK} />{model.name}{model.effort && <span className="ms-1 text-xs text-soft">{model.effort}</span>}</>;

/**
 * A breakdown's row by its name: a task no AI was given says so, a model is named as `ModelName` names it, any other
 * by its label, with the AI's mark before a model or (`agent`, a breakdown by agent) an agent. The tables and the list a
 * row opens name it so alike.
 */
export const rowName = (row: { label: string; model?: { name: string } | AnalysisModel; noOwnerRun?: true }, noAgent: string, agent = false): ReactNode =>
  row.noOwnerRun ? noAgent : row.model && "effort" in row.model ? <ModelName model={row.model} />
    : row.model || agent ? <><AgentMark name={row.model ? undefined : row.label} model={row.model?.name} className={INLINE_MARK} />{row.label}</>
    : row.label;

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
    <b className={cn("font-semibold tabular-nums decoration-ink underline-offset-4 group-hover/open:underline group-focus-visible/open:underline", big ? "text-figure narrow:text-figure-compact" : small ? "text-base" : "text-heading")}>{written.value}</b>
    {written.unit && <span className="text-base text-muted">{written.unit}</span>}
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
    <div className="mb-1 flex items-center text-base whitespace-nowrap text-muted">{square && <Square className={square} />}{label}</div>
    <Value kind={kind} value={value} onOpen={value ? onOpen : undefined} />
    {value !== null && <Compare kind={kind} value={value} previous={previous} length={length} />}
    {after}
  </div>;
}

/**
 * The head of a look's charts: on the left the way down to how the numbers are counted (the cards under the breakdown,
 * `Rules`), on the right the step of time of every chart, over the charts it steps.
 */
export function ChartHead() {
  const { t } = useTranslation("analysis");
  const { bucket } = useChoices();
  return <div className="mt-14 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 narrow:mt-10">
    {/* A way to a place on the page, not a way into tasks (no ›): pressed, the rules come into view and take the focus. */}
    <a href={`#${RULES}`} onClick={event => { event.preventDefault(); toRules(); }}
      className="-ms-1 rounded-sm px-1 text-base whitespace-nowrap text-muted decoration-ink underline-offset-4 hover:bg-hover hover:text-ink hover:underline">
      {t("tasks.howCounted")}</a>
    <Seg label={t("bucket.label")} value={bucket} onChange={next => useChoices.getState().choose({ bucket: next })}
      items={[["day", t("bucket.day")], ["week", t("bucket.week")], ["month", t("bucket.month")]]} />
  </div>;
}
/** Where the counting rules stand, by the id of their heading. */
const RULES = "analysis-rules";
/** Brings the counting rules into view, open, and gives their heading the focus (read out, and the keys go on from there). */
function toRules() {
  const heading = document.getElementById(RULES);
  const folded = heading?.closest("details");
  if (folded) folded.open = true;
  heading?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  heading?.focus({ preventScroll: true });
}
/**
 * How the numbers are counted, under the breakdown: a heading, then cards of rules that belong together, in the order
 * the rows show them (three across, two on a narrower page, one on a phone). Each card is a list of names and what each
 * counts. Open on a computer; on a phone, where the cards run to screens of their own, folded under the heading until
 * it (or the way down to it at the charts' head) is pressed.
 */
export function Rules({ children }: { children: ReactNode }) {
  const { t } = useTranslation("analysis");
  const narrow = useNarrow();
  const heading = <h2 id={RULES} tabIndex={-1} className="scroll-mt-[calc(var(--bar-h)+1.5rem)] text-heading font-semibold outline-none">{t("tasks.howCounted")}</h2>;
  const cards = <div className="mt-4 grid grid-cols-3 items-start gap-6 @max-5xl:grid-cols-2 narrow:grid-cols-1 narrow:gap-3">{children}</div>;
  return <section aria-labelledby={RULES} className="mt-16 narrow:mt-12">
    {narrow
      ? <details className="group/rules">
        <DisclosureSummary className="min-h-11 gap-2"><Caret className="group-open/rules:rotate-90" />{heading}</DisclosureSummary>
        {cards}</details>
      : <>{heading}{cards}</>}
  </section>;
}
/** A card of rules that belong together: each name over what it counts. */
export function RuleCard({ children }: { children: ReactNode }) {
  // Japanese breaks between phrases, not inside a word (auto-phrase reads the page's language).
  return <dl className="grid gap-y-1 rounded-lg border border-rule px-6 py-5 text-base text-muted [word-break:auto-phrase] narrow:p-4 [&_dd_p]:mt-1 [&_dd_p]:text-xs [&_dt]:font-semibold [&_dt]:text-ink [&_dt:not(:first-child)]:mt-3 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:ps-[1.4em]">{children}</dl>;
}
/** One counting rule: its name, then what it counts. */
export const Rule = ({ name, children }: { name: string; children: ReactNode }) => <><dt>{name}</dt><dd>{children}</dd></>;

/** A section under a rule, its name on the left and its switch on the right. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="mt-16 narrow:mt-12">
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2"><h2 className="me-auto text-heading font-semibold">{title}</h2>{aside}</div>
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

/** A read a part of the analysis draws from: its answer, or that it is on its way or could not be read. */
export type PartRead<T> = { data: T | undefined; isPlaceholderData: boolean; isError: boolean; error: Error | null; refetch: () => unknown };
/**
 * What a part shows of its reads: one set, every answer in it for the same choice. The set is whole when every read has
 * its own answer for what is chosen now, wherever the person came from; a stand-in answer (a placeholder, the last
 * choice's) is for some earlier choice, so a set with one is never shown as it is. While a choice's answers come in, the
 * last whole set of this `kind` (what the reads are for, as a look) stands as it was (dimmed, `current` false) and the
 * new one replaces it at once when all of it has come: no answer of one choice is ever drawn beside another's. A single
 * read's stand-in is one choice's whole answer, so it stands in too.
 */
export type ReadSet = { data: readonly unknown[] | null; current: boolean; reads: readonly PartRead<unknown>[] };
export function useReadSet(kind: string, reads: readonly PartRead<unknown>[]): ReadSet {
  const held = useRef(new Map<string, readonly unknown[]>());
  const whole = reads.every(read => read.data !== undefined && !read.isPlaceholderData);
  const answers = reads.map(read => read.data);
  if (whole) held.current.set(kind, answers);
  const kept = held.current.get(kind) ?? (reads.length === 1 && reads[0]!.data !== undefined ? answers : null);
  return { data: whole ? answers : kept, current: whole, reads };
}

/**
 * Every part of the analysis (the face, a breakdown, a list, a task's values) stands in its place by one rule, whatever
 * it waits for: drawn from its whole set of answers (`useReadSet`; one for an earlier choice dimmed and out of reach until
 * the new one has wholly come, `Shown`); until it has one, its own shape (`skeleton`), never nothing, so nothing is put in
 * above what is drawn later; any read for what is chosen now that could not be read said in its place as every read says
 * it, with a way to ask again, even while an earlier set stands (it would not be replaced); and, offline, what was never
 * read said as the list of tasks says it (ReadNote), not a wait that cannot end.
 */
export function ReadPart({ set, skeleton, children }: { set: ReadSet; skeleton: ReactNode; children: (data: readonly unknown[]) => ReactNode }) {
  const offline = useOfflineShown();
  const failed = set.current ? undefined : set.reads.find(read => read.isError);
  if (failed) return <ReadFailure error={failed.error} retry={() => {
    for (const read of set.reads) if (read.isError || read.data === undefined || read.isPlaceholderData) void read.refetch();
  }} />;
  if (set.data) return <Shown current={set.current}>{children(set.data)}</Shown>;
  if (offline) return <ReadNote kind="absent" />;
  return <>{skeleton}</>;
}

/**
 * Where an answer is drawn: one not read for what is chosen now (`Answer.current`) is dimmed and out of reach until the
 * current one comes, so a press never opens something other than what is shown.
 */
export function Shown({ current, className, children }: { current: boolean; className?: string; children: ReactNode }) {
  return <div inert={!current} data-answer={current ? "current" : "other"}
    className={cn("transition-opacity duration-(--motion-base)", !current && "opacity-60", className)}>{children}</div>;
}
