import { startTime } from '@/features/telemetry/count';
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { fileOpening } from "@/domain/task-files";
import { navigate } from "@/lib/history";
import { useDialogStore } from "./dialog-store";
import { markRead } from "./read-store";
import { fitReaderWidth, readerWidth } from "./screen-settings";
import { useTimeView } from "./time-view";
import type { AnalysisPlace } from "@/features/analysis/place";

/**
 * What the reader is looking at: the list's project, the search,
 * and the full-text panel. Several parts of the screen
 * read and change these, so they live here rather than in one component.
 *
 * Kept elsewhere: task data (TanStack Query, `data/queries.ts`), read marks
 * (`read-store.ts`), the open dialog (`dialog-store.ts`), and anything only
 * one component uses (its own useState).
 */
/** A text search shows results in the list's place. */
export const gathering = (state: { query: string }) => !!state.query;
/** The search row stands while asked for and always while a search is set; pressing its button closes what stands. */
export const isSearchShown = (state: { searchOpen: boolean; query: string }) => state.searchOpen || gathering(state);
/**
 * The reader's details panes and its analysis face.
 */
export type ReaderPane = "task" | "files" | "about" | "analysis";

/**
 * What the URL shows. A task it names that is still being looked up is kept as the URL names it
 * (`taskAddress`, with `task` null): the screen waits for it, and writes it back as it is.
 */
export type Navigation = { project: string | null; task: string | null; taskAddress: string | null; full: boolean; pane: ReaderPane; path: string | null; query: string; image: string | null;
  /** A file read over the reader in the viewer (viewer-target.ts: a Task's file, or one of its code locations): a surface as `image` is. */
  view: string | null; event: string | null; turnSequence?: boolean;
  /** The analysis face and what is open on it; null on the list of tasks. */
  analysis: AnalysisPlace | null };
/** The task the navigation's reader shows, known or waited for. */
export const readerOn = (navigation: Navigation) => navigation.task ?? navigation.taskAddress;
/** A place in the reader: a task and what of it is shown (Reports, About, Files and the folder or file open there). */
export type ReaderPlace = { task: string; pane: ReaderPane; path: string | null };
/** Where the navigation's reader is, when it is open. */
export const readerPlace = (navigation: Navigation): ReaderPlace | null => {
  const task = readerOn(navigation);
  return task ? { task, pane: navigation.pane, path: navigation.path } : null;
};

/** The narrow layout: at most 700px wide. */
export const NARROW_QUERY = "(max-width: 700px)";

const subscribeNarrow = (onChange: () => void) => {
  const query = matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
/** Whether the screen is at the narrow (one column, touch) width. */
export const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW_QUERY).matches);

