import { readQuery, taskReadState } from '@/data/read-model';
import { isMarkdownMediumId } from "@/domain/markdown";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { taskIdSchema } from "@alpacawork/contract";
import { viewerTarget } from "@/domain/viewer-target";
import { readerTask, taskDetail, useReaderTask, useWorkspaceInfo } from "@/data/queries";
import { queryClient } from "@/data/query-client";
import { ApiError } from "@/data/client";
import { resources, shelvedReadDetail } from "@/data/resources";
import type { TaskDetail, WorkspaceInfo } from "@/data/types";
import { taskAtAddress, withinProject, type TaskIndex } from "@/domain/tasks";
import { fileOpening, fileShelves, folderSheet, isFolderPath, isMedia, pathExists, sheetOfFile } from "@/domain/task-files";
import { NARROW_QUERY, readerOn, readerPlace, readerShows, screenNavigation, useViewStore, type Navigation, type ReaderPane } from "./view-store";
import { belowSurface, currentEntry, isStep, isTurnSequenceNavigation, stepEntry, surfacesOf, writeStep } from "./history-step";
import { leavePlace, noteReaderPlace, readerHistoryPosition, takeFollowedReference, whileShowingEntry } from "./reader-position";
import { rememberNavigation, resumeLanding, type Resume } from "./resume";
import { addressesIn, screenSettings, setUrlValue, urlValue } from "./screen-settings";
import { applyTimeViewUrl, useTimeView } from "./time-view";
import { attachScreen, navigate, onPersonMove, showScreen, type Write } from "@/lib/history";

/** The same screen showing another URL of it (a link pressed), for the intent applying it to write as its step. */
let showAt: ((url: URL) => void) | null = null;

/** Looks the URL's waited-for task up again, after the lookup failed (the reader's retry). */
export const lookUpAgain = () => navigate(showScreen);

/** A link to another state of this screen (`/?q=…`) opens in it as one history step, without loading the page again. */
export function openScreenLink(href: string) {
  // Where it goes is fixed when it is pressed, whatever is shown when it applies. The screen shows it, and the one
  // decision of a step (`change`) writes it, as any other move: inside the reader it keeps what Back comes back to.
  const url = new URL(href, location.href);
  // The agent view (`?agent=1`) belongs to this visit: following an internal screen link must not begin marking news read.
  const visit = new URL(location.href);
  if (visit.searchParams.has("agent")) url.searchParams.set("agent", visit.searchParams.get("agent")!);
  navigate(() => showAt?.(url), { write: "step" });
}

/**
 * A rule tab is kept when the task shows it. That is known once the task's view has been read;
 * before (a link opened afresh), the tab is kept and the reader shows the task pane if it is empty.
 */
function validPane(value: string | null, task: string | null): ReaderPane {
  return task && (value === "files" || value === "about") ? value : "task";
}

function validPath(value: string | null, task: string | null, pane: ReaderPane, detail: TaskDetail | undefined, root: string): string | null {
  if (value === null || !task || pane !== "files") return null;
  // A folder is also there when its sheet lists files: work/ lists the work files outside it too.
  return !detail || pathExists(value, detail.files.map(file => file.name))
    || isFolderPath(value) && folderSheet(fileShelves(detail, root, location.origin), value).files.length > 0 ? value : null;
}

/**
 * The Files tab's folder as a file of its task opens over it: the folder named while its sheet lists the file, else the
 * one whose sheet does (sheetOfFile), so that every way a file is opened (a row, a link in the task's words, a shared or
 * an old URL) shows it over the list holding it. Only an opening moves the folder: a folder chosen while a file stays
 * open in the viewer beside it is kept (a picture's slider covers the sheet, so its folder is always the one holding it).
 */
function filesPlace(path: string | null, file: string | null, detail: TaskDetail | undefined, root: string): string | null {
  if (!detail || !file || !detail.files.some(each => each.name === file)) return path;
  const shelves = fileShelves(detail, root, location.origin);
  if (folderSheet(shelves, path ?? "").files.some(each => each.name === file)) return path;
  return sheetOfFile(shelves, file) || null;
}
/** The file of `task` open over its Files tab: its picture, or the file of its folder read in the viewer. */
function openFile(task: string | null, image: string | null, view: string | null): string | null {
  if (image) return image;
  const target = view ? viewerTarget(view) : null;
  return target && target.where === "task" && target.owner === task ? target.path : null;
}

