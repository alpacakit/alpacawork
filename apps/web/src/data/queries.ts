import { readExecution, readPageFailed, requestOlder } from './read-demand';
import { listedPlacement, listedRun, readQuery, readIndex, serverReadFacts, isWrittenRead, readerPresentation, taskReadState, type TaskRead, requiredReadKeys, subscribeReads } from './read-model';
import { fetchAcceptedResource, ensureReadAnchor, readerTaskRow, readState, recoverReads } from './resources';
import type { ReadAssessment } from './read-model';
import { sendDirectIntent } from "./direct-write";
import { bindIntentTransport, intentKey } from "./write-intent";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { attachmentBytes, DEFAULT_LIMITS, serverSettingsSchema, type ServerSettings } from "@alpacawork/contract";
import { taskRowFields, taskWriteResultSchema, type ProjectedIndexDTO, type ControlRunDTO } from "@alpacawork/contract/control";
import { descendants, indexTasks, withinProjectFilter, type TaskIndex } from "@/domain/tasks";
import { api, indexKey, resources } from "./resources";
export { api } from "./resources";
import { rowTask } from "./map";
import { useFrameSelector, useWorkspaceSelector } from "./workspace-store";
import { indexPeople } from "@/domain/people";
import type { PeopleIndex } from "@/domain/people";
import { markRead, useReadStore } from "../state/read-store";
import type { Task, TaskDetail, WorkspaceInfo } from "./types";
import type { TaskProjectedViewDTO } from "@alpacawork/contract/control";
import { canSendWrites, useConnection, basisForRead, workspaceWriteBasis, type WriteBasis } from "./connection";
import { gathering, useViewStore } from "@/state/view-store";
import { ApiError } from './client';
import { receiveServerFacts } from "../state/read-store";

/** An explicit recovery read after a refused write; the feed remains the normal update path. */
export async function rereadWorkspaceIndex(client: QueryClient): Promise<ProjectedIndexDTO> {
  const fetched = await fetchAcceptedResource(client, { ...resources.index(), staleTime: 0 });
  const server = serverReadFacts(client);
  if (server) receiveServerFacts(server);
  return fetched;
}
export const useTasks = () => useWorkspaceSelector((data) => data.tasks);
/** limits.attachment_mib in bytes: the largest file the screen sends or opens. The server checks again. */
export const useAttachmentBytes = () => useFrameSelector((data) => data?.info.attachmentBytes ?? attachmentBytes(DEFAULT_LIMITS));
export function useWorkspaceInfo(): WorkspaceInfo;
export function useWorkspaceInfo<T>(selector: (info: WorkspaceInfo) => T): T;
export function useWorkspaceInfo<T>(selector?: (info: WorkspaceInfo) => T) {
  return useWorkspaceSelector((data) => selector ? selector(data.info) : data.info);
}
export const useReadIds = () => useWorkspaceSelector((data) => data.readIds);
export const ReaderPeopleContext = createContext<PeopleIndex | null>(null);
export const usePeople = () => useWorkspaceSelector((data) => data.people);
export const useShelved = () => useWorkspaceSelector((data) => data.shelved);
/**
 * Whether the workspace takes writes, as its last index says: none before the first, nor while it is read-only. A
 * connection lost since does not change it (the device's own drafts are written meanwhile; see useWriteDisabled).
 */
