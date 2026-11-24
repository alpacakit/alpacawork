import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { addDays, daysBetween, dayLabel, dayWithWeekday, monthLabel, spanLabel, ticks, weekday, weekdayLabel } from "./format";
import { tip } from "./parts";
import type { Bucket } from "./contract";

/**
 * The analysis's charts, drawn in HTML and CSS (a line in SVG): one bin a day, week or month over the whole record, the
 * chosen span lit and the rest dimmed. A bin pressed chooses its days. A bin that is not whole (the record starts or
 * today falls inside it) is boxed with a dashed line, so its short bar is not read as a drop.
 */
export type Bin = { from: string; to: string; complete: boolean };
type Days = { from: string; to: string };
const lit = (bin: Bin, span: Days) => bin.from >= span.from && bin.to <= span.to;

/** What a bin covers, for its small window: its days, and how much of it there is when it is not whole. */
function binName(bin: Bin, today: string, say: (key: string, options?: Record<string, unknown>) => string) {
  const name = spanLabel(bin.from, bin.to);
  if (bin.complete) return name;
  return `${name}${say("sep")}${bin.to >= today ? say("bucket.ongoing") : say("bucket.partial", { count: daysBetween(bin.from, bin.to) })}`;
}
/** A bin's name under the chart: every month or week; a day's on Mondays and the first, none too near the last (drawn at the end). */
function xLabel(bin: Bin, bucket: Bucket, at: number, count: number) {
  if (bucket === "month") return monthLabel(bin.from);
  if (bucket === "week") return dayLabel(bin.from);
  if (at === count - 1) return dayLabel(bin.from);
  return (weekday(bin.from) === 0 || at === 0) && at < count - 3 ? dayLabel(bin.from) : "";
}

/** The gutter on the left the scale's numbers stand in. */
const GUT = "ps-12 narrow:ps-10";
const GUT_LEFT = "start-12 narrow:start-10";

function Grid({ marks, top, label }: { marks: number[]; top: number; label: (value: number, last: boolean) => string }) {
  return <div aria-hidden className="pointer-events-none absolute inset-0">
    {marks.map((value, at) => <div key={value} style={{ bottom: `${value / top * 100}%` }} className="absolute inset-x-0">
      <i className={cn("absolute end-0 border-t border-rule", GUT_LEFT)} />
      <span className="absolute start-0 bottom-0 w-10 translate-y-1/2 text-end text-xs whitespace-nowrap text-soft narrow:w-8">{label(value, at === marks.length - 1)}</span>
    </div>)}
  </div>;
}

function XAxis({ bins, bucket }: { bins: Bin[]; bucket: Bucket }) {
  const wide = bucket !== "day";
  return <div aria-hidden className={cn("mt-1.5 grid h-4.5 auto-cols-[minmax(0,1fr)] grid-flow-col", GUT)}>
    {bins.map((bin, at) => <span key={bin.from} className={cn("overflow-visible text-xs whitespace-nowrap text-soft",
      wide ? "w-full text-center" : at === bins.length - 1 && at ? "flex w-full justify-end" : "w-0")}>
      {xLabel(bin, bucket, at, bins.length)}</span>)}
  </div>;
}

type Pick = (days: Days) => void;
/** A bin's own press: its days lit while chosen, the rest dimmed until pointed at. */
const binClass = (bin: Bin, span: Days, wide: boolean) => cn("relative flex h-full flex-col-reverse gap-0.5 rounded-t-xs opacity-50 transition-opacity duration-(--motion-base) ease-out hover:bg-rule hover:opacity-100",
  wide ? "px-[max(3px,calc(50%-26px))]" : "px-[clamp(1px,12%,6px)]", lit(bin, span) && "opacity-100",
  !bin.complete && "outline outline-dashed outline-lit-line -outline-offset-1");

