import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { Icon } from "@/components/ui/icon";
import { OPEN, OpenMark, tip, useChoices } from "./parts";

/** A cell: its number (its unit is the column's), its small window, its list; `split`: a share drawn as a small strip of its two parts. */
export type Cell = { text: string; tip?: string; open?: () => void; split?: [number, number] };
export type Row = { key: string; name: string; tag?: string; bar: number; cells: Cell[] };

/**
 * A breakdown: the name, then the numbers, each a way into its tasks. The rows stand by the first number, most first,
 * and that column draws a quiet bar of how many, to compare the rows by. Each column's unit is in its heading, once.
 * The table is as wide as the page is now: the name over the left quarter of the grid (its three columns and the gap
 * after them), the numbers sharing the rest evenly. A heading wraps to the lines it needs, never over its neighbour.
 * Where the numbers would have less than `MIN_COLUMN` each (a phone, a narrow window, a long language), the table shows
 * the name and one column, chosen from that column's own heading: it never scrolls sideways. The first ten rows stand;
 * the rest come with a press.
 */
export const MIN_COLUMN = 88;
/** Whether a table `width` pixels wide holds all its `count` numbers side by side (each at least MIN_COLUMN). */
export const holdsAll = (width: number, count: number) => (width * 0.75 - 6) / Math.max(1, count) >= MIN_COLUMN;

export function BreakdownTable({ id, head, columns, rows, limit = 10, tone = "muted" }: { id: string; head: string; columns: string[]; rows: Row[]; limit?: number;
  /** The colour of the rows' bars (the look's: tasks done's green, the AI's use working's blue), deeper the longer. */
  tone?: "done" | "working" | "muted" }) {
  const { t } = useTranslation("analysis");
  const all = useChoices(state => state.all);
  const [shown, setShown] = useState<Record<string, number>>({});
  const on = Math.min(shown[id] ?? 0, columns.length - 1);
  const narrow = useNarrow();
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
  }, [rows.length > 0]);
  if (!rows.length) return <p className="text-soft">{t("usage.none")}</p>;
  const one = narrow || width > 0 && !holdsAll(width, columns.length);
  const sorted = [...rows].sort((a, b) => b.bar - a.bar);
  const most = Math.max(1, ...sorted.map(row => row.bar));
  const visible = all ? sorted : sorted.slice(0, limit);
  const shows = (at: number) => !one || at === on;
  return <div ref={box}>
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col style={{ width: one ? "auto" : "calc(25% + 6px)" }} />
        {columns.map((name, at) => shows(at) && <col key={name} style={one ? { width: "45%" } : undefined} />)}
      </colgroup>
      <thead><tr className="text-xs text-soft">
        <th className="pb-1.5 text-start align-bottom font-normal">{head}</th>
        {columns.map((name, at) => shows(at) && <th key={name} className="px-2 pb-1.5 text-end align-bottom font-normal hyphens-auto [overflow-wrap:break-word] [word-break:auto-phrase]">
          {one
            // The column's name chooses which column shows: the arrow says it opens a choice.
            ? <span className="relative inline-flex max-w-full items-center">
              <select aria-label={name} value={on} onChange={event => setShown({ ...shown, [id]: Number(event.target.value) })}
                className="max-w-full appearance-none truncate bg-transparent pe-4 text-end text-xs text-soft">
                {columns.map((each, index) => <option key={each} value={index}>{each}</option>)}
              </select>
              <Icon name="down" className="pointer-events-none absolute end-0 size-3 text-soft" />
            </span>
            : name}
        </th>)}
      </tr></thead>
      <tbody className="border-t border-rule">{visible.map(row => <tr key={row.key} className="h-9 border-b border-rule text-sm">
        <td dir="auto" className={cn(one ? "pe-2 [overflow-wrap:anywhere]" : "truncate")}>{row.name}{row.tag && <small className="ms-1.5 text-soft">{row.tag}</small>}</td>
        {row.cells.map((cell, at) => {
          if (!shows(at)) return null;
          const body = <>{cell.split && <Split parts={cell.split} />}<span className="tabular-nums">{cell.text}</span></>;
          return <td key={at} className="text-end">
            <span className="flex h-8.75 items-center justify-end gap-2 px-2">
              {/* The first number's column draws how many before it: the rows compared at a glance. */}
              {at === 0 && !one && <i style={{ width: `${row.bar / most * 100}%`, background: `color-mix(in oklab, var(--${tone}) ${Math.round(45 + 55 * row.bar / most)}%, var(--bg))` }}
                className="me-auto block h-1.5 max-w-[60%] min-w-0.5 rounded-full" />}
              {cell.open
                ? <button type="button" onClick={cell.open} {...(cell.tip ? tip(cell.tip) : {})} className={cn(OPEN, "items-center")}>{body}<OpenMark /></button>
                : <span className="inline-flex items-center" {...(cell.tip ? tip(cell.tip) : {})}>{body}<i aria-hidden className="ms-0.5 inline-block size-3 flex-none" /></span>}
            </span>
          </td>;
        })}
      </tr>)}</tbody>
    </table>
    {rows.length > limit && <button type="button" onClick={() => useChoices.getState().choose({ all: !all })}
      className="-mx-1 mt-2.5 rounded-sm px-1 text-sm text-muted decoration-ink underline-offset-4 hover:bg-hover hover:text-ink hover:underline">
      {all ? t("breakdown.top") : t("breakdown.all", { count: rows.length })}</button>}
  </div>;
}

/** A share as a small strip (40px) of its two parts: without fixes in green, with fixes in orange. */
function Split({ parts: [passed, reworked] }: { parts: [number, number] }) {
  return <span aria-hidden className="me-2 inline-flex h-1.5 w-10 gap-px overflow-hidden rounded-full">
    <i style={{ flex: passed }} className="block bg-done" /><i style={{ flex: reworked }} className="block bg-reworked" />
  </span>;
}
