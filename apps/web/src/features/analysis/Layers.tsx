import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, HEAD_MARK } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { PhoneSheet, sheetExtent } from "@/features/coordinator/PhoneSheet";
import { useScreenHeight } from "@/features/reader/TaskSheet";
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

const listExtent = sheetExtent("alpacawork.analysisListExtent");
const closeList = () => closeAnalysisLayer(0);

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
  const room = Math.round(useScreenHeight() * 0.88);
  const reader = useViewStore(readerShows);
  const surface = useRef<HTMLElement | null>(null);
  const [surfaceBox, setSurfaceBox] = useState<HTMLElement | null>(null);
  const setSurface = useCallback((node: HTMLElement | null) => { surface.current = node; setSurfaceBox(node); }, []);
  const layers = analysisSurfaces(place);
  const depth = layers.length;
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
  const card = place.card;
  const phoneList = narrow && !card;
  const layer = phoneList ? "z-(--layer-dialog)" : "z-(--layer-reader)";
  const label = card ? t("card.make") : place.list ? listTitle(place.list) : "";
  const contents = card ? <>
    <div className={cn("flex min-h-12 items-center justify-end pt-3.5 pe-3 pb-1.5 ps-6", narrow && "pt-4.5 pe-2 ps-4")}>
      <CloseLayer />
    </div>
    <div data-analysis-layer className="min-h-0 flex-1 overflow-auto px-6 narrow:px-4"><CardPane place={place} project={project} /></div>
  </> : place.list && <ListPane key={layers[0]} place={place} project={project} days={days} />;
  return <>
    {visible && <div aria-hidden className={cn("fixed inset-x-0 top-(--bar-h) bottom-0", layer)} onClick={closeList} />}
    {visible && <PointerTip root={surfaceBox} />}
    {phoneList
      ? <PhoneSheet ref={setSurface} role="dialog" aria-label={label} inert={!visible} data-analysis-list
          label={t("list.resize")} below={0} room={room} expanded={visible} onLetGo={closeList}
          store={listExtent} first={2 / 3} unname={unnameList}
          className={cn(layer, "rounded-t-pane border-t-hairline border-lit-line bg-lit shadow-float", !visible && "invisible")}>
          {contents}
        </PhoneSheet>
      : <aside ref={setSurface} role="dialog" inert={!visible} data-analysis-panel={visible && !narrow ? "" : undefined} aria-label={label}
          className={cn(layer, "fixed flex flex-col border-hairline border-lit-line bg-lit shadow-float", !visible && "invisible",
            narrow ? "inset-x-0 top-[18%] bottom-0 animate-sheet rounded-t-pane"
              : "top-window right-window bottom-window w-[min(548px,calc(100%-24px))] animate-side rounded-pane")}>
          {contents}
        </aside>}
  </>;
}

function CloseLayer() {
  const { t } = useTranslation("analysis");
  const label = t("list.close");
  return <Button variant="ghost" size="icon" aria-label={label} title={label} data-layer-focus onClick={closeList}
    className={HEAD_MARK}><Icon name="close" /></Button>;
}

