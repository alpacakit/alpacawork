import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { tip, useChoices } from "./parts";

export type Cell = { text: string; unit?: string; tip?: string; open?: () => void };
export type Row = { key: string; name: string; tag?: string; bar: number; cells: Cell[] };

/**
 * A breakdown: the name, one quiet bar for how many, then the numbers, each a way into its tasks (it shows so when
 * pointed at). On a phone it shows the name and one column, chosen from that column's own heading. The first ten rows
 * stand; the rest come with a press.
 */
export function BreakdownTable({ id, head, columns, rows, limit = 10 }: { id: string; head: string; columns: string[]; rows: Row[]; limit?: number }) {
  const { t } = useTranslation("analysis");
  const all = useChoices(state => state.all);
  const [shown, setShown] = useState<Record<string, number>>({});
  const on = shown[id] ?? 0;
  const most = Math.max(1, ...rows.map(row => row.bar));
  const visible = all ? rows : rows.slice(0, limit);
  if (!rows.length) return <p className="text-soft">{t("usage.none")}</p>;
  const column = (at: number) => cn("w-33 text-end narrow:hidden", at === on && "narrow:table-cell narrow:w-auto");
  return <>
    <table className="w-full border-collapse">
      <thead><tr className="h-7 text-xs text-soft">
        <th className="w-55 text-start font-normal narrow:w-auto">{head}</th>
        <th className="w-28 px-2 narrow:w-16" />
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
        <td dir="auto" className="whitespace-nowrap narrow:whitespace-normal">{row.name}{row.tag && <small className="ms-1.5 text-soft">{row.tag}</small>}</td>
        <td className="px-2"><i style={{ width: `${row.bar / most * 100}%` }} className="block h-1.5 min-w-0.5 rounded-full bg-muted" /></td>
        {row.cells.map((cell, at) => <td key={at} className={column(at)}>
          {cell.open
            ? <button type="button" onClick={cell.open} {...(cell.tip ? tip(cell.tip) : {})}
              className="flex h-8.75 w-full items-center justify-end rounded-sm px-2 underline decoration-lit-line underline-offset-4 hover:bg-hover hover:decoration-ink">
              {cell.text}{cell.unit && <span className="ms-px text-xs text-soft">{cell.unit}</span>}</button>
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