function validImage(value: string | null, pane: ReaderPane, path: string | null, detail: TaskDetail | undefined, root: string): string | null {
  if (!value || value.length > 512) return null;
  if (pane === "files") {
    if (!isMedia(value) || path && !isFolderPath(path)) return null;
    // A picture the sheet of the path shows: its slide is there.
    if (detail && !folderSheet(fileShelves(detail, root, location.origin), path ?? "").files.some(file => file.name === value)) return null;
    return value;
  }
  if (pane !== "task") return null;
  return isMarkdownMediumId(value) ? value : null;
}

/**
 * A file read in the viewer over the reader, on any of its tabs (viewer-target.ts). One the Task does not hold, or may not
 * read, opens the viewer on its failure, as a missing picture does.
 */
const validView = (value: string | null): string | null => value && value.length <= 4096 && viewerTarget(value) ? value : null;

/** A report row's key (`log:T1:L2`, `request:Q1`, …) as the column draws it; one it does not have opens nothing. */
function validEvent(value: string | null): string | null {
  return value && value.length <= 512 ? value : null;
}

/**
 * Whether a task a URL names that the index does not hold may still be found: the address is a Task ID (`T14`; an
 * address of any other form, an old link's included, names no task) the server has not said it does not know.
 */
const awaitable = (address: string, missing: ReadonlySet<string>) => taskIdSchema.safeParse(address).success && !missing.has(address);

/** The projects the index lists: with its tasks, they tell which project holds a task (`withinProject`). */
type Projects = WorkspaceInfo["projects"];

/**
 * The project in view and what the screen opens in it (a task) are kept one here, for a URL
 * read (`readNavigation`) and for an intent (`fitProject`) alike: a task opened outside the project in view
 * widens the list to every project, wherever it was opened from (a URL, a link, a notice, a row); a project chosen
 * closes what is outside it.
 */
const outside = (id: string | null, project: string | null, index: TaskIndex, projects: Projects, root: string) =>
  id !== null && !withinProject(index.byId.has(id) ? id
    : readerTask(queryClient, root, id)?.projectId ?? id,
    project, { byId: index.byId, projects });

/** Keeps what an intent left the screen showing one with the project in view (`before`: the screen as it found it). */
function fitProject(before: { project: string | null; selected: string | null }, index: TaskIndex, projects: Projects, root: string) {
  const view = useViewStore.getState();
  const out = (id: string | null) => outside(id, view.project, index, projects, root);
  if (view.project !== before.project) {
    if (out(view.selected)) view.closeDetail();
  } else if (out(view.selected === before.selected ? null : view.selected))
    useViewStore.setState({ project: null });
}

/** A task's detail as it is read now; undefined before its view is. */
function detailOf(task: string | null, row: Parameters<typeof taskDetail>[0] | undefined, root: string): TaskDetail | undefined {
  const view = task && row ? taskReadState(queryClient, root, task).view : undefined;
  return view ? taskDetail(row!, view) : undefined;
}

/**
 * `index` holds every project's tasks and `projects` the projects it lists; `missing` the addresses the server says
 * name no task. A Task ID neither in the index nor missing is waited for.
 */