function unnameList(copy: HTMLElement) {
  copy.removeAttribute("data-analysis-list");
  copy.querySelector("[data-analysis-layer]")?.removeAttribute("data-analysis-layer");
  for (const row of copy.querySelectorAll("[data-unit-row]")) row.removeAttribute("data-unit-row");
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
  const left = first ? first.total - rows.length : 0;
  const title = first ? listHeading(list, first.total) : listTitle(list);
  const dayOf = (row: ListRow) => row.finishedAt ? instant(row.finishedAt, zone).split(" ")[0]! : null;
  const noDays = !showsDays(list, list.days ?? span);
  const columns = noDays ? "grid-cols-[44px_minmax(0,1fr)_minmax(64px,auto)]" : "grid-cols-[44px_minmax(0,1fr)_48px_minmax(64px,auto)]";
  return <>
    <header data-card-grab className="flex min-h-14 shrink-0 items-start gap-2 border-b border-rule px-6 pt-3 pb-2 narrow:touch-none narrow:px-3 narrow:pt-5">
      <div className="min-w-0 flex-1">
        <h3 className="text-heading font-semibold">{title}</h3>
        {(member || list.days || spanWords) && <p className="mt-0.5 text-xs text-soft">
          {member}{member && (list.days || spanWords) && t("sep")}{list.days ? spanLabel(list.days.from, list.days.to) : spanWords}
        </p>}
      </div>
      <CloseLayer />
    </header>
    <div data-analysis-layer className="min-h-0 flex-1 scroll-pt-10 overflow-auto overscroll-contain px-6 narrow:px-3 narrow:pb-[max(1rem,env(safe-area-inset-bottom))]">
      {!first ? <ReadPart set={{ data: null, current: false, reads: [query] }} skeleton={<RegionSkeleton shape="analysisList" />}>{() => null}</ReadPart>
        : rows.length ? <>
        <div className={cn("sticky top-0 z-1 grid min-h-7 items-end gap-x-3 border-b border-rule bg-lit pt-3 pb-1.5 text-xs text-soft",
          columns, "narrow:grid-cols-[minmax(0,1fr)_auto_0.75rem] narrow:gap-x-2")}>
          <span>{t("list.task")}</span><span className="narrow:hidden" />
          {!noDays && <span className="text-end [word-break:auto-phrase] narrow:hidden">{t("list.day")}{!list.value && " ▼"}</span>}
          <span className="text-end whitespace-nowrap">{listColumn(list)}{list.value && " ▼"}</span>
        </div>
        <ul>{rows.map(row => <li key={row.id} className="border-b border-rule">
          <button type="button" data-unit-row={row.id} onClick={() => useViewStore.getState().openTask(row.id, { reader: true, pane: "analysis" })}
            className={cn("grid min-h-9.75 w-full items-center gap-x-3 rounded-sm text-start text-base hover:bg-hover focus:bg-hover",
              columns, "narrow:min-h-12 narrow:grid-cols-[minmax(0,1fr)_auto_0.75rem] narrow:gap-x-2 narrow:py-1.5")}>
            <span dir="auto" className="col-start-2 row-start-1 truncate narrow:col-start-1 narrow:line-clamp-2 narrow:whitespace-normal">{row.title}</span>
            <span className="contents narrow:col-start-1 narrow:row-start-2 narrow:flex narrow:gap-2 narrow:text-xs narrow:text-soft">
              <span className="col-start-1 row-start-1 text-muted">{row.id}</span>
              {!noDays && <span className="col-start-3 row-start-1 text-end text-soft">{dayOf(row) ?? ""}</span>}
            </span>
            <span className={cn(noDays ? "col-start-3" : "col-start-4",
              "row-start-1 text-end font-semibold whitespace-nowrap narrow:col-start-2 narrow:row-span-2")}>
              {list.value && row.value !== null ? writeValue(list.value, row.value)
                : <span className="inline-flex items-center font-normal text-muted">{row.outcome && <Square className={OUTCOME[row.outcome]} />}{outcomeWord(row, t)}</span>}
            </span>
            <Icon name="right" className="col-start-3 row-span-2 row-start-1 hidden size-3 text-muted narrow:block" />
          </button>
        </li>)}</ul>
        {/* The next page comes in where its rows will stand; a page that could not be read says so, with a way to ask again. */}
        {query.isFetchingNextPage ? <RegionSkeleton shape="analysisRows" />
          : query.isFetchNextPageError ? <ReadFailure error={query.error} className="mt-2.5" retry={() => void query.fetchNextPage()} />
          : left > 0 && query.hasNextPage && <button type="button" onClick={() => void query.fetchNextPage()}
            className="-mx-1 mt-2.5 rounded-sm px-1 text-base text-muted decoration-ink underline-offset-4 hover:bg-hover hover:text-ink hover:underline">{t("list.more", { count: left })}</button>}
      </> : <p className="mt-4 text-soft">{t("list.empty")}</p>}
    </div>
  </>;
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