type ViewState = {
  /**
   * The project Task the list is narrowed to (its ID, the URL's `project`): its subtree, nested projects included; null
   * shows every project. What the screen opens and the project are kept one where the URL is written (state/bootstrap.ts):
   * a task opened outside it widens the list to every project, and choosing a project closes what is outside it.
   */
  project: string | null;
  /** Narrow the list to one project, or show every project. */
  setProject: (project: string | null) => void;
  query: string;
  /** Whether the first URL navigation has been applied to this screen. */
  navigationReady: boolean;
  /** An edit before that navigation takes precedence over the initial URL, including an empty query. */
  queryEditedBeforeNavigation: boolean;
  /** The task selected from the list or shown in the full-text panel. */
  selected: string | null;
  /** The image named by the URL in either the report or file slider. */
  image: string | null;
  setImage: (image: string | null) => void;
  /** The file read in the viewer over the reader, as the URL's `view` names it. */
  view: string | null;
  setView: (view: string | null) => void;
  /** The report row open in the task's column, as the URL's `event` names it: a time mark, a link or the row itself. */
  event: string | null;
  setEvent: (event: string | null) => void;
  /** The full text: whether it is shown and its pane. */
  reader: { open: boolean; pane: ReaderPane;
    returnTo: { element: HTMLElement; selected: string | null } | null; turnSequence?: boolean;
    /** Counts the reader's openings by hand (not its moving on to the next question): each is a card of its own. */
    opening?: number;
    /** On a phone the reader is a sheet from the bottom (`TaskSheet`); pulled to the top it is the whole screen until let down. */
    whole?: boolean;
    /**
     * The task the URL opens the reader on that is still being looked up, as the URL names it (`awaitedTask`): the
     * reader stands, waiting for it, with no task selected.
     */
    address?: string | null };
  /**
   * The folder or file open in a rule tab (the Files tab's `path` in the URL):
   * "" is the Task folder, "dir/" a folder, anything else a file or request ID.
   */
  filePath: { taskId: string; path: string } | null;
  /** Narrow width only: the search row is shown (its button in the app bar). It is always shown while a search is set. */
  searchOpen: boolean;
  openSearch: () => void;
  toggleSearch: () => void;
  /** Full/partial mode is projected from the URL; the partial width belongs to the device cell. */
  readerFull: boolean;
  setReaderFull: (full: boolean) => void;
  setReaderWidth: (width: number | "full" | null) => void;
  setQuery: (query: string) => void;
  clearSearch: () => void;
  select: (id: string) => void;
  openTask: (id: string, options?: { pane?: ReaderPane; reader?: boolean; whole?: boolean; returnTo?: HTMLElement; turnSequence?: boolean; event?: string | null }) => void;
  closeDetail: (id?: string) => void;
  openReader: (id: string) => void;
  closeReader: () => void;
  setReaderPane: (pane: ReaderPane) => void;
  setReaderWhole: (whole: boolean) => void;
  /**
   * A path of a Task's folder pressed (a link, an attachment), opened as it opens (fileOpening): a file read in the viewer
   * over what the reader shows, where it shows one; else, and for a folder or a picture, the Task's Files tab on it.
   */
  openTaskFile: (taskId: string, path: string) => void;
  /** Open a folder or file of `taskId` in the current rule tab. */
  setFilePath: (taskId: string, path: string) => void;
  /** The analysis face and what is open on it (`Navigation.analysis`). */
  analysis: AnalysisPlace | null;
  /** Shows the analysis at a place, closing the task open; null goes back to the list of tasks. */
  showAnalysis: (place: AnalysisPlace | null) => void;
  /** Apply a validated URL as one transition, without the side effects of the individual navigation actions. */
  applyNavigation: (navigation: Navigation) => void;
};

/**
 * An input drawn inside the full text (the body editor, the send-back) lives as long as that task's full text is open: closing it, or opening
 * another task in it, ends the input and its draft.
 */
function endReaderInput(next: string | null) {
  const dialogs = useDialogStore.getState();
  const dialog = dialogs.dialog;
  if (dialog?.kind === "input" && dialog.taskId !== next) dialogs.close();
}

/**
 * The shared cleanup when the full text closes: its input ends, and a jump to an event still on its way
 * is let go (its callers clear `event`).
 */
function closedReader(reader: ViewState["reader"]): ViewState["reader"] {
  endReaderInput(null);
  useTimeView.getState().pick("", null);
  return { ...reader, open: false, returnTo: null, whole: false };
}

/** Return to the list row that opened the reader, or its regular task control. */
function focusReturn(element: HTMLElement | null, selectors: string[]) {
  const transition = useViewStore.getState().reader;
  requestAnimationFrame(() => {
    if (useViewStore.getState().reader !== transition) return;
    if (element?.isConnected && getComputedStyle(element).display !== "none") {
      element.focus({ preventScroll: true });
      return;
    }
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (target && getComputedStyle(target).display !== "none") { target.focus({ preventScroll: true }); return; }
    }
  });
}

/** Where focus goes once the reader now open has closed (by `closeReader`, or by going back past its steps). */
export function readerFocusReturn(): () => void {
  const { selected, reader } = useViewStore.getState();
  if (!selected || !reader.open) return () => {};
  const element = reader.returnTo?.element ?? null;
  return () => focusReturn(element, [`[data-open-reader="${CSS.escape(selected)}"]`, `[data-read="${CSS.escape(selected)}"]`]);
}

/**
 * How the full text was last opened: by a press on the screen (a title, a row, a link), or by a URL being applied
 * (the page's first draw, back and forward). Only a press brings the window in. It is not state: nothing is
 * redrawn by it; the reader's window looks at it once, when it opens.
 */
let openedByPress = false;
export const readerOpenedByPress = () => openedByPress;

/**
 * The task the reader waits for, as the URL names it: the reader is open on no task selected, which only the URL makes
 * (every action that opens it selects a task; every one that closes it closes it).
 */
