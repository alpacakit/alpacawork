import { UrlViewer } from "./viewer/Viewer";
import { TaskAnalysisPane } from "@/features/analysis/TaskAnalysis";
import { endTime } from '@/features/telemetry/count';
import { markRead, useReadReady } from "@/state/read-store";
import { useAnswerCueLifetime } from "./answer-cue";
import { ReaderSwipe } from './swipe-answer';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { windowBox, WindowWidthHandle } from "@/features/shell/docked-window";
import { closeReaderStep, isTurnSequenceNavigation } from "@/state/history-step";
import { ReaderPeopleContext, useHomeList, useReaderPeople, useReadState, useTaskDetail, useReaderTask, useWorkspaceInfo } from "@/data/queries";
import type { Task, TaskDetail } from "@/data/types";
import { historyWindowRefused, moveHistoryToLatest } from "@/data/history-resource";
import { useQueryClient } from "@tanstack/react-query";
import { AwaitedLookup } from "./AwaitedLookup";
import { failureCause, titleTurn } from "@/domain/lead";
import { OpeningForm, focusOpeningForm, useOpeningFocus } from "@/lib/opening-focus";
import { useDialogStore, type OpenInput } from "@/state/dialog-store";
import { readerOpenedByPress, readerShows, useNarrow, useViewStore } from "@/state/view-store";
import { readerWidthBeside, windowMargin } from "@/state/screen-settings";
import { VIEW_BESIDE_WIDTH } from "./viewer/viewer-layout";
import { ResponsibleSection } from "@/features/forms/ResponsibleInputs";
import { MoveSection } from "@/features/forms/MoveInputs";
import { HoldKey } from "./HoldKey";
import { TaskActions } from "./TaskActions";
import { FrameButtons, ReaderHeader, readerHeadBox, ReaderTitle } from "./ReaderHeader";
import { ContextPage, ReportFeed } from "./ReportFeed";
import { COLUMN, looksWide } from "./reading-column";
import { FilesTab } from "./files/FilesTab";
import { MarkdownBody } from "./MarkdownBody";
import { DEFAULT_SCHEMA, renderContext, type TaskValues } from "@alpacawork/contract";
import { useFieldCatalog } from "@/data/fields";
import { shownCatalog } from "@/domain/field-display";
import { Message } from "@/components/ui/message";
import { problemText } from "@/features/forms/problem-text";
import { Loadable, ReadFailure, ReadNote, ReadRetryContext, useWaited } from "@/components/ui/loadable";
import { useConnection } from "@/data/connection";
import { cn } from "@/lib/utils";
import { hidesHeldContent } from "./ReaderReadState";
import { appear, crossfade, moveAcross } from "@/lib/motion";
import { usePanelGoing } from "./panel-going";
import { cardFlying } from "./departure";
import { unnameReader } from "./reader-copy";
import { useReaderHeaderAway } from "./reader-header-away";
import { useWheelBack } from "./wheel-back";
import { useReaderReportPosition } from "./reading-position";
import { useReaderRestoration } from "./reading-restoration";
import { PLACEHOLDER_WAIT_MS, RegionSkeleton } from "@/components/ui/skeleton";
import { ReadingLine } from "@/features/chrome/ProgressLine";
import { TurnReason } from "./TurnReason";
import { ReaderPanel, ReaderPanelSlot } from "./ReaderPanel";
import { ReaderEntries } from "./ReaderEntries";
import { EmptyDeck, ReaderOperationStatus, useDeckEmptied, useMoveOn, useReaderReads } from "./NextQuestion";
import { ReaderCardContext, useShowCard, useSitting, type ReaderCard, type Shelf } from "./next-question";
import { keepFocusInside, SHEET_SURFACE, SheetControlContext, SheetFrame, StandingGrip, useCloseOnPressBehind, useSheetControl, useSheetMotion } from "./TaskSheet";

/**
 * Where the reader sits, decided by the shell: `docked` is a resizable window
 * beside or over the list; `overlay` covers the screen when requested or when the list leaves no room beside it;
 * `sheet` is a phone's sheet from the bottom (TaskSheet), the whole screen only when pulled up.
 */
