import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { subscribeStep } from "@/state/history-step";
import { daysBetween, dayLabel, monthLabel, spanLabel, ticks, weekday } from "./format";
import { axisLabels } from "./charts";
import { tipBeside } from "./parts";
import type { Bucket } from "./contract";

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
  return <div className="grid grid-cols-4 gap-x-6 narrow:grid-cols-2 narrow:gap-x-3 narrow:gap-y-5">{children}</div>;
}

/**
 * A lead number: its name, the value large on a line of one height (so the four stand level whatever is beside a value),
 * the span before, and the whole record so far (`ever`; left out when the span is the whole record).
 */
export function Lead({ name, value, beside, compare, ever }: { name: ReactNode; value: ReactNode; beside?: ReactNode; compare: ReactNode; ever?: string | null }) {
  const { t } = useTranslation("analysis");
  return <div className="min-w-0">
    <div className="flex items-center text-xs whitespace-nowrap text-muted">{name}</div>
    <div className="flex h-[45px] items-center gap-5 narrow:h-[33px] narrow:gap-3">{value}{beside}</div>
    {compare}
    {ever && <div className="text-xs whitespace-nowrap text-soft">{t("lead.ever", { value: ever })}</div>}
  </div>;
}

/** The parts of a row's whole, each its colour, name and number (a way into its tasks), the numbers in one column. */
export function Parts({ items }: { items: { color: string; name: string; value: ReactNode }[] }) {
  return <div className="mt-2 grid w-max grid-cols-[max-content_max-content] items-baseline gap-x-4 gap-y-1 narrow:flex narrow:w-auto narrow:flex-wrap narrow:gap-x-4">
    {items.map(item => <div key={item.name} className="contents narrow:flex narrow:items-baseline narrow:gap-2">
      <span className="flex items-center text-base whitespace-nowrap text-muted"><i aria-hidden className={cn("me-2 inline-block size-2 flex-none rounded-xs", item.color)} />{item.name}</span>
      <span className="text-base">{item.value}</span>
    </div>)}
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
type Line = { name: string; value: (at: number) => string };
type Group = { bins: Bin[]; span: Days; today: string; bucket: Bucket; pick: (days: Days) => void;
  lines: Line[]; hovered: number | null; point: (at: number | null, row?: number, box?: DOMRect) => void };
const GroupContext = createContext<Group | null>(null);

/**
 * The charts drawn on the same days (`bins`), and what the window says of each day (`lines`, in the rows' order). A
 * press on a day chooses it as the span, as it always has; under a finger there is no window.
 */
export function ChartGroup({ bins, span, today, bucket, pick, lines, children }: Omit<Group, "hovered" | "point"> & { children: ReactNode }) {
  const [hovered, setHovered] = useState<{ at: number; row: number; box: DOMRect } | null>(null);
  const narrow = useNarrow();
  const binName = useBinName();
  // A move to another step takes the window away: it was about what is no longer shown.
  useLayoutEffect(() => subscribeStep(() => setHovered(null)), []);
  const point = (at: number | null, row = 0, box?: DOMRect) => setHovered(at === null || !box || narrow ? null : { at, row, box });
  return <GroupContext value={{ bins, span, today, bucket, pick, lines, hovered: hovered?.at ?? null, point }}>
    <div onMouseLeave={() => setHovered(null)}>{children}</div>
    {hovered && <DayWindow name={binName(bins[hovered.at]!, today)} lines={lines.map(line => [line.name, line.value(hovered.at)] as const)}
      strong={hovered.row} box={hovered.box} />}
  </GroupContext>;
}
const useGroup = () => useContext(GroupContext)!;

/** What a bin covers: its days, and how much of it there is when it is not whole. */
function useBinName() {
  const { t } = useTranslation("analysis");
  return (bin: Bin, today: string) => {
    const name = spanLabel(bin.from, bin.to);
    if (bin.complete) return name;
    return `${name}${t("sep")}${bin.to >= today ? t("bucket.ongoing") : t("bucket.partial", { count: daysBetween(bin.from, bin.to) })}`;
  };
}

/** The window beside a pointed day: its days, then every row's value, the row pointed at in ink. Kept on the screen. */
function DayWindow({ name, lines, strong, box }: { name: string; lines: (readonly [string, string])[]; strong: number; box: DOMRect }) {
  const self = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const window = self.current;
    if (!window) return;
    window.style.maxHeight = "";
    const place = tipBeside({ left: box.left, right: box.right, top: box.top, width: window.offsetWidth, height: window.offsetHeight,
      screenWidth: innerWidth, screenHeight: innerHeight });
    window.style.left = `${place.left}px`; window.style.top = `${place.top}px`;
    if (place.maxHeight !== null) window.style.maxHeight = `${place.maxHeight}px`;
  }, [name, lines, strong, box]);
  return <div ref={self} role="presentation" className="pointer-events-none fixed z-(--layer-popover) max-w-[calc(100vw-8px)] overflow-hidden rounded-md border border-line bg-raised px-2.5 py-2 text-xs shadow-float">
    <div className="mb-1 font-semibold text-ink">{name}</div>
    <div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-0.5">
      {lines.map(([label, value], at) => <div key={label} className={cn("contents", at === strong ? "font-semibold text-ink" : "text-muted")}>
        <span className="whitespace-nowrap">{label}</span><span className="text-end whitespace-nowrap tabular-nums">{value}</span></div>)}
    </div>
  </div>;
}

