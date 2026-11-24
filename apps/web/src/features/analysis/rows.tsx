import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { subscribeStep } from "@/state/history-step";
import { daysBetween, dayLabel, monthLabel, numberText, spanLabel, ticks, weekday } from "./format";
import { axisLabels } from "./charts";
import { tipBeside } from "./parts";
import { Icon } from "@/components/ui/icon";
import type { Bucket, Group, ListSet, ListValue } from "./contract";

/**
 * The analysis laid out on one grid: 12 columns, 24px apart (a phone stacks them). A row gives its left 3 columns to a
 * name and its numbers and its right 9 to a chart; every chart of a group stands on the same days, so one day can be
 * read down all of them. Pointed at, a day lights in every chart of the group, and one small window beside it says
 * every row's value for it.
 */
export type Bin = { from: string; to: string; complete: boolean };
type Days = { from: string; to: string };

/** The grid's columns: the rows' and the lead numbers'. */
export const GRID = "grid grid-cols-12 gap-x-6 narrow:block";
export const LEFT = "col-span-3", RIGHT = "col-span-9 min-w-0";

/** Four numbers across the top, three columns each; on a phone two by two. */
export function Leads({ children }: { children: ReactNode }) {
  // Each number spans four shared rows (its name, value, the span before, the whole record), so neighbours' lines stand
  // level even where one of them wraps; a phone's second pair stands a step below the first.
  return <div className="grid grid-cols-4 gap-x-6 narrow:grid-cols-2 narrow:gap-x-3 [&>*:nth-child(n+3)]:narrow:mt-5">{children}</div>;
}

/**
 * A lead number: its name, the value large on a line of one height (so the four stand level whatever is beside a value),
 * the span before, and the whole record so far (`ever`; left out when the span is the whole record).
 */
export function Lead({ name, value, beside, compare, ever }: { name: ReactNode; value: ReactNode; beside?: ReactNode; compare: ReactNode; ever?: string | null }) {
  const { t } = useTranslation("analysis");
  return <div className="row-span-4 grid min-w-0 grid-rows-subgrid">
    <div className="flex min-w-0 flex-wrap items-center text-xs text-muted">{name}</div>
    <div className="flex h-[45px] min-w-0 items-center gap-5 narrow:h-[33px] narrow:gap-3">{value}{beside}</div>
    <div className="min-w-0">{compare}</div>
    <div className="text-xs text-soft">{ever && t("lead.ever", { value: ever })}</div>
  </div>;
}

/**
 * The parts of a row's whole, each its colour, name and number (a way into its tasks) and, where it means something, its
 * share of the whole; then the row's per-task line (─●), its value and its gap to the span before.
 */
export function Parts({ items = [], line }: { items?: { color: string; name: string; value: ReactNode; share?: string }[];
  line?: { name: string; value: ReactNode; gap?: ReactNode } }) {
  return <div className="mt-2 grid w-max grid-cols-[max-content_max-content_max-content] items-baseline gap-x-4 gap-y-1 narrow:flex narrow:w-auto narrow:flex-wrap narrow:gap-x-4">
    {items.map(item => <div key={item.name} className="contents narrow:flex narrow:items-baseline narrow:gap-2">
      <span className="flex items-center text-base whitespace-nowrap text-muted">{item.color && <i aria-hidden className={cn("me-2 inline-block size-2 flex-none rounded-xs", item.color)} />}{item.name}</span>
      <span className="text-base">{item.value}</span>
      <span className="text-xs text-soft tabular-nums">{item.share ?? ""}</span>
    </div>)}
    {line && <div className="contents narrow:flex narrow:w-full narrow:items-baseline narrow:gap-2">
      <span className={cn("flex items-center text-base whitespace-nowrap text-muted", items.length > 0 && "mt-2 narrow:mt-1")}><LineMark />{line.name}</span>
      <span className={cn("text-base", items.length > 0 && "mt-2 narrow:mt-1")}>{line.value}</span>
      <span className={cn("text-xs", items.length > 0 && "mt-2 narrow:mt-1")}>{line.gap}</span>
    </div>}
  </div>;
}

