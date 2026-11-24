import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { Icon } from "@/components/ui/icon";
import { tip, useChoices } from "./parts";

/** A cell: its number and unit, its small window, its list; `split`: a share drawn as a small strip of its two parts. */
export type Cell = { text: string; unit?: string; tip?: string; open?: () => void; split?: [number, number] };
export type Row = { key: string; name: string; tag?: string; bar: number; cells: Cell[] };

/**
 * A breakdown: the name, one quiet bar for how many, then the numbers, each a way into its tasks (it shows so when
 * pointed at). On a phone it shows the name and one column, chosen from that column's own heading. The first ten rows
 * stand; the rest come with a press.
 */
/**
 * A table `width` pixels wide on the page's grid (12 columns, 24px apart): the name and its bar over the left three
 * columns and the gap after them, each number a seventh of the right nine.
 */
export function grid(width: number) {
  const column = (width - 11 * 24) / 12;
  return { name: Math.max(0, 3 * column + 3 * 24 - 112), number: (9 * column + 8 * 24) / 7 };
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
        <col style={{ width: grid(width).name }} /><col style={{ width: 112 }} />
        {columns.map(name => <col key={name} style={{ width: grid(width).number }} />)}<col />
      </colgroup>}
      <thead><tr className="h-7 text-xs text-soft">
        <th className="text-start font-normal">{head}</th>
        <th className="px-2 narrow:w-16" />
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
        <th className="narrow:hidden" />
      </tr></thead>
      <tbody>{visible.map(row => <tr key={row.key} className="h-9 border-b border-rule">
        <td dir="auto" className="truncate narrow:whitespace-normal">{row.name}{row.tag && <small className="ms-1.5 text-soft">{row.tag}</small>}</td>
        <td className="px-2"><i style={{ width: `${row.bar / most * 100}%`, background: `color-mix(in oklab, var(--${tone}) ${Math.round(45 + 55 * row.bar / most)}%, var(--bg))` }}
          className="block h-1.5 min-w-0.5 rounded-full" /></td>
        {row.cells.map((cell, at) => <td key={at} className={column(at)}>
          {cell.open
            ? <button type="button" onClick={cell.open} {...(cell.tip ? tip(cell.tip) : {})}
              className="flex h-8.75 w-full items-center justify-end rounded-sm px-2 underline decoration-lit-line underline-offset-4 hover:bg-hover hover:decoration-ink">
              {cell.split && <Split parts={cell.split} />}{cell.text}{cell.unit && <span className="ms-px text-xs text-soft">{cell.unit}</span>}</button>
            : <span className="flex h-8.75 items-center justify-end px-2" {...(cell.tip ? tip(cell.tip) : {})}>{cell.text}{cell.unit && <span className="ms-px text-xs text-soft">{cell.unit}</span>}</span>}
        </td>)}
        <td className="narrow:hidden" />
      </tr>)}</tbody>
    </table>
    {rows.length > limit && <button type="button" onClick={() => useChoices.getState().choose({ all: !all })}
      className="mt-2.5 text-muted underline decoration-line underline-offset-4 hover:decoration-ink">
      {all ? t("breakdown.top") : t("breakdown.all", { count: rows.length })}</button>}
  </>;
}

/** A share as a small strip (40px) of its two parts: without fixes in green, with fixes in orange. */
function Split({ parts: [passed, reworked] }: { parts: [number, number] }) {
  return <span aria-hidden className="me-2 inline-flex h-1.5 w-10 gap-px overflow-hidden rounded-full">
    <i style={{ flex: passed }} className="block bg-done" /><i style={{ flex: reworked }} className="block bg-reworked" />
  </span>;
}