export type ReaderMode = "overlay" | "docked" | "sheet";

/**
 * The reader has one newest-first report column. The file button replaces it with the file sheet. Whichever pane is
 * open stands in the reader's one column, but an HTML page (COLUMN, looksWide: reading-column.ts).
 */
export function Reader({ mode, overlapping = false, canDock = mode === "docked" }: { mode: ReaderMode; overlapping?: boolean; canDock?: boolean }) {
  const { t } = useTranslation("reader");
  const selected = useViewStore((state) => state.selected);
  const people = useReaderPeople(selected);
  const reader = useViewStore((state) => state.reader);
  const filePath = useViewStore((state) => state.filePath);
  const openTask = useViewStore((state) => state.openTask);
  const task = useReaderTask(selected);
  const completed = useDeckEmptied(task?.id);
  const open = reader.open && !!task;
  const openingInput = useDialogStore(state => state.dialog?.kind === "input" && state.dialog.taskId === selected ? state.dialog : null);
  const { titleRef, formRef } = useFocusOnOpen(open, openingInput);
  const pane = reader.pane;
  useAnswerCueLifetime(open ? task!.id : null, pane);
  // The folder or file the files pane shows: with the task and the pane, the reader's place.
  const shownPath = pane === "files" && filePath && filePath.taskId === task?.id ? filePath.path || null : null;
  // Each opening on a task is a card of its own: an answer started on an earlier one does not move this one.
  // Opening by hand the task whose card says every question was answered (it was the last one, held or answered here)
  // begins a new card on it.
  const cardVersion = useSitting(state => state.cardVersion);
  // Row availability may briefly change while a direct write moves it between live and finished caches.
  // Only navigation owns an opening; publishing a write must not create a new card or clear completion.
  const card = useMemo(() => reader.open && selected ? { taskId: selected } : null, [reader.open, selected, cardVersion]);
  const sitting = <ReaderSitting key="sitting" card={card} taskId={task?.id} byHand={!reader.turnSequence} />;
  // The row shows the header at once; the about and files panes wait for the opened view (body, log, files, requests).
  const { detail, failure, refreshing, query: view, assessment, fetching, viewSettled, presentation, retry: retryRead } = useTaskDetail(open ? task : undefined, pane === "task");
  // The reports do not wait for it: a held History is drawn with the row, and what only the view says (its questions,
  // its review band, its images) joins it when the view arrives.
  const root = useWorkspaceInfo((info) => info.root);
  const history = useReadState(["task-history", root, open && pane === "task" && task ? task.id : ""]);
  const client = useQueryClient();
  const reports = useMemo(() => detail ?? (open && pane === "task" && task && history.assessment.display ? rowDetail(task) : undefined),
    [detail, open, pane, task, history.assessment.display]);
  const { catalog } = useFieldCatalog(open);
  // A Task its own write answered with, before its view arrives: its values as the context tab would show them.
  const written = presentation.kind === 'written'
    ? renderContext(presentation.earlier?.values.fields ?? DEFAULT_SCHEMA, presentation.document.values as TaskValues, shownCatalog(catalog)) : "";
  // What was read is shown as its group's assessment allows; the held DOM stays mounted either way.
  const offline = useConnection((state) => state.offline);
  const hidden = hidesHeldContent(assessment, fetching, !!detail) && !(pane === "task" && reports);
  const readReady = useReadReady();
  // Navigation may precede the personal checkpoint. A currently visible, qualified reader owns that later observation.
  // A task opened from the screen takes its time until its content shows.
  useEffect(() => { if (open && !hidden && detail && detail.id === task!.id) endTime('task', task!.id); }, [open, hidden, detail?.id, task?.id]);
  useEffect(() => {
    if (open && readReady && !hidden && assessment.project && detail) void markRead(task!.id);
  }, [open, readReady, hidden, assessment.project, detail?.id, task?.id]);
  const dim = useWaited(!assessment.display && fetching);
  // When the wait for what the reader shows began: this opening, of this task, on this pane. Its placeholders, one
  // taking over from another as the reads move on (RegionSkeleton), keep this one time.
  const waiting = useRef({ on: "", from: 0 });
  const opening = `${open}/${task?.id}/${pane}`;
  if (waiting.current.on !== opening) waiting.current = { on: opening, from: performance.now() };
  const waitFrom = waiting.current.from;
  // A new task or pane starts at the top; the report position below retains the row being read across live updates.
  const content = useRef<HTMLDivElement>(null);
  // Where the card is read, its head over the reports: a sideways finger anywhere on it swipes the card (ReaderSwipe).
  const readArea = useRef<HTMLDivElement>(null);
  // Read away from the top, the head is ruled off from what passes under it.
  const [scrolled, setScrolled] = useState(false);
  // The reader card comes in when opened; its header shares the list bar's reading direction.
  const box = useRef<HTMLElement>(null);
  const headerLayer = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const placing = useRef<string | null>(null);
  const { reset: resetHeader, rebase: rebaseHeader } = useReaderHeaderAway(headerLayer, content, open && narrow,
    `${open}/${task?.id}/${pane}/${shownPath ?? ""}`, placing);
  const { retry: retryReading, noteScroll } = useReaderRestoration(content, open, task?.id, pane, shownPath, detail?.id, viewSettled, resetHeader, setScrolled, placing);
  useReaderReportPosition(content, open && pane === "task" ? task!.id : null, placing, rebaseHeader);
  useWheelBack(box, open);
  // It comes in when a press opened it; a reader the URL, Back or Forward opened is simply there (readerOpenedByPress).
  // Closed, it goes back the way it came. A phone's sheet comes and goes by itself (TaskSheet).
  usePanelGoing(box, mode === "sheet" ? null : (now, before) => before.reader.open && !now.reader.open, mode === "overlay" ? "below" : "side", [mode]);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open && !wasOpen.current && readerOpenedByPress() && mode !== "sheet") appear(box.current, mode === "overlay" ? "below" : "side");
    wasOpen.current = open;
  }, [open]);
  // Another task shown in the open reader (a row pressed, a reference followed, Back), in a window or a phone's sheet: the
  // reader stays, what it showed dissolves into what it shows now, its reading column moving a little in the same turn
  // (crossfade). Another pane of the same task (a tab chosen) is the same turn under the head: the title and its tabs
  // stay, the tab's grey sliding along them (TabMarker), and what was read under them dissolves into the pane chosen on
  // the same time, so the ground arrives as the new pane settles. It is seen as the store turns, before React draws the
  // other task or pane. Another task dissolves in once it is drawn (readerDrawn): its reads may still be on the way, and
  // what was shown stays until then, for as long as a placeholder would wait. While an answered card's stamped copy is over it (held, then flying away: departure.ts), the
  // card has already been shown leaving: nothing more goes.
  useEffect(() => useViewStore.subscribe((view, before) => {
    if (!view.reader.open || !before.reader.open || cardFlying()) return;
    if (view.selected !== before.selected) crossfade(box.current, { content: "[data-reader-content]", ready: unnameReader,
      drawn: { done: () => readerDrawn(box.current, view.selected), within: PLACEHOLDER_WAIT_MS } });
    else if (view.reader.pane !== before.reader.pane) crossfade(box.current, { content: "[data-reading-column]", ready: (copy, find) => {
      // Only what was read is drawn, on the reader's own ground over all of the pane chosen; it is cut where the live
      // title and tabs stand once that pane is drawn at its own place (scrolled back up, they come down into view), so
      // they always show, the tab's grey sliding along them.
      unnameReader(copy);
      copy.style.visibility = "hidden";
      const read = find("[data-reader-content]"), live = box.current;
      if (!read || !live) return;
      Object.assign(read.style, { visibility: "visible", backgroundColor: getComputedStyle(live).backgroundColor });
      find("[data-head-title]")?.style.setProperty("visibility", "hidden");
      const cut = () => {
        const head = live.querySelector("[data-head-title]")?.getBoundingClientRect().bottom ?? 0, top = read.getBoundingClientRect().top;
        read.style.clipPath = head > top ? `inset(${head - top}px 0 0 0)` : "";
      };
      queueMicrotask(cut);
      requestAnimationFrame(cut);
    } });
  }), []);
  // The URL's task still being looked up: the reader stands where it stood, waiting for it (`AwaitedSurface`).
  const awaited = useViewStore(readerShows);
  const follow = useCallback((id: string) => openTask(id, { reader: true }), [openTask]);
  // Kept while `follow` is: the viewer reads its document again only when what it read changes.
  const renderProse = useCallback((words: string) => <MarkdownBody text={words} task={null} onFollow={follow} />, [follow]);
  // The same keyed panel survives moving through a task still being looked up.
  const shownTask = useRef(task);
  if (task) shownTask.current = task;
  const family = reader.open && shownTask.current && <ReaderPanel key="related" task={shownTask.current} onFollow={follow} />;
  if (!open || !task) return <>
    {awaited && <ReadRetryContext value={retryReading}>
    <ReaderCardContext value={null}>
    <ReaderPeopleContext value={people}><ReaderFrame sheet={mode === "sheet"} whole={reader.whole === true}><AwaitedSurface address={awaited} mode={mode} canDock={canDock} /></ReaderFrame></ReaderPeopleContext>
    </ReaderCardContext>
    </ReadRetryContext>}{family}{sitting}</>;

  const walking = reader.turnSequence || isTurnSequenceNavigation();
  const sheet = mode === "sheet";
  // A task named here is the reader's next step, on a phone too: `follow`.
  // Whether a finger may carry this card sideways (ReaderSwipe): its content then leaves the browser only up and down and
  // pinching. Declared here, on the content that lasts from card to card, so moving on to the next card, or an update
  // of this one, never lets go of it and takes it back: each change of it restyles all the content holds.
  const swipeable = !completed && pane === 'task' && task.state !== 'held';
  const wide = looksWide(shownPath);
  const header = <ReaderHeader task={task} mode={mode} canDock={canDock} onFollow={follow} walking={walking} pane={pane} ruled={scrolled} />;
  // Why the user's turn came, answered here: Continue and Retry go to the coordinator; Stop reports directly.
  const turn = titleTurn(task);
  const notes = turn && <p className="my-type-close text-sm text-turn"><TurnReason turn={turn} task={task} cause={failureCause(task, people)} /></p>;
  const whole = reader.whole === true;
  // What it shows being read again flows along the rule under the task's head (title and tabs), standing in for
  // that rule as the screen's line does for the feed. It goes with the rule when that is scrolled away; each task's
  // reads are its own. Only over what the pane shows read: while its placeholder stands, that says the wait instead.
  const shownRead = !(presentation.kind === "written" && !detail) && (pane === "task" ? !!reports && history.assessment.display : !!detail);
  const reading = shownRead && <ReadingLine key={task.id} reading={refreshing} className="absolute inset-x-0 top-full z-1" />;
  const surface = <>
    <ReaderOperationStatus />
    <aside
      ref={box}
      aria-label={t("reader.label")}
      data-reader-mode={mode}
      data-window=""
      data-held={task.state === "held" || undefined}
      data-reader-over-list={mode !== "docked" || overlapping ? "" : undefined}
      // Whole on a phone, as the overlay, it keeps the keyboard.
      onKeyDown={mode === "overlay" || sheet && whole ? keepFocusInside : undefined}
      className={readerBox(mode)}
    >
      <EmptyDeck taskId={task.id} />
      {/* The completed card covers this whole region: keep its DOM and layout, but expose only the visible surface. */}
      <div className="contents" inert={completed} aria-hidden={completed || undefined}>
      {canDock && <ReaderWidthHandle label={t("reader.resize")} taskId={task.id} />}
      <div ref={readArea} className="reader-reading relative flex min-h-0 flex-1 flex-col">
        <div ref={headerLayer} data-reader-header="shown" data-input-view={task.id} className="reader-heading relative flex-none bg-lit">
          <StandingGrip />{header}
          <ResponsibleSection task={task} /><MoveSection task={task} />
        </div>
      {/* Under the head: the reports, and a diff or a file the URL names over them while the reader takes the screen (UrlViewer). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={content} data-reader-content style={{ touchAction: swipeable ? "pan-y pinch-zoom" : undefined }} onScroll={(event) => { setScrolled(event.currentTarget.scrollTop > 0); noteScroll(event.currentTarget.scrollTop); }} className={`reader-content min-h-0 flex-1 overflow-auto px-4 py-2 text-base [overflow-wrap:anywhere] [overflow-anchor:none] narrow:px-3`}>
        {/* Every pane stands under the task's title and its tabs (ReaderEntries), which scroll with it. */}
        <div data-head-title className={`relative -mx-4 -mt-2 mb-2 border-b border-rule pb-1 narrow:-mx-3 narrow:px-3 ${COLUMN.title}`}>
          <ReaderTitle task={task} titleRef={titleRef} /><ReaderEntries task={task} detail={detail} pane={pane} /><ReaderPanelSlot />{notes}{reading}</div>
        <div data-reading-column={wide ? "wide" : ""} data-held-hidden={hidden || undefined} inert={hidden} aria-hidden={hidden || undefined}
          className={cn(!wide && COLUMN.body, hidden && "invisible", dim && "opacity-50")}>
        {/* A History read back too far to read again whole keeps what it showed, and offers its newest events instead. */}
        {pane === "task" && historyWindowRefused(history.error) && <Message data-read-failure tone="error" size="line" title={problemText(history.error)}
          action={{ label: t("reportFeed.jumpToLatest"), run: () => moveHistoryToLatest(client, root, task.id) }} />}
        {presentation.kind === 'written' && !detail ? <>
          <MarkdownBody text={written} task={null} onFollow={follow} />
          {offline ? <ReadNote kind="absent" /> : view.isError ? <ReadFailure error={view.error} retry={() => void retryRead()} /> : <RegionSkeleton shape="reports" />}
        </> : offline && !reports && !view.isFetching ? <ReadNote kind="absent" />
        : <Loadable query={{ ...view, ...(pane === "task" && reports && { isPending: false, isError: false }), data: pane === "task" ? reports : detail, refetch: retryRead }} skeleton={<RegionSkeleton shape="reports" waitFrom={waitFrom} />} empty={null} unwrapped>{(ready) => <>
        {/* One rule for every pane drawn: what is shown stays (a held view, or History before its view), and above it the
            view's state is said in one place: offline with no view held, or its last read failed, with a way to read it again. */}
        {offline && !detail ? <ReadNote kind="absent" /> : failure ? <ReadFailure error={failure} retry={() => void retryRead()} /> : null}
        {pane === "files" ? <FilesTab task={ready}
          path={filePath?.taskId === task.id ? filePath.path : ""} />
          : pane === "about" ? <ContextPage task={ready} onFollow={follow} />
          : pane === "analysis" ? <TaskAnalysisPane task={ready.id} />
            : <ReportFeed key={task.id} task={ready} people={people} onFollow={follow} waitFrom={waitFrom} />}
        </>}</Loadable>}
        </div>
      </div>
      {/* A diff or a file the URL names: over the page on a phone; on a computer right of the docked reader, which moves
          to the screen's left for it, or over the reports while the reader takes the whole screen. */}
      <UrlViewer renderProse={renderProse} onFollow={follow} place={mode === "docked" ? "page" : "reader"} />
      <ReaderMoves box={box} mode={mode} />
      </div>
      </div>
      {!completed && <HoldKey task={task} />}
      {/* The reader owns Change state and Done, drawn in the conversation's row over its input. */}
      <TaskActions task={task} phone={sheet} />
      </div>
    </aside>
    <ReaderSwipe key={task.id} task={task} box={box} reading={readArea} content={content} className={readerBox(mode)} enabled={swipeable} />
  </>;
  return <>
    <ReadRetryContext value={retryReading}>
    <ReaderCardContext value={card}>
    <ReaderPeopleContext value={people}><ReaderFrame sheet={sheet} whole={whole}><OpeningForm value={formRef}>{surface}</OpeningForm></ReaderFrame></ReaderPeopleContext>
    </ReaderCardContext>
    </ReadRetryContext>
    {family}
    {sitting}
  </>;
}