function readNavigation(url: URL, index: TaskIndex, root: string, projects: Projects, missing: ReadonlySet<string>,
  turnSequence = isTurnSequenceNavigation()): Navigation {
  const requestedTask = urlValue("task", url);
  const row = requestedTask ? taskAtAddress(requestedTask, index) ?? readerTask(queryClient, root, requestedTask) : undefined;
  const refusal = requestedTask ? readQuery(queryClient, ['task', root, requestedTask])?.state.error : undefined;
  const task = row?.id ?? (refusal instanceof ApiError && refusal.code === 'forbidden' ? requestedTask : null);
  const taskAddress = requestedTask && !task && awaitable(requestedTask, missing) ? requestedTask : null;
  // The project in view is one the index lists, holding what the URL opens.
  const requestedProject = urlValue("project", url);
  const project = requestedProject && (projects.some(({ id }) => id === requestedProject)
    ? !outside(task, requestedProject, index, projects, root)
    : awaitable(requestedProject, missing)) ? requestedProject : null;
  const detail = detailOf(task, row, root);
  // What the reader shows of a task waited for is kept as the URL says it, and checked once the task is known.
  const shown = task ?? taskAddress;
  const pane = validPane(urlValue("tab", url), shown);
  // The Files tab's path names a folder; a file named there (a link written before files opened in the viewer) opens as
  // a file opens now (fileOpening), and the URL is written so.
  const named = urlValue("path", url);
  const opening = shown && pane === "files" && named !== null ? fileOpening(shown, named) : null;
  const image = urlValue("image", url) ?? opening?.image ?? null, view = shown ? urlValue("view", url) ?? opening?.view ?? null : null;
  const folder = opening ? opening.path : named;
  // A URL opens the file its path names (fileOpening), and a picture; a file read beside a folder the URL names stays so.
  const opened = (opening && openFile(task, opening.image, opening.view)) || image;
  const path = validPath(pane === "files" ? filesPlace(folder, opened, detail, root) : folder, shown, pane, detail, root);
  return { project, task, taskAddress, full: !!shown && urlValue("width", url) === "full", pane, path,
    image: shown ? validImage(image, pane, path, detail, root) : null,
    view: validView(view),
    event: shown && pane === "task" ? validEvent(urlValue("event", url)) : null,
    query: urlValue("q", url) ?? "", turnSequence };
}

/**
 * A move that opened a file over the Files tab (one not open before it) shows it over the list holding it (filesPlace),
 * as a URL naming it does; a move that keeps the open file (a chip, another folder) keeps the folder it chose.
 */
function settleFilesPlace(was: Navigation, index: TaskIndex, root: string) {
  const shown = screenNavigation();
  if (!shown.task || shown.pane !== "files") return;
  const opened = openFile(shown.task, shown.image, shown.view);
  if (!opened || was.task === shown.task && openFile(was.task, was.image, was.view) === opened) return;
  const detail = detailOf(shown.task, taskAtAddress(shown.task, index) ?? readerTask(queryClient, root, shown.task), root);
  const place = filesPlace(shown.path, opened, detail, root);
  if ((place ?? "") !== (shown.path ?? "")) useViewStore.setState({ filePath: { taskId: shown.task, path: place ?? "" } });
}

function writeNavigation(url: URL, navigation: Navigation): URL {
  // The navigation's keys are written afresh in one order, so one navigation has one URL whatever URL it came from
  // (the repair below compares them). Only full/partial mode belongs to the URL.
  // A task and the project are named by their Task IDs.
  for (const key of ["project", "task", "width", "tab", "path", "q", "image", "view", "event"] as const) setUrlValue(key, null, url);
  const task = readerOn(navigation);
  const full = !!task && navigation.full;
  if (navigation.project) setUrlValue("project", navigation.project, url);
  if (task) setUrlValue("task", task, url);
  if (full) setUrlValue("width", "full", url);
  if (task && navigation.pane !== "task") setUrlValue("tab", navigation.pane, url);
  if (task && navigation.path) setUrlValue("path", navigation.path, url);
  if (navigation.query) setUrlValue("q", navigation.query, url);
  if (task && navigation.image) setUrlValue("image", navigation.image, url);
  if (task && navigation.view) setUrlValue("view", navigation.view, url);
  if (task && navigation.pane === "task" && navigation.event) setUrlValue("event", navigation.event, url);
  return url;
}

