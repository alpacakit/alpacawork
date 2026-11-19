import { currentStepKey, navigate, pushStep, replaceStep, traverse } from "@/lib/history";
import { gathering, readerFocusReturn, readerOn, useViewStore, type Navigation, type ReaderPane, type ReaderPlace } from "./view-store";

const HISTORY_KEY = "alpacaworkNavigation";
/**
 * Where the reader was in a place it left: its scroll, and, when a task reference was followed, which one (Back tints
 * it). Every step taken inside the open reader writes it into the step it leaves, so Back lands where the person was
 * reading. The row it was read in is the URL's `event`, kept in the same entry.
 */
/** `rows`: on a Task's reports, the History rows the person opened or closed there, so the pixel lands on the same layout. */
export type ReaderPosition = { task: string; pane: ReaderPane; path: string | null; scroll: number; referenceId?: string; occurrence?: number;
  rows?: Record<string, boolean> };
/**
 * `opened`, for each surface of the step's stack (`surfacesOf`), the step to go back to when it closes: its Navigation
 * API entry key (`key`), with `here` when this page opened the surface by a step of its own (the key is the step before
 * that one) or not (a URL opened straight on it: the key is the first step showing it, written over without it).
 */
type Opened = { key: string | null; here: boolean };
/**
 * What this page keeps in a step of the browser's. Each step taken while the reader stays open keeps the place it left
 * (`behind`): the reader's Back goes back to it.
 */
export type HistoryEntry = { [HISTORY_KEY]: 1; behind?: ReaderPlace | null; readerPosition?: ReaderPosition; turnSequence?: boolean; opened?: Opened[] };
/** The step the browser stands on, when this page wrote it. */
export function currentEntry(): HistoryEntry | null {
  const entry = history.state as Partial<HistoryEntry> | null;
  return entry?.[HISTORY_KEY] === 1 ? entry as HistoryEntry : null;
}
export const stepEntry = (fields: Omit<HistoryEntry, typeof HISTORY_KEY | "opened"> = {}): HistoryEntry => ({ [HISTORY_KEY]: 1, ...fields });
export const isTurnSequenceNavigation = () => currentEntry()?.turnSequence === true;
export const samePlace = (a: ReaderPlace, b: ReaderPlace) => a.task === b.task && a.pane === b.pane && (a.path ?? null) === (b.path ?? null);

/**
 * The URL is what the screen shows: the list (project, q) and the one reader over it (task, and in it the
 * tab, path, event and image, or a file in the viewer). Reading another task is the reader showing it, one history step, wherever it is pressed
 * (a reference in a report, a row, a card, a notice): Back shows the task before. Of what the URL shows, the reader and
 * what is over it (a picture or the viewer: OVER_READER) are surfaces a person closes; one
 * rule for all of them:
 * - Opening one, or moving to another task, folder, document or project, is a history step (`writeStep`);
 *   closing one never is.
 * - Back, Forward and a reload apply the URL, and nothing else.
 * - The store's part that the URL holds is what the URL shows: a change of it is an intent (`navigate`, lib/history.ts),
 *   written into the URL as it applies (`change`, state/bootstrap.ts), and the URL is shown into the store (`show`),
 *   never the other way round later.
 * - Closing one (×, Esc, a finger, a press behind it) undoes its opening (`closeSurface`): when this page wrote the
 *   step that opened it, it goes back to the step before, so a later Back opens none of them again; when it did not (a
 *   URL opened straight on it), it goes back to the first step showing it and writes the URL without it over it. Each
 *   step keeps where its surfaces were opened (`opened`, `writeStep`).
 * What is open for a moment only (a menu, a dialog, the coordinator's card) is not in the URL; Back closes it with the
 * page's step (`useCloseOnBack`).
 */
export function surfacesOf(search: string): string[] {
  const url = new URLSearchParams(search);
  const task = url.get("task");
  if (!task) return [];
  return [task, ...overReader(url).map(([kind, value]) => `${kind}:${value}`)];
}
/**
 * The surfaces over the reader, bottom first, as the URL names them: a picture, or the viewer. The
 * one order `surfacesOf` stacks and `belowSurface` takes them away in.
 */
const OVER_READER = ["image", "view"] as const;
type OverReader = typeof OVER_READER[number];
const overReader = (url: URLSearchParams): [OverReader, string][] =>
  OVER_READER.flatMap(kind => { const value = url.get(kind); return value ? [[kind, value] as [OverReader, string]] : []; });
const sameStack = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, at) => item === b[at]);