/**
 * Whether the reader shows `id` drawn: its head names it, and its pane shows what it reads, not the wait for it (an
 * empty column while a placeholder is still unseen, the placeholder, or held content hidden while it is read again).
 */
function readerDrawn(reader: HTMLElement | null, id: string | null) {
  if (!reader || !id || reader.querySelector("[data-reader-task-id]")?.textContent !== id) return false;
  const column = reader.querySelector("[data-reading-column]");
  return !!column && column.childElementCount > 0 && !column.matches("[data-held-hidden]") && !column.querySelector('[data-skeleton="reports"]');
}

/**
 * The reader's sitting, kept beside what it draws: which questions it goes on through and what it reads ahead follow
 * the home list and the list's rows, and none of those changes redraws the reader.
 */
function ReaderSitting({ card, taskId, byHand }: { card: ReaderCard | null; taskId: string | undefined; byHand: boolean }) {
  useMoveOn();
  useReaderReads();
  // A card opened on a row of Your turn or Hold goes on through that shelf's questions, as the home list sections them.
  const section = useHomeList().rows.find((row) => row.taskId === taskId)?.section;
  const shelf: Shelf | null = section === "review" || section === "held" ? section : null;
  useShowCard(card, shelf, byHand);
  return null;
}

/**
 * The reader on a task the URL names that is still being looked up: the same frame and its controls (a phone's sheet
 * keeps its height, grip and whole screen; a computer's window its width, edge and full width; × and Esc close it), and
 * the task's shape until it comes (`AwaitedLookup`). Nothing of the task shown before stays.
 */