/** Bars of one or more parts a bin, stacked from the foot, on a scale of round marks. */
export function BarPanel({ bins, bucket, span, today, values, tipOf, unit, unitName, wholeOnly, grow, onPick }: {
  bins: Bin[]; bucket: Bucket; span: Days; today: string; values: (bin: number) => [string, number][]; tipOf: (bin: number) => string;
  unit: number; unitName: string; wholeOnly: boolean; grow: boolean; onPick: Pick;
}) {
  const { t } = useTranslation("analysis");
  const sums = bins.map((_, at) => values(at).reduce((total, [, value]) => total + value, 0));
  const marks = ticks(Math.max(0, ...sums), unit, wholeOnly), top = marks[marks.length - 1] || 1;
  const scale = (value: number, last: boolean) => {
    const written = (Math.round(value / unit * 100) / 100).toLocaleString();
    return last && unitName ? t(unit === 1 ? "unit.join" : "unit.joinTight", { value: written, unit: unitName }) : written;
  };
  return <>
    <div className={cn("relative h-33", GUT)}>
      <Grid marks={marks} top={top} label={scale} />
      <div className="grid h-full auto-cols-[minmax(0,1fr)] grid-flow-col items-end border-b border-lit-line">
        {bins.map((bin, at) => <button key={bin.from} type="button" onClick={() => onPick(bin)} className={binClass(bin, span, bucket !== "day")}
          {...tip(`${binName(bin, today, t)}${t("sep")}${tipOf(at)}`)}>
          {values(at).map(([color, value], part, all) => value > 0 && <i key={part} style={{ height: `${value / top * 100}%` }}
            className={cn("block flex-none origin-bottom rounded-[1px]", color, part === all.length - 1 && "rounded-t-[3px]", grow && "animate-bar")} />)}
        </button>)}
      </div>
    </div>
    <XAxis bins={bins} bucket={bucket} />
  </>;
}

/**
 * The share that went through without a fix, a point a bin. A point on fewer than ten accepted tasks is drawn faint
 * (one task moves it a lot), and so is the line to it.
 */
