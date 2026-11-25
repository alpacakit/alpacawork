import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow, useViewStore } from "@/state/view-store";
import { subscribeStep } from "@/state/history-step";
import { daysBetween, dayLabel, format, monthLabel, numberText, spanLabel, ticks, weekday } from "./format";
import { axisLabels } from "./charts";
import { tipAround } from "./parts";
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

/**
 * A row of the grid: a rule above it, its name and numbers on the left, its chart on the right. On a computer, while a
 * day of its chart (`row`, its number in the group) is pointed at or chosen from the keys, the left says that day in
 * place of the span: it is the chart's legend, and its parts open that day's tasks. The span's numbers keep their room,
 * so nothing below moves. The day stays while the pointer or the focus is within the row (straight from the chart to
 * its legend), and goes when they leave it.
 */
export function Row({ row, left, children, className }: { row?: number; left: ReactNode; children?: ReactNode; className?: string }) {
  const group = useContext(GroupContext);
  const day = group && !group.narrow && row !== undefined && group.pointed?.row === row ? group.pointed.at : null;
  const leave = (to: EventTarget | null) => {
    if (day === null || to instanceof Node && (self.current?.contains(to) || to instanceof Element && to.closest("[data-day-column]"))) return;
    group!.point(null);
  };
  const self = useRef<HTMLDivElement>(null);
  return <div ref={self} data-row={row} className={cn(GRID, "border-t border-rule py-4 narrow:py-3.5", className)}
    onMouseLeave={event => leave(event.relatedTarget)} onBlur={event => leave(event.relatedTarget)}>
    {/* Each in its own place on the grid, so the day's legend (placed over the left) moves neither. The left holds,
        from the first, the room of the tallest of the span's numbers and every day's legend (each unseen but the one
        shown), so pointing at a day never makes the row taller nor runs it into the next. */}
    <div className={cn(LEFT, "col-start-1 row-start-1 grid min-w-0")}>
      <div className={cn("col-start-1 row-start-1 min-w-0", day !== null && "invisible")}>{left}</div>
      {group && !group.narrow && row !== undefined && group.rows[row] && <LegendRoom say={group.rows[row]!} days={group.bins.map((_, at) => group.dayName(at))} />}
    </div>
    {children && <div className={cn(RIGHT, "col-start-4 row-start-1 narrow:mt-3")}>{children}</div>}
    {/* After the chart, so the keys go from the chart to its day's parts; drawn over the left's room. Escape there
        lets go of the day and gives the focus to the chart. */}
    {day !== null && <div className="relative col-span-3 col-start-1 row-start-1 min-w-0"
      onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); group!.point(null); group!.chartOf(row!)?.focus({ preventScroll: true }); }}>
      <DayLegend say={group!.rows[row!]!} at={day} day={group!.dayName(day)} onList={list => group!.openDay(list)} />
    </div>}
  </div>;
}

/**
 * Every day's legend of a row, unseen and out of reach, in the left's place: the room the row keeps (the tallest of
 * them). Drawn again only when the row's days or what it says change, not as a day is pointed at.
 */
const LegendRoom = memo(function LegendRoom({ say, days }: { say: RowSay; days: string[] }) {
  return days.map((day, at) => <div key={at} aria-hidden inert className="invisible col-start-1 row-start-1 min-w-0">
    <DayLegend still say={say} at={at} day={day} onList={() => {}} /></div>);
}, (a, b) => a.say === b.say && a.days.join() === b.days.join());

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
type Box = { left: number; right: number; top: number; bottom: number };
/** The day pointed at, its row, and (under a finger) the box of the bin pressed, the window's place. */
type Pointed = { at: number; row: number; box: Box | null };
type GroupState = { bins: Bin[]; span: Days; bucket: Bucket; rows: RowSay[]; hovered: number | null; narrow: boolean;
  pointed: Pointed | null; dayName: (at: number) => string; openDay: (list: (bin: Bin) => DayList) => void;
  /** Shows a day (null: none) at once, dropping a day waiting to be shown. */
  point: (at: number | null, row?: number, box?: Box) => void;
  /** Shows a day after a moment (the pointer passing on its way to the legend), unless anything else comes first. */
  pointSoon: (at: number, row: number) => void; cancel: () => void;
  press: (at: number, row: number, part?: number) => void; chartOf: (row: number) => HTMLElement | null };
const GroupContext = createContext<GroupState | null>(null);

