import type { LaunchFilter } from "./series";
import { isTokenUnit } from "@/domain/tokens";
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow, useViewStore } from "@/state/view-store";
import { subscribeStep } from "@/state/history-step";
import { daysBetween, dayLabel, format, splitFigure, inUnit, monthLabel, numberText, unitOf, spanLabel, ticks, weekday } from "./format";
import { axisLabels } from "./charts";
import { OpenMark, tipAround } from "./parts";
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

/**
 * The rows' grid: the left (names and numbers) and the chart. On a wide page the left is as wide as one of the four lead
 * numbers above (a quarter, less their gaps); narrower (a window beside it), a third. It never goes under 15rem, the room
 * its names keep to one line each beside their numbers: below that the chart gives up its width instead.
 */
export const GRID = "grid grid-cols-[minmax(15rem,calc(25%_-_18px))_minmax(0,1fr)] gap-x-6 @max-5xl:grid-cols-[minmax(15rem,calc(33.333%_-_16px))_minmax(0,1fr)] narrow:block";
export const LEFT = "col-start-1", RIGHT = "col-start-2 min-w-0";

/** Four numbers across the top, three columns each; on a phone two by two. */
export function Leads({ children }: { children: ReactNode }) {
  // Each number spans five shared rows (its name, value, its note, the span before, the whole record), so neighbours' lines stand
  // level even where one of them wraps; a phone's second pair stands a step below the first.
  return <div className="grid grid-cols-4 gap-x-6 narrow:grid-cols-2 narrow:gap-x-3 [&>*:nth-child(n+3)]:narrow:mt-5">{children}</div>;
}

/**
 * A lead number: its name, the value large on a line of one least height (the four share each line's height, so they stand
 * level; what is beside a value wraps under it where the column is too narrow for both),
 * what the value holds that reads otherwise (`note`, as the tokens' cache), the span before, and the whole record so far
 * (`ever`; left out when the span is the whole record). The lines after the value are in one small type.
 */
export function Lead({ name, value, beside, note, compare, ever }: { name: ReactNode; value: ReactNode; beside?: ReactNode; note?: ReactNode; compare: ReactNode; ever?: string | null }) {
  const { t } = useTranslation("analysis");
  return <div className="row-span-5 grid min-w-0 grid-rows-subgrid">
    <div className="flex min-w-0 flex-wrap items-center text-base text-muted">{name}</div>
    {/* What stands beside the value (the share) goes under it where the column has no room for both: never into the next number. */}
    <div className="mt-1 flex min-w-0 flex-wrap content-start items-center gap-x-5 gap-y-1 narrow:gap-x-3">{value}{beside}</div>
    <div className="mt-2 min-w-0 text-xs text-soft">{note}</div>
    <div className="mt-0.5 min-w-0">{compare}</div>
    <div className="mt-0.5 text-xs text-soft">{ever && t("lead.ever", { value: ever })}</div>
  </div>;
}

/**
 * A part of a row's whole: its colour, name and number, its share of the whole where it means something, and the tasks
 * a press on it opens (`onOpen`; the whole line is the way in, its name as much as its number).
 */
export type PartItem = { color: string; name: string; value: ReactNode; share?: ReactNode; onOpen?: () => void; index?: number };
/**
 * The parts of a row's whole, then the row's per-task line (─●), its value and its gap to the span before (or, for a
 * day, its base under it). One grid for the span's numbers and a day's alike: the name, then the number at the end of a
 * column of its own, then what goes beside it (under the name where the column is narrow). The two number columns are as wide as the widest that any row of the
 * group says on any day (`--part-value`, `--part-share`, measured by ChartGroup from the span's numbers and each row's
 * room), so the numbers stand in one column down the rows and do not move when a day is pointed at.
 */
export function Parts({ items = [], line }: { items?: PartItem[]; line?: { name: string; value: ReactNode; gap?: ReactNode; base?: ReactNode } }) {
  const row = "col-span-3 grid grid-cols-subgrid items-baseline";
  // Where the column is too narrow for a name beside its numbers (under 13rem: a window under about 900px), each name
  // takes a line of its own and its numbers stand under it, in the same two columns.
  const name = "flex min-w-0 items-baseline text-muted [overflow-wrap:anywhere] [word-break:auto-phrase] @max-[13rem]:col-span-3";
  const value = "justify-self-end inline-flex items-baseline gap-0.5 text-end whitespace-nowrap @max-[13rem]:col-start-2";
  const share = "justify-self-end text-end text-xs whitespace-nowrap";
  return <div className="@container mt-3 text-base">
    <div className="grid w-full grid-cols-[minmax(0,1fr)_var(--part-value,auto)_var(--part-share,auto)] gap-x-2 gap-y-1">
      {items.map(item => {
        const cells = <>
          <span className={name}>{item.color && <i aria-hidden className={cn("me-2 inline-block size-2 flex-none self-center rounded-xs", item.color)} />}{item.name}</span>
          <span data-part-col="value" className={value}>{item.value}{item.onOpen ? <OpenMark /> : <i aria-hidden className="inline-block size-3 flex-none" />}</span>
          <span data-part-col="share" className={cn(share, "text-soft tabular-nums")}>{item.share ?? ""}</span>
        </>;
        // A part that opens its tasks: the whole line takes the press and the keys, as one way in.
        return item.onOpen ? <button key={item.name} type="button" data-part-index={item.index} onClick={item.onOpen}
          className={cn(row, "group/open -mx-1.5 rounded-sm px-1.5 text-start hover:bg-hover focus-visible:bg-hover active:translate-y-px")}>{cells}</button>
          : <div key={item.name} className={row}>{cells}</div>;
      })}
      {line && <div className={cn(row, items.length > 0 && "mt-1.5")}>
        <span className={name}><LineMark />{line.name}</span>
        <span data-part-col="value" className={value}>{line.value}</span>
        <span data-part-col="share" className={share}>{line.gap}</span>
      </div>}
      {line?.base && <span className="col-span-3 ps-6 text-xs text-soft">{line.base}</span>}
    </div>
  </div>;
}