export const awaitedTask = ({ reader, selected }: Pick<ViewState, "reader" | "selected">) =>
  reader.open && !selected ? reader.address ?? null : null;

/** The task the reader shows, once it is known. */
export const shownInReader = ({ reader, selected }: Pick<ViewState, "reader" | "selected">) => reader.open ? selected : null;
/** What the reader shows: its task, or the address it waits for. */
export const readerShows = (state: Pick<ViewState, "reader" | "selected">) => shownInReader(state) ?? awaitedTask(state);

/** A search edit made before the first URL navigation takes precedence over that URL (`queryEditedBeforeNavigation`). */
const queryEdit = (state: Pick<ViewState, "navigationReady" | "queryEditedBeforeNavigation">) =>
  ({ queryEditedBeforeNavigation: !state.navigationReady || state.queryEditedBeforeNavigation });

/**
 * An action changing what the URL shows (the reader, its tab, folder, picture and row, the project and search):
 * one intent of the history's (`navigate`, lib/history.ts), applied now or once the page's own move is there, and written
 * into the URL as it applies. A `bound` one acts on what the reader shows when it is called.
 */
function intent<A extends unknown[]>(change: (...args: A) => void, bound: boolean | ((...args: NoInfer<A>) => boolean) = false) {
  return (...args: A) => navigate(() => change(...args), { bound: typeof bound === "boolean" ? bound : bound(...args) });
}

/** What closes with the reader or a move in it: every surface over it (`surfacesOf`, state/history-step.ts). */
const NO_SURFACE = { image: null, view: null } as const;

