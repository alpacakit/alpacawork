import { EFFORT_NONE } from "./series";
import { useTranslation } from "react-i18next";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { useBreakdown, useUnitList } from "./data";
import { instant, spanLabel } from "./format";
import { listColumn, listHeading, showsDays, writeValue } from "./lists";
import { ReadPart, rowName, Square, useChoices } from "./parts";
import type { ListRow } from "./contract";
import type { AnalysisPlace, ListPlace, Span } from "./place";

export { CardPane } from "./ShareCard";

/** A task's outcome: its colour and its word. */
const OUTCOME = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;
const outcomeWord = (row: ListRow, say: (key: string) => string) => say(`outcome.${row.outcome ?? "none"}`);

/** The tasks of one number: how many, for which days, and each task with its own value for it, most first. */
export function ListPane({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const list = place.list!;
  const query = useUnitList(project, place.span, list);
  const row = useRowOf(project, place.span, list);
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const rows = pages.flatMap(page => page.rows);
  const zone = first?.head.timeZone ?? "UTC";
  // A row is named as its breakdown names it (its key is not its name); a whole of skills, tools or MCP by the breakdown.
  // An effort none was recorded for is named in the reader's language, as the chart names it.
  const member = row ? list.group === "effort" && "effort" in row && row.effort === null ? t("usage.effortNone") : rowName(row, t("tasks.noAgent"))
    : list.member === null ? list.group && t(`usage.by.${list.group}`) : null;
  // The model and effort the launches were filtered to, so a list opened again from its address says what it holds.
  const filter = [list.filter?.model, list.filter?.effort && (list.filter.effort === EFFORT_NONE ? `${t("usage.launchEffort")} ${t("usage.effortNone")}` : `${t("usage.launchEffort")} ${list.filter.effort}`)]
    .filter(Boolean).join(t("sep"));
  const span = first?.head.period ?? days;
  const spanWords = !list.days && span ? spanLabel(span.from, span.to) : null;
  // Until its first page has come, the list stands as every part does (ReadPart): its shape, its failure, or offline.
  if (!first) return <ReadPart set={{ data: null, current: false, reads: [query] }} skeleton={<RegionSkeleton shape="analysisList" />}>{() => null}</ReadPart>;
  const left = first.total - rows.length;
  // A list of a chart's bin says its days and what it lists on one line; a number's list says its span under it.
  const title = listHeading(list, first.total);
  const dayOf = (row: ListRow) => row.finishedAt ? instant(row.finishedAt, zone).split(" ")[0]! : null;
  const noDays = !showsDays(list, list.days ?? span);
  const columns = noDays ? "grid-cols-[44px_minmax(0,1fr)_minmax(64px,auto)]" : "grid-cols-[44px_minmax(0,1fr)_48px_minmax(64px,auto)]";
  return <div className="animate-rise">
    <h3 className="text-heading font-semibold">{list.days ? `${spanLabel(list.days.from, list.days.to)}${t("sep")}${title}` : title}</h3>
    <p className="mt-0.5 text-xs text-soft">{[member, filter, spanWords].filter(Boolean).map((words, at) => <span key={at}>{at > 0 && t("sep")}{words}</span>)}</p>
    {rows.length ? <>
      {/* A heading that wraps (a narrow window, a long language) makes the line taller, never runs into the first row. */}
      <div className={cn("mt-4 grid min-h-7 items-end gap-x-3 border-b border-rule pb-1.5 text-xs text-soft", columns)}>
        <span>{t("list.task")}</span><span />{!noDays && <span className="text-end [word-break:auto-phrase]">{t("list.day")}{!list.value && " ▼"}</span>}
        <span className="text-end whitespace-nowrap">{listColumn(list)}{list.value && " ▼"}</span>
      </div>
      <ul>{rows.map(row => <li key={row.id} className="border-b border-rule">
        <button type="button" data-unit-row={row.id}
          onClick={event => useViewStore.getState().openTask(row.id, { reader: true, pane: "analysis", returnTo: event.currentTarget })}
          className={cn("grid h-9.75 w-full items-center gap-x-3 rounded-sm text-start text-base hover:bg-hover", columns)}>
          <span className="text-muted">{row.id}</span>
          <span dir="auto" className="truncate">{row.title}</span>
          {!noDays && <span className="text-end text-soft">{dayOf(row) ?? ""}</span>}
          <span className="text-end font-semibold whitespace-nowrap">
            {list.value && row.value !== null ? writeValue(list.value, row.value)
              : <span className="inline-flex items-center font-normal text-muted">{row.outcome && <Square className={OUTCOME[row.outcome]} />}{outcomeWord(row, t)}</span>}
          </span>
        </button>
      </li>)}</ul>
      {/* The next page comes in where its rows will stand; a page that could not be read says so, with a way to ask again. */}
      {query.isFetchingNextPage ? <RegionSkeleton shape="analysisRows" />
        : query.isFetchNextPageError ? <ReadFailure error={query.error} className="mt-2.5" retry={() => void query.fetchNextPage()} />
        : left > 0 && query.hasNextPage && <button type="button" onClick={() => void query.fetchNextPage()}
          className="-mx-1 mt-2.5 rounded-sm px-1 text-base text-muted decoration-ink underline-offset-4 hover:bg-hover hover:text-ink hover:underline">{t("list.more", { count: left })}</button>}
    </> : <p className="mt-4 text-soft">{t("list.empty")}</p>}
  </div>;
}

/**
 * The breakdown's row a list was opened from, and its row by key: for a number of the span, the breakdown's own answer
 * (already read); for a chart's bin, that bin's days, where the row may be one the span does not hold.
 */
function useRowOf(project: string | null, span: Span, list: ListPlace) {
  const bucket = useChoices(state => state.bucket);
  const group = list.group ?? "model", row = list.group !== null && list.member !== null;
  const read = useBreakdown(list.set === "used" ? "usage" : "tasks", project, list.days ?? span, bucket, group, row);
  const rows: (Parameters<typeof rowName>[0] & { key: string })[] = read.data?.breakdown.rows ?? [];
  return row ? rows.find(each => each.key === list.member) ?? null : null;
}