export const useWorkspaceWritable = () => useFrameSelector((data) => data?.info.writable ?? false);
/** Whether what goes to serve waits: the workspace does not take writes, or serve is out of reach. */
export function useWriteDisabled(target?: string | QueryKey | WriteBasis | (() => WriteBasis)) {
  const client = useQueryClient();
  // One snapshot of both sources. A derived basis must be recomputed after a Query recovers; a caller's explicit
  // hash (for example the version an editor opened on) remains fixed.
  const subscribe = useCallback((changed: () => void) => {
    const connection = useConnection.subscribe(changed), queries = subscribeReads(client, changed);
    return () => { connection(); queries(); };
  }, [client]);
  return useSyncExternalStore(subscribe, () => {
    const value = typeof target === 'function' ? target() : target;
    return !canSendWrites(value && typeof value === 'object' && 'kind' in value ? value as WriteBasis : basisForRead(value as string | QueryKey | undefined));
  });
}
const indexes = new WeakMap<Task[], Map<TaskIndex["childCounts"], TaskIndex>>();
export function taskIndex(tasks: Task[], counts?: TaskIndex["childCounts"]): TaskIndex {
  let byCounts = indexes.get(tasks);
  if (!byCounts) { byCounts = new Map(); indexes.set(tasks, byCounts); }
  let index = byCounts.get(counts);
  if (!index) { index = indexTasks(tasks, counts); byCounts.set(counts, index); }
  return index;
}
const shown = new WeakMap<Task[], Map<string, Task[]>>();
/**
 * The tasks in view: every project's, or those of the project Task the list is narrowed to (`useViewStore`'s
 * `project`) and of the projects nested in it, as each row names its project (`withinProject`). Kept with the tasks:
 * a project never changes its place, and a new one comes with its own row.
 */
function tasksInView(tasks: Task[], project: string | null, projects: WorkspaceInfo["projects"]): Task[] {
  if (project === null) return tasks;
  let byProject = shown.get(tasks);
  if (!byProject) { byProject = new Map(); shown.set(tasks, byProject); }
  let found = byProject.get(project);
  if (!found) {
    const index = { byId: taskIndex(tasks).byId, projects };
    const includes = withinProjectFilter(project, index);
    found = tasks.filter((task) => includes(task.id));
    byProject.set(project, found);
  }
  return found;
}
type TaskName = { title: string; parentId: string | null };
/**
 * The title and parent of each of `ids` the list holds (`inView`: among the tasks in view only), as one map that stays
 * the same object while what it says of those Tasks does: a change to any other row draws nothing for its reader.
 */
export function useTaskNames(ids: readonly string[], inView: boolean): ReadonlyMap<string, TaskName> {
  const project = useViewStore((state) => state.project);
  const key = ids.join(" ");
  const select = useMemo(() => {
    const wanted = key ? key.split(" ") : [];
    let prior: Map<string, TaskName> | undefined;
    return (data: { tasks: Task[]; info: WorkspaceInfo }) => {
      const byId = taskIndex(inView ? tasksInView(data.tasks, project, data.info.projects) : data.tasks).byId;
      const next = new Map<string, TaskName>();
      for (const id of wanted) { const row = byId.get(id); if (row) next.set(id, { title: row.title, parentId: row.parent }); }
      if (prior && prior.size === next.size && [...next].every(([id, name]) => {
        const held = prior!.get(id); return !!held && held.title === name.title && held.parentId === name.parentId;
      })) return prior;
      prior = next;
      return next;
    };
  }, [key, inView, project]);
  return useWorkspaceSelector(select);
}
/** The tasks in view, as the list, the detail's walk and its Remaining count them. */
export function useTaskIndex(): TaskIndex {
  const project = useViewStore((state) => state.project);
  return useWorkspaceSelector((data) => taskIndex(tasksInView(data.tasks, project, data.info.projects), data.info.counts.children));
}
const readerRows = new WeakMap<object, Task>();
/** Translate the read Owner's row without adding it to the workspace's current index. */
export function readerTask(client: QueryClient, root: string, id: string): Task | undefined {
  const row = readerTaskRow(client, root, id);
  if (!row) return;
  let task = readerRows.get(row);
  if (!task) { task = rowTask(row); readerRows.set(row, task); }
  return task;
}
/**
 * Whether the reader has task `id` to show, by the rule it draws it by (useReaderTask): the current index's row, or else
 * its own read. The page lays the reader out by the same rule (Workbench), so a task the index lets go of while its read
 * stays (a finished one, as it is read again) keeps the reader's place and width.
 */
export const readerHasTask = (client: QueryClient, data: { info: { root: string }; tasks: readonly Task[] }, id: string) =>
  data.tasks.some((task) => task.id === id) || readerTask(client, data.info.root, id) !== undefined;