/* ── a chart: the scale's one mark over its top line, a line across its middle, bins over the group's days ── */
type Scale = { top: number; label: string };
/** The round mark a chart's top line stands for, written with its unit once. */
export function useScale(largest: number, unit: number, unitName: string, wholeOnly: boolean): Scale {
  const { t } = useTranslation("analysis");
  const marks = ticks(Math.max(0, largest), unit, wholeOnly), top = marks[marks.length - 1] || unit;
  const written = (Math.round(top / unit * 100) / 100).toLocaleString();
  return { top, label: unitName ? t(unit === 1 ? "unit.join" : "unit.joinTight", { value: written, unit: unitName }) : written };
}

const lit = (bin: Bin, span: Days) => bin.from >= span.from && bin.to <= span.to;

/** The frame every chart is drawn in: its height, the mark over its top, the middle line and the foot line. */
function Frame({ scale, height, children }: { scale: Scale; height: string; children: ReactNode }) {
  return <div className="pt-4 narrow:pt-4.5">
    <div className={cn("relative", height)}>
      <span aria-hidden className="absolute bottom-full start-0 text-xs whitespace-nowrap text-soft">{scale.label}</span>
      <i aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-rule" />
      <i aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-rule" />
      <div className="absolute inset-0 border-b border-lit-line">{children}</div>
    </div>
  </div>;
}

/**
 * The bins of a chart over its group's days: each a press that chooses its days, lit while chosen, a dashed box when the
 * bin is not whole, the ground lit while the day is pointed at anywhere in the group. `uncounted` bins (before counting
 * began) lie on a hatched ground, with nothing drawn on them.
 */
function Bins({ row, uncounted, children }: { row: number; uncounted?: (at: number) => boolean; children: (at: number) => ReactNode }) {
  const group = useGroup();
  const wide = group.bucket !== "day";
  return <div className="grid h-full auto-cols-[minmax(0,1fr)] grid-flow-col items-end">
    {group.bins.map((bin, at) => {
      const off = uncounted?.(at) ?? false;
      const edge = off && !(uncounted?.(at + 1) ?? true);
      return <button key={bin.from} type="button" onClick={() => group.pick(bin)}
        onMouseEnter={event => group.point(at, row, event.currentTarget.getBoundingClientRect())}
        aria-label={`${spanLabel(bin.from, bin.to)} ${group.lines[row]?.value(at) ?? ""}`}
        className={cn("relative flex h-full flex-col-reverse gap-0.5 opacity-50 transition-opacity duration-(--motion-base) ease-out",
          wide ? "px-[max(3px,calc(50%-26px))]" : "px-[clamp(1px,12%,6px)]",
          lit(bin, group.span) && "opacity-100", group.hovered === at && "bg-rule opacity-100",
          !bin.complete && "outline outline-dashed outline-lit-line -outline-offset-1",
          off && "bg-[repeating-linear-gradient(135deg,var(--rule)_0_1px,transparent_1px_6px)]",
          edge && "border-e border-lit-line")}>
        {!off && children(at)}
      </button>;
    })}
  </div>;
}