export function RatePanel({ bins, bucket, span, today, points, onPick }: {
  bins: Bin[]; bucket: Bucket; span: Days; today: string; points: { passed: number; accepted: number }[]; onPick: Pick;
}) {
  const { t } = useTranslation("analysis");
  const at = points.map((point, i) => point.accepted ? { x: (i + 0.5) / bins.length * 100, y: 100 - point.passed / point.accepted * 100, faint: point.accepted < 10 } : null);
  const lines = at.flatMap((point, i) => {
    const before = at.slice(0, i).reverse().find(Boolean);
    return point && before ? [{ from: before, to: point, faint: point.faint || before.faint }] : [];
  });
  const words = (point: { passed: number; accepted: number }) => !point.accepted ? t("chart.none")
    : point.accepted < 10 ? t("chart.shareTipFew", point)
      : t("chart.sharePercentTip", { ...point, share: `${Math.round(point.passed / point.accepted * 100)}%` });
  return <div className={cn("relative mb-5 h-19", GUT)}>
    <Grid marks={[0, 50, 100]} top={100} label={(value) => value === 100 ? "100%" : String(value)} />
    <svg aria-hidden className={cn("pointer-events-none absolute top-0 h-full w-[calc(100%-3rem)] overflow-visible narrow:w-[calc(100%-2.5rem)]", GUT_LEFT)}>
      {lines.map(({ from, to, faint }) => <line key={`${from.x}-${to.x}`} x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`}
        className={cn("stroke-done [stroke-linecap:round] [stroke-width:2]", faint && "[stroke-dasharray:2_4] [stroke-opacity:.4]")} />)}
    </svg>
    <div className="grid h-full auto-cols-[minmax(0,1fr)] grid-flow-col items-end">
      {bins.map((bin, i) => <button key={bin.from} type="button" onClick={() => onPick(bin)} className={binClass(bin, span, bucket !== "day")}
        {...tip(`${binName(bin, today, t)}${t("sep")}${words(points[i]!)}`)}>
        {points[i]!.accepted > 0 && <em style={{ bottom: `${points[i]!.passed / points[i]!.accepted * 100}%` }}
          className={cn("absolute start-1/2 -ms-1 -mb-1 size-2 rounded-full bg-done ring-2 ring-bg",
            points[i]!.accepted < 10 && "border-[1.5px] border-done bg-bg opacity-65")} />}
      </button>)}
    </div>
  </div>;
}

/** Levels of a day on the calendar: none, then four steps by the quarters of the days that had any. */
export function grassLevels(counts: number[]): (count: number) => number {
  const some = counts.filter(Boolean).sort((a, b) => a - b);
  const quarters = [0.25, 0.5, 0.75].map(q => some[Math.floor(q * (some.length - 1))] ?? 0);
  return count => count ? 1 + quarters.filter(q => count > q).length : 0;
}
const LEVEL = ["bg-grass-0", "bg-grass-1", "bg-grass-2", "bg-grass-3", "bg-done"];

/** The calendar of finished tasks: a cell a day, a column a week from Monday, deeper with more finished. */
export function Grass({ from, counts, firstDay, span, onPick }: { from: string; counts: number[]; firstDay: string | null; span: Days; onPick: Pick }) {
  const { t } = useTranslation("analysis");
  const level = grassLevels(counts);
  const one = span.from === span.to;
  const weeks: string[][] = [];
  for (let at = 0; at < counts.length; at++) (weeks[Math.floor(at / 7)] ??= []).push(addDays(from, at));
  const names = [0, 3, 6].map(day => [day, weekdayLabel(addDays(from, day))] as const);
  const cell = "block size-3.5 rounded-[3px]";
  return <div>
    <div role="group" aria-label={t("tasks.grass")} className="grid w-max grid-flow-col grid-rows-[16px_repeat(7,14px)] gap-0.75">
      <em />
      {[0, 1, 2, 3, 4, 5, 6].map(day => <em key={day} className="flex h-3.5 items-center justify-end pe-1 text-xs not-italic text-soft">{names.find(([at]) => at === day)?.[1] ?? ""}</em>)}
      {weeks.map((week, column) => [
        <em key={`m${column}`} className="flex h-3.5 w-3.5 items-center overflow-visible text-xs whitespace-nowrap not-italic text-soft">
          {column === 0 || Number(week[0]!.slice(8)) <= 7 ? monthLabel(week[0]!) : ""}</em>,
        ...week.map((day, row) => {
          const count = counts[column * 7 + row]!;
          if (firstDay && day < firstDay) return <span key={day} className={cell} />;
          const chosen = day >= span.from && day <= span.to;
          return <button key={day} type="button" onClick={() => onPick({ from: day, to: day })}
            className={cn(cell, LEVEL[level(count)], "hover:outline-[1.5px] hover:outline-ink hover:outline-offset-1 hover:outline-solid",
              one && chosen && "ring-[1.5px] ring-ink ring-offset-[1.5px] ring-offset-bg")}
            {...tip(t("tasks.grassTip", { day: dayWithWeekday(day), count }))} />;
        }),
      ])}
    </div>
    <p aria-hidden className="mt-2 flex items-center gap-0.75 text-xs text-soft">
      {t("tasks.grassFew")}<span className="w-1" />{LEVEL.slice(1).map(color => <i key={color} className={cn("block size-2.5 rounded-xs", color)} />)}<span className="w-1" />{t("tasks.grassMany")}
    </p>
  </div>;
}

/** One full bar of parts, each part's share of the whole; tiny ones still show. */
export function SplitBar({ parts, className }: { parts: { color: string; value: number; words: string }[]; className?: string }) {
  return <div className={cn("flex h-2 gap-0.5", className)}>
    {parts.map((part, at) => part.value > 0 && <i key={at} style={{ flex: part.value }} className={cn("block min-w-0.5 rounded-xs", part.color)} {...tip(part.words)} />)}
  </div>;
}