/** Explicit Reader admission, independent of list membership; all other indexes remain current-only. */
export function useReaderTask(id: string | null) {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  const current = useEveryTaskIndex().byId.get(id ?? '');
  const snapshot = useSyncExternalStore(useCallback((changed: () => void) => subscribeReads(client, changed), [client]),
    () => id ? readerTask(client, root, id) : undefined);
  // The opened Query owns the displayed document; a list projection can still be awaiting publication.
  return snapshot ?? current;
}
/** The qualified row both a closed label and its open card draw; no acquisition or Query observer. */
export function useReferenceRow(id: string) {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  const current = useEveryTaskIndex().byId.get(id);
  const { row, view, failure } = useCacheSnapshot(() => ({
    row: readerTask(client, root, id) ?? current,
    view: taskReadState(client, root, id, false).view,
    failure: readQuery(client, ['task', root, id])?.state.error ?? null,
  }), (a, b) => a.row === b.row && a.view === b.view && a.failure === b.failure, [root, id, current]);
  // Page rows keep only a state mark and one report. The qualified document retains the owner's latest report too;
  // a write receipt carries no History, so the row keeps its own until the read it asked for lands.
  const task = useMemo(() => row && view && !isWrittenRead(view) && view.task.version === row.version
    ? { ...row, stateLog: taskRowFields(view.task).stateLog } : row, [row, view]);
  // The API retains deletion records. A prose reference treats that tombstone as an unavailable destination.
  const error = useMemo(() => view?.task.lifecycle === 'deleted'
    ? new ApiError('Task does not exist', 'not_found', 'fix') : failure, [view?.task.lifecycle, failure]);
  return { task: error ? undefined : task, error, pending: !task && !error };
}
/** An open reference acquires the same qualified view, without adding closed rows to the live list. */
export function useReferenceTask(id: string, enabled = true) {
  const root = useWorkspaceInfo(info => info.root);
  const query = useQuery({ ...resources.taskView(root, id), enabled });
  const read = useReferenceRow(id);
  const { error } = read;
  const retry = error instanceof ApiError && error.code === 'not_found' ? undefined : () => void query.refetch();
  return { ...read, retry };
}
/** Every project's tasks: where a task named from elsewhere (a link, a notice) is found, whatever is in view. */
export function useEveryTaskIndex(): TaskIndex {
  return useWorkspaceSelector((data) => taskIndex(data.tasks, data.info.counts.children));
}
/**
 * Every task as the reader relates `task` to the others (its tree, its start order): with `task` in it, as the reader
 * admits it (readerHasTask) while the index lets it go a moment (a finished task as it is read again).
 */
export function useReaderIndex(task: Task): TaskIndex {
  const index = useEveryTaskIndex();
  return useMemo(() => index.byId.has(task.id) ? index : indexTasks([...index.byId.values(), task], index.childCounts), [index, task]);
}
const serverTasks = new WeakMap<ProjectedIndexDTO, Task[]>();
export function serverTasksFor(client: QueryClient): Task[] | undefined {
  const facts = serverReadFacts(client);
  if (!facts) return;
  let tasks = serverTasks.get(facts);
  if (!tasks) { tasks = facts.tasks.map(row => rowTask(row)); serverTasks.set(facts, tasks); }
  return tasks;
}
export function useServerTasks() {
  const client = useQueryClient();
  return useSyncExternalStore(useCallback((changed: () => void) => subscribeReads(client, changed), [client]), () => serverTasksFor(client));
}
/**
 * The active project Tasks as the index lists them, each with its parent, its depth and its tree's numbers (the
 * person's turns, the Tasks running; a parent's include its nested projects'). None until the first index arrives
 * (the header is drawn before it).
 */
export const useProjects = () => useFrameSelector((data) => data?.info.projects ?? NO_PROJECTS);
const NO_PROJECTS: WorkspaceInfo["projects"] = [];
const NO_MENU_COUNTS: WorkspaceInfo["counts"]["all"] = { turn: 0, running: 0 };
/**
 * Every project's menu numbers (All), as the index counts them: the screen adds no project's up. None until the first
 * index arrives.
 */
export const useAllProjectCounts = () => useFrameSelector((data) => data?.info.counts.all ?? NO_MENU_COUNTS);
const NO_CLOSED = { finished: 0, shelved: 0 };
/**
 * The top level's closed Tasks in view, as the index counts them for its scope: every project's (`root`), or the one
 * project Task's subtree, nested projects included. The screen adds none up.
 */
