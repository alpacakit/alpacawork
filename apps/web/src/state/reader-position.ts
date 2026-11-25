import { useSyncExternalStore } from "react";
import { goBack, navigate, replaceStep, showScreen } from "@/lib/history";
import { closeTopReader, currentEntry, samePlace, subscribeStep, type HistoryEntry, type ReaderPosition } from "./history-step";
import { setUrlValue } from "./screen-settings";
import { readerPlace, screenNavigation, shownInReader, useViewStore, type ReaderPane, type ReaderPlace } from "./view-store";

/**
 * Where the person last read in the place the reader shows (Reader tells it as they scroll; never the scrolls it makes
 * itself while putting the reader back). A new place starts with none (`noteReaderPlace`).
 */
let readerScroll: ReaderPosition | null = null;
/** The task reference being followed, for the one step its intent takes (`followReference`, `takeFollowedReference`). */
let pendingReference: { task: string; referenceId: string; occurrence: number } | null = null;
let keepTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * The History rows opened or closed by hand on the Task whose reports are shown (ReportFeed tells it as they change):
 * kept in the step with where the reader stands, as one position, so Back, Forward and a reload lay the rows out as
 * they were read before putting the pixel back.
 */
let readerRows: { task: string; rows: Record<string, boolean> } | null = null;
export function noteReaderRows(task: string, rows: ReadonlyMap<string, boolean>) {
  readerRows = { task, rows: Object.fromEntries(rows) };
  // Rows changed where the person reads (not while the reader is put back): kept as a move is.
  if (readerScroll?.task === task) { clearTimeout(keepTimer); keepTimer = setTimeout(keepReaderPosition, 200); }
}
const rowsOf = (place: ReaderPlace, kept: ReaderPosition | null | undefined) =>
  place.pane === "task" ? readerRows?.task === place.task ? readerRows.rows : kept?.rows : undefined;
const sameRows = (a?: Record<string, boolean>, b?: Record<string, boolean>) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
/**
 * Where the reader stands is kept in the step it stands on, once it has stopped moving (and before Back leaves it), so
 * Back and Forward land where it was last read, not where it was first left.
 */
export function noteReaderScroll(task: string, pane: ReaderPane, path: string | null, scroll: number) {
  noteReaderPosition({ task, pane, path, scroll });
}
/** The whole position chosen again, with the reference followed from it (Retry re-chooses its original request). */
export function noteReaderPosition(position: ReaderPosition) {
  readerScroll = { ...position };
  clearTimeout(keepTimer);
  keepTimer = setTimeout(keepReaderPosition, 200);
}
/** The reader shows another place: nothing is read in it yet. */
export function noteReaderPlace() {
  clearTimeout(keepTimer);
  readerScroll = null;
}
function keepReaderPosition() {
  clearTimeout(keepTimer);
  const noted = readerScroll;
  if (!noted) return;
  navigate(() => {
    const entry = currentEntry();
    const place = readerPlace(screenNavigation());
    if (!entry || !place || !samePlace(place, noted)) return;
    const kept = entry.readerPosition;
    const rows = rowsOf(noted, kept && samePlace(kept, noted) ? kept : null);
    if (kept && samePlace(kept, noted) && kept.scroll === noted.scroll && kept.referenceId === noted.referenceId
      && kept.occurrence === noted.occurrence && sameRows(kept.rows, rows)) return;
    const position: ReaderPosition = { ...noted };
    delete position.rows;
    replaceStep({ ...entry, readerPosition: { ...position, ...rows ? { rows } : {} } }, location.href);
  });
}

/** The position the step the browser stands on keeps for this place, if any. */
export function readerHistoryPosition(task: string, pane: ReaderPane = "task", path: string | null = null): ReaderPosition | null {
  const position = currentEntry()?.readerPosition;
  return position && samePlace(position, { task, pane, path }) ? position : null;
}

/**
 * True while a URL or a browser entry is being shown: the row its event names is the entry's, not one the person
 * opened, so where the reader stood before it is not chosen for it.
 */
let shownEntry = false;
export const showingNavigation = () => shownEntry;
export function whileShowingEntry(show: () => void) {
  shownEntry = true;
  try { show(); } finally { shownEntry = false; }
}

/**
 * A task reference followed from the reader, `follow` opening its task, as one intent: the step it takes keeps where
 * the reader was and which reference it was (Back tints it), and writes the row it was read in into the step it leaves
 * (the URL's `event`, so Back opens that row again). A press that moves nothing keeps nothing; one given while the
 * reader moved on (a × under way) only follows.
 */