/**
 * The widths of the parts' number columns: the widest each takes in the group, the live legend over a row left out (it
 * says one of the days its row's room already holds). Measured again only when what the cells say has changed (their
 * words are read without laying the page out) or when `force`d (the group's width or type changed); every width is read
 * before any is written. They are written on the rows' lefts (`data-part-room`), the only places that read them, and
 * only where they move: the charts beside them, most of the page, are not styled again for them.
 */
const measuredParts = new WeakMap<HTMLElement, { said: string; widths: Record<"value" | "share", string> }>();
function measureParts(root: HTMLElement, force = false) {
  const cells = [...root.querySelectorAll<HTMLElement>("[data-part-col]")].filter(cell => !cell.closest("[data-day-legend]"));
  const said = cells.map(cell => `${cell.dataset.partCol}\u0000${cell.textContent}`).join("\u0001");
  let measured = measuredParts.get(root);
  if (force || measured?.said !== said) {
    const most: Record<string, number> = { value: 0, share: 0 };
    for (const cell of cells) most[cell.dataset.partCol!] = Math.max(most[cell.dataset.partCol!] ?? 0, cell.getBoundingClientRect().width);
    const width = (column: string) => most[column] ? `${Math.ceil(most[column]!)}px` : "auto";
    measuredParts.set(root, measured = { said, widths: { value: width("value"), share: width("share") } });
  }
  // A left drawn since the words were measured (a day's legend) takes them too.
  for (const room of root.querySelectorAll<HTMLElement>("[data-part-room]"))
    for (const column of ["value", "share"] as const)
      if (room.style.getPropertyValue(`--part-${column}`) !== measured.widths[column]) room.style.setProperty(`--part-${column}`, measured.widths[column]);
}

/**
 * A row of the grid: a rule above it, its name and numbers on the left, its chart on the right. On a computer, while a
 * day of its chart (`row`, its number in the group) is pointed at or chosen from the keys, the left says that day in
 * place of the span: it is the chart's legend, and its parts open that day's tasks. The span's numbers keep their room,
 * so nothing below moves. The day stays while the pointer or the focus is within the row (straight from the chart to
 * its legend), and goes when they leave it.
 */
export function Row({ row, left, children, className }: { row?: number; left: ReactNode; children?: ReactNode; className?: string }) {
  const group = useContext(GroupContext), { pointed } = usePointed();
  const day = group && !group.narrow && row !== undefined && pointed?.row === row ? pointed.at : null;
  const leave = (to: EventTarget | null) => {
    if (day === null || to instanceof Node && (self.current?.contains(to) || to instanceof Element && to.closest("[data-day-column]"))) return;
    group!.point(null);
  };
  const self = useRef<HTMLDivElement>(null);
  return <div ref={self} data-row={row} className={cn(GRID, "border-t border-rule py-6 narrow:py-5", className)}
    onMouseLeave={event => leave(event.relatedTarget)} onBlur={event => leave(event.relatedTarget)}>
    {/* Each in its own place on the grid, so the day's legend (placed over the left) moves neither. The left holds,
        from the first, the room of the tallest of the span's numbers and every day's legend (each unseen but the one
        shown), so pointing at a day never makes the row taller nor runs it into the next. */}
    <div data-part-room="" className={cn(LEFT, "row-start-1 grid min-w-0")}>
      <div className={cn("col-start-1 row-start-1 min-w-0", day !== null && "invisible")}>{left}</div>
      {group && !group.narrow && row !== undefined && group.rows[row] && <LegendRoom say={group.rows[row]!} names={group.names} />}
    </div>
    {children && <div className={cn(RIGHT, "row-start-1 narrow:mt-3")}>{children}</div>}
    {/* After the chart, so the keys go from the chart to its day's parts; drawn over the left's room. Escape there
        lets go of the day and gives the focus to the chart. */}
    {day !== null && <div data-part-room="" className={cn(LEFT, "relative row-start-1 min-w-0")}
      onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); group!.point(null); group!.chartOf(row!)?.focus({ preventScroll: true }); }}>
      <DayLegend say={group!.rows[row!]!} at={day} day={group!.dayName(day)} onList={list => group!.openDay(list)} />
    </div>}
  </div>;
}

/**
 * The room a row keeps: one legend, unseen and out of reach, in the left's place, made of the widest words each of its
 * lines takes on any day (`legendRoom`). Each line of a legend is a line of its own, and wider words never make one
 * shorter, so it is as tall as the tallest day's. Made when the row's days or what it says change, never as a day is
 * chosen.
 */
const LegendRoom = memo(function LegendRoom({ say, names }: { say: RowSay; names: string[] }) {
  const room = legendRoom(say, names);
  return <div aria-hidden inert className="invisible col-start-1 row-start-1 min-w-0">
    <DayLegend still say={room.say} at={0} day={room.day} onList={() => {}} /></div>;
}, (a, b) => a.say === b.say && a.names === b.names);