export function useClosedCounts() {
  const project = useViewStore((state) => state.project);
  return useWorkspaceInfo((info) => info.counts.closed[project ?? "root"] ?? NO_CLOSED);
}
/** What the list's place shows: nothing known yet, search results, a project still looked up, no project yet, how work starts, or the list. */
export type ListPlace = "loading" | "search" | "lookup" | "no-projects" | "welcome" | "list";
/**
 * The one rule for what the list's place shows, read by the page (Workbench) and the list (TimeTree). Until the first
 * index arrives nothing is known: no index is not "no project" and not empty. How work starts shows while the project
 * in view (or every project) holds no Task at all, as the index counts them, and nothing else takes the place. The
 * getting-started guide shown again takes no place of the list's: the work in it stays in view.
 */
export function listPlace(searching: boolean, project: string | null, info: WorkspaceInfo | null): ListPlace {
  if (searching) return "search";
  if (!info) return "loading";
  if (project && !info.projects.some((item) => item.id === project)) return "lookup";
  if (!info.projects.length) return "no-projects";
  return info.counts.tasks[project ?? "root"] === 0 ? "welcome" : "list";
}
export function useListPlace(): ListPlace {
  const searching = useViewStore(gathering);
  const project = useViewStore((state) => state.project);
  return useFrameSelector((data) => listPlace(searching, project, data?.info ?? null));
}
type HomeList = { rows: WorkspaceInfo["home"]; counts: WorkspaceInfo["counts"]["home"][string] };
const NO_HOME_COUNTS: HomeList["counts"] = { doing: 0, error: 0, review: 0, awaited: 0, held: 0, todo: 0 };
const homeLists = new WeakMap<WorkspaceInfo, Map<string | null, HomeList>>();
/**
 * The home list as the server projects it (index-feed's homeRows), in view: its rows, in the order the index has them,
 * of every project or of the project Task in view and the projects nested in it (`withinProject`), and each section's
 * count for that scope. The screen derives no row, section or count. Kept with the info: a listed row comes with its
 * Task's row, and a Task never leaves its project.
 */
export function useHomeList(): HomeList {
  const project = useViewStore((state) => state.project);
  return useWorkspaceSelector((data) => {
    let byProject = homeLists.get(data.info);
    if (!byProject) { byProject = new Map(); homeLists.set(data.info, byProject); }
    let list = byProject.get(project);
    if (!list) {
      const includes = project === null ? undefined
        : withinProjectFilter(project, { byId: taskIndex(data.tasks).byId, projects: data.info.projects });
      list = { rows: includes ? data.info.home.filter((row) => includes(row.taskId)) : data.info.home,
        counts: data.info.counts.home[project ?? "root"] ?? NO_HOME_COUNTS };
      byProject.set(project, list);
    }
    return list;
  });
}

const sameItems = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

function subtree(id: string, tasks: Task[], counts?: TaskIndex["childCounts"]) {
  const index = taskIndex(tasks, counts);
  const own = index.byId.get(id);
  return { index, members: own ? [own, ...descendants(id, index)] : [] };
}

/** A tree row needs a new index only when its own subtree changes. */
export function useTaskIndexFor(id: string): TaskIndex {
  const select = useMemo(() => {
    let prior: { members: Task[]; index: TaskIndex } | undefined;
    return (data: { tasks: Task[]; info: WorkspaceInfo }) => {
      const next = subtree(id, data.tasks, data.info.counts.children);
      if (prior && sameItems(prior.members, next.members) && prior.index.childCounts === next.index.childCounts) return prior.index;
      prior = next;
      return next.index;
    };
  }, [id]);
  return useWorkspaceSelector(select);
}