/** A row of the grid: a rule above it, its name and numbers on the left, its chart on the right. */
export function Row({ left, children, className }: { left: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={cn(GRID, "border-t border-rule py-4 narrow:py-3.5", className)}>
    <div className={cn(LEFT, "min-w-0")}>{left}</div>
    {children && <div className={cn(RIGHT, "narrow:mt-3")}>{children}</div>}
  </div>;
}

/** A row's name, in the small grey type of every name. */
export const RowName = ({ children }: { children: ReactNode }) => <div className="text-xs text-muted">{children}</div>;

/* ── one group of charts on the same days: what is pointed at, and the window that says it ── */
/**
 * What a row says of one of its days, in the window beside it: the row's name and total, its parts in the colours it
 * draws them in (with their share where it means something), its per-task line and that line's base, and the tasks a
 * press opens (`list`, for the bin's days).
 */
export type RowSay = {
  name: string; total: (at: number) => string;
  /** Its parts, each with the tasks of that part a press opens (`list`, for the bin's days). */
  parts?: (at: number) => { color: string; name: string; value: string; share?: string; list?: (bin: Bin) => DayList }[];
  line?: { name: string; value: (at: number) => string; base: (at: number) => string };
  list?: (bin: Bin, at: number) => DayList | null;
};
/** The tasks behind a row on one bin: its list, for the bin's days (`from`–`to`). */
export type DayList = { set: ListSet; value: ListValue | null; group?: Group | null; member?: string | null; from: string; to: string };
type Pointed = { at: number; row: number; box: { left: number; right: number; top: number } };
type GroupState = { bins: Bin[]; span: Days; bucket: Bucket; rows: RowSay[]; hovered: number | null; narrow: boolean;
  point: (at: number | null, row?: number, box?: Pointed["box"]) => void; press: (at: number, row: number) => void };
const GroupContext = createContext<GroupState | null>(null);

/**
 * The charts drawn on the same days (`bins`), and what each row says of a day (`rows`, by the row's number). A day is
 * read, never chosen, from a chart: pointed at (pressed, under a finger) its column lights through every row and the
 * window beside it says the row pointed at, alone; pressed on a computer it opens that row's tasks of that day (under a
 * finger, from the window). The span changes only from the period's switch. Between two charts the window stays with
 * the row last pointed at. Another step of time, a scroll or a move to another step closes it.
 */
export function ChartGroup({ bins, span, today, bucket, rows, open, children }: {
  bins: Bin[]; span: Days; today: string; bucket: Bucket; rows: RowSay[]; open: (list: DayList) => void; children: ReactNode;
}) {
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const narrow = useNarrow();
  const binName = useBinName();
  const close = () => setPointed(null);
  useLayoutEffect(() => subscribeStep(close), []);
  // The days are other days now (another step of time, another span of record): what was pointed at is gone.
  const days = `${bucket}:${bins.length}:${bins[0]?.from ?? ""}`;
  useLayoutEffect(close, [days]);
  useEffect(() => {
    if (!pointed) return;
    addEventListener("scroll", close, true);
    // Under a finger the window stays until a press elsewhere (its own way into the tasks is inside it).
    const away = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.("[data-day-column], [data-day-window]")) close(); };
    if (narrow) addEventListener("pointerdown", away, true);
    return () => { removeEventListener("scroll", close, true); removeEventListener("pointerdown", away, true); };
  }, [pointed, narrow]);
  const point = (at: number | null, row = -1, box?: Pointed["box"]) => setPointed(previous => at === null || !box ? null
    // Between two charts the window keeps the row last pointed at.
    : { at, row: row >= 0 ? row : previous?.row ?? 0, box });
  const listOf = (at: number, row: number) => rows[row]?.list?.(bins[at]!, at) ?? null;
  const press = (at: number, row: number) => { const list = listOf(at, row); if (list) { close(); open(list); } };
  const shown = pointed && bins[pointed.at] && rows[pointed.row] ? pointed : null;
  return <GroupContext value={{ bins, span, bucket, rows, hovered: shown?.at ?? null, narrow, point, press }}>
    <div className="relative" onMouseLeave={narrow ? undefined : event => { if (!intoWindow(event)) close(); }}>
      {!narrow && <Columns layer="back" />}
      <div className="relative">{children}</div>
      {!narrow && <Columns layer="front" />}
    </div>
    {shown && <DayWindow day={binName(bins[shown.at]!, today)} say={rows[shown.row]!} at={shown.at} box={shown.box} narrow={narrow}
      onList={listOf(shown.at, shown.row) ? () => press(shown.at, shown.row) : null}
      onPart={list => { close(); open(list(bins[shown.at]!)); }} onLeave={close}
      // Under a finger the window steps to the day before or after, as if that day were pressed.
      onStep={step => { const width = shown.box.right - shown.box.left, next = shown.at + step;
        if (bins[next]) point(next, shown.row, { ...shown.box, left: shown.box.left + step * width, right: shown.box.right + step * width }); }}
      first={shown.at === 0} last={shown.at === bins.length - 1} />}
  </GroupContext>;
}
const useGroup = () => useContext(GroupContext)!;
/** Whether the pointer left for the day's window (on a computer it is entered, to press one of its parts). */
const intoWindow = (event: React.MouseEvent) => event.relatedTarget instanceof Element && !!event.relatedTarget.closest("[data-day-window]");