/** `index` holds every project's tasks: a URL may name a task of any project. */
export function useUrlBootstrap(index: TaskIndex) {
  const root = useWorkspaceInfo((info) => info.root);
  const projects = useWorkspaceInfo((info) => info.projects);
  const current = useRef({ index, root, projects });
  current.current = { index, root, projects };
  /** Shows the URL again once the data it is read with has changed: only when the screen does not show it as it is. */
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let landing = false;
    let live = true;
    /** The landing's wait for its saved destination, while it lasts. */
    let resume: Resume | null = null;
    /** The address of a link being shown (`showAt`), for its intent's step (consumed by `change`). */
    let linkTarget: URL | null = null;
    const pending = new Set<string>();
    /** Addresses the server says name no task: the URL is applied without them. */
    const missing = new Set<string>();
    /** The tasks a URL names that are neither in the index yet nor known to be missing: all are looked up at once. */
    const unresolved = (url: URL, index: TaskIndex) => addressesIn(url).filter((address) => !taskAtAddress(address, index)
      && !(urlValue('task', url) === address && readerTask(queryClient, current.current.root, address))
      && !shelvedReadDetail(queryClient.getQueryState(resources.taskView(current.current.root, address).queryKey)?.error)
      && awaitable(address, missing));
    /**
     * Shows `url` as it is, whatever of it is known yet, and says what it shows: the browser's entry as it stands, or
     * (`fresh`) a new place a link names, opened as any other (no walk through the questions carried over). A task it
     * names that is still being looked up is shown as waited for (`readNavigation`), never by what the screen showed
     * before. Each such address is looked up once at a time; when the answer comes the URL is read again (`refresh`): a
     * task found is shown, one the server does not know is left out, and a failure leaves it waited for until it is
     * asked again (`lookUpAgain`).
     */
    const showNavigation = (url: URL, fresh = false): Navigation => {
      const { index, root, projects } = current.current;
      for (const address of unresolved(url, index).filter((address) => !pending.has(address))) {
        pending.add(address);
        void queryClient.fetchQuery(resources.taskView(root, address)).then((view) => {
          pending.delete(address);
          // The page row enters the workspace index on the query notification.
          if (live) navigate(refresh.current);
        }).catch((error: unknown) => {
          pending.delete(address);
          if (shelvedReadDetail(error) || !(error instanceof ApiError && error.code === "not_found")) return;
          missing.add(address);
          if (live) navigate(refresh.current);
        });
      }
      const navigation = readNavigation(url, index, root, projects, missing, fresh ? false : undefined);
      // An edit made before the first index came (the screen not up yet) takes precedence over the URL query.
      const search = useViewStore.getState();
      if (!search.navigationReady && search.queryEditedBeforeNavigation) navigation.query = search.query;
      whileShowingEntry(() => useViewStore.getState().applyNavigation(navigation));
      // A link to a row jumps to it as a time mark does; Back to a reference instead returns to where the reader left.
      if (navigation.task && navigation.event && !readerHistoryPosition(navigation.task)) useTimeView.getState().pick(navigation.task, navigation.event);
      return navigation;
    };
    const applyUrl = () => {
      const { root } = current.current;
      const url = new URL(location.href);
      const navigation = showNavigation(url);
      const canonical = writeNavigation(new URL(url), navigation);
      const prior = currentEntry();
      const entry = stepEntry({ behind: prior?.behind ?? null, readerPosition: prior?.readerPosition, turnSequence: prior?.turnSequence });
      const depth = surfacesOf(canonical.search).length;
      if (landing && depth && matchMedia(NARROW_QUERY).matches) {
        // A phone opened straight on a task (a shared link, a notice) has a step for each surface of the stack, from
        // the list up, as if they were opened here one by one: Back and × take them away one at a time.
        writeStep(false, stepEntry(), writeNavigation(new URL(url), belowSurface(navigation, 0)));
        for (let open = 1; open < depth; open++) writeStep(true, stepEntry(), writeNavigation(new URL(url), belowSurface(navigation, open)));
        writeStep(true, entry, canonical);
      } else if (canonical.href !== url.href || !prior) writeStep(false, entry, canonical);
      landing = false;
      rememberNavigation(root, canonical, !!navigation.taskAddress);
    };
    /** Where the browser is, shown: Back, Forward, the page's own move there, a link to a state of the screen. */
    const show = () => {
      resume?.cancel();
      // A browser history step is a new navigation. A search edit made while
      // the previous entry was unresolved belongs to that entry alone.
      useViewStore.setState({ queryEditedBeforeNavigation: false });
      applyTimeViewUrl();
      applyUrl();
    };
    /**
     * Writes what an intent left the screen showing into the URL, as a step of its own or over the current one
     * (`isStep`).
     */
    const change = (run: () => void, write?: Write) => {
      const view = useViewStore.getState();
      const before = { project: view.project, selected: view.selected };
      run();
      // A link pressed: its own address is what its step is written from (its settings, what else it names).
      const base = linkTarget;
      linkTarget = null;
      // A reference followed belongs to this intent's step alone, whether it takes one or not.
      const followed = takeFollowedReference();
      if (!live) return;
      const { index, root, projects } = current.current;
      fitProject(before, index, projects, root);
      const beforeUrl = new URL(location.href);
      const was = readNavigation(beforeUrl, index, root, projects, missing);
      settleFilesPlace(was, index, root);
      const after = screenNavigation();
      // A task still waited for is written back as the URL names it (`writeNavigation`).
      const nextUrl = writeNavigation(new URL(base ?? beforeUrl), after);
      if (nextUrl.href === beforeUrl.href) return;
      resume?.cancel();
      // This intent commits an ordinary move; startup must not synthesize its history again.
      landing = false;
      const push = write ? write === "step" : isStep(was, after, beforeUrl, nextUrl);
      const prior = currentEntry();
      const behind = leavePlace(prior, readerPlace(was), readerPlace(after), push, followed, beforeUrl);
      writeStep(push, stepEntry({ behind, turnSequence: after.turnSequence }), nextUrl);
      rememberNavigation(root, nextUrl, !!after.taskAddress);
      if (!useViewStore.getState().navigationReady) applyUrl();
    };
    refresh.current = () => {
      if (resume?.waiting()) return;
      const { index, root, projects } = current.current;
      const url = new URL(location.href);
      // The URL as it is read now (a task or pane gone after a feed update, an address found or not), and the screen as
      // it is: shown again only when either differs from the URL, or the screen waits for what is now known.
      const navigation = readNavigation(url, index, root, projects, missing);
      const shown = screenNavigation();
      const canonical = writeNavigation(new URL(url), navigation).href;
      if (canonical !== url.href || writeNavigation(new URL(url), shown).href !== canonical
        || navigation.task !== shown.task) applyUrl();
    };
    // The page was opened afresh (not reloaded, not come back to): the first navigation it applies is where it landed.
    landing = !currentEntry();
    const launch = new URL(location.href);
    resume = landing ? resumeLanding(launch, root, () => current.current.projects, applyUrl) : null;
    if (resume) {
      // Show the launch's list while waiting, without committing it over the unverified saved destination.
      showNavigation(launch);
      resume.check();
    } else applyUrl();
    const showLink = (url: URL) => { linkTarget = url; applyTimeViewUrl(url); showNavigation(url, true); };
    showAt = showLink;
    // What the reader shows: its task, or the address it waits for (a bound intent given meanwhile acts on that).
    const detach = attachScreen({ change, show, shown: () => readerShows(useViewStore.getState()) });
    // A place noted on the step left and not yet kept is that step's, not the one shown now's, even where both show the
    // same place. The page's own steps keep it first (`readerBack`, `change`).
    const offPersonMove = onPersonMove(noteReaderPlace);
    const stopSettings = Object.values(screenSettings).map(setting => setting.subscribe(() => navigate(show)));
    return () => { live = false; resume?.stop(); detach(); offPersonMove(); stopSettings.forEach(stop => stop()); if (showAt === showLink) showAt = null; refresh.current = () => {}; };
  }, []);
  // The opened task's view, as the reader reads it: once it arrives, a tab it does not show is repaired.
  const opened = useViewStore(readerShows);
  const readable = useReaderTask(opened);
  const view = useQuery({ ...resources.taskView(root, opened ?? ""), enabled: false }).data;
  useEffect(() => {
    // A task or pane can disappear after a feed update; the URL is read again, in turn with every other intent.
    navigate(refresh.current);
  }, [index, root, view, readable, projects]);
}
