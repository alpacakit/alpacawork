import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { addDays, dayWithWeekday, monthLabel, weekdayLabel } from "./format";
import { tip } from "./parts";

/** The calendar of finished tasks, and which days a chart's axis names (the charts themselves: rows.tsx). */
type Days = { from: string; to: string };
/** How wide a bin's name is drawn (a day "10/15", a month), and the least room between two names. */
const LABEL_PX = 34, LABEL_GAP_PX = 8;
/**
 * Which bins are named under a chart `width` pixels wide, so that no two names touch at any width or length of record:
 * a day chart names its first day, its last (drawn at the chart's end) and the Mondays between that have room; a week or
 * month chart names every bin that has room, each centred under its bin. The last is always named.
 */
export function axisLabels(count: number, wide: boolean, candidate: (at: number) => boolean, width: number): number[] {
  if (count <= 1) return count ? [0] : [];
  const bin = width / count;
  const extent = (at: number): [number, number] => wide ? [(at + 0.5) * bin - LABEL_PX / 2, (at + 0.5) * bin + LABEL_PX / 2]
    : at === count - 1 ? [width - LABEL_PX, width] : [at * bin, at * bin + LABEL_PX];
  const last = extent(count - 1), kept: number[] = [];
  let end = -Infinity;
  for (let at = 0; at < count - 1; at++) {
    if (at !== 0 && !candidate(at)) continue;
    const [from, to] = extent(at);
    if (from >= end + LABEL_GAP_PX && to + LABEL_GAP_PX <= last[0]) { kept.push(at); end = to; }
  }
  return [...kept, count - 1];
}

type Pick = (days: Days) => void;
/** Levels of a day on the calendar: none, then four steps by the quarters of the days that had any. */
export function grassLevels(counts: number[]): (count: number) => number {
  const some = counts.filter(Boolean).sort((a, b) => a - b);
  const quarters = [0.25, 0.5, 0.75].map(q => some[Math.floor(q * (some.length - 1))] ?? 0);
  return count => count ? 1 + quarters.filter(q => count > q).length : 0;
}
const LEVEL = ["bg-grass-0", "bg-grass-1", "bg-grass-2", "bg-grass-3", "bg-done"];

/** The calendar of finished tasks: a cell a day, a column a week from Monday, deeper with more finished. */
export function Grass({ from, counts, firstDay, today, span, onPick }: { from: string; counts: number[]; firstDay: string | null; today: string; span: Days; onPick: Pick }) {
  const { t } = useTranslation("analysis");
  const level = grassLevels(counts);
  const one = span.from === span.to;
  const weeks: string[][] = [];
  // Whole weeks: the days after today close the last one, drawn as the days before the record are.
  const shown = Math.ceil(counts.length / 7) * 7;
  for (let at = 0; at < shown; at++) (weeks[Math.floor(at / 7)] ??= []).push(addDays(from, at));
  const names = [0, 3, 6].map(day => [day, weekdayLabel(addDays(from, day))] as const);
  const cell = "block size-3.5 rounded-[3px]";
  // A long record is wider than the room: the calendar scrolls inside itself, and shows its latest weeks first.
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (box.current) box.current.scrollLeft = box.current.scrollWidth; }, [from, counts.length]);
  return <div ref={box} className="max-w-full min-w-0 overflow-x-auto pb-1 [scrollbar-width:thin]">
    <div role="group" aria-label={t("tasks.grass")} className="grid w-max grid-flow-col grid-rows-[16px_repeat(7,14px)] gap-0.75">
      <em />
      {[0, 1, 2, 3, 4, 5, 6].map(day => <em key={day} className="flex h-3.5 items-center justify-end pe-1 text-xs not-italic text-soft">{names.find(([at]) => at === day)?.[1] ?? ""}</em>)}
      {weeks.map((week, column) => [
        <em key={`m${column}`} className="flex h-3.5 w-3.5 items-center overflow-visible text-xs whitespace-nowrap not-italic text-soft">
          {column === 0 || Number(week[0]!.slice(8)) <= 7 ? monthLabel(week[0]!) : ""}</em>,
        ...week.map((day, row) => {
          const count = counts[column * 7 + row] ?? 0;
          // A day outside the record (before it began, after today) is a small dot: where the record runs is seen.
          if (firstDay && day < firstDay || day > today) return <span key={day} aria-hidden className={cn(cell, "grid place-items-center")}><i className="block size-0.5 rounded-full bg-lit-line" /></span>;
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