/**
 * The charts drawn on the same days (`bins`), and what each row says of a day (`rows`, by the row's number). A day is
 * read, never chosen, from a chart. On a computer nothing is laid over the charts: the day pointed at lights its column
 * through every row and the pointed row's left says that day; a press opens that row's tasks of that day, or, on a
 * part of a stacked bar, that part's. Under a finger a press opens a window over or under the bin that says the day and
 * leads to its tasks. The span changes only from the period's switch. Between two charts the row last pointed at
 * stays. Another step of time, a scroll or a move to another step lets go of the day.
 */
export function ChartGroup({ bins, span, today, bucket, rows, open, children }: {
  bins: Bin[]; span: Days; today: string; bucket: Bucket; rows: RowSay[]; open: (list: DayList) => void; children: ReactNode;
}) {
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const narrow = useNarrow();
  const binName = useBinName();
  // The one place that says which day is shown. The last thing done wins: a day waiting for the pointer (`pointSoon`)
  // is dropped by any other change, a key, a move of the focus or a scroll.
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (waiting.current) clearTimeout(waiting.current); waiting.current = null; };
  useEffect(() => cancel, []);
  const show = (at: number | null, row = -1, box?: Box) => setPointed(previous => {
    if (at === null) return null;
    // Between two charts the row last pointed at stays; the same day and row stay as they are.
    const next = row >= 0 ? row : previous?.row ?? 0;
    return previous && previous.at === at && previous.row === next ? previous : { at, row: next, box: box ?? null };
  });
  const point = (at: number | null, row = -1, box?: Box) => { cancel(); show(at, row, box); };
  const pointSoon = (at: number, row: number) => { cancel(); waiting.current = setTimeout(() => { waiting.current = null; show(at, row); }, INTENT_MS); };
  const close = () => point(null);
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
  const self = useRef<HTMLDivElement>(null);
  const chartOf = (row: number) => self.current?.querySelector<HTMLElement>(`[data-row="${row}"] [data-chart-row]`) ?? null;
  // A list opened from a chart or its legend gives the focus back there as it closes, as every window does to what
  // opened it: to the chart, or to the same part of the same day's legend (the day shown again).
  const opener = useRef<{ at: number; row: number; part: number | null } | null>(null), refocus = useRef<{ row: number; part: number } | null>(null);
  const remember = (at: number, row: number) => {
    const from = document.activeElement;
    const inside = from instanceof HTMLElement && !!self.current?.contains(from);
    const part = inside ? (from as HTMLElement).closest<HTMLElement>("[data-part-index]")?.dataset.partIndex : undefined;
    opener.current = inside ? { at, row, part: part === undefined ? null : Number(part) } : null;
  };
  const layerOpen = useViewStore(state => !!(state.analysis?.list || state.analysis?.unit));
  useLayoutEffect(() => {
    const back = opener.current;
    if (layerOpen || !back) return;
    opener.current = null;
    if (back.part === null) { chartOf(back.row)?.focus({ preventScroll: true }); return; }
    refocus.current = { row: back.row, part: back.part };
    point(back.at, back.row);
  }, [layerOpen]);
  useLayoutEffect(() => {
    const back = refocus.current;
    if (!back) return;
    refocus.current = null;
    self.current?.querySelector<HTMLElement>(`[data-row="${back.row}"] [data-day-legend] [data-part-index="${back.part}"]`)?.focus({ preventScroll: true });
  }, [pointed]);
  const listOf = (at: number, row: number) => rows[row]?.list?.(bins[at]!, at) ?? null;
  // A part of a stacked bar opens that part's tasks of the day; elsewhere the column opens the row's.
  const press = (at: number, row: number, part?: number) => {
    const ofPart = part === undefined ? undefined : rows[row]?.parts?.(at)[part]?.list;
    const list = ofPart ? ofPart(bins[at]!) : listOf(at, row);
    if (list) { remember(at, row); close(); open(list); }
  };
  const shown = pointed && bins[pointed.at] && rows[pointed.row] ? pointed : null;
  const dayName = (at: number) => binName(bins[at]!, today);
  const openDay = (list: (bin: Bin) => DayList) => { if (!shown) return; remember(shown.at, shown.row); close(); open(list(bins[shown.at]!)); };
  // What the day chosen says, read out as it changes (the keys move it a day at a time).
  const said = shown ? [dayName(shown.at), rows[shown.row]!.name, rows[shown.row]!.total(shown.at),
    ...(rows[shown.row]!.parts?.(shown.at) ?? []).map(part => `${part.name} ${part.value}`),
    ...rows[shown.row]!.line ? [`${rows[shown.row]!.line!.name} ${rows[shown.row]!.line!.value(shown.at)}`] : []].join(", ") : "";
  return <GroupContext value={{ bins, span, bucket, rows, hovered: shown?.at ?? null, narrow, pointed: shown, dayName, openDay, point, pointSoon, cancel, press, chartOf }}>
    {!narrow && <span aria-live="polite" className="sr-only">{said}</span>}
    <div ref={self} className="relative" onMouseLeave={narrow ? undefined : close} onKeyDownCapture={cancel} onFocusCapture={cancel}>
      {!narrow && <Columns layer="back" />}
      <div className="relative">{children}</div>
      {!narrow && <Columns layer="front" />}
    </div>
    {narrow && shown?.box && <DayWindow day={dayName(shown.at)} say={rows[shown.row]!} at={shown.at} box={shown.box}
      onList={listOf(shown.at, shown.row) ? () => press(shown.at, shown.row) : null}
      onPart={openDay}
      // The window steps to the day before or after, as if that day were pressed.
      onStep={step => { const box = shown.box!, width = box.right - box.left, next = shown.at + step;
        if (bins[next]) point(next, shown.row, { ...box, left: box.left + step * width, right: box.right + step * width }); }}
      first={shown.at === 0} last={shown.at === bins.length - 1} />}
  </GroupContext>;
}
const useGroup = () => useContext(GroupContext)!;