function AwaitedSurface({ address, mode, canDock }: { address: string; mode: ReaderMode; canDock: boolean }) {
  const { t } = useTranslation("reader");
  const sheet = useSheetControl();
  const offline = useConnection((state) => state.offline);
  return <aside aria-label={t("reader.label")} data-reader-mode={mode} data-window="" data-reader-awaiting={address}
    onKeyDown={mode === "overlay" || sheet?.whole ? keepFocusInside : undefined} className={readerBox(mode)}>
    {canDock && <ReaderWidthHandle label={t("reader.resize")} taskId={null} />}
    <StandingGrip />
    <header {...sheet?.grip} className={`${readerHeadBox(mode)} border-rule`}>
      <div data-reader-head-row className="flex min-w-0 items-center justify-end text-xs text-muted">
        <FrameButtons canDock={canDock} />
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-auto px-4 py-2 narrow:px-3">
      <div data-reading-column className={COLUMN.body}><ReaderPanelSlot />{!offline ? <AwaitedLookup address={address} reason={{ kind: "task_lookup_unavailable" }} skeleton={<RegionSkeleton shape="reports" />} />
        : <ReadNote kind="absent" />}</div>
    </div>
  </aside>;
}

/**
 * The phone's reader stands in a sheet (TaskSheet): the same sheet at every height, whole only when pulled to the top.
 * A finger sliding it away, or a press on nothing behind it, closes it as × does. On a wider screen the frame is no box
 * of its own, so the window is the same element at every width.
 */