/** The chart row under a point of the screen (its `data-chart-row`), or -1 between charts. */
function rowAt(x: number, y: number, self: Element) {
  const under = (document.elementsFromPoint?.(x, y) ?? []).find(element => element !== self && element instanceof HTMLElement && element.closest("[data-chart-row]"));
  return Number((under as HTMLElement | undefined)?.closest<HTMLElement>("[data-chart-row]")?.dataset.chartRow ?? -1);
}

/**
 * The group's day columns over the charts' nine grid columns, through every row (a computer's). Behind the charts:
 * the chosen span's band and the day pointed at. In front: a column a day that takes the pointer and the press.
 */
function Columns({ layer }: { layer: "back" | "front" }) {
  const group = useGroup();
  return <div aria-hidden={layer === "back"} className={cn(GRID, "pointer-events-none absolute inset-0", layer === "front" && "z-1")}>
    {/* Leaving the day columns (for the numbers on the left) closes what a day said. */}
    <div className="col-span-9 col-start-4 grid auto-cols-[minmax(0,1fr)] grid-flow-col" onMouseLeave={layer === "front" ? event => { if (!intoWindow(event)) group.point(null); } : undefined}>
      {group.bins.map((bin, at) => layer === "back"
        ? <i key={bin.from} className={cn("block", group.hovered === at ? "bg-rule" : lit(bin, group.span) && "bg-span-band")} />
        : <span key={bin.from} data-day-column="" className="pointer-events-auto cursor-pointer"
          onMouseMove={event => {
            const box = event.currentTarget.getBoundingClientRect();
            group.point(at, rowAt(event.clientX, event.clientY, event.currentTarget), { left: box.left, right: box.right, top: event.clientY - 12 });
          }}
          onClick={event => { const row = rowAt(event.clientX, event.clientY, event.currentTarget); if (row >= 0) group.press(at, row); }} />)}
    </div>
  </div>;
}

/** What a bin covers: its days, and how much of it there is when it is not whole. */
function useBinName() {
  const { t } = useTranslation("analysis");
  return (bin: Bin, today: string) => {
    const name = spanLabel(bin.from, bin.to);
    if (bin.complete) return name;
    return `${name}${t("sep")}${bin.to >= today ? t("bucket.ongoing") : t("bucket.partial", { count: daysBetween(bin.from, bin.to) })}`;
  };
}

/**
 * The window beside a pointed day: the day, the row's name and total (large), its parts with their colours, its
 * per-task line and base, and the way to its tasks. Kept on the screen. Each part with tasks opens that part's tasks
 * of the day: on a computer the window stands against the day's column, so the pointer goes straight into it; under a
 * finger it also steps to the day before or after (‹ ›).
 */