/** What is under a point of the screen: the chart row (its `data-chart-row`, -1 between charts) and the part of a stacked bar (`data-part`). */
function under(x: number, y: number, self: Element) {
  const all = (document.elementsFromPoint?.(x, y) ?? []).filter(element => element !== self && element instanceof HTMLElement) as HTMLElement[];
  const row = all.find(element => element.closest("[data-chart-row]"))?.closest<HTMLElement>("[data-chart-row]")?.dataset.chartRow;
  const part = all.find(element => element.dataset.part !== undefined)?.dataset.part;
  return { row: Number(row ?? -1), part: part === undefined ? undefined : Number(part) };
}

/**
 * The group's day columns over the charts' nine grid columns, through every row (a computer's). Behind the charts:
 * the chosen span's band and the day pointed at. In front: a column a day that takes the pointer and the press.
 */
function Columns({ layer }: { layer: "back" | "front" }) {
  const group = useGroup();
  const last = useRef<Trace | null>(null);
  // A day of the same row the pointer passes on its way to the legend waits (`dayIntent`); any other is shown at once.
  const move = (at: number, row: number, trace: Trace) => {
    const from = last.current;
    last.current = trace;
    const same = group.pointed && (row < 0 || row === group.pointed.row);
    if (group.pointed?.at === at && same) { group.cancel(); return; }
    if (same && dayIntent(from, trace) === "wait") group.pointSoon(at, row);
    else group.point(at, row);
  };
  return <div aria-hidden={layer === "back"} className={cn(GRID, "pointer-events-none absolute inset-0", layer === "front" && "z-1")}>
    {/* Leaving the day columns lets go of the day, unless for the same row (its legend, on the left). */}
    <div className="col-span-9 col-start-4 grid auto-cols-[minmax(0,1fr)] grid-flow-col" onMouseLeave={layer === "front" ? event => {
      group.cancel();
      const row = group.pointed?.row, to = event.relatedTarget;
      if (!(to instanceof Element && row !== undefined && to.closest(`[data-row="${row}"]`))) group.point(null);
    } : undefined}>
      {group.bins.map((bin, at) => layer === "back"
        ? <i key={bin.from} className={cn("block", group.hovered === at ? "bg-rule" : lit(bin, group.span) && "bg-span-band")} />
        : <span key={bin.from} data-day-column="" className="pointer-events-auto cursor-pointer"
          onMouseMove={event => move(at, under(event.clientX, event.clientY, event.currentTarget).row, { x: event.clientX, y: event.clientY, time: event.timeStamp })}
          onClick={event => { const { row, part } = under(event.clientX, event.clientY, event.currentTarget); if (row >= 0) group.press(at, row, part); }} />)}
    </div>
  </div>;
}

/** Where the pointer was last, and the day it is heading for (`move`), deferred or not (`dayIntent`). */
type Trace = { x: number; y: number; time: number };
/**
 * Whether a move to another day of the same row waits: the pointer going left fast and mostly sideways (or starting
 * that way from rest) is on its way to the row's legend (the days it crosses are not chosen); slower, or any other
 * way, it takes the day at once.
 */
