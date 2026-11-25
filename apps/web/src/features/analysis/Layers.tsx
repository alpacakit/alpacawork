import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { closeAnalysisLayer } from "@/state/history-step";
import { readerShows, useNarrow, useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { giveFocusBack, openerChain } from "@/lib/focus-return";
import { useBreakdown, useUnitList } from "./data";
import { instant, spanLabel } from "./format";
import { listColumn, listHeading, listTitle, showsDays, writeValue } from "./lists";
import { PointerTip, ReadPart, rowName, Square, useChoices } from "./parts";
import { CardPane } from "./ShareCard";
import type { ListRow } from "./contract";
import { analysisSurfaces, type AnalysisPlace, type ListPlace, type Span } from "./place";

/** A task's outcome: its colour and its word. */
const OUTCOME = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;
const outcomeWord = (row: ListRow, say: (key: string) => string) => say(`outcome.${row.outcome ?? "none"}`);

/**
 * A number's task list and the share card. The list stays mounted beneath a task panel so it can give its scroll
 * position and focus back when the reader closes.
 */
export function Layers({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const narrow = useNarrow();
  const reader = useViewStore(readerShows);
  const surface = useRef<HTMLElement | null>(null);
  const [surfaceBox, setSurfaceBox] = useState<HTMLElement | null>(null);
  const setSurface = (node: HTMLElement | null) => { surface.current = node; setSurfaceBox(node); };
  const depth = analysisSurfaces(place).length;
  const open = depth > 0;
  const visible = open && !reader;
  useEffect(() => {
    if (!visible) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeAnalysisLayer(depth - 1); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [visible, depth]);
  const openedRow = useRef<string | null>(null);
  useEffect(() => {
    if (reader) { openedRow.current ??= reader; return; }
    const row = openedRow.current && surface.current?.querySelector<HTMLElement>(`[data-unit-row="${CSS.escape(openedRow.current)}"]`);
    openedRow.current = null;
    (row || surface.current?.querySelector<HTMLElement>("[data-layer-focus]"))?.focus({ preventScroll: true });
  }, [place.list, place.card, reader]);
  const opener = useRef<Element[]>([]);
  useLayoutEffect(() => {
    if (open) { opener.current = openerChain(document.activeElement); return; }
    const chain = opener.current;
    opener.current = [];
    giveFocusBack(chain);
  }, [open]);
  if (!open) return null;
  return <>
    {visible && <div aria-hidden className="fixed inset-x-0 top-(--bar-h) bottom-0 z-(--layer-reader)" onClick={() => closeAnalysisLayer(0)} />}
    {visible && <PointerTip root={surfaceBox} />}
    <aside ref={setSurface} role="dialog" inert={!visible} data-analysis-panel={visible && !narrow ? "" : undefined} aria-label={place.card ? t("card.make") : place.list ? listTitle(place.list) : ""}
      className={cn("fixed z-(--layer-reader) flex flex-col border-hairline border-lit-line bg-lit shadow-float", !visible && "invisible",
        narrow ? "inset-x-0 top-[18%] bottom-0 animate-sheet rounded-t-pane before:absolute before:top-1.5 before:left-1/2 before:-ms-4.5 before:h-1 before:w-9 before:rounded-xs before:bg-lit-line"
          : "top-window right-window bottom-window w-[min(548px,calc(100%-24px))] animate-side rounded-pane")}>
      <div className={cn("flex min-h-12 items-center justify-end pt-3.5 pe-3 pb-1.5 ps-6", narrow && "pt-4.5 pe-2 ps-4")}>
        <Button variant="ghost" size="icon" aria-label={t("list.close")} title={t("list.close")} data-layer-focus
          onClick={() => closeAnalysisLayer(0)}><Icon name="close" /></Button>
      </div>
      <div data-analysis-layer className="min-h-0 flex-1 overflow-auto px-6 narrow:px-4">
        {place.card ? <CardPane place={place} project={project} />
          : place.list && <ListPane key={JSON.stringify(place.list)} place={place} project={project} days={days} />}
      </div>
    </aside>
  </>;
}

/** The tasks of one number: how many, for which days, and each task with its own value for it, most first. */
function ListPane({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const list = place.list!;
  const query = useUnitList(project, place.span, list);
  const row = useRowOf(project, place.span, list);
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const rows = pages.flatMap(page => page.rows);
  const zone = first?.head.timeZone ?? "UTC";
  // A row is named as its breakdown names it (its key is not its name); a whole of skills, tools or MCP by the breakdown.
  const member = row ? rowName(row, t("tasks.noAgent")) : list.member === null ? list.group && t(`usage.by.${list.group}`) : null;
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
    <p className="mt-0.5 text-xs text-soft">{member}{member && spanWords && t("sep")}{spanWords}</p>
    {rows.length ? <>
      {/* A heading that wraps (a narrow window, a long language) makes the line taller, never runs into the first row. */}
      <div className={cn("mt-4 grid min-h-7 items-end gap-x-3 border-b border-rule pb-1.5 text-xs text-soft", columns)}>
        <span>{t("list.task")}</span><span />{!noDays && <span className="text-end [word-break:auto-phrase]">{t("list.day")}{!list.value && " ▼"}</span>}
        <span className="text-end whitespace-nowrap">{listColumn(list)}{list.value && " ▼"}</span>
      </div>
      <ul>{rows.map(row => <li key={row.id} className="border-b border-rule">
        <button type="button" data-unit-row={row.id} onClick={() => useViewStore.getState().openTask(row.id, { reader: true, pane: "analysis" })}
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

/** The breakdown's row a list was opened from: the answer that drew it (already read), and its row by key. */
function useRowOf(project: string | null, span: Span, list: ListPlace) {
  const bucket = useChoices(state => state.bucket);
  const group = list.group ?? "model", row = list.group !== null && list.member !== null;
  // The same read as the breakdown's own (already held when the list was opened from it).
  const read = useBreakdown(list.set === "used" ? "usage" : "tasks", project, span, bucket, group, row);
  const rows: (Parameters<typeof rowName>[0] & { key: string })[] = read.data?.breakdown.rows ?? [];
  return row ? rows.find(each => each.key === list.member) ?? null : null;
}