function DayWindow({ day, say, at, box, narrow, onList, onPart, onLeave, onStep, first, last }: { day: string; say: RowSay; at: number; box: Pointed["box"]; narrow: boolean;
  onList: (() => void) | null; onPart: (list: (bin: Bin) => DayList) => void; onLeave: () => void; onStep: (step: -1 | 1) => void; first: boolean; last: boolean }) {
  const { t } = useTranslation("analysis");
  const self = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const window = self.current;
    if (!window) return;
    window.style.maxHeight = "";
    const place = tipBeside({ left: box.left, right: box.right, top: box.top, width: window.offsetWidth, height: window.offsetHeight,
      screenWidth: innerWidth, screenHeight: innerHeight, gap: narrow ? 8 : 0 });
    window.style.left = `${place.left}px`; window.style.top = `${place.top}px`;
    if (place.maxHeight !== null) window.style.maxHeight = `${place.maxHeight}px`;
  }, [day, say, at, box, narrow]);
  const parts = say.parts?.(at) ?? [];
  const step = (to: -1 | 1, off: boolean) => <button type="button" disabled={off} onClick={() => onStep(to)} aria-label={t(to < 0 ? "window.before" : "window.after")}
    className="-my-1 flex size-7 items-center justify-center rounded-sm text-muted hover:bg-hover disabled:opacity-30">
    <Icon name={to < 0 ? "left" : "right"} className="size-3.5" /></button>;
  return <div ref={self} role="presentation" data-day-window=""
    onMouseLeave={narrow ? undefined : event => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-day-column]"))) onLeave(); }}
    className="fixed z-(--layer-popover) w-max max-w-[calc(100vw-8px)] overflow-y-auto rounded-md border border-line bg-raised px-3 py-2.5 text-xs shadow-float">
    {narrow ? <div className="-mx-1.5 flex items-center justify-between gap-2 text-soft">{step(-1, first)}<span>{day}</span>{step(1, last)}</div>
      : <div className="text-soft">{day}</div>}
    <div className="mt-1 flex items-baseline justify-between gap-6"><span className="text-muted">{say.name}</span><b className="text-md font-semibold text-ink tabular-nums">{say.total(at)}</b></div>
    {parts.length > 0 && <div className="mt-1.5 -mx-1.5 grid grid-cols-[auto_auto_auto] gap-x-4">
      {parts.map(part => {
        const cells = <>
          <span className="flex items-center whitespace-nowrap text-muted">{part.color && <i aria-hidden className={cn("me-2 inline-block size-2 rounded-xs", part.color)} />}{part.name}</span>
          <span className={cn("text-end font-semibold whitespace-nowrap text-ink tabular-nums", part.list && "underline decoration-lit-line underline-offset-4 group-hover/part:decoration-ink")}>{part.value}</span>
          <span className="flex items-center justify-end gap-0.5 whitespace-nowrap text-soft tabular-nums">{part.share ?? ""}{part.list && <Icon name="right" className="size-3" />}</span>
        </>;
        const row = "group/part col-span-3 grid grid-cols-subgrid items-center rounded-sm px-1.5 py-0.5 narrow:py-1.5";
        return part.list ? <button key={part.name} type="button" onClick={() => onPart(part.list!)} className={cn(row, "text-start hover:bg-hover")}>{cells}</button>
          : <div key={part.name} className={row}>{cells}</div>;
      })}
    </div>}
    {say.line && <div className="mt-2 border-t border-rule pt-2">
      <div className="flex items-baseline justify-between gap-6"><span className="flex items-center text-muted"><LineMark />{say.line.name}</span>
        <b className="font-semibold text-ink tabular-nums">{say.line.value(at)}</b></div>
      <div className="ps-5 text-soft">{say.line.base(at)}</div>
    </div>}
    {onList && <button type="button" onClick={onList} className="mt-2 flex w-full items-center gap-1 border-t border-rule pt-2 text-muted hover:text-ink">{t("window.list")}<Icon name="right" className="size-3" /></button>}
  </div>;
}

/** The mark of a per-task line (─●), as its name is drawn wherever the line is named. */
export const LineMark = () => <svg aria-hidden viewBox="0 0 16 8" className="me-2 h-2 w-4 flex-none overflow-visible">
  <line x1="0" y1="4" x2="16" y2="4" className="stroke-ink [stroke-width:1.5]" /><circle cx="8" cy="4" r="2.5" className="fill-ink stroke-bg [stroke-width:1]" />
</svg>;

/* ── a chart: the scale's one mark over its top line, a line across its middle, bins over the group's days ── */
type Scale = { top: number; label: string };
/** The round mark a chart's top line stands for, written with its unit once. */
export function useScale(largest: number, unit: number, unitName: string, wholeOnly: boolean): Scale {
  const { t } = useTranslation("analysis");
  const marks = ticks(Math.max(0, largest), unit, wholeOnly), top = marks[marks.length - 1] || unit;
  const written = numberText(Math.round(top / unit * 100) / 100);
  return { top, label: unitName ? t(unit === 1 ? "unit.join" : "unit.joinTight", { value: written, unit: unitName }) : written };
}