function ReaderFrame({ sheet, whole, children }: { sheet: boolean; whole: boolean; children: ReactNode }) {
  const setWhole = useViewStore((state) => state.setReaderWhole);
  const control = useSheetMotion({ whole, onWhole: setWhole, onAway: closeReaderStep, rising: readerOpenedByPress(), on: sheet });
  useCloseOnPressBehind(sheet && !whole, control.frame, closeReaderStep);
  return <SheetControlContext value={sheet ? { ...control, whole } : null}>
    <SheetFrame control={control} whole={whole} layer={20} on={sheet}>{children}</SheetFrame>
  </SheetControlContext>;
}

/**
 * Docked while a diff or a file is read, the reader stands on the screen's left and the diff right of it (readerBox, the
 * page's data-view-beside): docked before and after, it moves there from its own side as the diff opens, and back as it
 * closes (moveAcross). Its own part: what it reads (whether a diff stands beside it), what it remembers (where it stood)
 * and when it moves, apart from what the reader draws.
 */
function ReaderMoves({ box, mode }: { box: RefObject<HTMLElement | null>; mode: ReaderMode }) {
  const viewingBeside = useViewStore((state) => state.view !== null);
  const stood = useRef({ beside: viewingBeside, mode });
  useLayoutEffect(() => {
    const element = box.current, was = stood.current;
    stood.current = { beside: viewingBeside, mode };
    if (!element || mode !== "docked" || was.mode !== "docked" || was.beside === viewingBeside) return;
    // From the other side it stood on: its right edge at the screen's (opening), its left edge at the screen's (closing).
    const margin = windowMargin();
    moveAcross(element, viewingBeside ? innerWidth - margin - element.offsetWidth : margin);
  }, [viewingBeside, mode, box]);
  return null;
}

