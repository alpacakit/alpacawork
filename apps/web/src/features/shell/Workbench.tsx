import { useDirectWriteRecovery } from "@/features/reader/recovery";
import { useCallback, useContext, useDeferredValue, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { readerHasTask, useEveryTaskIndex, useListPlace } from "@/data/queries";
import { subscribeReads } from "@/data/read-model";
import { useQueryClient } from "@tanstack/react-query";
import { useFrameSelector, WorkspaceContext } from "@/data/workspace-store";
import { Loadable } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { NoProjects } from "@/features/archive/NoProjects";
import { openSettings, useDialogStore } from "@/state/dialog-store";
import { AwaitedLookup } from "@/features/reader/AwaitedLookup";
import { useOpenFromNotification } from "@/data/push";
import { useUrlBootstrap } from "@/state/bootstrap";
import { useInputMode } from "@/state/input-mode";
import { awaitedTask, isSearchShown, shownInReader, useNarrow, useViewStore } from "@/state/view-store";
import { AppBar } from "@/features/chrome/AppBar";
import { useProjectShortcuts } from "@/features/chrome/ProjectMenu";
import { SearchResults } from "@/features/chrome/SearchResults";
import { NarrowSearchRow } from "@/features/chrome/SearchField";
import { WorkspaceNotice } from "@/features/chrome/WorkspaceNotice";
import { ProgressLine } from "@/features/chrome/ProgressLine";
import { useDocumentTitle } from "@/features/chrome/use-document-title";
import { useGlobalShortcuts } from "@/features/chrome/use-shortcuts";
import { ListNavigationProvider } from "@/features/tree/list-navigation";
import { TimeTree } from "@/features/tree/TimeTree";
import { AnalysisView } from "@/features/analysis/AnalysisView";
import { useDeviceValue } from "@/lib/device-storage";
import { readerEdgeHeld, readerWidth, fitReaderWidth, MIN_DOCK_VIEWPORT_WIDTH, READER_MIN_WIDTH, readerListReservation, readerWidthBeside, stripHidden, urlValue, windowMargin } from "@/state/screen-settings";
import { VIEW_BESIDE_WIDTH } from "@/features/reader/viewer/viewer-layout";
import { Reader, readerBox, type ReaderMode } from "@/features/reader/Reader";
import { DialogHost } from "./DialogHost";
import { barVars, UNDER_BAR, useBar, useBarAutoHide } from "@/state/bar";
import { AWAY, Bar, BarRoom } from "@/features/chrome/Bar";
import { CoordinatorCard, useCoordinatorShortcut } from "@/features/coordinator/CoordinatorCard";
import { GuideBalloon } from "@/features/guide/Guide";

const subscribeViewport = (notify: () => void) => {
  addEventListener("resize", notify);
  return () => removeEventListener("resize", notify);
};
const subscribeReaderGeometry = (notify: () => void) => {
  const stopWidth = readerWidth.subscribe(notify), stopViewport = subscribeViewport(notify);
  return () => { stopWidth(); stopViewport(); };
};
const canFitDock = () => innerWidth >= MIN_DOCK_VIEWPORT_WIDTH;
const viewportWidth = () => innerWidth;
const readerOverlaps = () => {
  const width = fitReaderWidth(readerWidth.get(), innerWidth);
  return width > readerListReservation(width, innerWidth);
};
/**
 * The docked reader's width: as set (fitReaderWidth), but while a diff or a file stands beside it,
 * no wider than leaves that place its least width (VIEW_BESIDE_WIDTH): widening the reader then stops at it, rather than
 * the diff giving its place up. One rule for every width of screen: the diff stands beside the reader wherever the
 * narrowest reader leaves it that much, else the reader takes the whole screen and the diff stands over its reports.
 */
const dockedWidth = (width: number | null, viewport: number, viewing: boolean) => {
  const fit = fitReaderWidth(width, viewport);
  return viewing ? Math.min(fit, readerWidthBeside(viewport, VIEW_BESIDE_WIDTH)) : fit;
};
const viewFitsBeside = () => innerWidth - READER_MIN_WIDTH - 3 * windowMargin() >= VIEW_BESIDE_WIDTH;

/**
 * The page: its parts in order. Only layout lives here; every part
 * reads what it needs from the hooks in `data/` and the stores in `state/`.
 * Parts that sit inside another part's box are passed in as slots, so the
 * units that own them never import each other.
 *
 * The page is as wide as the screen: the list shares width with the reader until it is down to its titles and
 * the least of its time strip, then keeps its width as the reader overlaps it. Past half the screen, what the
 * reader takes from the list hides the oldest part of its time strip (`--strip-hidden`) rather than squeezing it.
 * Dragging the reader's left edge sets its width (`readerWidth`; unset, it is 38% of the screen), within the
 * `fitReaderWidth` limits.
 * The bar (the app bar, the phone's search row its button opens, the workspace notice) lies over the list: the
 * list keeps the bar's height at its top, and on a phone the bar slides away while the list is read downwards
 * (`state/bar.ts`). The feed's progress line lies over the bar at the screen's top edge.
 *
 * The full text is a window beside the list (docked); on a phone or when expanded it covers the screen (overlay). It is one
 * element in one place whatever its form, so what is being typed in it (the body editor, a run's fields) survives a
 * change of width.
 *
 * The bars are drawn at once; what waits for the first index (the list, the full text) is its region's
 * skeleton until then, so the page stands where it will be. The full text's window is drawn for a URL that names a task.
 */
export function Workbench() {
  // Redraws the page when the language changes, below Workspace's memo: kept for text read directly from i18n.
  useTranslation("ui");
  useInputMode();
  useGlobalShortcuts();
  useCoordinatorShortcut();
  const narrow = useNarrow();
  const noneSelected = useViewStore((state) => shownInReader(state) === null);
  const project = useViewStore(state => state.project);
  const analysis = useViewStore(state => state.analysis);
  const place = useDeferredValue(useListPlace());
  const ready = useFrameSelector((data) => data !== null);
  const readerOpen = useReaderOpen();
  const full = useViewStore((state) => state.readerFull);
  // A diff or a file read on a computer stands right of the reader, which moves to the screen's left over the list
  // (UrlViewer); where that room is narrower than its least width, the reader takes the whole screen and it stands over
  // the reports.
  const viewing = useViewStore((state) => state.view !== null);
  const fitsBeside = useSyncExternalStore(subscribeViewport, viewFitsBeside, viewFitsBeside);
  const readerFull = readerOpen && (full || viewing && !narrow && !fitsBeside || noneSelected && urlValue("width") === "full");
  // Below the room needed for both columns, the reader covers the list instead.
  const fitsDock = useSyncExternalStore(subscribeViewport, canFitDock, canFitDock);
  const canDock = !narrow && fitsDock;
  // On a phone the task is a sheet from the bottom over the list, which stays in reach until the sheet is pulled whole.
  const mode: ReaderMode = narrow ? "sheet" : !canDock || readerFull ? "overlay" : "docked";
  const sheetWhole = useViewStore((state) => state.reader.whole === true);
  const docked = readerOpen && mode === "docked";
  // While it stands there, the list and its bar are out of reach at once, and out of sight once the reader has moved
  // over them (the page's data-panel-moving: lib/motion.ts moveAcross), kept as they were for its closing.
  const listAway = docked && viewing;
  // The shell only needs to know when the window begins to overlap the list. Its continuous width belongs to
  // PageFrame: publishing each pixel here would redraw the reader's reports, chrome and conversation as well.
  const overlapping = useSyncExternalStore(subscribeReaderGeometry, readerOverlaps, readerOverlaps) && docked;
  // In the overlay the full text is the whole screen: what it covers is out of reach
  // (inert), so the keyboard stays in it until it closes.
  const covered = readerOpen && (mode === "overlay" || mode === "sheet" && sheetWhole);
  const searchShown = useViewStore(isSearchShown);
  // A phone's bar gives its room to the list while it is read; a computer has the room, and its bar holds the search.
  useBarAutoHide(narrow, searchShown || covered);
  const barHeight = useBar((state) => state.height), barHidden = useBar((state) => state.hidden);
  return (
    // The page is as tall as the screen: the bars take what they need and the tree (or the page reader) takes the
    // rest, down to its smallest height, below which the page scrolls. One pixel is left for the box that ends
    // the page (the Toaster's).
    <ListNavigationProvider><PageFrame docked={docked} viewing={listAway} barHeight={barHeight} barHidden={barHidden}>
      {ready && <WorkspaceEffects />}
      <Bar inert={covered || listAway} away={listAway}>
        <AppBar />
        <div className={cn("@container px-6 has-[[data-workspace-notice]]:pb-2 narrow:px-3", docked && "pr-[calc(var(--window-reserve)+36px)]")}>
          <NarrowSearchRow />{ready && <WorkspaceNotice />}
        </div>
      </Bar>
      {/* Above the bar, shown or hidden, and above the full text: the feed's state is the whole screen's. */}
      <ProgressLine />
      {/* Docked, the full text stays at the same top edge while it grows over the list.
          The list and app bar give it their width down to the list's least (readerListReservation) before it overlaps them. */}
      <main id="main" className={cn("@container flex min-h-0 w-full flex-1 flex-col px-6 pb-3 narrow:px-3 narrow:pb-6",
          docked && "pr-[calc(var(--window-reserve)+36px)]")}>
        {/* Until the first index the list's place (its skeleton) starts under the bar too. */}
        {!ready && <BarRoom />}
        <IndexRegions skeleton={<>
          <RegionSkeleton shape="time" />
          {readerOpen && (mode === "sheet"
            ? <div className="fixed inset-x-0 bottom-0 z-(--layer-reader) h-[67dvh]"><RegionSkeleton shape="reader" className={readerBox(mode)} /></div>
            : <RegionSkeleton shape="reader" className={readerBox(mode)} />)}
        </>}>{() => <>
          <div inert={covered || listAway} className={cn("contents", listAway && AWAY)}>
            {place === "search" ? <div data-list-scroll {...UNDER_BAR} className="relative min-h-75 flex-1 basis-0 overflow-auto overscroll-contain scroll-pb-(--list-foot) pb-(--list-foot) narrow:min-h-67.5"><BarRoom /><SearchResults /></div>
              : place === "lookup" && project ? <div className="flex min-h-75 flex-1 flex-col narrow:min-h-67.5"><BarRoom /><AwaitedLookup address={project} placement="list" reason={{ kind: "scope_lookup_unavailable" }} skeleton={<RegionSkeleton shape="time" />} /></div>
              : place === "no-projects" ? <div className="flex-1"><BarRoom /><NoProjects onOpenArchive={() => openSettings("projects")} onCreateProject={() => useDialogStore.getState().openProject()} /></div>
              : analysis ? <AnalysisView place={analysis} /> : <TimeTree />}
          </div>
          <Reader mode={mode} overlapping={overlapping} canDock={canDock} />
        </>}</IndexRegions>
      </main>
      {ready && <DialogHost />}
      {/* Its input reads the workspace; opened before that arrives (by a share at start-up), it waits for it. */}
      {ready && <CoordinatorCard />}
      {ready && <GuideBalloon />}
    </PageFrame></ListNavigationProvider>
  );
}

/**
 * Whether the reader stands, not on which task: moving it to another task redraws the reader and the list's ring, never
 * the page. It stands by the rule the reader draws its task by (readerHasTask): the page and the reader never disagree
 * on it, so the reader keeps its width while what it shows is read again. A task the URL names that is still being
 * looked up has the reader standing, waiting for it.
 */
function useReaderOpen() {
  const frame = useContext(WorkspaceContext);
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => {
    const stopView = useViewStore.subscribe(changed), stopFrame = frame?.subscribe(changed), stopReads = subscribeReads(client, changed);
    return () => { stopView(); stopFrame?.(); stopReads(); };
  }, [frame, client]);
  return useSyncExternalStore(subscribe, () => {
    const data = frame?.getState(), view = useViewStore.getState();
    if (!data) return !!urlValue("task");
    const selected = shownInReader(view);
    return awaitedTask(view) !== null || selected !== null && readerHasTask(client, data, selected);
  });
}