/** Whether a bin meets the chosen span at all (a week or month it falls inside, partly or whole). */
const lit = (bin: Bin, span: Days) => bin.from <= span.to && bin.to >= span.from;
/**
 * The largest amount a chart's scale is set by: the bins within the chosen span only, so a large day outside it does
 * not flatten the days the span is about (one over the top is cut there, and marked so).
 */
export const spanMost = (bins: Bin[], span: Days, amount: (at: number) => number) =>
  Math.max(0, ...bins.map((bin, at) => lit(bin, span) ? amount(at) : 0));
/** The bins within the chosen span, by number. */
export const inSpanOf = (bins: Bin[], span: Days) => (at: number) => !!bins[at] && lit(bins[at]!, span);

/** The frame every chart is drawn in: its height, the bars' mark over its top left, the line's over its top right. */
function Frame({ row, scale, lineScale, height, children }: { row: number; scale: Scale; lineScale?: { name: string; label: string }; height: string; children: ReactNode }) {
  return <div data-chart-row={row} className="pt-4 narrow:pt-4.5">
    <div className={cn("relative", height)}>
      <span aria-hidden className="absolute bottom-full start-0 text-xs whitespace-nowrap text-soft">{scale.label}</span>
      {/* The line's scale says what the line is (its mark and name), then, apart, the value its top stands for. */}
      {lineScale && <span aria-hidden className="absolute end-0 bottom-full flex items-center text-xs whitespace-nowrap text-soft">
        <LineMark /><span className="text-muted">{lineScale.name}</span><span className="ms-2.5 tabular-nums">{lineScale.label}</span></span>}
      <i aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-rule" />
      <i aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-rule" />
      <div className="absolute inset-0 border-b border-lit-line">{children}</div>
    </div>
  </div>;
}

/**
 * The bins of a chart over its group's days: lit within the chosen span and pale outside it (40%, paler than any bar
 * inside), a dashed box when the bin is not whole, lit while pointed at. Under a finger a bin is the press that says its
 * day. `uncounted` bins (before counting began) lie on a hatched ground, with nothing drawn on them, and open nothing.
 */
function Bins({ row, uncounted, partial, children }: { row: number; uncounted?: (at: number) => boolean; partial?: (at: number) => boolean; children: (at: number) => ReactNode }) {
  const group = useGroup();
  const wide = group.bucket !== "day";
  return <div className="grid h-full auto-cols-[minmax(0,1fr)] grid-flow-col items-end">
    {group.bins.map((bin, at) => {
      const off = uncounted?.(at) ?? false;
      const edge = off && !(uncounted?.(at + 1) ?? true);
      const look = cn("relative flex h-full flex-col-reverse gap-0.5 opacity-40 transition-opacity duration-(--motion-base) ease-out",
        wide ? "px-[max(3px,calc(50%-26px))]" : "px-[clamp(1px,12%,6px)]",
        lit(bin, group.span) && "opacity-100", group.hovered === at && "opacity-100",
        // Under a finger the band and the pressed day are drawn in each chart (a phone's rows stack their names between).
        group.narrow && (group.hovered === at ? "bg-rule" : lit(bin, group.span) && "bg-span-band"),
        (!bin.complete || partial?.(at)) && "outline outline-dashed outline-lit-line -outline-offset-1",
        off && "bg-[repeating-linear-gradient(135deg,var(--rule)_0_1px,transparent_1px_6px)]",
        edge && "border-e border-lit-line");
      if (!group.narrow || off) return <div key={bin.from} className={look}>{!off && children(at)}</div>;
      return <button key={bin.from} type="button" data-day-column="" aria-label={`${spanLabel(bin.from, bin.to)} ${group.rows[row]?.total(at) ?? ""}`}
        onClick={event => { const box = event.currentTarget.getBoundingClientRect();
          group.point(group.hovered === at ? null : at, row, { left: box.left, right: box.right, top: box.top }); }}
        className={look}>{children(at)}</button>;
    })}
  </div>;
}