/**
 * The window the reader is drawn in, which its skeleton takes too. It keeps one margin from the screen's edges all
 * round (`window`), and its head's row stands its head's room under its top, on the line the app bar beside it puts
 * its own controls on (styles.css, Head line). Its foot is the screen's: what stands over the screen's foot, the
 * coordinator's input, stands over it as well.
 */
export function readerBox(mode: ReaderMode) {
  if (mode === "sheet") return `group/reader ${SHEET_SURFACE}`;
  return mode === "overlay" ? `group/reader ${windowBox(mode)}`
    : `group/reader ${windowBox(mode)} in-data-view-beside:right-auto in-data-view-beside:left-window`;
}

/** The reader's edge: while a diff or a file stands beside it, it widens only as far as leaves that its place. */
function ReaderWidthHandle({ label, taskId }: { label: string; taskId: string | null }) {
  const viewing = useViewStore((state) => state.view !== null);
  return <WindowWidthHandle label={label} taskId={taskId} widest={viewing ? viewport => readerWidthBeside(viewport, VIEW_BESIDE_WIDTH) : undefined} />;
}

/**
 * Opened from a control (a card's title), the reader takes the focus on its
 * title (the heading, reached by script only). Opened with
 * nothing focused (a shared URL), it leaves the focus alone. Closing gives
 * the focus back to the card's title (`useViewStore.closeReader`).
 */