/** Placement changes elsewhere do not redraw a card or its descendant marks. */
export function usePeopleFor(id: string, includeDescendants = false): PeopleIndex {
  const readerPeople = useContext(ReaderPeopleContext);
  const select = useMemo(() => {
    let prior: { values: unknown[]; people: PeopleIndex } | undefined;
    return (data: { tasks: Task[]; people: PeopleIndex }) => {
      const members = includeDescendants ? subtree(id, data.tasks).members : [taskIndex(data.tasks).byId.get(id)];
      const people = readerPeople ?? data.people;
      const values = members.flatMap((task) => task ? [task.id, people.tasks.get(task.id), people.crews.get(task.id),
        people.runsByTask.get(task.id), ...(includeDescendants ? [people.children.get(task.id)] : [])] : []);
      if (prior && sameItems(prior.values, values)) return prior.people;
      prior = { values, people };
      return people;
    };
  }, [id, includeDescendants, readerPeople]);
  return useWorkspaceSelector(select);
}

/** The view whose placements and runs the reader adds to the server's; a written document adds none of its own. */
function readerPeopleView(client: QueryClient, root: string, id: string | null) {
  const presentation = id ? readerPresentation(client, root, id) : undefined;
  return presentation?.kind === 'view' ? presentation.view : presentation?.kind === 'written' ? presentation.earlier : undefined;
}
/** Every reader of the same facts shares one index: each update otherwise builds it once per hook on the screen. */
const peopleOf = new WeakMap<ProjectedIndexDTO, Map<TaskProjectedViewDTO | undefined, PeopleIndex>>();
/** The same synchronous people projection for render and report admission. */
export function readerPeopleFor(client: QueryClient, root: string, id: string | null, previous?: PeopleIndex): PeopleIndex {
  const server = serverReadFacts(client), view = readerPeopleView(client, root, id);
  const held = server && peopleOf.get(server), known = held?.get(view);
  if (known) return known;
  const people = indexPeople({ tasks: server?.tasks ?? [],
    placements: [...new Map([...(view?.placements ?? []).map(listedPlacement), ...(server?.placements ?? [])].map(each => [each.id, each])).values()],
    runs: [...new Map([...(view?.runs ?? []).map(listedRun), ...(server?.runs ?? [])].map(each => [each.id, each])).values()] }, previous);
  if (server) { if (held) held.set(view, people); else peopleOf.set(server, new Map([[view, people]])); }
  return people;
}
export function useReaderPeople(id: string | null): PeopleIndex {
  const client = useQueryClient(), root = useWorkspaceInfo(info => info.root);
  const held = useRef<{ server: ProjectedIndexDTO | undefined; view: TaskProjectedViewDTO | undefined; people: PeopleIndex } | null>(null);
  const snapshot = () => {
    const server = serverReadFacts(client), view = readerPeopleView(client, root, id);
    if (held.current && held.current.server === server && held.current.view === view) return held.current.people;
    const people = readerPeopleFor(client, root, id, held.current?.people);
    held.current = { server, view, people }; return people;
  };
  return useSyncExternalStore(useCallback((changed: () => void) => subscribeReads(client, changed), [client]), snapshot);
}

/** Only read markers below this row affect its hidden-unread badge. */
export function useReadIdsFor(id: string): ReadonlySet<string> {
  const select = useMemo(() => {
    let prior: { values: unknown[]; readIds: ReadonlySet<string> } | undefined;
    return (data: { tasks: Task[]; readIds: ReadonlySet<string> }) => {
      const values = subtree(id, data.tasks).members.flatMap((task) => [task.id, data.readIds.has(task.id)]);
      if (prior && sameItems(prior.values, values)) return prior.readIds;
      prior = { values, readIds: data.readIds };
      return data.readIds;
    };
  }, [id]);
  return useWorkspaceSelector(select);
}

/** Shape adapter only: the normal History Query owns data, status, errors and execution. */
export function useTaskHistory(root: string, id: string) {
  const client = useQueryClient(), result = useQuery(resources.history(root, id));
  const query = readQuery(client, resources.history(root, id).queryKey);
  const fetchNextPage = useCallback(async () => {
    if (query) await requestOlder(query);
    return client.getQueryState(resources.history(root, id).queryKey);
  }, [client, query, root, id]);
  return { ...result, hasNextPage: !!result.data?.pages.at(-1)?.nextBefore,
    isFetchingNextPage: result.isFetching && !!query && readExecution(query)?.plan.kind === 'older',
    isFetchNextPageError: result.isError && !!query && readPageFailed(query),
    fetchNextPage };
}