const STEP_WRITTEN = "alpacawork-history-changed";
/** Calls `notify` whenever the browser stands on another step, or the one it stands on is written anew. */
export function subscribeStep(notify: () => void) {
  window.addEventListener(STEP_WRITTEN, notify);
  window.addEventListener("popstate", notify);
  return () => { window.removeEventListener(STEP_WRITTEN, notify); window.removeEventListener("popstate", notify); };
}

/**
 * Every step this page writes: a new one over the current one (`push`), or the current one written over. Each surface
 * of the new stack still standing on the same surfaces below it keeps where it was opened (a step further back when one
 * is pushed); one new here was opened by this step.
 */
export function writeStep(push: boolean, entry: HistoryEntry, url: string | URL) {
  const prior = currentEntry()?.opened ?? [];
  const was = surfacesOf(location.search);
  const now = surfacesOf(new URL(url, location.href).search);
  // The step written over keeps its key; a pushed one comes after it.
  const here = currentStepKey();
  const opened = now.map((_, depth): Opened => {
    const standing = depth < was.length && sameStack(was.slice(0, depth), now.slice(0, depth));
    if (standing && prior[depth]) return prior[depth]!;
    return push ? { key: here, here: true } : { key: here, here: false };
  });
  if (push) pushStep({ ...entry, opened }, url);
  else replaceStep({ ...entry, opened }, url);
  window.dispatchEvent(new Event(STEP_WRITTEN));
}

/**
 * Closes the surface at `depth` of the stack and every one over it (0: the reader). When this page opened it, the page
 * goes to the step before the one that opened it, past every step taken while it stayed open (`landed` runs there).
 * When it did not (a URL opened straight on it), it goes to the first step that showed it and `apply` writes the stack
 * below over that step. Either way no step showing it is left behind for Back to open again. The browser goes there
 * and says when it is there (the Navigation API, by `traverse` in lib/history.ts); without the API, or with that step
 * gone from it, the current step is written over (`apply`): it closes, and Back may show what it showed before.
 */
function closeSurface(depth: number, apply: () => void, landed?: () => void) {
  const opened = surfacesOf(location.search).length > depth ? currentEntry()?.opened?.[depth] : undefined;
  if (!opened?.key || opened.key === currentStepKey()) { apply(); return; }
  traverse(opened.key, opened.here ? landed : apply, apply);
}

/** A surface over the reader closed (a picture's ×, the viewer's ×): it and those over it. */
function closeOver(kind: OverReader, apply: () => void) {
  const depth = surfacesOf(location.search).findIndex(surface => surface.startsWith(`${kind}:`));
  if (depth < 1) { apply(); return; }
  navigate(() => closeSurface(depth, apply), { bound: true });
}
export const closeImage = () => closeOver("image", () => useViewStore.getState().setImage(null));
export const closeView = () => closeOver("view", () => useViewStore.getState().setView(null));

/** The reader's ×, Esc, and every other way a person closes it (a finger sliding a phone's sheet away, a press behind it). */
export function closeReaderStep() {
  navigate(() => closeSurface(0, () => useViewStore.getState().closeReader(), readerFocusReturn()), { bound: true });
}

/** The navigation with only its `depth` bottom surfaces open (`surfacesOf`). */
export function belowSurface(navigation: Navigation, depth: number): Navigation {
  if (depth <= 0) return { ...navigation, task: null, taskAddress: null, image: null, view: null, event: null, path: null, pane: "task" };
  // The surfaces over the reader the navigation shows, bottom first (`overReader`): those below `depth` stay.
  const shown = new URLSearchParams();
  for (const kind of OVER_READER) if (navigation[kind]) shown.set(kind, navigation[kind]);
  const kept = new Set(overReader(shown).slice(0, depth - 1).map(([kind]) => kind));
  return { ...navigation, image: kept.has("image") ? navigation.image : null, view: kept.has("view") ? navigation.view : null };
}

/**
 * The one decision of what a change of the screen is to the history: a step of its own when it opens a surface or
 * moves to another thing to read (another task, wherever it was pressed; a folder or document, in the Files tab or in
 * the viewer, by a row or by a link in what is read; a project; a search begun or ended). Anything else writes over the
 * current step: a picture turned, a row opened, a search typed on, a surface closed (its × goes back instead:
 * `closeSurface`).
 */
export function isStep(before: Navigation, after: Navigation, beforeUrl: URL, afterUrl: URL): boolean {
  const was = surfacesOf(beforeUrl.search), now = surfacesOf(afterUrl.search);
  const opened = now.length > was.length && sameStack(now.slice(0, was.length), was);
  const moved = before.project !== after.project
    || gathering(before) !== gathering(after)
    || !!readerOn(after) && (readerOn(before) !== readerOn(after) || before.pane !== after.pane || before.path !== after.path
      || !!before.view && !!after.view && before.view !== after.view);
  return opened || moved;
}