export function dayIntent(from: Trace | null, to: Trace) {
  if (!from) return "now";
  const dx = to.x - from.x, dy = to.y - from.y, gap = to.time - from.time;
  if (!(dx < 0 && Math.abs(dx) > 2 * Math.abs(dy))) return "now";
  // The first move after the pointer rested has no speed yet: a long one waits too (a slow one is taken a moment
  // later); a small one (over a column's edge) is taken at once.
  return gap > 100 ? (-dx > 4 ? "wait" : "now") : -dx / Math.max(1, gap) > 0.5 ? "wait" : "now";
}
/** How long a day passed on the way to the legend waits before it is taken (the pointer stopped over it). */
const INTENT_MS = 120;

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
 * The window of a pressed day under a finger: the day (with ‹ › to the days beside it), the row's name and total
 * (large), its parts with their colours, each with tasks opening that part's tasks of the day, its per-task line and
 * base, and the way to its tasks. It stands over or under the bin, where there is room, so the bins beside it stay in
 * sight; only where neither has room, beside it. Kept on the screen.
 */
function DayWindow({ day, say, at, box, onList, onPart, onStep, first, last }: { day: string; say: RowSay; at: number; box: Box;
  onList: (() => void) | null; onPart: (list: (bin: Bin) => DayList) => void; onStep: (step: -1 | 1) => void; first: boolean; last: boolean }) {
  const { t } = useTranslation("analysis");
  const self = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const window = self.current;
    if (!window) return;
    window.style.maxHeight = "";
    const place = tipAround({ ...box, width: window.offsetWidth, height: window.offsetHeight, screenWidth: innerWidth, screenHeight: innerHeight });
    window.style.left = `${place.left}px`; window.style.top = `${place.top}px`;
    if (place.maxHeight !== null) window.style.maxHeight = `${place.maxHeight}px`;
  }, [day, say, at, box]);
  const parts = say.parts?.(at) ?? [];
  const step = (to: -1 | 1, off: boolean) => <button type="button" disabled={off} onClick={() => onStep(to)} aria-label={t(to < 0 ? "window.before" : "window.after")}
    className="-my-1 flex size-7 items-center justify-center rounded-sm text-muted hover:bg-hover disabled:opacity-30">
    <Icon name={to < 0 ? "left" : "right"} className="size-3.5" /></button>;
  return <div ref={self} role="presentation" data-day-window=""
    className="fixed z-(--layer-popover) w-max max-w-[calc(100vw-8px)] overflow-y-auto rounded-md border border-line bg-raised px-3 py-2.5 text-xs shadow-float">
    <div className="-mx-1.5 flex items-center justify-between gap-2 text-soft">{step(-1, first)}<span>{day}</span>{step(1, last)}</div>
    <div className="mt-1 flex items-baseline justify-between gap-6"><span className="text-muted">{say.name}</span><b className="text-md font-semibold text-ink tabular-nums">{say.total(at)}</b></div>
    {parts.length > 0 && <div className="mt-1.5 -mx-1.5 grid grid-cols-[auto_auto_auto] gap-x-4">
      {parts.map(part => {
        const cells = <>
          <span className="flex items-center whitespace-nowrap text-muted">{part.color && <i aria-hidden className={cn("me-2 inline-block size-2 rounded-xs", part.color)} />}{part.name}</span>
          <span className={cn("text-end font-semibold whitespace-nowrap text-ink tabular-nums", part.list && "underline decoration-lit-line underline-offset-4 group-hover/part:decoration-ink")}>{part.value}</span>
          <span className="flex items-center justify-end gap-0.5 whitespace-nowrap text-soft tabular-nums">{part.share ?? ""}{part.list && <Icon name="right" className="size-3" />}</span>
        </>;
        const row = "group/part col-span-3 grid grid-cols-subgrid items-center rounded-sm px-1.5 py-1.5";
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

/**
 * The left of a row while one of its days is pointed at or chosen (a computer's): the day and the row's name, its total
 * large, its parts with their colours and shares, each with tasks a way into that part's tasks of the day, and its
 * per-task line with its base. Laid over the span's numbers, which keep their room; within the column at any width
 * (its names wrap, its type is a step smaller than the span's).
 */
function DayLegend({ say, at, day, onList, still }: { say: RowSay; at: number; day: string; onList: (list: (bin: Bin) => DayList) => void;
  /** Laid in the flow (the room a row keeps), not over the left. */
  still?: boolean }) {
  const parts = say.parts?.(at) ?? [];
  // A part a line: its name (wrapping between words), then its value and share at the end, below the name when the
  // column is too narrow.
  const line = "flex w-full flex-wrap items-baseline justify-between gap-x-3";
  const figures = "ms-auto flex items-baseline gap-2 whitespace-nowrap";
  return <div data-day-legend={still ? undefined : ""} className={cn("text-sm", !still && "absolute inset-x-0 top-0")}>
    {/* One line, so the legend keeps to the row's room at a narrow width (the row's name is read out in full). */}
    <div title={`${day} ${say.name}`} className="truncate text-xs text-muted"><b className="me-2 font-semibold text-ink">{day}</b>{say.name}</div>
    <b className="block text-lg font-semibold tabular-nums">{say.total(at)}</b>
    {parts.length > 0 && <div className="mt-1 -mx-1.5">
      {parts.map((part, index) => {
        const inner = <>
          <span className="flex min-w-0 items-baseline text-muted [word-break:auto-phrase]">{part.color && <i aria-hidden className={cn("me-2 inline-block size-2 flex-none self-center rounded-xs", part.color)} />}{part.name}</span>
          <span className={figures}>
            <b className={cn("font-semibold tabular-nums", part.list && "underline decoration-lit-line underline-offset-4 group-hover/part:decoration-ink")}>{part.value}</b>
            {part.share && <span className="text-xs text-soft tabular-nums">{part.share}</span>}
            {part.list && <Icon name="right" className="size-3 self-center text-soft" />}
          </span>
        </>;
        const row = cn(line, "group/part rounded-sm px-1.5 text-start");
        return part.list ? <button key={part.name} type="button" data-part-index={index} onClick={() => onList(part.list!)} className={cn(row, "hover:bg-hover")}>{inner}</button>
          : <div key={part.name} className={row}>{inner}</div>;
      })}
    </div>}
    {say.line && <div className="mt-1">
      <div className={line}><span className="flex min-w-0 items-baseline text-muted [word-break:auto-phrase]"><LineMark />{say.line.name}</span>
        <b className={cn(figures, "font-semibold tabular-nums")}>{say.line.value(at)}</b></div>
      {/* The line's base under it, within the column (it may be long: "fewer than ten accepted"). */}
      <div className="ps-6 text-xs text-soft">{say.line.base(at)}</div>
    </div>}
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

/** The span's last bin: where the keys start in a chart. */
const lastLit = (bins: Bin[], span: Days) => { for (let at = bins.length - 1; at >= 0; at--) if (lit(bins[at]!, span)) return at; return Math.max(0, bins.length - 1); };
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
function Frame({ row, scale, lineScale, height, children }: { row: number; scale: Scale; lineScale?: string; height: string; children: ReactNode }) {
  const group = useGroup();
  const { t } = useTranslation("analysis");
  // On a computer a chart takes the focus once: the arrows (Home, End) choose its day, starting from the span's last,
  // and its legend says it; Enter opens that day's tasks; Escape lets go.
  const keys = group.narrow ? {} : {
    tabIndex: 0, role: "group", "aria-label": `${group.rows[row]?.name ?? ""}${t("sep")}${t("chart.keys")}`,
    onKeyDown: (event: React.KeyboardEvent) => {
      const at = group.pointed?.row === row ? group.pointed.at : null, last = group.bins.length - 1, start = lastLit(group.bins, group.span);
      const to = { ArrowLeft: at === null ? start : at - 1, ArrowRight: at === null ? start : at + 1, Home: 0, End: last }[event.key];
      if (to !== undefined) { event.preventDefault(); group.point(Math.max(0, Math.min(last, to)), row); }
      else if (event.key === "Enter" && at !== null) { event.preventDefault(); group.press(at, row); }
      else if (event.key === "Escape" && group.pointed) { event.preventDefault(); group.point(null); }
    },
  };
  return <div data-chart-row={row} {...keys} className="rounded-xs pt-4 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink narrow:pt-4.5">
    <div className={cn("relative", height)}>
      <span aria-hidden className="absolute bottom-full start-0 text-xs whitespace-nowrap text-soft">{scale.label}</span>
      {/* The line's scale: only the value its top stands for, as quiet as the bars' (the line is named on the left). */}
      {lineScale && <span aria-hidden className="absolute end-0 bottom-full text-xs whitespace-nowrap text-soft">{lineScale}</span>}
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
          group.point(group.hovered === at ? null : at, row, { left: box.left, right: box.right, top: box.top, bottom: box.bottom }); }}
        className={look}>{children(at)}</button>;
    })}
  </div>;
}