/** The page's geometry changes synchronously with every requested width. Its children keep their own data
 * subscriptions; only a real change of their box (the time strip's ResizeObserver) needs to draw them again. */
function PageFrame({ docked, viewing, barHeight, barHidden, children }: {
  docked: boolean; viewing: boolean; barHeight: number; barHidden: boolean; children: ReactNode;
}) {
  const screen = useSyncExternalStore(subscribeViewport, viewportWidth, viewportWidth);
  const width = dockedWidth(useDeviceValue(readerWidth), screen, viewing);
  // While the reader's edge is held, the page keeps the geometry it had (what is laid out by it, the list first, keeps
  // its layout until let go) and only the reader takes the width the hand asks: a change of the page's variables restyles
  // all it holds, too much for every move of the hand. A diff beside the reader stands by that geometry, so it follows.
  const held = useSyncExternalStore(readerEdgeHeld.subscribe, readerEdgeHeld.get, readerEdgeHeld.get) && docked && !viewing;
  const laidOut = useRef(width);
  if (!held) laidOut.current = width;
  useLayoutEffect(() => {
    const reader = document.querySelector<HTMLElement>('aside[data-reader-mode="docked"]');
    if (held && reader) reader.style.width = `${width}px`;
    return () => { reader?.style.removeProperty("width"); };
  }, [held, width, docked]);
  const page = laidOut.current;
  // While a diff or a file stands beside the docked reader, the reader stands on the screen's left and it right of the
  // reader (readerBox, ViewerPanel, the reader's edge): this mark is the one place that says so.
  return <div data-page data-view-beside={viewing ? "" : undefined} style={{ ...barVars(barHeight, barHidden),
    ...docked ? { "--window-fit": `${page}px`, "--window-reserve": `${readerListReservation(page, screen)}px`,
      "--strip-hidden": `${stripHidden(page, screen)}px` } : {} } as CSSProperties}
    className="flex min-h-[calc(100dvh-1px)] flex-col">{children}</div>;
}

/**
 * What waits for the first index, under `Loadable`'s timing (a query that is pending until the index comes). It stays
 * the skeleton while the feed cannot reach the server: the progress line says so, and reconnects when it gives up.
 */
function IndexRegions({ skeleton, children }: { skeleton: ReactNode; children: () => ReactNode }) {
  const ready = useFrameSelector((data) => data !== null);
  return <Loadable query={{ data: ready || undefined, isPending: true, isError: false, isFetching: true, error: null, refetch: () => {} }}
    skeleton={skeleton} empty={null} unwrapped>{children}</Loadable>;
}

/** Index and preference changes perform navigation work without redrawing the page frame. */
function WorkspaceEffects() {
  useDirectWriteRecovery();
  useProjectShortcuts();
  // A URL or a notice may name a task of any project by its ID; opening one outside the project in view widens the list
  // to every project (state/bootstrap.ts).
  const every = useEveryTaskIndex();
  useUrlBootstrap(every);
  useDocumentTitle();
  useOpenFromNotification(every);
  return null;
}