/** The per-task line over a chart's bars: its value a bin (null: none), its name, its top (and how it is written), and which bins rest on fewer than ten. */
export type Overlay = { values: (number | null)[]; top: number; name: string; label: string; faint: (at: number) => boolean };

/** A bar's colour for a one-colour row: its tone, deeper the taller it stands (45% at the foot to the full colour at the top). */
const toneOf = (tone: Tone, share: number) => `color-mix(in oklab, var(--${tone}) ${Math.round(45 + 55 * Math.max(0, Math.min(1, share)))}%, var(--bg))`;
export type Tone = "turn" | "working" | "muted";

/**
 * A row's chart: the bin's amount as bars (stacked parts in their colours, or one colour deeper with the amount), and,
 * over them, the amount per task as a line in ink on its own scale. Within the chosen span the line has points;
 * outside it, it is thin and pale with none; where bins are narrower than 12px it has no points. A point resting on
 * fewer than ten tasks is hollow. Both scales are the chosen span's: a bar or point over the top is cut and marked.
 */
export function BarChart({ row, height, scale, values, tone, overlay, uncounted, partial, grow }: {
  row: number; height: string; scale: Scale; values: (at: number) => [string, number][]; tone?: Tone; overlay?: Overlay;
  uncounted?: (at: number) => boolean;
  /** Bins only part of which is counted (counting began inside them): boxed as a bin not whole is. */
  partial?: (at: number) => boolean; grow?: boolean;
}) {
  const group = useGroup();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const self = box.current;
    if (!self) return;
    const measure = () => setWidth(self.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(self);
    return () => watch.disconnect();
  }, []);
  const line = overlay ? lineDots(overlay.values, overlay.top, overlay.faint) : null;
  const inSpan = (at: number) => lit(group.bins[at]!, group.span);
  const points = width / Math.max(1, group.bins.length) >= 12;
  // A bin over the scale's top (one outside the chosen span: the top is the span's) stands to the top, its parts in
  // their shares of it, and is cut there with a small break across it.
  const bars = (at: number) => {
    const all = values(at), sum = all.reduce((total, [, value]) => total + Math.max(0, value), 0);
    const cut = sum > scale.top, fit = cut ? scale.top / sum : 1, last = all.reduce((found, [, value], part) => value > 0 ? part : found, -1);
    return all.map(([color, value], part) => value > 0 &&
      <i key={part} style={{ height: `${Math.min(100, value * fit / scale.top * 100)}%`, ...tone ? { background: toneOf(tone, Math.min(1, value / scale.top)) } : {} }}
        className={cn("relative block flex-none origin-bottom rounded-[1px]", !tone && color, part === last && "rounded-t-[3px]", grow && "animate-bar")}>
        {cut && part === last && <b data-cut="" className="absolute inset-x-0 top-1 block h-0.75 -skew-y-12 bg-bg" />}
      </i>);
  };
  return <div ref={box}><Frame row={row} scale={scale} lineScale={overlay && { name: overlay.name, label: overlay.label }} height={height}>
    <Bins row={row} uncounted={uncounted} partial={partial}>{bars}</Bins>
    {line && <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {line.lines.map(({ from, to }) => { const at = line.dots.indexOf(to), within = inSpan(at) && inSpan(at - 1);
        return <line key={`${from.x}-${to.x}`} x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`}
          className={cn("stroke-ink [stroke-linecap:round]", within ? "[stroke-width:2]" : "[stroke-width:1] [stroke-opacity:.45]")} />; })}
    </svg>}
    {line && <div aria-hidden className="pointer-events-none absolute inset-0">
      {line.dots.map((dot, at) => {
        // Where bins are too narrow for points the line lies flat on the top where it is cut; elsewhere a point over the
        // top stands on it as a small caret up, in the span or out of it.
        if (!dot || !points) return null;
        if (dot.over) return <svg key={at} data-cut="" viewBox="0 0 8 5" style={{ left: `${dot.x}%`, top: 0 }}
          className={cn("absolute h-1.25 w-2 -translate-x-1/2 -translate-y-full overflow-visible", !inSpan(at) && group.hovered !== at && "opacity-45")}>
          <path d="M0.5 4.5 L4 1 L7.5 4.5" className="fill-none stroke-ink [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5]" /></svg>;
        return (inSpan(at) || group.hovered === at) && <em key={at} style={{ left: `${dot.x}%`, top: `${dot.y}%` }}
          className={cn("absolute -translate-1/2 rounded-full ring-2 ring-bg", group.hovered === at ? "size-2.25" : "size-1.75",
            dot.faint ? "border-[1.5px] border-ink bg-bg" : "bg-ink")} />;
      })}
    </div>}
  </Frame></div>;
}

/**
 * A level a bin, as points joined by a line (the share without fixes, a median, an amount per task): a bin with none has
 * no point and the line breaks there. A faint point (too few to lean on) is drawn hollow. A value over the top stands
 * on the top (`over`), where it is cut.
 */
export function lineDots(values: (number | null)[], top: number, faint: (at: number) => boolean = () => false) {
  const dots = values.map((value, at) => value === null ? null
    : { x: (at + 0.5) / values.length * 100, y: 100 - Math.min(1, value / top) * 100, faint: faint(at), over: value > top });
  const lines = dots.flatMap((dot, at) => {
    const before = at > 0 ? dots[at - 1] : null;
    return dot && before ? [{ from: before, to: dot }] : [];
  });
  return { dots, lines };
}

/**
 * The top of a per-task line's scale: round, and set by the bins within the chosen span (`inSpan`) resting on ten tasks
 * or more (one task's large value must not flatten every other day), or by every bin of the span when none does; a
 * value over it is cut at the top, and marked so.
 */
export function lineTop(values: (number | null)[], steady: (at: number) => boolean, inSpan: (at: number) => boolean = () => true): number {
  const shown = (at: number) => values[at] !== null && values[at] !== undefined && inSpan(at);
  const kept = values.filter((_, at) => shown(at) && steady(at)) as number[];
  const from = kept.length ? kept : values.filter((_, at) => shown(at)) as number[];
  const marks = ticks(Math.max(0, ...from), 1, false);
  return marks[marks.length - 1] || 1;
}

/** The days under a chart: as many names as its width holds; one day (`strong`, where counting began) in ink and bold. */
export function DayAxis({ strong }: { strong?: { at: number; day: string } | null }) {
  const group = useGroup();
  const { bins, bucket } = group;
  const wide = bucket !== "day";
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const self = box.current;
    if (!self) return;
    const measure = () => setWidth(self.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(self);
    return () => watch.disconnect();
  }, []);
  const room = width || bins.length * 68;
  const named = new Set(axisLabels(bins.length, wide, at => wide || weekday(bins[at]!.from) === 0, room, strong?.at));
  const name = (bin: Bin, at: number) => at === strong?.at ? dayLabel(strong.day) : bucket === "month" ? monthLabel(bin.from) : dayLabel(bin.from);
  // A day's name that would run past the axis's end is drawn ending at it.
  const atEnd = (at: number) => !wide && at > 0 && (at + 1) * room / bins.length > room - 34;
  return <div ref={box} aria-hidden className="mt-1.5 grid h-4.5 auto-cols-[minmax(0,1fr)] grid-flow-col">
    {bins.map((bin, at) => <span key={bin.from} className={cn("overflow-visible text-xs whitespace-nowrap",
      at === strong?.at ? "font-semibold text-ink" : "text-soft",
      wide ? "w-full text-center" : atEnd(at) ? "flex w-full justify-end" : "w-0")}>
      {named.has(at) ? name(bin, at) : ""}</span>)}
  </div>;
}

/** How the charts' colours read, said once in the counting rules: whose hand a task took, and the per-task line. */
export function Legend() {
  const { t } = useTranslation("analysis");
  const item = (color: string, word: string) => <span key={word} className="inline-flex items-center"><i aria-hidden className={cn("me-1.5 inline-block size-2 rounded-xs", color)} />{word}</span>;
  return <p className="flex flex-wrap gap-x-4 gap-y-1">
    {item("bg-done", t("legend.passed"))}{item("bg-turn", t("legend.yours"))}{item("bg-working", t("legend.ai"))}{item("bg-stopped-part", t("legend.stopped"))}
    <span className="inline-flex items-center"><LineMark />{t("legend.line")}</span>
  </p>;
}