/** Bars of one or more parts a bin, stacked from the foot. */
export function BarChart({ row, height, scale, values, uncounted, grow }: {
  row: number; height: string; scale: Scale; values: (at: number) => [string, number][]; uncounted?: (at: number) => boolean; grow?: boolean;
}) {
  return <Frame scale={scale} height={height}>
    <Bins row={row} uncounted={uncounted}>{at => values(at).map(([color, value], part, all) => value > 0 &&
      <i key={part} style={{ height: `${Math.min(100, value / scale.top * 100)}%` }}
        className={cn("block flex-none origin-bottom rounded-[1px]", color, part === all.length - 1 && "rounded-t-[3px]", grow && "animate-bar")} />)}</Bins>
  </Frame>;
}

/**
 * A level a bin, as points joined by a line (the share without fixes, the median time): a bin with none has no point and
 * the line breaks there. A faint point (too few to lean on) is drawn hollow, and so is the line that touches it.
 */
export function lineDots(values: (number | null)[], top: number, faint: (at: number) => boolean = () => false) {
  const dots = values.map((value, at) => value === null ? null
    : { x: (at + 0.5) / values.length * 100, y: 100 - Math.min(1, value / top) * 100, faint: faint(at) });
  const lines = dots.flatMap((dot, at) => {
    const before = at > 0 ? dots[at - 1] : null;
    return dot && before ? [{ from: before, to: dot, faint: dot.faint || before.faint }] : [];
  });
  return { dots, lines };
}
export function LineChart({ row, height, scale, values, faint, color }: {
  row: number; height: string; scale: Scale; values: (number | null)[]; faint?: (at: number) => boolean; color: "done" | "muted";
}) {
  const { dots, lines } = lineDots(values, scale.top, faint);
  return <Frame scale={scale} height={height}>
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {lines.map(({ from, to, faint: pale }) => <line key={`${from.x}-${to.x}`} x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`}
        className={cn("[stroke-linecap:round] [stroke-width:2]", color === "done" ? "stroke-done" : "stroke-muted", pale && "[stroke-dasharray:2_4] [stroke-opacity:.4]")} />)}
    </svg>
    <Bins row={row}>{at => dots[at] && <em style={{ bottom: `${100 - dots[at]!.y}%` }}
      className={cn("absolute start-1/2 -ms-1 -mb-1 size-2 rounded-full ring-2 ring-bg", color === "done" ? "bg-done" : "bg-muted",
        dots[at]!.faint && cn("border-[1.5px] bg-bg opacity-65", color === "done" ? "border-done" : "border-muted"))} />}</Bins>
  </Frame>;
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
  const named = new Set(axisLabels(bins.length, wide, at => wide || weekday(bins[at]!.from) === 0 || at === strong?.at, width || bins.length * 68));
  if (strong) named.add(strong.at);
  const name = (bin: Bin, at: number) => at === strong?.at ? dayLabel(strong.day) : bucket === "month" ? monthLabel(bin.from) : dayLabel(bin.from);
  return <div ref={box} aria-hidden className="mt-1.5 grid h-4.5 auto-cols-[minmax(0,1fr)] grid-flow-col">
    {bins.map((bin, at) => <span key={bin.from} className={cn("overflow-visible text-xs whitespace-nowrap",
      at === strong?.at ? "font-semibold text-ink" : "text-soft",
      wide ? "w-full text-center" : at === bins.length - 1 && at ? "flex w-full justify-end" : "w-0")}>
      {named.has(at) ? name(bin, at) : ""}</span>)}
  </div>;
}