/** An opened task: its row, and what `GET /api/task/view` adds once it has arrived. */
export function useTaskDetail(task: Task | undefined, reports = false) {
  const root = useWorkspaceInfo((info) => info.root);
  const client = useQueryClient();
  const query = useQuery({ ...resources.taskView(root, task?.id ?? ""), enabled: !!task });
  // The parent that qualifies this group also owns both acquisitions. If the History proof expires,
  // ReportFeed can unmount; its child observer must not be the only thing keeping recovery active.
  const history = useQuery({ ...resources.history(root, task?.id ?? ''), enabled: !!task && reports });
  // The existing group assessment owns display; raw Query data cannot bypass its identity/refusal gates.
  const { assessment, fetching, refreshing, viewSettled, view } = useTaskReadState(root, task?.id ?? '', reports);
  const detail = useMemo(() => task && view && view.task.id === task.id ? taskDetail(task, view) : undefined, [task, view]);
  const presentation = readerPresentation(client, root, task?.id ?? '');
  const retry = () => recoverReads(client, [resources.taskView(root, task?.id ?? '').queryKey,
    ...(reports ? [resources.history(root, task?.id ?? '').queryKey] : [])]);
  // Loadable consumes the qualified group, not the Task GET's unrelated success status.
  const error = query.error ?? (reports ? history.error : null);
  // Whether the view is held and shown (detail) and whether its last read failed (failure) are separate: a held view
  // stays on screen while a failed read of it is said and can be read again.
  const failure = query.isError ? query.error : null;
  return { detail, failure, refreshing, query: { ...query, isPending: !detail && !error, isError: !detail && !!error,
    isFetching: fetching, error, refetch: async (options?: Parameters<typeof query.refetch>[0]) => {
      await ensureReadAnchor(client); return query.refetch(options);
    } }, assessment, fetching, viewSettled, presentation, retry };
}

const sameAssessment = (a: ReadAssessment, b: ReadAssessment) => a.state === b.state && a.display === b.display
  && a.project === b.project && a.persist === b.persist && a.acquiredAt === b.acquiredAt && a.needsRead === b.needsRead;
/** The cache's answer, kept while it says the same, so a reader is redrawn only when the assessment changes. */
function useCacheSnapshot<T>(read: () => T, same: (a: T, b: T) => boolean, deps: unknown[]): T {
  const client = useQueryClient();
  const held = useRef<{ deps: unknown[]; value: T } | null>(null);
  const snapshot = () => {
    const next = read();
    if (held.current && sameItems(held.current.deps, deps) && same(held.current.value, next)) return held.current.value;
    held.current = { deps, value: next };
    return next;
  };
  return useSyncExternalStore(useCallback((changed: () => void) => subscribeReads(client, changed), [client]), snapshot);
}
type ReadView = { assessment: ReadAssessment; error: unknown; fetching: boolean; retry: () => void };
/**
 * A read's assessment (read-model's, through resources.readState) as the screen draws it: whether its held data may be
 * shown, of when it is, and whether a read of it is under way. It decides nothing itself.
 */