export const useViewStore = create<ViewState>((set, get) => ({
  project: null,
  setProject: intent((project) => set({ project })),
  query: "",
  navigationReady: false,
  queryEditedBeforeNavigation: false,
  selected: null,
  image: null,
  setImage: intent((image) => set({ image }), true),
  view: null,
  setView: intent((view) => set({ view }), true),
  event: null,
  setEvent: intent((event) => set({ event }), true),
  reader: { open: false, pane: "task", returnTo: null },
  filePath: null,
  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  toggleSearch: intent(() => set((state) => isSearchShown(state)
    ? { searchOpen: false, query: "", ...queryEdit(state) }
    : { searchOpen: true })),
  readerFull: false,
  setReaderFull: intent((readerFull) => set({ readerFull })),
  setReaderWidth: (requested) => {
    if (requested !== "full") {
      if (requested === null) readerWidth.remove();
      else if (Number.isFinite(requested)) readerWidth.set(Math.round(fitReaderWidth(requested, innerWidth)));
    }
    get().setReaderFull(requested === "full");
  },
  setQuery: intent((query) => set((state) => ({ query, ...queryEdit(state), ...query && state.analysis ? { analysis: null } : {} }))),
  clearSearch: intent(() => set((state) => ({ query: "", ...queryEdit(state) }))),
  select: intent((id) => set({ selected: id })),
  // The move on to the next question after an answer acts on the reader that took the answer.
  openTask: intent((id, { pane = "task", reader = false, whole, returnTo, turnSequence = false, event, } = {}) => {
    // Pressing the task already shown is no opening to wait for.
    if (pane !== "analysis") {
      if (!(get().reader.open && get().selected === id)) startTime('task', id);
      markRead(id);
    }
    if (reader) { endReaderInput(id); openedByPress = true; }
    set((state) => {
      // The task the reader shows, on the pane it shows, is no move: the row open in it stays open, and a walk
      // through the questions, or a task chosen by hand, stays what it was. Its URL does not change, so its step neither.
      const here = reader && state.reader.open && state.selected === id && state.reader.pane === pane;
      return {
        selected: id,
        ...NO_SURFACE, event: event !== undefined ? event : here ? state.event : null,
        reader: reader ? { ...state.reader, open: true, pane, turnSequence: here ? state.reader.turnSequence : turnSequence, opening: (state.reader.opening ?? 0) + (turnSequence ? 0 : 1),
          whole: whole ?? (state.reader.open && state.reader.whole),
          returnTo: returnTo ? { element: returnTo, selected: state.selected } : null }
          : state.reader.open ? closedReader(state.reader) : state.reader,
      };
    });
  }, (_id, options?) => !!options?.turnSequence),
  closeDetail: intent((id?: string) => {
    // What the detail shows: the task named, or by default the one selected, or the one the reader waits for.
    const state = get();
    const shown = id ?? state.selected ?? awaitedTask(state);
    if (!shown || shown !== state.selected && shown !== awaitedTask(state)) return;
    const returnTo = state.reader.returnTo;
    set((current) => ({
      selected: returnTo ? returnTo.selected : null,
      ...NO_SURFACE, event: null,
      reader: current.reader.open ? closedReader(current.reader) : current.reader,
    }));
    focusReturn(returnTo?.element ?? null, [`[data-read="${CSS.escape(shown)}"]`]);
  }),
  openReader: (id) => get().openTask(id, { pane: "task", reader: true, event: null }),
  closeReader: intent(() => {
    const focus = readerFocusReturn();
    const { reader } = get();
    set((state) => ({ ...NO_SURFACE, event: null, reader: closedReader(state.reader), selected: reader.returnTo ? reader.returnTo.selected : state.selected }));
    focus();
  }, true),
  setReaderPane: intent((pane) => set((state) => ({ ...NO_SURFACE, event: null, reader: { ...state.reader, pane }, filePath: null })), true),
  setReaderWhole: (whole) => set((state) => ({ reader: { ...state.reader, whole } })),
  openTaskFile: intent((taskId, path) => {
    const opening = fileOpening(taskId, path);
    if (opening.view && readerShows(get())) { set({ view: opening.view }); return; }
    openedByPress = true;
    set((state) => ({ selected: taskId, ...NO_SURFACE, image: opening.image, view: opening.view, event: null,
      filePath: { taskId, path: opening.path }, reader: { ...state.reader, open: true, pane: "files", whole: state.reader.open && state.reader.whole } }));
  }),
  setFilePath: intent((taskId, path) => set({ filePath: { taskId, path } }), true),
  analysis: null,
  // Coming to the analysis closes the task open and ends a search, as the search's own button does: the analysis takes
  // the list's place. A search begun on it goes back to the list, where its results are (setQuery).
  showAnalysis: intent((analysis) => set((state) => ({
    analysis,
    ...analysis ? { searchOpen: false, query: "", ...state.query ? queryEdit(state) : {} } : {},
    ...state.reader.open && (state.analysis || analysis) ? { selected: null, ...NO_SURFACE, event: null, reader: closedReader(state.reader) } : {},
  }))),
  /** The URL shown into the store (state/bootstrap.ts): the only other writer of what the URL holds. */
  applyNavigation: (navigation) => {
    const { project, task, taskAddress, full, pane, path, query, image, view, event, turnSequence, analysis } = navigation;
    endReaderInput(task); openedByPress = false;
    if (task && pane !== "analysis") markRead(task);
    // The reader shows the task the URL names, or waits for it while it is looked up (`awaitedTask`).
    const shown = readerOn(navigation);
    const returnFocus = !shown && get().reader.open ? readerFocusReturn() : null;
    set((state) => {
      // A URL names the task the detail opens; the list keeps its shape (the task's row is in its group, or
      // under a parent the reader opens), so its parents are not unfolded for it.
      return {
        // A URL with no task says nothing of the reader's width (full belongs to the task): going back to the list from
        // a task opened full keeps it for the next one, as closing it does.
        project, query, analysis, readerFull: shown ? full : state.readerFull, navigationReady: true, queryEditedBeforeNavigation: false,
        selected: task, image, view, event,
        reader: { ...state.reader, open: !!shown, address: task ? null : taskAddress, pane, returnTo: shown === state.selected ? state.reader.returnTo : null, turnSequence,
          whole: !!shown && state.reader.open && state.reader.whole },
        filePath: shown && path !== null ? { taskId: shown, path } : null,
      };
    });
    returnFocus?.();
  },
}));

/** What the screen shows, as the URL would say it: `applyNavigation` the other way round. */
export function screenNavigation(): Navigation {
  const view = useViewStore.getState();
  const task = shownInReader(view);
  const taskAddress = awaitedTask(view);
  const shown = task ?? taskAddress;
  return { project: view.project, task, taskAddress, full: view.readerFull, pane: view.reader.pane, image: shown ? view.image : null, view: shown ? view.view : null, turnSequence: view.reader.turnSequence,
    event: shown && view.reader.pane === "task" ? view.event : null,
    path: shown && view.filePath?.taskId === shown && view.reader.pane === "files" ? view.filePath.path || null : null,
    query: view.query, analysis: view.analysis };
}