export function followReference(button: HTMLElement, id: string, follow: () => void) {
  const content = button.closest<HTMLElement>("[data-reader-content]");
  const task = useViewStore.getState().selected;
  // The row the reference was read in (a folded report counts as its own row) is the one Back opens again, and the
  // reference is counted inside it, so a closed row above does not shift which one it was.
  const scope = button.closest<HTMLElement>("[data-folded-report]") ?? button.closest<HTMLElement>("[data-report-key]");
  const row = scope?.dataset.foldedReport ?? scope?.dataset.reportKey ?? null;
  const occurrence = content ? [...(scope ?? content).querySelectorAll<HTMLElement>(`[data-task-reference="${CSS.escape(id)}"]`)].indexOf(button) : -1;
  navigate(() => {
    const view = useViewStore.getState();
    const entry = currentEntry();
    if (content && task && shownInReader(view) === task && entry) {
      pendingReference = { task, referenceId: id, occurrence };
      replaceStep(entry, setUrlValue("event", row));
      showScreen();
    }
    follow();
  });
}
/** A reference followed belongs to one intent's step alone, whether it takes one or not. */
export function takeFollowedReference() {
  const followed = pendingReference;
  pendingReference = null;
  return followed;
}

/**
 * The reader's place before and after a step written, and what its Back goes back to: a step that moves the reader
 * (another task, tab, folder or file) keeps the place it left, and writes into the step left where the reader was in it.
 * A step over the same place (a picture opened on it) keeps what was behind; one opening or closing the reader has
 * nothing behind it.
 */
export function leavePlace(prior: HistoryEntry | null, from: ReaderPlace | null, to: ReaderPlace | null, push: boolean,
  followed: ReturnType<typeof takeFollowedReference>, url: URL): ReaderPlace | null {
  const leaving = push && from && to && !samePlace(from, to) ? from : null;
  if (leaving && prior) keepPlaceLeft(prior, leaving, followed, url);
  return leaving ?? (!push || from && to && samePlace(from, to) ? prior?.behind ?? null : null);
}
/**
 * What the person read in the place left, and the reference followed from it, go into the step left. Read nothing new
 * and followed nothing (still being put back, or left untouched), what the step kept stands whole.
 */
function keepPlaceLeft(prior: HistoryEntry, leaving: ReaderPlace, followed: ReturnType<typeof takeFollowedReference>, url: URL) {
  clearTimeout(keepTimer);
  const reference = followed?.task === leaving.task ? followed : null;
  const kept = prior.readerPosition && samePlace(prior.readerPosition, leaving) ? prior.readerPosition : null;
  const read = readerScroll && samePlace(readerScroll, leaving) ? readerScroll : null;
  const from = reference ? { referenceId: reference.referenceId, occurrence: reference.occurrence }
    : read?.referenceId !== undefined ? { referenceId: read.referenceId, occurrence: read.occurrence }
    // Read nothing new, only rows opened or closed: the step's own reference stands with its pixel.
    : !read && kept?.referenceId !== undefined ? { referenceId: kept.referenceId, occurrence: kept.occurrence } : {};
  const rows = rowsOf(leaving, kept);
  if (read !== null || reference || !kept || !sameRows(kept.rows, rows))
    replaceStep({ ...prior, readerPosition: { ...leaving, scroll: read?.scroll ?? kept?.scroll ?? 0, ...from, ...rows ? { rows } : {} } }, url);
}

/**
 * The reader's one Back: to the place the step left (`behind`), whatever it was — a report a file link was
 * pressed in, a list a file was opened from, another task, another tab. A reader opened straight on a tab or a file
 * (a link, a reload) has nothing behind it in this reader: its Back goes to the task's reports instead.
 */
const readerBehind = (): ReaderPlace | null => currentEntry()?.behind ?? null;
export const useReaderBehind = (): ReaderPlace | null => useSyncExternalStore(subscribeStep, readerBehind, () => null);
/** The browser's Back asked for from the reader (a sideways swipe over it): the place read is kept first, as the
 * reader's own Back keeps it, so Forward comes back to it. */
export function browserBack() {
  keepReaderPosition();
  navigate(goBack);
}
export function readerBack(toList = false) {
  keepReaderPosition();
  if (!toList && readerBehind()) navigate(goBack, { bound: true });
  else if (useViewStore.getState().analysis?.list) closeTopReader();
  // A direct link to a details tab has no previous reader step.
  else navigate(() => useViewStore.getState().setReaderPane("task"), { bound: true, write: "over" });
}

/** Whether Back in the header returns to the analysis list: on the step its row opened, with nothing behind it. */
export function useAnalysisListBack(behind: ReaderPlace | null) {
  const inList = useViewStore(state => !!state.analysis?.list);
  return inList && !behind;
}
