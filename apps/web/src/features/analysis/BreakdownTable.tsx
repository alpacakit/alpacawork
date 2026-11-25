import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { Icon } from "@/components/ui/icon";
import { OPEN, OpenMark, tip, useChoices } from "./parts";

/** A cell: its number and unit, its small window, its list; `split`: a share drawn as a small strip of its two parts. */
export type Cell = { text: string; unit?: string; tip?: string; open?: () => void; split?: [number, number] };
export type Row = { key: string; name: string; tag?: string; bar: number; cells: Cell[] };

/**
 * A breakdown: the name, then the numbers, each a way into its tasks; the first number's column draws a quiet bar of
 * how many before it, to compare the rows by. Each column's unit is in its heading, once. On a phone it shows the name
 * and one column, chosen from that column's own heading. The first ten rows stand; the rest come with a press.
 */
/**
 * A table `width` pixels wide on the page's grid (12 columns, 24px apart): the name over the left three columns and
 * the gap after them, the `count` numbers sharing the right nine evenly, to its edge.
 */
export function grid(width: number, count: number) {
  const column = (width - 11 * 24) / 12;
  return { name: 3 * column + 3 * 24, number: (9 * column + 8 * 24) / Math.max(1, count) };
}

export function BreakdownTable({ id, head, columns, rows, limit = 10, tone = "muted" }: { id: string; head: string; columns: string[]; rows: Row[]; limit?: number;
  /** The colour of the rows' bars (the look's: tasks done's green, the AI's use working's blue), deeper the longer. */
  tone?: "done" | "working" | "muted" }) {
  const { t } = useTranslation("analysis");
  const all = useChoices(state => state.all);
  const [shown, setShown] = useState<Record<string, number>>({});
  const on = shown[id] ?? 0;
  const narrow = useNarrow();
  const box = useRef<HTMLTableElement>(null);
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
  const most = Math.max(1, ...rows.map(row => row.bar));
  const visible = all ? rows : rows.slice(0, limit);
  if (!rows.length) return <p className="text-soft">{t("usage.none")}</p>;
  const column = (at: number) => cn("text-end narrow:hidden", at === on && "narrow:table-cell narrow:w-auto");
  // On a computer the table stands on the page's grid: the name and its bar over the left three columns and the gap after
  // them, the numbers over the right nine, a seventh of them each, from the left.
  return <>
    <table ref={box} className="w-full table-fixed border-collapse narrow:table-auto">
      {!narrow && width > 0 && <colgroup>
        <col style={{ width: grid(width, columns.length).name }} />
        {columns.map(name => <col key={name} style={{ width: grid(width, columns.length).number }} />)}
      </colgroup>}
      <thead><tr className="h-7 text-xs text-soft">
        <th className="text-start font-normal">{head}</th>
        {columns.map((name, at) => <th key={name} className={cn(column(at), "px-2 font-normal whitespace-nowrap")}>
          <span className="narrow:hidden">{name}</span>
          {/* On a phone the column's name chooses which column shows: the arrow says it opens a choice. */}
          <span className="relative hidden items-center narrow:inline-flex">
            <select aria-label={name} value={on} onChange={event => setShown({ ...shown, [id]: Number(event.target.value) })}
              className="max-w-[13em] appearance-none bg-transparent pe-4 text-end text-xs text-soft">
              {columns.map((each, index) => <option key={each} value={index}>{each}</option>)}
            </select>
            <Icon name="down" className="pointer-events-none absolute end-0 size-3 text-soft" />
          </span>
        </th>)}
      </tr></thead>
      <tbody>{visible.map(row => <tr key={row.key} className="h-9 border-b border-rule text-sm">
        <td dir="auto" className="truncate narrow:whitespace-normal">{row.name}{row.tag && <small className="ms-1.5 text-soft">{row.tag}</small>}</td>
        {row.cells.map((cell, at) => {
          const body = <>{cell.split && <Split parts={cell.split} />}<span className="tabular-nums">{cell.text}</span>
            {cell.unit && <span className="ms-px text-xs text-soft">{cell.unit}</span>}</>;
          return <td key={at} className={column(at)}>
            <span className="flex h-8.75 items-center justify-end gap-2 px-2">
              {/* The first number's column draws how many before it: the rows compared at a glance. */}
              {at === 0 && <i style={{ width: `${row.bar / most * 100}%`, background: `color-mix(in oklab, var(--${tone}) ${Math.round(45 + 55 * row.bar / most)}%, var(--bg))` }}
                className="me-auto block h-1.5 max-w-[60%] min-w-0.5 rounded-full narrow:hidden" />}
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
  </>;
}

/** A share as a small strip (40px) of its two parts: without fixes in green, with fixes in orange. */
function Split({ parts: [passed, reworked] }: { parts: [number, number] }) {
  return <span aria-hidden className="me-2 inline-flex h-1.5 w-10 gap-px overflow-hidden rounded-full">
    <i style={{ flex: passed }} className="block bg-done" /><i style={{ flex: reworked }} className="block bg-reworked" />
  </span>;
}