/** How wide words stand: a full-width letter (Japanese, Chinese) as two. */
const breadth = (words: string) => [...words].reduce((sum, letter) => sum + (/[\u2e80-\uffef]/.test(letter) ? 2 : 1), 0);
const widest = (all: string[]) => {
  let most = "", room = 0;
  for (const words of all) { const each = breadth(words); if (each > room) { most = words; room = each; } }
  return most;
};
/** A row's legend made of the widest words each of its lines takes over its days (`names`): its room. */
export function legendRoom(say: RowSay, names: string[]): { day: string; say: RowSay } {
  const days = names.map((_, at) => at);
  const parts = days.map(at => say.parts?.(at) ?? []);
  const count = Math.max(0, ...parts.map(each => each.length));
  const room = Array.from({ length: count }, (_, index) => {
    const of = parts.map(each => each[index]).filter(part => !!part);
    return { color: of[0]?.color ?? "", name: widest(of.map(part => part.name)), value: widest(of.map(part => part.value)),
      share: of.some(part => part.share) ? widest(of.map(part => part.share ?? "")) : undefined,
      list: of.find(part => part.list)?.list };
  });
  const line = say.line, values = line ? widest(days.map(at => line.value(at))) : "", bases = line ? widest(days.map(at => line.base(at))) : "";
  const total = widest(days.map(at => say.total(at)));
  return { day: widest(names), say: { name: say.name, total: () => total, parts: () => room,
    line: line && { name: line.name, value: () => values, base: () => bases } } };
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
export type DayList = { set: ListSet; value: ListValue | null; group?: Group | null; member?: string | null; from: string; to: string; filter?: LaunchFilter | null };
type Box = { left: number; right: number; top: number; bottom: number };
/** The day pointed at, its row, and (under a finger) the box of the bin pressed, the window's place. */
type Pointed = { at: number; row: number; box: Box | null };
/** A change of what Runs ran under (`analysis changes`), on its local day, with each thing that changed in words. */
export type ChangeMark = { day: string; words: string[] };
/**
 * What the group's charts are drawn from, the same while a day is pointed at, so pointing redraws none of their bars.
 * `pointedNow`: the day pointed at as of now, for what a key or a press does.
 */
type GroupState = { bins: Bin[]; span: Days; bucket: Bucket; rows: RowSay[]; narrow: boolean; changes: ChangeMark[];
  pointedNow: () => Pointed | null; dayName: (at: number) => string; names: string[]; openDay: (list: (bin: Bin) => DayList) => void;
  /** Shows a day (null: none) at once, dropping a day waiting to be shown. */
  point: (at: number | null, row?: number, box?: Box) => void;
  /** Shows a day after a moment (the pointer passing on its way to the legend), unless anything else comes first. */
  pointSoon: (at: number, row: number) => void; cancel: () => void;
  press: (at: number, row: number, part?: number) => void; chartOf: (row: number) => HTMLElement | null };
const GroupContext = createContext<GroupState | null>(null);
/**
 * The day pointed at, read only by what draws it (the band, the points over the bars, the left's legend, the changes'
 * line). `hovered`: the day the band and points stand on, which follows the pointer at once, even while the legend's
 * day (`pointed`) waits for the pointer passing on its way to the legend. `chosen`: the bin whose tasks the open list
 * holds; it stays lit while the list stands beside the charts.
 */
type PointedState = { hovered: number | null; chosen: number | null; pointed: Pointed | null };
const PointedContext = createContext<PointedState>({ hovered: null, chosen: null, pointed: null });
const usePointed = () => useContext(PointedContext);

/** No changes, one and the same each time, so a group without them keeps what its charts are drawn from. */
const NO_CHANGES: ChangeMark[] = [];
/**
 * The charts drawn on the same days (`bins`), and what each row says of a day (`rows`, by the row's number). A day is
 * read, never chosen, from a chart. On a computer nothing is laid over the charts: the day pointed at lights its column
 * through every row and the pointed row's left says that day; a press opens that row's tasks of that day, or, on a
 * part of a stacked bar, that part's. Under a finger a press opens a window over or under the bin that says the day and
 * leads to its tasks. The span changes only from the period's switch. Between two charts the row last pointed at
 * stays. Another step of time, a scroll or a move to another step lets go of the day.
 */
export function ChartGroup({ bins, span, today, bucket, rows, open, changes = NO_CHANGES, children }: {
  bins: Bin[]; span: Days; today: string; bucket: Bucket; rows: RowSay[]; open: (list: DayList) => void; changes?: ChangeMark[]; children: ReactNode;
}) {
  const [pointed, setPointed] = useState<Pointed | null>(null);
  // The day the pointer is passing over while the legend's day waits for it (`pointSoon`): the band stands on it.
  const [passing, setPassing] = useState<number | null>(null);
  const narrow = useNarrow();
  const binName = useBinName();
  // The one place that says which day is shown. The last thing done wins, on the whole screen: a day waiting for the
  // pointer (`pointSoon`) is dropped by any other change here and by any input that is not the pointer's anywhere (a
  // key, a move of the focus, a scroll or a wheel), and by another span or step of time.
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One function for the whole life of the group, so the listeners it adds are the ones it takes away whichever render
  // drops the day.
  const [cancel] = useState(() => {
    const drop = () => {
      setPassing(null);
      if (!waiting.current) return;
      clearTimeout(waiting.current); waiting.current = null;
      for (const kind of OTHER_INPUT) removeEventListener(kind, drop, true);
    };
    return drop;
  });
  useEffect(() => cancel, []);
  const show = (at: number | null, row = -1, box?: Box) => setPointed(previous => {
    if (at === null) return null;
    // Between two charts the row last pointed at stays; the same day and row stay as they are.
    const next = row >= 0 ? row : previous?.row ?? 0;
    return previous && previous.at === at && previous.row === next ? previous : { at, row: next, box: box ?? null };
  });
  const point = (at: number | null, row = -1, box?: Box) => { cancel(); show(at, row, box); };
  const pointSoon = (at: number, row: number) => {
    cancel();
    setPassing(at);
    waiting.current = setTimeout(() => { cancel(); show(at, row); }, INTENT_MS);
    for (const kind of OTHER_INPUT) addEventListener(kind, cancel, true);
  };
  const close = () => point(null);
  useLayoutEffect(() => subscribeStep(close), []);
  // The days are other days now (another step of time, another span of record): what was pointed at is gone.
  const days = `${bucket}:${bins.length}:${bins[0]?.from ?? ""}`;
  useLayoutEffect(close, [days]);
  useLayoutEffect(cancel, [span.from, span.to]);
  useEffect(() => {
    if (!pointed) return;
    addEventListener("scroll", close, true);
    // Under a finger the window stays until a press elsewhere (its own way into the tasks is inside it).
    const away = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.("[data-day-column], [data-day-window]")) close(); };
    if (narrow) addEventListener("pointerdown", away, true);
    return () => { removeEventListener("scroll", close, true); removeEventListener("pointerdown", away, true); };
  }, [pointed, narrow]);
  const self = useRef<HTMLDivElement>(null);
  // The first resize observation has the group's layout. Later commits also measure when they change the words in
  // the number columns, even if the group's size stays the same.
  useLayoutEffect(() => {
    const root = self.current;
    if (root && measuredParts.has(root)) measureParts(root);
  });
  useLayoutEffect(() => {
    const root = self.current;
    if (!root) return;
    let width: number | undefined;
    const watch = new ResizeObserver(([entry]) => {
      const next = entry!.contentRect.width;
      // Growing or replacing the charts can change the group's height without affecting the number columns.
      if (next === width) return;
      width = next;
      measureParts(root, true);
    });
    watch.observe(root);
    // Only type still loading can change the widths already measured during the first drawing.
    let live = true;
    if (document.fonts?.status === "loading")
      void document.fonts.ready.then(() => { if (live) measureParts(root, true); });
    return () => { live = false; watch.disconnect(); };
  }, []);
  const chartOf = (row: number) => self.current?.querySelector<HTMLElement>(`[data-row="${row}"] [data-chart-row]`) ?? null;
  // A list gives the focus back to what opened it, as every window does (Layers: only when the focus was in it or is
  // gone, never taking it from where the person moved it). What opens a list from here is a chart: it takes the focus
  // as the list opens (pressed with the pointer too), so the focus comes back to it; given back to it, the focus goes
  // on to what in it opened the list, the same part of the same day's legend (the day shown again). On a phone nothing
  // of it is left to take the focus: the day's window opens again with the focus on what opened the list.
  type Opener = { at: number; row: number; part: number | "list" | null; box: Box | null };
  const opener = useRef<Opener | null>(null), refocus = useRef<Opener | null>(null);
  const remember = (at: number, row: number) => {
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const part = from?.closest<HTMLElement>("[data-part-index]")?.dataset.partIndex, list = !!from?.closest("[data-window-list]");
    const ours = !!from && (!!self.current?.contains(from) || !!from.closest("[data-day-window]"));
    opener.current = { at, row, part: ours && part !== undefined ? Number(part) : ours && list ? "list" : null, box: now.current?.box ?? null };
    if (!narrow) chartOf(row)?.focus({ preventScroll: true });
  };
  const layerOpen = useViewStore(state => !!state.analysis?.list);
  useLayoutEffect(() => {
    const back = opener.current;
    if (layerOpen || !back) return;
    opener.current = null;
    // After the step that closed the list (a step lets go of the day) and after the focus was given back.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const given = narrow ? !active || active === document.body : active === chartOf(back.row);
      if (!given || back.part === null) return;
      refocus.current = back;
      point(back.at, back.row, back.box ?? undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [layerOpen]);
  useLayoutEffect(() => {
    const back = refocus.current;
    if (!back) return;
    refocus.current = null;
    const within = narrow ? "[data-day-window]" : `[data-row="${back.row}"] [data-day-legend]`;
    const target = back.part === "list" ? "[data-window-list]" : `[data-part-index="${back.part}"]`;
    document.querySelector<HTMLElement>(`${within} ${target}`)?.focus({ preventScroll: true });
  }, [pointed]);
  const listOf = (at: number, row: number) => rows[row]?.list?.(bins[at]!, at) ?? null;
  // A part of a stacked bar opens that part's tasks of the day; elsewhere the column opens the row's.
  const press = (at: number, row: number, part?: number) => {
    const ofPart = part === undefined ? undefined : rows[row]?.parts?.(at)[part]?.list;
    const list = ofPart ? ofPart(bins[at]!) : listOf(at, row);
    if (list) { remember(at, row); close(); open(list); }
  };
  const shown = pointed && bins[pointed.at] && rows[pointed.row] ? pointed : null;
  const now = useRef(shown);
  now.current = shown;
  const listDays = useViewStore(state => state.analysis?.list?.days ?? null);
  const chosen = listDays ? bins.findIndex(bin => bin.from === listDays.from && bin.to === listDays.to) : -1;
  // The days' names, made when the days change (not as a day is chosen).
  const { i18n } = useTranslation();
  const names = useMemo(() => bins.map(bin => binName(bin, today)), [bins, today, i18n.language]);
  const dayName = (at: number) => names[at]!;
  // A row's room (legendRoom) is made once for its days and words, not again at each day a finger steps to.
  const rooms = useMemo(() => new WeakMap<RowSay, ReturnType<typeof legendRoom>>(), [names]);
  const roomOf = (say: RowSay) => { let room = rooms.get(say); if (!room) rooms.set(say, room = legendRoom(say, names)); return room; };
  const openDay = (list: (bin: Bin) => DayList) => { const day = now.current; if (!day) return; remember(day.at, day.row); close(); open(list(bins[day.at]!)); };
  // What the day chosen says, read out as it changes (the keys move it a day at a time).
  const said = shown ? [dayName(shown.at), rows[shown.row]!.name, rows[shown.row]!.total(shown.at),
    ...(rows[shown.row]!.parts?.(shown.at) ?? []).map(part => `${part.name} ${part.value}`),
    ...rows[shown.row]!.line ? [`${rows[shown.row]!.line!.name} ${rows[shown.row]!.line!.value(shown.at)}`] : []].join(", ") : "";
  // What the charts are drawn from changes with their days and rows, not with the day pointed at; what acts reads the
  // latest of the group through `acts`, so the one value stays the same while a day is pointed at.
  const acts = useRef({ point, pointSoon, press, openDay });
  acts.current = { point, pointSoon, press, openDay };
  const group = useMemo<GroupState>(() => ({ bins, span, bucket, rows, changes, narrow, names, dayName: (at: number) => names[at]!,
    pointedNow: () => now.current, cancel, chartOf: (row: number) => self.current?.querySelector<HTMLElement>(`[data-row="${row}"] [data-chart-row]`) ?? null,
    point: (...args) => acts.current.point(...args), pointSoon: (...args) => acts.current.pointSoon(...args),
    press: (...args) => acts.current.press(...args), openDay: list => acts.current.openDay(list) }), [bins, span, bucket, rows, changes, narrow, names, cancel]);
  const hover = useMemo<PointedState>(() => ({ hovered: passing ?? shown?.at ?? null, chosen: chosen < 0 ? null : chosen, pointed: shown }), [passing, shown, chosen]);
  // The day pointed at and the day whose list is open light their bins (`data-bin`) in every chart, the band behind them
  // and their change mark: only those elements are marked (`data-lit`, `data-chosen`), so following the pointer draws
  // none of the charts' bins again, however many days they show.
  useLayoutEffect(() => {
    const root = self.current;
    if (!root) return;
    const mark = (name: string, days: number[]) => {
      for (const element of root.querySelectorAll<HTMLElement>(`[${name}]`)) if (!days.includes(Number(element.dataset.bin))) element.removeAttribute(name);
      for (const at of days) for (const element of root.querySelectorAll<HTMLElement>(`[data-bin="${at}"]`)) element.setAttribute(name, "");
    };
    mark("data-lit", [hover.hovered, hover.chosen].filter((at): at is number => at !== null));
    mark("data-chosen", hover.chosen === null ? [] : [hover.chosen]);
  }, [hover.hovered, hover.chosen, bins]);
  return <GroupContext value={group}><PointedContext value={hover}>
    {!narrow && <span aria-live="polite" className="sr-only">{said}</span>}
    <div ref={self} className="relative" onMouseLeave={narrow ? undefined : close} onKeyDownCapture={cancel} onFocusCapture={cancel}>
      {!narrow && <Columns layer="back" />}
      <div className="relative">{children}</div>
      {!narrow && <Columns layer="front" />}
    </div>
    {narrow && shown?.box && <DayWindow day={dayName(shown.at)} say={rows[shown.row]!} room={roomOf(rows[shown.row]!)} at={shown.at} box={shown.box}
      onList={listOf(shown.at, shown.row) ? () => press(shown.at, shown.row) : null}
      onPart={openDay}
      // The window steps to the day before or after, as if that day were pressed.
      onStep={step => { const box = shown.box!, width = box.right - box.left, next = shown.at + step;
        if (bins[next]) point(next, shown.row, { ...box, left: box.left + step * width, right: box.right + step * width }); }}
      first={shown.at === 0} last={shown.at === bins.length - 1} />}
  </PointedContext></GroupContext>;
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
  const band = banded(group.bins, group.span);
  // A day of the same row the pointer passes on its way to the legend waits (`dayIntent`); any other is shown at once.
  const move = (at: number, row: number, trace: Trace) => {
    const from = last.current;
    last.current = trace;
    const pointed = group.pointedNow(), same = pointed && (row < 0 || row === pointed.row);
    if (pointed?.at === at && same) { group.cancel(); return; }
    if (same && dayIntent(from, trace) === "wait") group.pointSoon(at, row);
    else group.point(at, row);
  };
  return <div aria-hidden={layer === "back"} className={cn(GRID, "pointer-events-none absolute inset-x-0 top-6 bottom-6", layer === "front" && "z-1")}>
    {/* Leaving the day columns lets go of the day, unless for the same row (its legend, on the left). */}
    <div className={cn(RIGHT, "grid auto-cols-[minmax(0,1fr)] grid-flow-col")} onMouseLeave={layer === "front" ? event => {
      group.cancel();
      const row = group.pointedNow()?.row, to = event.relatedTarget;
      if (!(to instanceof Element && row !== undefined && to.closest(`[data-row="${row}"]`))) group.point(null);
    } : undefined}>
      {group.bins.map((bin, at) => layer === "back"
        // The day whose list is open is boxed, so it stays apart from the day pointed at.
        ? <i key={bin.from} data-bin={at} className={cn("block data-lit:bg-day-band data-chosen:outline data-chosen:outline-1 data-chosen:-outline-offset-1 data-chosen:outline-ink/50",
          band && lit(bin, group.span) && "bg-span-band")} />
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
/** The inputs that are not the pointer's: any of them drops a day the pointer left waiting. */
const OTHER_INPUT = ["keydown", "focusin", "scroll", "wheel"] as const;
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
function DayWindow({ day, say, room, at, box, onList, onPart, onStep, first, last }: { day: string; say: RowSay; room: { day: string; say: RowSay }; at: number; box: Box;
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
    className="fixed z-(--layer-popover) w-max max-w-[calc(100vw-8px)] overflow-y-auto rounded-md border border-line bg-raised px-3 py-2.5 text-base shadow-float">
    <div className="-mx-1.5 flex items-center justify-between gap-2 text-soft">{step(-1, first)}<span>{day}</span>{step(1, last)}</div>
    <div className="mt-1 flex items-baseline justify-between gap-6"><span className="text-muted">{say.name}</span><Total className="text-ink" written={say.total(at)} /></div>
    {/* As wide, and its columns as wide, as the widest any of the row's days takes (legendRoom): stepping to another day
        moves nothing. The room is laid out unseen and of no height. */}
    <div aria-hidden className="invisible h-0 overflow-hidden whitespace-nowrap">
      <div className="flex gap-2"><span className="size-7" />{room.day}<span className="size-7" /></div>
      <div className="flex gap-6"><span>{room.say.name}</span><Total written={room.say.total(0)} /></div>
      {room.say.line && <div className="flex gap-6 ps-6"><span>{room.say.line.name}</span><b className="font-semibold">{room.say.line.value(0)}</b></div>}
      {room.say.line && <div className="ps-5">{room.say.line.base(0)}</div>}
    </div>
    {parts.length > 0 && <div className="mt-1.5 -mx-1.5 grid grid-cols-[auto_auto_auto] gap-x-4">
      {(room.say.parts?.(0) ?? []).map((part, index) => <div key={`room-${index}`} aria-hidden className="invisible col-span-3 grid h-0 grid-cols-subgrid overflow-hidden px-1.5">
        <span className="flex items-center whitespace-nowrap">{part.color && <i className="me-2 inline-block size-2" />}{part.name}</span>
        <span className="font-semibold whitespace-nowrap tabular-nums">{part.value}</span>
        <span className="flex items-center gap-0.5 text-xs whitespace-nowrap tabular-nums">{part.share ?? ""}{part.list && <OpenMark />}</span>
      </div>)}
      {parts.map(part => {
        const cells = <>
          <span className="flex items-center whitespace-nowrap text-muted">{part.color && <i aria-hidden className={cn("me-2 inline-block size-2 rounded-xs", part.color)} />}{part.name}</span>
          <span className="text-end font-semibold whitespace-nowrap text-ink tabular-nums decoration-ink underline-offset-4 group-hover/open:underline">{part.value}</span>
          <span className="flex items-center justify-end gap-0.5 text-xs whitespace-nowrap text-soft tabular-nums">{part.share ?? ""}{part.list && <OpenMark />}</span>
        </>;
        const row = "group/open col-span-3 grid grid-cols-subgrid items-center rounded-sm px-1.5 py-1.5";
        return part.list ? <button key={part.name} type="button" data-part-index={parts.indexOf(part)} onClick={() => onPart(part.list!)} className={cn(row, "text-start hover:bg-hover")}>{cells}</button>
          : <div key={part.name} className={row}>{cells}</div>;
      })}
    </div>}
    {say.line && <div className="mt-2 border-t border-rule pt-2">
      <div className="flex items-baseline justify-between gap-6"><span className="flex items-center text-muted"><LineMark />{say.line.name}</span>
        <b className="font-semibold text-ink tabular-nums">{say.line.value(at)}</b></div>
      <div className="ps-5 text-soft">{say.line.base(at)}</div>
    </div>}
    {onList && <button type="button" data-window-list="" onClick={onList} className="group/open mt-2 flex w-full items-center gap-1 border-t border-rule pt-2 text-muted hover:text-ink">{t("window.list")}<OpenMark /></button>}
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
  // A day's numbers as the span's are written (Parts adds the › of what opens tasks).
  const figure = (value: string) => <b className="font-semibold tabular-nums decoration-ink underline-offset-4 group-hover/open:underline group-focus-visible/open:underline">{value}</b>;
  return <div data-day-legend={still ? undefined : ""} className={cn(!still && "absolute inset-x-0 top-0")}>
    {/* One line, so the legend keeps to the row's room at a narrow width (the row's name is read out in full). */}
    <div title={`${day} ${say.name}`} className="mb-1 truncate text-base text-muted"><b className="me-2 font-semibold text-ink">{day}</b>{say.name}</div>
    <div><Total written={say.total(at)} /></div>
    <Parts items={(say.parts?.(at) ?? []).map((part, index) => ({ color: part.color, name: part.name, share: part.share, index,
      value: figure(part.value), onOpen: part.list ? () => onList(part.list!) : undefined }))}
      line={say.line && { name: say.line.name, value: <>{figure(say.line.value(at))}<i aria-hidden className="inline-block size-3 flex-none" /></>, base: say.line.base(at) }} />
  </div>;
}

/** A day's total, large, its unit (k, M, 時間, h) at the body's step beside it, as every number with a unit is drawn. */
function Total({ written, className }: { written: string; className?: string }) {
  const { value, unit } = splitFigure(written);
  return <span className={cn("inline-flex items-baseline gap-0.5 whitespace-nowrap", className)}>
    <b className="text-heading font-semibold tabular-nums">{value}</b>{unit && <span className="text-base text-muted">{unit}</span>}</span>;
}

/** The mark of a per-task line (─●), as its name is drawn wherever the line is named. */
export const LineMark = () => <svg aria-hidden viewBox="0 0 16 8" className="me-2 h-2 w-4 flex-none overflow-visible">
  <line x1="0" y1="4" x2="16" y2="4" className="stroke-trend [stroke-width:1.5]" /><circle cx="8" cy="4" r="2.5" className="fill-trend stroke-bg [stroke-width:1]" />
</svg>;

/* ── a chart: the scale's one mark over its top line, a line across its middle, bins over the group's days ── */
type Scale = { top: number; label: string };
/** The round mark a chart's top line stands for, written with its unit once. */
export function useScale(largest: number, unit: number, unitName: string, wholeOnly: boolean): Scale {
  const { t } = useTranslation("analysis");
  const marks = ticks(Math.max(0, largest), unit, wholeOnly), top = marks[marks.length - 1] || unit;
  const written = numberText(Math.round(top / unit * 100) / 100);
  return { top, label: !unitName ? written : isTokenUnit(unitName) ? `${written}${unitName}`
    : t(unit === 1 ? "unit.join" : "unit.joinTight", { value: written, unit: unitName }) };
}

/** The span's last bin: where the keys start in a chart. */
const lastLit = (bins: Bin[], span: Days) => { for (let at = bins.length - 1; at >= 0; at--) if (lit(bins[at]!, span)) return at; return Math.max(0, bins.length - 1); };
/** Whether a bin meets the chosen span at all (a week or month it falls inside, partly or whole). */
const lit = (bin: Bin, span: Days) => bin.from <= span.to && bin.to >= span.from;
/** The chosen span is banded only where the chart also draws days outside it: a band over every day says nothing. */
const banded = (bins: Bin[], span: Days) => bins.some(bin => !lit(bin, span));
/**
 * The largest amount a chart's scale is set by: the bins within the chosen span only, so a large day outside it does
 * not flatten the days the span is about (one over the top is cut there, and marked so).
 */
export const spanMost = (bins: Bin[], span: Days, amount: (at: number) => number) =>
  Math.max(0, ...bins.map((bin, at) => lit(bin, span) ? amount(at) : 0));
/**
 * The days a chart's bins stand on, as a key: the charts are drawn anew, and their bars grow, when the days they show
 * change (another step of time or record has come), not when one is chosen and its numbers are still on their way.
 */
export const binsKey = (bins: Bin[]) => `${bins.length}:${bins[0]?.from ?? ""}:${bins.at(-1)?.to ?? ""}`;
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
      const pointed = group.pointedNow(), at = pointed?.row === row ? pointed.at : null, last = group.bins.length - 1, start = lastLit(group.bins, group.span);
      const to = { ArrowLeft: at === null ? start : at - 1, ArrowRight: at === null ? start : at + 1, Home: 0, End: last }[event.key];
      if (to !== undefined) { event.preventDefault(); group.point(Math.max(0, Math.min(last, to)), row); }
      else if (event.key === "Enter" && at !== null) { event.preventDefault(); group.press(at, row); }
      else if (event.key === "Escape" && pointed) { event.preventDefault(); group.point(null); }
    },
  };
  return <>{row === 0 && <ChangeStrip />}<div data-chart-row={row} {...keys} className="rounded-xs pt-4 outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink narrow:pt-4.5">
    <div className={cn("relative", height)}>
      <span aria-hidden className="absolute bottom-full start-0 text-xs whitespace-nowrap text-soft">{scale.label}</span>
      {/* The line's scale: only the value its top stands for, as quiet as the bars' (the line is named on the left). */}
      {lineScale && <span aria-hidden className="absolute end-0 bottom-full flex items-center text-xs whitespace-nowrap text-soft"><LineMark />{lineScale}</span>}
      <i aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-rule" />
      <i aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-rule" />
      <div className="absolute inset-0 border-b border-lit-line">{children}</div>
    </div>
  </div></>;
}

/** Each bin's changes, every thing that changed said once (agents that took the same change on the same days say it once). */
export function changesByBin(bins: readonly Bin[], changes: readonly ChangeMark[]): Map<number, string[]> {
  const marks = new Map<number, string[]>();
  for (const change of changes) {
    const at = bins.findIndex(bin => bin.from <= change.day && change.day <= bin.to);
    if (at < 0) continue;
    const words = marks.get(at) ?? [];
    for (const each of change.words) if (!words.includes(each)) words.push(each);
    marks.set(at, words);
  }
  return marks;
}

/** On how many days of the bins something changed. */
const changeDays = (bins: readonly Bin[], changes: readonly ChangeMark[]) =>
  new Set(changes.filter(change => bins[0]!.from <= change.day && change.day <= bins.at(-1)!.to).map(change => change.day)).size;
/**
 * The changes of what Runs ran under (alpacawork's version, a skill, an instruction file) over the group's first chart,
 * on their days: a small mark over each bin that has one, and one line of words, saying what changed on the day pointed
 * at (else on how many days), so the numbers before and after a change are read down the charts below it. The line is
 * always one line tall, so pointing at a day never moves the charts; where a day's changes do not fit it, they are also
 * listed whole above it (over the room above the charts, never over the day's bars) while the day is pointed at.
 */
function ChangeStrip() {
  const { t } = useTranslation("analysis");
  const group = useGroup(), { hovered } = usePointed();
  const marks = useMemo(() => changesByBin(group.bins, group.changes), [group.bins, group.changes]);
  const line = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const at = hovered, words = at === null ? undefined : marks.get(at);
  useLayoutEffect(() => { setCut(!!words && !!line.current && line.current.scrollWidth > line.current.clientWidth); }, [words]);
  if (!marks.size) return null;
  return <div data-change-strip="" className="relative">
    <p ref={line} className="h-4.5 truncate text-xs text-muted">
      <span className="me-2 text-soft">{t("change.legend")}</span>
      {at !== null && words ? <><b className="me-2 font-semibold text-ink">{group.dayName(at)}</b>{words.join(t("sep"))}</>
        : t("period.days", { count: changeDays(group.bins, group.changes) })}
    </p>
    {cut && words && <ul data-change-list="" className="pointer-events-none absolute start-0 bottom-full z-2 mb-1 max-w-full rounded-md border-hairline border-lit-line bg-lit px-2.5 py-1.5 text-xs text-muted shadow-float">
      {words.map(each => <li key={each} className="[overflow-wrap:anywhere]">{each}</li>)}
    </ul>}
    <div aria-hidden className="mt-1 grid h-2 auto-cols-[minmax(0,1fr)] grid-flow-col">
      {group.bins.map((bin, each) => <span key={bin.from} className="flex items-center justify-center">
        {marks.has(each) && <i data-bin={each} className="block size-1.5 rotate-45 bg-muted transition-transform duration-(--motion-base) data-lit:scale-150 data-lit:bg-ink" />}
      </span>)}
    </div>
  </div>;
}

/**
 * The bins of a chart over its group's days: lit within the chosen span and pale outside it (40%, paler than any bar
 * inside), a dashed box when the bin is not whole, lit while pointed at. Under a finger a bin is the press that says its
 * day. `uncounted` bins (before counting began) lie on a hatched ground, with nothing drawn on them, and open nothing.
 */
function Bins({ row, uncounted, partial, drawn }: { row: number; uncounted?: (at: number) => boolean; partial?: (at: number) => boolean;
  /** Each bin's bars, made by the chart: the same while a day is pointed at, so only the bins' own lighting is drawn again. */
  drawn: ReactNode[] }) {
  const group = useGroup();
  const { t } = useTranslation("analysis");
  const wide = group.bucket !== "day", band = banded(group.bins, group.span);
  return <div className="grid h-full auto-cols-[minmax(0,1fr)] grid-flow-col items-end">
    {group.bins.map((bin, at) => {
      const off = uncounted?.(at) ?? false;
      const edge = off && !(uncounted?.(at + 1) ?? true);
      const look = cn("relative flex h-full flex-col-reverse gap-0.5 opacity-40 transition-opacity duration-(--motion-base) ease-out",
        wide ? "px-[max(min(3px,20%),calc(50%-26px))]" : "px-[clamp(1px,12%,6px)]",
        lit(bin, group.span) && "opacity-100", "data-lit:opacity-100",
        // Under a finger the band and the pressed day are drawn in each chart (a phone's rows stack their names between).
        group.narrow && cn("data-lit:bg-day-band", band && lit(bin, group.span) && "bg-span-band"),
        (!bin.complete || partial?.(at)) && "outline outline-dashed outline-lit-line -outline-offset-1",
        off && "bg-[repeating-linear-gradient(135deg,var(--rule)_0_1px,transparent_1px_6px)]",
        edge && "border-e border-lit-line");
      if (!group.narrow || off) return <div key={bin.from} data-bin={at} className={look}>{!off && drawn[at]}</div>;
      return <button key={bin.from} type="button" data-day-column="" aria-label={t("chart.binLabel", { day: spanLabel(bin.from, bin.to), name: group.rows[row]?.name ?? "", value: group.rows[row]?.total(at) ?? "" })}
        onClick={event => { const box = event.currentTarget.getBoundingClientRect();
          group.point(group.pointedNow()?.at === at ? null : at, row, { left: box.left, right: box.right, top: box.top, bottom: box.bottom }); }}
        data-bin={at} className={look}>{drawn[at]}</button>;
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
  const thin = width > 0 && width / Math.max(1, group.bins.length) < 4;
  // A bin over the scale's top (one outside the chosen span: the top is the span's) stands to the top, its parts in
  // their shares of it, and is cut there with a small break across it.
  const bars = (at: number) => {
    const all = values(at), sum = all.reduce((total, [, value]) => total + Math.max(0, value), 0);
    const cut = sum > scale.top, last = all.reduce((found, [, value], part) => value > 0 ? part : found, -1);
    // A bar stands as high as its amount on the scale (to the top where it is cut), its gaps between parts taken from
    // its parts, not added to it: a bar of more parts is never taller than one of a larger amount. A gap is 2px, or less
    // on a short bar, all of them a quarter of it at most, so its parts always keep their colours; they share the rest
    // in their amounts' shares.
    const shown = all.filter(([, value]) => value > 0), whole = `${Math.min(100, sum / scale.top * 100)}%`;
    const gap = shown.length > 1 ? `min(2px, ${25 / (shown.length - 1)}%)` : "0px", gaps = `(${shown.length - 1} * ${gap})`;
    // Where a bin is only a few pixels wide (days over a long record), its parts are one element painted in their
    // colours with the same gaps, not one element each: the same picture at a fraction of the page to lay out.
    // Too narrow to press a part, the bin opens the row's tasks.
    if (thin && !tone && !cut && shown.length > 1) {
      let below = 0;
      const stops = shown.map(([color, value], part) => {
        const from = `calc((100% - ${gaps}) * ${below / sum} + ${part} * ${gap})`; below += value;
        const to = `calc((100% - ${gaps}) * ${below / sum} + ${part} * ${gap})`, paint = `var(--${color.replace(/^bg-/, "")})`;
        return `${paint} ${from}, ${paint} ${to}${part < shown.length - 1 ? `, transparent ${to}, transparent calc(${to} + ${gap})` : ""}`;
      });
      return <i style={{ height: whole, background: `linear-gradient(to top, ${stops.join(", ")})` }}
        className={cn("relative block min-w-px flex-none origin-bottom rounded-t-[3px] rounded-b-[1px]", grow && "animate-bar")} />;
    }
    // A bar of several parts stands as one column of them, its own height, and grows as one: a stacked chart moves as
    // many things as its bins, not its parts (each that moves is its own layer for the browser to put together).
    const stacked = shown.length > 1;
    const parts = all.map(([color, value, of], part) => value > 0 &&
      <i key={part} data-part={of} style={{ ...stacked ? { flex: `${value} 1 0px` } : { height: whole },
        ...tone ? { background: toneOf(tone, Math.min(1, value / scale.top)) } : {} }}
        className={cn("relative block origin-bottom rounded-[1px]", !stacked && "flex-none", !tone && color, part === last && "rounded-t-[3px]", grow && !stacked && "animate-bar")}>
        {cut && part === last && <b data-cut="" className="absolute inset-x-0 top-1 block h-0.75 -skew-y-12 bg-bg" />}
      </i>);
    return stacked ? <span style={{ height: whole, gap }}
      className={cn("flex flex-none origin-bottom flex-col-reverse overflow-hidden", grow && "animate-bar")}>{parts}</span> : parts;
  };
  return <div ref={box}><Frame row={row} scale={scale} lineScale={overlay?.label} height={height}>
    <Bins row={row} uncounted={uncounted} partial={partial} drawn={group.bins.map((_, at) => bars(at))} />
    {line && <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {line.lines.map(({ from, to, at }) => { const within = inSpan(at) && inSpan(at - 1);
        return <line key={`${from.x}-${to.x}`} x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`}
          className={cn("stroke-trend [stroke-linecap:round]", within ? "[stroke-width:2]" : "[stroke-width:1] [stroke-opacity:.68] dark:[stroke-opacity:.45]")} />; })}
    </svg>}
    {line && <Dots dots={line.dots} points={points} inSpan={inSpan} />}
  </Frame></div>;
}

/**
 * The per-task line's points over a chart: within the chosen span, and the day pointed at (larger) anywhere. The only
 * part of a chart drawn again as a day is pointed at.
 */
function Dots({ dots, points, inSpan }: { dots: ReturnType<typeof lineDots>["dots"]; points: boolean; inSpan: (at: number) => boolean }) {
  const group = useGroup(), { hovered } = usePointed();
  return <div aria-hidden className="pointer-events-none absolute inset-0">
    {dots.map((dot, at) => {
      // On a computer a point over the top stands on it as a small caret up, in the span or out of it; under a finger
      // (and where bins are too narrow for points) the line only lies flat on the top where it is cut.
      if (!dot || !points) return null;
      if (dot.over) return !group.narrow && <svg key={at} data-cut="" viewBox="0 0 8 5" style={{ left: `${dot.x}%`, top: 0 }}
        className={cn("absolute h-1.25 w-2 -translate-x-1/2 -translate-y-full overflow-visible", !inSpan(at) && hovered !== at && "opacity-45")}>
        <path d="M0.5 4.5 L4 1 L7.5 4.5" className="fill-none stroke-trend [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5]" /></svg>;
      return (inSpan(at) || hovered === at) && <em key={at} style={{ left: `${dot.x}%`, top: `${dot.y}%` }}
        className={cn("absolute -translate-1/2 rounded-full ring-2 ring-bg", hovered === at ? "size-2.25" : "size-1.75",
          dot.faint ? "border-[1.5px] border-trend bg-bg" : "bg-trend")} />;
    })}
  </div>;
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
    return dot && before ? [{ from: before, to: dot, at }] : [];
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
  return (kind: "hours" | "times" | "tasks" | "questions" | "tokens", top: number) => kind === "hours" || kind === "tokens" ? format(kind, top)
    : inUnit(numberText(Math.round(top * 100) / 100), unitOf(kind));
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