/** The per-task line over a chart's bars: its value a bin (null: none), its top (and how it is written), and which bins rest on fewer than ten. */
export type Overlay = { values: (number | null)[]; top: number; label: string; faint: (at: number) => boolean };

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
  row: number; height: string; scale: Scale;
  /** A bin's bar: its parts, each its colour, amount and (stacked) the number of the row's part it draws, which a press on it opens. */
  values: (at: number) => [string, number, number?][]; tone?: Tone; overlay?: Overlay;
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
    const cut = sum > scale.top, last = all.reduce((found, [, value], part) => value > 0 ? part : found, -1);
    // Cut, the parts share the height left after the 2px gaps between them, so the bar ends on the top line.
    const gaps = 2 * (all.filter(([, value]) => value > 0).length - 1);
    const height = (value: number) => cut ? `calc((100% - ${gaps}px) * ${value / sum})` : `${Math.min(100, value / scale.top * 100)}%`;
    return all.map(([color, value, of], part) => value > 0 &&
      <i key={part} data-part={of} style={{ height: height(value), ...tone ? { background: toneOf(tone, Math.min(1, value / scale.top)) } : {} }}
        className={cn("relative block flex-none origin-bottom rounded-[1px]", !tone && color, part === last && "rounded-t-[3px]", grow && "animate-bar")}>
        {cut && part === last && <b data-cut="" className="absolute inset-x-0 top-1 block h-0.75 -skew-y-12 bg-bg" />}
      </i>);
  };
  return <div ref={box}><Frame row={row} scale={scale} lineScale={overlay?.label} height={height}>
    <Bins row={row} uncounted={uncounted} partial={partial}>{bars}</Bins>
    {line && <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {line.lines.map(({ from, to }) => { const at = line.dots.indexOf(to), within = inSpan(at) && inSpan(at - 1);
        return <line key={`${from.x}-${to.x}`} x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`}
          className={cn("stroke-ink [stroke-linecap:round]", within ? "[stroke-width:2]" : "[stroke-width:1] [stroke-opacity:.45]")} />; })}
    </svg>}
    {line && <div aria-hidden className="pointer-events-none absolute inset-0">
      {line.dots.map((dot, at) => {
        // On a computer a point over the top stands on it as a small caret up, in the span or out of it; under a finger
        // (and where bins are too narrow for points) the line only lies flat on the top where it is cut.
        if (!dot || !points) return null;
        if (dot.over) return !group.narrow && <svg key={at} data-cut="" viewBox="0 0 8 5" style={{ left: `${dot.x}%`, top: 0 }}
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
 * The top of a per-task line's scale: round, and the larger of the largest value within the chosen span (`inSpan`) and
 * the 90th percentile of every bin shown resting on ten tasks or more, so the line keeps its course outside the span
 * too; only a value over that is cut at the top, and marked so. The span's largest counts its bins on ten tasks or more
 * (one task's large value must not flatten every other day), or every bin of the span when none is.
 */
export function lineTop(values: (number | null)[], steady: (at: number) => boolean, inSpan: (at: number) => boolean = () => true): number {
  const has = (at: number) => values[at] !== null && values[at] !== undefined;
  const pick = (keep: (at: number) => boolean) => values.filter((_, at) => has(at) && keep(at)) as number[];
  const spanSteady = pick(at => inSpan(at) && steady(at));
  const span = spanSteady.length ? spanSteady : pick(inSpan);
  const shown = pick(steady).sort((a, b) => a - b);
  const p90 = shown.length ? shown[Math.ceil(shown.length * 0.9) - 1]! : 0;
  const marks = ticks(Math.max(0, p90, ...span), 1, false);
  return marks[marks.length - 1] || 1;
}

/** A line scale's top as written over the chart's right: with as many places as it needs (0.25 stays 0.25). */
export function useLineLabel() {
  const { t } = useTranslation("analysis");
  return (kind: "hours" | "times" | "tasks" | "tokens", top: number) => kind === "hours" || kind === "tokens" ? format(kind, top)
    : t("unit.join", { value: numberText(Math.round(top * 100) / 100), unit: t(`unit.${kind}`, { count: 2 }) });
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