export function useReadState(key: QueryKey): ReadView {
  const client = useQueryClient();
  const hash = JSON.stringify(key);
  return useCacheSnapshot(() => {
    const state = readState(client, key);
    const fetching = readQuery(client, key)?.state.fetchStatus === "fetching";
    return { assessment: state.assessment, error: state.error, fetching, retry: () => void readState(client, key).retry?.().catch(() => {}) };
  }, (a, b) => sameAssessment(a.assessment, b.assessment) && a.error === b.error && a.fetching === b.fetching, [hash]);
}
/** One Task's reads as one group (resources.taskReadState): its view, and its History when the reports are shown. */
export function useTaskReadState(root: string, id: string, reports: boolean) {
  const client = useQueryClient();
  return useCacheSnapshot(() => {
    const reads = taskReadState(client, root, id, reports);
    const reading = [["task", root, id], ["task-history", root, id]].slice(0, reports ? 2 : 1).map(key => readQuery(client, key))
      .filter((query): query is NonNullable<typeof query> => query?.state.fetchStatus === "fetching");
    return { assessment: reads.assessment, view: reads.view, viewSettled: reads.viewSettled,
      fetching: reading.length > 0,
      // What it shows being read again: its view or its newest History, not an older page read below it.
      refreshing: reading.some(query => readExecution(query)?.plan.kind !== 'older') };
  }, (a, b) => sameAssessment(a.assessment, b.assessment) && a.fetching === b.fetching && a.refreshing === b.refreshing && a.view === b.view
    && a.viewSettled === b.viewSettled, [root, id, reports]);
}
/** One empty list for every Task without files, so a reader of them sees the same list from read to read. */
const NO_FILES: TaskDetail["files"] = [];
/** A Task's files as a read holds them: a written document's own, else those of the view it was written over. */
export const filesOfRead = (read: TaskRead) => read.task.files ?? (isWrittenRead(read) ? read.earlier : read)?.task.files;
export function taskDetail(task: Task, read: TaskProjectedViewDTO): TaskDetail;
export function taskDetail(task: Task, read: TaskRead): TaskDetail | undefined;
export function taskDetail(task: Task, read: TaskRead): TaskDetail | undefined {
  const view = isWrittenRead(read) ? read.earlier : read;
  if (!view) return;
  return { ...task, responsibleRevision: view.placements.find(placement => placement.active && placement.responsible)?.revision ?? null, title: read.task.title, hash: read.task.hash, version: read.task.version, values: view.values, settings: read.task.settings,
    logs: view.task.log, files: filesOfRead(read) ?? NO_FILES, requestHeads: view.requestHeads, reply: view.reply ?? undefined,
    questions: view.questions, userQuestions: view.userQuestions, userReviews: view.userReviews, requestedByUser: view.requestedByUser };
}

type WriteOptions = { errorToast?: false };

/** The same object while its contents stay the same, so a reader of it is not redrawn for an equal read. */
function useStable<T>(value: T): T {
  const held = useRef(value);
  if (JSON.stringify(held.current) !== JSON.stringify(value)) held.current = value;
  return held.current;
}
/**
 * The AI tab reads this PC's config.yaml (its limits and agents) afresh each time it opens and keeps that read as
 * its draft's base; a change elsewhere meets the save as a conflict. A save answers the file it wrote. A project's
 * name and values are its Task's: read with `useTaskDetail`, saved with a Task update.
 */
export function useServerSettings(fresh = false) {
  const root = useFrameSelector((data) => data?.info.root ?? "");
  return useQuery({ ...resources.serverSettings(root), enabled: !!root, refetchOnMount: fresh ? "always" : false });
}
export function useAgentStatus() {
  const root = useFrameSelector((data) => data?.info.root ?? "");
  return useQuery({ ...resources.agentStatus(root), enabled: !!root, refetchOnMount: "always" });
}
export function useAgentExecutable(adapter: string, command: string | null) {
  const root = useFrameSelector((data) => data?.info.root ?? "");
  return useQuery({ ...resources.agentExecutable(root, adapter, command ?? ""), enabled: !!root && command !== null });
}
export function useSaveServerSettings(meta?: WriteOptions) {
  const client = useQueryClient();
  const root = useWorkspaceInfo((info) => info.root);
  return useMutation({ meta, mutationFn: async ({ yaml, agents, expected, opId, basis }: { yaml: string; agents: string; expected: string; opId?: string; basis?: WriteBasis }): Promise<ServerSettings> => {
    const wire = { expectedConfigHash: expected, config: yaml, agents };
    const access = bindIntentTransport(basis ?? workspaceWriteBasis(), { yaml, agents, expected }, wire, opId);
    const settings = await api.request("config/set", serverSettingsSchema, undefined, wire, opId, access);
    client.setQueryData(resources.serverSettings(root).queryKey, settings);
    // The saved agents may run another executable: their status is read again.
    void client.invalidateQueries({ queryKey: resources.agentStatus(root).queryKey });
    return settings;
  } });
}

/** The stopped Run reaches the screen with the feed's next delta. */
export function useStopRun(meta?: WriteOptions) {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  return useMutation({ meta, mutationFn: async (run: ControlRunDTO) => {
    await sendDirectIntent(client, intentKey(root, "run/stop", run.id),
      { path: "run/stop", response: "stop", label: run.id }, () => ({ run: run.id }), workspaceWriteBasis());
  } });
}