function useFocusOnOpen(open: boolean, input: OpenInput | null) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Reading and input are successive intentions of one reader, never competing opening requests.
  useOpeningFocus(open ? input ?? true : null, (previous) => {
    if (input) return () => ({
      complete: !!formRef.current,
      focus: () => {
        if (!focusOpeningForm(formRef.current)) titleRef.current?.focus({ preventScroll: true });
      },
    });
    // Reading begins as the reader opens. An input ending in it opens nothing: the focus stays where it was chosen.
    if (previous) return null;
    const origin = document.activeElement;
    if (origin !== document.body && !readerFocusOpener(origin)) return null;
    return () => ({ complete: true, focus: () => {
      // A pointer opening can commit before its native focus. A shared URL leaves BODY alone.
      const active = origin === document.body ? document.activeElement : origin;
      if (readerFocusOpener(active)) titleRef.current?.focus({ preventScroll: true });
    } });
  });
  return { titleRef, formRef };
}

/** The existing main-focus boundary for reading, shared by the opening and its eventual native focus. */
function readerFocusOpener(active: Element | null) {
  return active instanceof HTMLElement && active !== document.body && !active.closest("[data-result]");
}

/**
 * An opened Task before its view arrives, as its row says it: what History draws with. The parts only the view brings
 * are empty until it does (no question, no review, no file), never "could not be read".
 */
const rowDetails = new WeakMap<Task, TaskDetail>();
function rowDetail(task: Task): TaskDetail {
  let detail = rowDetails.get(task);
  if (!detail) {
    detail = { ...task, responsibleRevision: null, values: { values: {}, fields: [], from: null, context: "" }, logs: [], files: [],
      requestHeads: [], reply: undefined, questions: [], userQuestions: [], userReviews: [], requestedByUser: null, conversations: null };
    rowDetails.set(task, detail);
  }
  return detail;
}
