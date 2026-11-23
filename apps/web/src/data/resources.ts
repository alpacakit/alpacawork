import { agentLimitsResponseSchema } from "@alpacawork/contract/agent-limits";
import { AGENT_CHECK_READ_MS, foldersSchema, hostEpisodeMinutesSchema, hostStatusSchema, noticeStateResponseSchema, personalSettingsResponseSchema, placeHomeRows, pushDevicesSchema, pushKeySchema, serverSettingsSchema } from "@alpacawork/contract";
import { projectedIndexSchema, controlRunFilesSchema, projectShelfSchema, taskProjectedPageSchema, taskRowFields, taskProjectedSearchSchema, taskShelvedDetailSchema, taskProjectedTimelineAxisSchema, taskProjectedTimelineSchema, type ProjectedIndexDTO, type ControlTaskHeadDTO, type IndexPatchDTO, type TaskRowDTO, type TaskProjectedTimelineDTO, type TaskProjectedViewDTO } from "@alpacawork/contract/control";
import { CancelledError, QueryObserver, infiniteQueryOptions, keepPreviousData, queryOptions, type InfiniteData, type QueryClient, type QueryKey, type Query as QueryRecord } from "@tanstack/react-query";
import { ApiError, createApi, retryOf } from "./client";
import { readCoordinator, type CoordinatorSnapshot } from './coordinator';
import { historyResource, missingHistoryRange, trimClosedHistory } from './history-resource';
import { pendingReadPage, readDemandPending, readDemandReady, readHasLaterDemand, readRecoveryPending, requestRead, requestReadRecovery } from './read-demand';
import { acceptedGet, admitsRead, anchorReadScope, beginReadReceipt, beginResourceGet, captureReadBoundary, captureReadProof, deriveReadAcquisition, displayReadFacts, evaluateRead, failedGetAccepted, getReadProof, hasCurrentReadGet, holdsRowPages, isWrittenRead, minimumTaskVersion, observeReadProofs, pageRow, preserveReadProof, readAcquisition, readCodec, readEntry, readGetTicket, readIndex, readMarker, readQuery, readRefusalCovers, readRefused, readScope, readSerial, readStartedProof, readViewSchema, receiveReadScope, recordIndexGetResult, unlistedAggregates, viewRow, writtenFloors, rowsOfPages, recordIndexProof, recordReadAcquired, recordReadError, recordReadProof, recordReadResult, recordReadStructure, recordCheckedRead, refuseRead, requireTaskVersion, requiredReadKeys, sameReadSession, serverReadFacts, taskReadState, verifiedReadAcquisition, type TaskRead } from './read-model';

import { decodeText } from "@/domain/text-bytes";
import { DIFF_LIMITS } from "@alpacawork/contract/report-diff";
import { z } from "zod";
import { taskCodeUrl, taskFileUrl } from "./task-file-url";

const codeRootsSchema = z.object({ roots: z.array(z.string()) });

import { useConnection } from './connection';
import { skillCatalogSchema } from './skill-catalog';

type Query = QueryRecord<any, any, any, any>;
export const api = createApi();
const readLiveIndex = (signal?: AbortSignal) => api.request("workspace/live", projectedIndexSchema, signal);

/**
 * What the screen reads, each with its key, how it is fetched and how long it is kept.
 * The index is the feed's (SSE); the rest is read when a screen needs it and read again
 * when the feed says it changed (`receiveDelta`).
 */
export const indexKey = ["index"] as const;
/** The most of a Task's file the screen reads whole: a larger one is not asked for, and one whose body outruns it is let go. */
export const FILE_READ_BYTES = DIFF_LIMITS.inputBytes * 4;

/** A Task's file's bytes as stored, read once per revision (FILE_READ_BYTES at most), whoever draws or copies them. */
const fileBytesRead = (root: string, taskId: string, name: string, revision: string) => ({
  queryKey: ["task-file-bytes", root, taskId, name, revision] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.requestBytes(taskFileUrl(taskId, name, revision), FILE_READ_BYTES, signal),
  staleTime: Infinity,
});

export const resources = {
  projectShelf: (root: string) => queryOptions({
    queryKey: ['project-shelf', root] as const,
    queryFn: ({ client, queryKey, signal }) => readResource(client, queryKey, () => api.request('project/shelf', projectShelfSchema, signal)),
    staleTime: Infinity,
  }),
  skills: (root: string, profile: string, conversation: string | null) => queryOptions({
    queryKey: ['coordinator-skills', root, conversation, profile] as const,
    queryFn: ({ client, queryKey, signal }) => readResource(client, queryKey, async () => {
      const catalog = await readSkillCatalog(conversation!, signal);
      // Kept under the AI it was asked for: an answer for another (the settings changed meanwhile) is not that one's.
      if (catalog.profile !== profile) throw new ApiError('Skill catalog answered a different profile', 'invalid_response', 'later');
      return catalog;
    }),
    staleTime: 0,
  }),
  coordinator: (client: QueryClient, root: string, receive: (fetch: () => Promise<CoordinatorSnapshot>) => Promise<CoordinatorSnapshot>) => queryOptions({
    queryKey: ['coordinator', root] as const,
    // A sent request may still contribute acceptance facts after its Query execution is superseded.
    queryFn: () => {
      const read = () => readResource(client, ['coordinator', root], () => receive(() => readCoordinator()));
      return readScope(client)?.anchored === false ? ensureReadAnchor(client).then(read) : read();
    },
    retry: (count, error) => {
      const query = readQuery(client, ['coordinator', root]), index = readIndex(client);
      return count < 5 && retryOf(error) === 'later' && !['forbidden', 'not_found'].includes((error as ApiError).code)
        && !!query && readDemandPending(query) && (query.state.data === undefined || !!index && getReadProof(query)?.marker !== readMarker(index, query.queryKey));
    },
    retryDelay: count => Math.min(30_000, 1_000 * 2 ** count),
    staleTime: Infinity,
  }),
  index: () => queryOptions({ queryKey: indexKey,
    queryFn: async ({ client, signal }) => {
      const query = readQuery(client, indexKey)!; beginResourceGet(client, query);
      const ticket = readGetTicket(query), started = captureResourceRead(client, indexKey);
      const index = await readLiveIndex(signal);
      if (started.boundary && !sameReadSession(client, started.boundary)) return discardCapturedResourceRead(client, started);
      const held = readIndex(client);
      if (held && held.root === index.root && held.generation === index.generation && held.rev > index.rev) return discardCapturedResourceRead(client, started);
      receiveFullIndex(client, index);
      anchorReadScope(client, started.boundary);
      const accepted = readIndex(client)!;
      if (!recordIndexGetResult(client, query, ticket, accepted)) return discardCapturedResourceRead(client, started);
      return accepted;
    }, staleTime: Infinity }),
  /**
   * A parent's finished children, or the top level's: every project's, or those in `scope`'s subtree (the project Task
   * in view, nested projects included).
   */
  finished: (root: string, parent: string | null, scope: string | null = null) => infiniteQueryOptions({
    queryKey: ["task-finished", root, parent ?? "root", parent === null ? scope : null] as const,
    queryFn: ({ client, queryKey, signal, pageParam }) => readResource(client, queryKey, () => api.request(`task/finished?parent=${encodeURIComponent(parent ?? "root")}&limit=20`
      + (parent === null && scope !== null ? `&scope=${encodeURIComponent(scope)}` : "")
      + (pageParam ? `&after=${encodeURIComponent(pageParam)}` : ""), taskProjectedPageSchema, signal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextAfter ?? undefined,
    staleTime: Infinity,
  }),
  /** Archived and deleted Tasks: every project's, or those in `scope`'s subtree (the project Task in view). */
  shelved: (root: string, scope: string | null) => infiniteQueryOptions({
    queryKey: ["task-shelved", root, scope] as const,
    queryFn: ({ client, queryKey, signal, pageParam }) => readResource(client, queryKey, () => api.request(`task/shelved?limit=20${scope !== null ? `&scope=${encodeURIComponent(scope)}` : ""}`
      + (pageParam ? `&after=${encodeURIComponent(pageParam)}` : ""), taskProjectedPageSchema, signal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextAfter ?? undefined,
    staleTime: Infinity,
  }),
  timelineAxis: (root: string, scope: string | null, lanes: string[], folded: string[]) => queryOptions({
    queryKey: ["task-timeline", root, "axis", scope ?? "root", lanes.join(","), folded.join(",")] as const,
    queryFn: ({ client, queryKey, signal }) => readTimeline(client, queryKey, scope, lanes, () => api.request(`task/timeline-axis?scope=${encodeURIComponent(scope ?? "root")}`
      + `&lanes=${encodeURIComponent(lanes.join(","))}&folded=${encodeURIComponent(folded.join(","))}`, taskProjectedTimelineAxisSchema, signal)),
    staleTime: Infinity,
  }),
  timeline: (root: string, scope: string | null, visible: string[], folded: string[], from: string, to: string) => infiniteQueryOptions({
    queryKey: ["task-timeline", root, scope ?? "root", [...new Set(visible)].sort().join(","), [...new Set(folded)].sort().join(","), from, to] as const,
    placeholderData: (previous: InfiniteData<TaskProjectedTimelineDTO> | undefined, query) =>
      query?.queryKey[1] === root && query.queryKey[2] === (scope ?? "root") ? previous : undefined,
    queryFn: ({ client, queryKey, signal, pageParam }) => readTimeline(client, queryKey, scope, visible, () => api.request(`task/timeline?scope=${encodeURIComponent(scope ?? "root")}`
      + `&visible=${encodeURIComponent([...new Set(visible)].sort().join(","))}&folded=${encodeURIComponent([...new Set(folded)].sort().join(","))}`
      + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2000`
      + (typeof pageParam === "string" ? `&after=${encodeURIComponent(pageParam)}` : ""), taskProjectedTimelineSchema, signal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextAfter ?? undefined,
    staleTime: Infinity,
  }),
  notices: (root: string) => queryOptions({
    queryKey: ["person-notices", root] as const,
    queryFn: ({ client, queryKey, signal }) => readResource(client, queryKey, () => api.request("person/notices", noticeStateResponseSchema, signal)),
    staleTime: Infinity,
  }),
  personalSettings: (root: string) => queryOptions({
    queryKey: ["person-settings", root] as const,
    queryFn: ({ client, queryKey, signal }) => readResource(client, queryKey, () => api.request("settings/get", personalSettingsResponseSchema, signal)),
    staleTime: Infinity,
  }),
  /** This PC's config.yaml: its limits and agents. */
  serverSettings: (root: string) => queryOptions({
    queryKey: ["server-settings", root] as const,
    queryFn: ({ signal }) => api.request("config/get", serverSettingsSchema, signal),
    staleTime: Infinity,
  }),
  /** Each agent's executable and sign-in status. It runs the agents' own checks (a second or more), so it is read apart
   * from config.yaml and arrives after it. The server bounds those checks; this read waits past that bound, and a failed
   * one is not asked again (each ask runs every check once more). */
  agentStatus: (root: string) => queryOptions({
    queryKey: ["agent-status", root] as const,
    queryFn: ({ signal }) => api.readWithin("config/get?check=true", serverSettingsSchema, AGENT_CHECK_READ_MS, signal),
    staleTime: 0, retry: false,
  }),
  /** The version of a typed executable path. */
  agentExecutable: (root: string, adapter: string, command: string) => queryOptions({
    queryKey: ["agent-executable", root, adapter, command] as const,
    queryFn: async ({ signal }) => (await api.readWithin(`config/get?check=true&adapter=${encodeURIComponent(adapter)}&command=${encodeURIComponent(command)}`,
      serverSettingsSchema, AGENT_CHECK_READ_MS, signal)).inspected ?? null,
    staleTime: 0, retry: false,
  }),
  pushDevices: () => queryOptions({ queryKey: ["push-devices"] as const,
    queryFn: ({ signal }) => api.request("notify/devices", pushDevicesSchema, signal), staleTime: 0 }),
  /** The folders in one folder of this PC (null: where projects' code usually is), for a folder field. */
  folders: (root: string, path: string | null, prefix = "") => queryOptions({ queryKey: ["folders", root, path, prefix] as const,
    queryFn: ({ signal }) => api.request(`workspace/folders?${new URLSearchParams({ ...(path === null ? {} : { path }),
      ...(prefix ? { prefix } : {}), ...(prefix.startsWith(".") ? { hidden: "true" } : {}) })}`, foldersSchema, signal),
    staleTime: 10_000, retry: false }),
  /** Each kind of agent's plan limits. The server asks an agent at most every 5 minutes, within the agents' check
   * deadline (a first read waits for it); reading each minute while the screen is shown brings a fresh answer within a minute of it. */
  agentLimits: (root: string) => queryOptions({ queryKey: ["agent-limits", root] as const,
    queryFn: ({ signal }) => api.readWithin("limits", agentLimitsResponseSchema, AGENT_CHECK_READ_MS, signal),
    staleTime: 60_000, refetchInterval: 60_000 }),
  /** Host status: read again every sample (10 s) while the tab is open. */
  hostStatus: (root: string) => queryOptions({ queryKey: ["host-status", root] as const,
    queryFn: ({ signal }) => api.request("host/status", hostStatusSchema, signal), staleTime: 0, refetchInterval: 10_000 }),
  /** The minute values around one tight episode: read again each minute while it lasts, kept once it has ended. */
  hostEpisode: (root: string, id: number, end: number | null) => queryOptions({ queryKey: ["host-episode", root, id, end] as const,
    queryFn: ({ signal }) => api.request(`host/episode?id=${id}`, hostEpisodeMinutesSchema, signal),
    staleTime: end === null ? 60_000 : Infinity, refetchInterval: end === null ? 60_000 : false }),
  /** A Run's final reply, read when History opens a member's result: a committed reply never changes, so it is read once. */
  runResult: (root: string, run: string) => queryOptions({ queryKey: ["run-result", root, run] as const,
    queryFn: ({ signal }) => api.request(`run/get?${new URLSearchParams({ run })}`, controlRunFilesSchema, signal),
    staleTime: Infinity, gcTime: 5 * 60_000, retry: false }),
  pushKey: () => queryOptions({ queryKey: ["push-key"] as const,
    queryFn: ({ signal }) => api.request("notify/key", pushKeySchema, signal), staleTime: 60_000 }),
  /**
   * One opened task: its document, request headings, values, and latest reply. A read stays cached when its last
   * reader closes, so returning to that task reuses the same view.
   */
  taskView: (root: string, id: string) => queryOptions({
    queryKey: ["task", root, id] as const,
    queryFn: ({ client, queryKey, signal }) => readResource<TaskRead>(client, queryKey, () => api.request(`task/view?task=${encodeURIComponent(id)}`, readViewSchema, signal)),
    staleTime: Infinity,
  }),
  history: historyResource(api, readResource),
  /**
   * IDs of the tasks whose title, body, ID or responsible person's name contains the words; in `scope`'s subtree (the
   * project Task in view, nested projects included) when the screen is narrowed to it.
   */
  taskSearch: (root: string, text: string, scope: string | null) => infiniteQueryOptions({
    queryKey: ["task-search", root, text, scope] as const,
    queryFn: ({ client, queryKey, signal, pageParam }) => readResource(client, queryKey, () => api.request(`task/search?text=${encodeURIComponent(text)}&limit=40`
      + (scope !== null ? `&scope=${encodeURIComponent(scope)}` : "")
      + (pageParam ? `&after=${encodeURIComponent(pageParam)}` : ""), taskProjectedSearchSchema, signal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextAfter ?? undefined,
    staleTime: 30_000, placeholderData: keepPreviousData,
  }),
  /** A Task's diff file as text, as the browser decodes it (the viewer cuts it into a diff's pages). */
  diffText: (root: string, taskId: string, name: string, revision: string) => queryOptions({
    queryKey: ["task-diff-text", root, taskId, name, revision] as const,
    queryFn: ({ signal }) => api.requestText(taskFileUrl(taskId, name, revision), signal),
    staleTime: Infinity,
  }),
  /**
   * A Task's file's words, or null where its bytes are not text (decodeText): its one read of bytes (fileBytes), seen
   * as text, so a table drawn from its bytes and its words copied are one read.
   */
  fileText: (root: string, taskId: string, name: string, revision: string) => queryOptions({
    ...fileBytesRead(root, taskId, name, revision), select: decodeText,
  }),
  /** A diff file's report header alone (`part=head`): its summary, without the patch's rows. */
  diffHead: (root: string, taskId: string, name: string, revision: string) => queryOptions({
    queryKey: ["task-diff-head", root, taskId, name, revision] as const,
    queryFn: ({ signal }) => api.requestText(`${taskFileUrl(taskId, name, revision)}&part=head`, signal),
    staleTime: Infinity,
  }),
  /** A file of a Task's code locations (an absolute path its words name), as text; the server refuses any other. */
  codeFile: (root: string, taskId: string, path: string) => queryOptions({
    queryKey: ["task-code-file", root, taskId, path] as const,
    queryFn: ({ signal }) => api.requestText(taskCodeUrl(taskId, path), signal),
    staleTime: 30_000, retry: false,
  }),
  /** The places a Task's words may name code files in: its projects' code locations and their git worktrees. */
  codeRoots: (root: string, taskId: string) => queryOptions({
    queryKey: ["task-code-roots", root, taskId] as const,
    queryFn: ({ signal }) => api.request(`tasks/${encodeURIComponent(taskId)}/code-roots`, codeRootsSchema, signal),
    staleTime: 60_000,
  }),
  fileBytes: (root: string, taskId: string, name: string, revision: string) => queryOptions(fileBytesRead(root, taskId, name, revision)),
};

/**
 * A whole index replaces the held one after a fresh subscription or a recovery read. What it made old is read again by
 * the one rule every patch follows (applyReadEvidence): a resource whose required version moved.
 */
export function receiveFullIndex(client: QueryClient, index: ProjectedIndexDTO): ProjectedIndexDTO {
  applyReadEvidence(client, index);
  return readIndex(client)!;
}

/** Changed entries of a keyed record replace or leave it; the rest stay the same objects. */
function patchRecord<V>(record: Record<string, V>, change: { upsert: Record<string, V>; remove: string[] }): Record<string, V> {
  if (!change.remove.length && !Object.keys(change.upsert).length) return record;
  const next = { ...record, ...change.upsert };
  for (const key of change.remove) delete next[key];
  return next;
}
/**
 * One `patch` on the index it follows, key by key: rows, placements and Runs replaced or removed by ID; each changed
 * home row placed after the row it names (null: first, placeHomeRows); the counts, required versions and small fields
 * that changed. Null when the home rows it names are not the ones held: the patch does not follow this index.
 */
export function applyIndexPatch(index: ProjectedIndexDTO, patch: IndexPatchDTO): ProjectedIndexDTO | null {
  const merge = <T extends { id: string }>(items: T[], change: { upsert: T[]; remove: string[] }) => {
    if (!change.upsert.length && !change.remove.length) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const item of change.upsert) byId.set(item.id, item);
    for (const id of change.remove) byId.delete(id);
    return [...byId.values()];
  };
  const home = patch.home.upsert.length || patch.home.remove.length ? placeHomeRows(index.home, patch.home) : index.home;
  if (!home) return null;
  const { counts, requiredPv } = patch;
  return { ...index, ...patch.meta, rev: patch.rev, sourcePv: patch.sourcePv,
    tasks: merge(index.tasks, patch.tasks), placements: merge(index.placements, patch.placements), runs: merge(index.runs, patch.runs), home,
    counts: { closed: patchRecord(index.counts.closed, counts.closed), home: patchRecord(index.counts.home, counts.home),
      tasks: patchRecord(index.counts.tasks, counts.tasks), children: patchRecord(index.counts.children, counts.children),
      all: counts.all ?? index.counts.all },
    requiredPv: { view: patchRecord(index.requiredPv.view, requiredPv.view), history: patchRecord(index.requiredPv.history, requiredPv.history),
      page: patchRecord(index.requiredPv.page, requiredPv.page), timeline: patchRecord(index.requiredPv.timeline, requiredPv.timeline),
      search: patchRecord(index.requiredPv.search, requiredPv.search) } };
}

/** Apply a patch to the cache; what it made old is read again where it is on screen. A patch that does not follow is a gap. */
export function receivePatch(client: QueryClient, patch: IndexPatchDTO): ProjectedIndexDTO | null {
  const current = readIndex(client);
  if (!current || patch.generation !== current.generation || patch.rev !== current.rev + 1) return null;
  const next = applyIndexPatch(current, patch);
  if (!next) return null;
  applyReadEvidence(client, next, true);
  return readIndex(client)!;
}

/**
 * A write answers the task as written. It is shown at once: its row and its opened view are
 * replaced, so a form opened next carries the new hash. The feed's later delta for the same
 * write changes nothing. The card's question and the view's other parts follow with it.
 */
export function showWrittenTask(client: QueryClient, task: ControlTaskHeadDTO, source?: ProjectedIndexDTO) { applyReadEvidence(client, { kind: 'written', task, source }); }
function applyWrittenTask(client: QueryClient, task: ControlTaskHeadDTO) {
  const index = readIndex(client);
  if (!index) return;
  const taskKey: QueryKey = ['task', index.root, task.id];
  const query = client.getQueryCache().build(client, { queryKey: taskKey });
  const held = query.state.data as TaskRead | undefined;
  const row = serverReadFacts(client)?.tasks.find(row => row.id === task.id);
  if (Math.max(row?.version ?? 0, held?.task.version ?? 0, minimumTaskVersion(query)) > task.version) return;
  requireTaskVersion(query, task.version);
  const earlier = held && (isWrittenRead(held) ? held.earlier : held);
  const acquiredAt = earlier ? getReadProof(query)?.acquiredAt : undefined;
  const written: TaskRead = { kind: 'written', task, ...(earlier ? { earlier } : {}) };
  publishReadReceipt(client, taskKey, written, () => ({ ...captureReadProof(index, taskKey), minimumVersion: task.version, receiptAwaitingIndex: true, ...(acquiredAt !== undefined ? { acquiredAt } : {}), uncertain: true }));
  // The receipt asks for its own view. Its History, pages, searches and time lines are read again when the patch of
  // this write raises their required versions, as for any other write.
  requestRead(query);
  void client.refetchQueries({ queryKey: taskKey, exact: true, type: 'active' }, { cancelRefetch: false });
}

// Session reception is tied to the index Query identity. Disk hydration never sets it.
const liveIndexes = new WeakMap<object, { root: string; generation: string; rev: number; receivedAt: number }>();
type ReadEvent = { kind: 'live'; scopeChanged: boolean } | { kind: 'clear' | 'remove' };
const listeners = new WeakMap<QueryClient, Set<(event: ReadEvent) => void>>();
export function onReadEvent(client: QueryClient, listener: (event: ReadEvent) => void) {
  const set = listeners.get(client) ?? new Set(); listeners.set(client, set); set.add(listener);
  return () => { set.delete(listener); };
}
const emitReadEvent = (client: QueryClient, event: ReadEvent) => listeners.get(client)?.forEach(listener => listener(event));
export function liveRead(client: QueryClient) {
  const query = readQuery(client, indexKey);
  return query && liveIndexes.get(query);
}
export function assessRead(client: QueryClient, query: Query) {
  readScope(client);
  const index = readIndex(client), entry = readEntry(query), base = evaluateRead(index, entry);
  // A page answered before this screen's write cannot certify that Task's older row (the version floor).
  if (index && base.project && holdsRowPages(entry.key)) {
    const floor = writtenFloors(client, index.root);
    if (floor.size && rowsOfPages(entry.data).some(row => row.version < (floor.get(row.id) ?? 0)))
      return { ...base, state: 'unverified' as const, project: false, needsRead: true };
  }
  return base;
}
const writtenRows = new WeakMap<object, TaskRowDTO>();
/** Reader-only row; never enters serverReadFacts, counts, people or the current index. */
export function readerTaskRow(client: QueryClient, root: string, id: string) {
  const index = readIndex(client), query = readQuery(client, ['task', root, id]);
  if (query && readRefused(query)) return;
  const { view } = taskReadState(client, root, id);
  const row = index?.root === root ? serverReadFacts(client)?.tasks.find(row => row.id === id) : undefined;
  if (view && !isWrittenRead(view)) {
    // The view's own fields over the list's numbers: what descendants decide is the list's alone.
    if (!row || view.task.version >= row.version) return viewRow(view, row);
    return row;
  }
  if (row) return view ? displayReadFacts(client)?.tasks.find(row => row.id === id) ?? row : row;
  if (!view) return;
  const previous = writtenRows.get(view);
  if (previous) return previous;
  const task = view.task, earlier = view.earlier;
  const displayed = displayReadFacts(client);
  const known = earlier ? viewRow(earlier, displayed?.tasks.find(row => row.id === id)) : displayed?.tasks.find(row => row.id === id);
  const projectId = task.kind === 'project' ? task.id : known?.projectId ?? displayed?.tasks.find(row => row.id === task.parentId)?.projectId;
  if (!projectId) return;
  // Preserve known server location/order. A new document's header alone invents no list membership.
  // A receipt carries no History: until the read lands, the row derives nothing from one.
  const fields = taskRowFields({ ...task, log: [] });
  const written: TaskRowDTO = known ? { ...known, title: task.title, lifecycle: task.lifecycle, version: task.version, hash: task.hash }
    : { ...fields, ...unlistedAggregates, projectId, ball: null, notice: { ...fields.notice, turnKey: null },
      question: '', startOrder: null, usage: null };
  writtenRows.set(view, written); return written;
}
/** Query-backed UI adapter: no private loader or retry queue. A missing Query is created by its resource hook. */
export function readState<T = unknown>(client: QueryClient, key: QueryKey) {
  const query = readQuery(client, key);
  const assessment = query ? assessRead(client, query) : evaluateRead(readIndex(client), { key, data: undefined });
  const status: 'ready' | 'error' | 'loading' | 'idle' = assessment.display ? 'ready' : assessment.state !== 'missing' || query?.state.status === 'error' ? 'error'
    : query?.state.fetchStatus === 'fetching' ? 'loading' : 'idle';
  return { assessment, data: assessment.display ? query?.state.data as T | undefined : undefined, status,
    error: query?.state.error ?? null, retry: query ? () => recoverReads(client, [key]) : undefined };
}
/** Transport reception uses the existing Query and read-session identities, never a new durable identity. */
export function captureResourceRead(client: QueryClient, key: QueryKey) {
  const query = readQuery(client, key);
  return { key, query, index: readIndex(client), boundary: captureReadBoundary(client), serial: query ? readSerial(query) : 0, operation: query ? readStartedProof(query) : undefined };
}
/** One scope/Query/refusal gate for GET commits and receipt display. Domain acceptance stays with its caller. */
export function admitResourceRead(client: QueryClient, started: ReturnType<typeof captureResourceRead>): boolean {
  const { query, index, boundary, key, serial } = started, now = readIndex(client);
  if (query !== readQuery(client, key) || index && (!now || index.root !== now.root || index.generation !== now.generation)
    || boundary && !sameReadSession(client, boundary) || !admitsRead(client, key, boundary)
    || query && readRefused(query) && readSerial(query) !== serial) {
    // A late transport can outlive its execution. Retire only the pending proof it started with;
    // a newer explicit read on the same Query owns its own cancellation and completion.
    cancelCapturedResourceRead(client, started);
    return false;
  }
  return true;
}
/** A lane selection belongs to the server's current rows. An index can retire it before React replaces the
 * observer's key; refreshing that old selection would ask the server for IDs it has already removed. */
function readTimeline<T>(client: QueryClient, key: QueryKey, scope: string | null, lanes: readonly string[], fetch: () => Promise<T>) {
  const facts = serverReadFacts(client);
  if (facts && facts.root === key[1]) {
    const rows = new Set(facts.tasks.map(row => row.id));
    if (scope !== null && !rows.has(scope) || lanes.some(id => !rows.has(id))) return discardResourceRead(readQuery(client, key));
  }
  return readResource(client, key, fetch);
}
/**
 * What the AI the conversation's next message goes to can use now, read fresh: for the shared Query, and on its own for
 * a send, which outlives who is looking. The server answers for its own next AI (`profile`), which a send compares
 * with the one its chips were checked for.
 */
export function readSkillCatalog(conversation: string, signal?: AbortSignal) {
  return api.request(`coordinator/skills?conversationId=${encodeURIComponent(conversation)}`, skillCatalogSchema, signal);
}
/** Reject responses from a former scope/query and GETs overtaken by a local write. */
async function readResource<T>(client: QueryClient, key: QueryKey, fetch: () => Promise<T>): Promise<T> {
  const initial = readQuery(client, key);
  // An offline read freezes this Query's actual state, including an earlier refusal or an unacquired region.
  // Cancellation reverts through Query's own snapshot; it publishes no success and queues no transport.
  if (useConnection.getState().offline) return discardResourceRead(initial);
  if (initial) beginResourceGet(client, initial);
  const started = captureResourceRead(client, key), { query, index, serial } = started;
  const heldRevision = query?.state.data && typeof query.state.data === 'object' && 'revision' in query.state.data ? query.state.data.revision : undefined;
  const expectedMarker = index ? readMarker(index, key) : undefined;
  const postAhead = heldRevision !== undefined && heldRevision !== expectedMarker && getReadProof(query!)?.precedingMarker !== undefined && getReadProof(query!)?.precedingMarker === expectedMarker;
  const ticket = query && readGetTicket(query);
  let value: T;
  try { value = await fetch(); } catch (cause) {
    const shelving = shelvedReadDetail(cause);
    const error = cause instanceof ApiError && cause.reason?.kind === 'task_archived'
      && (!shelving || key[0] === 'task' && shelving.task.id !== key[2])
      ? new ApiError('Invalid shelving facts', 'invalid_response', 'later') : cause;
    recordReadError(ticket, error); throw error;
  }
  if (value && typeof value === 'object' && 'task' in value && key[0] === 'task' && (value.task as { id: string }).id !== key[2])
    throw new ApiError('Task read answered a different identity', 'invalid_response', 'later');
  if (query) recordReadAcquired(query, Date.now());
  if (!admitResourceRead(client, started)) throw new CancelledError({ revert: true });
  if (query?.state.data && value && typeof value === 'object' && 'task' in value) {
    const held = query.state.data as TaskRead, incoming = value as unknown as TaskProjectedViewDTO;
    if (held.task?.id === incoming.task.id && held.task.version > incoming.task.version) return discardCapturedResourceRead(client, started);
  }
  if (query && key[0] === 'task' && (value as unknown as TaskProjectedViewDTO).task.version < minimumTaskVersion(query))
    return discardCapturedResourceRead(client, started);
  if (postAhead && value && typeof value === 'object' && 'revision' in value && value.revision === expectedMarker)
    return discardCapturedResourceRead(client, started);
  if (query && key[0] !== 'task-history' && readSerial(query) !== serial && query.state.data !== undefined)
    return discardCapturedResourceRead(client, started);
  if (query) recordReadResult(query, value, ticket);
  // Checked by its schema as it arrived: drawing it does not check it again.
  recordCheckedRead(key, value);
  return value;
}
/** A superseded reception can cancel only the execution it captured, never a replacement flight. */
export function cancelCapturedResourceRead(client: QueryClient, started: ReturnType<typeof captureResourceRead>) {
  const query = started.query;
  if (query && readQuery(client, started.key) === query && readStartedProof(query) === started.operation) cancelResourceRead(query);
}
/** A discarded page cancels the whole fetch. Only Query owns its aggregate and reversion snapshot;
 * returning Query.data from a page queryFn would insert InfiniteData as a single page. Manual writes update
 * Query's reversion snapshot too, so cancellation retains a receipt accepted during the flight. */
export function cancelResourceRead(query: Query | undefined) {
  if (query) { preserveReadProof(query); void query.cancel({ revert: true }); }
}
function discardResourceRead(query: Query | undefined): never {
  cancelResourceRead(query);
  throw new CancelledError({ revert: true });
}
function discardCapturedResourceRead(client: QueryClient, started: ReturnType<typeof captureResourceRead>): never {
  cancelCapturedResourceRead(client, started);
  throw new CancelledError({ revert: true });
}
/** Direct callers must validate the result of the flight they actually awaited, including reverted cancellations. */
export async function fetchAcceptedResource<T, K extends QueryKey>(client: QueryClient, options: import('@tanstack/react-query').FetchQueryOptions<T, Error, T, K>): Promise<T> {
  const reading = client.fetchQuery(options), query = readQuery(client, options.queryKey)!;
  const ticket = readGetTicket(query);
  const raw = await reading;
  if (ticket ? !acceptedGet(ticket, raw) : query !== readQuery(client, options.queryKey) || raw !== query.state.data
    || readAcquisition(query)?.source !== 'get' || !verifiedReadAcquisition(client, query))
    throw new CancelledError({ revert: true });
  return raw;
}
/**
 * The one order of a manual receipt, against a GET in flight: its transport is cancelled first, so it cannot write over
 * the value; then the value, its acquisition, and last the proof, whose publication sees all of them.
 */
function publishReadReceipt(client: QueryClient, key: QueryKey, value: object, proofOf: (query: Query) => import('./read-model').ReadProof) {
  const query = client.getQueryCache().build(client, { queryKey: key });
  beginReadReceipt(query);
  client.setQueryData(key, value);
  deriveReadAcquisition(query);
  recordReadProof(query, proofOf(query));
}
/** A full coordinator receipt replaces only this session's current Query. */
export function acceptCoordinatorSnapshot(client: QueryClient, value: CoordinatorSnapshot, started: import('./read-model').ReadProof) {
  const index = readIndex(client);
  if (!index || value.root !== index.root || value.generation !== index.generation || started.root !== index.root || started.generation !== index.generation) return;
  publishReadReceipt(client, ['coordinator', index.root], value, query => ({ ...started, acquiredAt: getReadProof(query)?.acquiredAt ?? started.acquiredAt, marker: value.revision,
    precedingMarker: started.precedingMarker, receiptAwaitingIndex: value.conversation.id !== index.person.coordinator?.id }));
}
/** Manual POST responses carry their own opaque revision. A late GET cannot roll them back. */
export function acceptPersonalRead<T extends { revision: string | null }>(client: QueryClient, key: QueryKey, value: T,
  started: ReturnType<typeof captureResourceRead>): boolean {
  if (!started.query || started.query !== readQuery(client, key) || readSerial(started.query) !== started.serial
    || !started.index || !admitResourceRead(client, started)) return false;
  // Admission above has just held the index this read started under.
  const index = readIndex(client)!;
  publishReadReceipt(client, key, value, query => ({ ...captureReadProof(index, key), marker: value.revision, precedingMarker: readMarker(index, key), acquiredAt: getReadProof(query)?.acquiredAt ?? Date.now() }));
  return true;
}
/** A deliberate reconciliation after a refused/uncertain write certifies this actual GET, if no newer feed overtook it. */
export function confirmPersonalRead<T extends { revision: string | null }>(client: QueryClient, key: QueryKey, value: T) {
  const query = readQuery(client, key), index = readIndex(client);
  const proof = query && getReadProof(query);
  if (query && index && proof?.rev === index.rev && (query.state.data as T | undefined)?.revision === value.revision)
    recordReadProof(query, { ...proof, marker: value.revision, precedingMarker: readMarker(index, key) });
}
export function sameReadScope(client: QueryClient, source: Pick<ProjectedIndexDTO, 'root' | 'generation'>) {
  const index = readIndex(client);
  return !!index && index.root === source.root && index.generation === source.generation;
}
/** The sole application point for live source/scope evidence; adapters describe their event, not freshness. */
export function applyReadEvidence(client: QueryClient, evidence: ProjectedIndexDTO | { kind: 'written'; task: ControlTaskHeadDTO; source?: ProjectedIndexDTO }
  | { kind: 'refused'; query: Query }, fromDelta = false) {
  if ('kind' in evidence) {
    if (evidence.kind !== 'refused' && evidence.source && !sameReadScope(client, evidence.source))
      throw new ApiError('Read scope changed while awaiting the write receipt', 'scope_changed', 'check');
    if (evidence.kind === 'written') applyWrittenTask(client, evidence.task);
    else applyReadRefusal(client, evidence.query);
    return;
  }
  let index = evidence;
  observeReadProofs(client);
  observeReadRefusals(client);
  observeLaterReadDemand(client);
  observeHistoryClosing(client);
  const before = readIndex(client);
  const live = liveRead(client);
  if (live && live.root === index.root && live.generation === index.generation && live.rev > index.rev) return;
  const scopeChanged = !!before && (before.root !== index.root || before.generation !== index.generation);
  if (scopeChanged) {
    emitReadEvent(client, { kind: 'clear' });
    for (const query of client.getQueryCache().getAll()) if (query.queryKey[0] !== 'index') client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
  // Query may structurally share this publication. Scope evidence belongs to the stored
  // object, which receiveReadScope registers, rather than the transport's original object.
  index = client.setQueryData<ProjectedIndexDTO>(indexKey, index)!;
  const query = readQuery(client, indexKey)!;
  if (fromDelta) recordReadStructure(indexKey, query.state.data as object);
  receiveReadScope(client);
  const proof = captureReadProof(index, indexKey);
  recordIndexProof(client, index);
  liveIndexes.set(query, { root: index.root, generation: index.generation, rev: index.rev, receivedAt: proof.acquiredAt });
  const connection = useConnection.getState();
  if (!connection.fresh || connection.writable !== index.writable) useConnection.setState({ fresh: true, writable: index.writable });
  for (const read of client.getQueryCache().getAll()) {
    if (!readCodecManaged(read.queryKey)) continue;
    if (before && before.projectShelfVersion !== index.projectShelfVersion && readRefused(read)
      && shelvedReadDetail(read.state.error)) {
      void recoverReads(client, [read.queryKey]);
      continue;
    }
    const previousMarker = before && readMarker(before, read.queryKey);
    const marker = readMarker(index, read.queryKey);
    if ((!before || previousMarker !== marker) && assessRead(client, read).needsRead) {
      // An in-flight read begun with this marker already serves this evidence.
      if (read.state.fetchStatus === 'idle' || readStartedProof(read)?.startedMarker !== marker) requestRead(read);
      if (read.isActive()) void client.refetchQueries({ queryKey: read.queryKey, exact: true, type: 'active' }, { cancelRefetch: false });
    }
  }
  emitReadEvent(client, { kind: 'live', scopeChanged });
}
export function discardReadResources(client: QueryClient) {
  useConnection.setState({ fresh: false, writable: false });
  emitReadEvent(client, { kind: 'clear' });
  client.clear();
}
/** Schema-checked shelving facts from the same task/view refusal. */
export function shelvedReadDetail(error: unknown) {
  if (!(error instanceof ApiError) || error.reason?.kind !== 'task_archived') return;
  const parsed = taskShelvedDetailSchema.safeParse(error.detail);
  return parsed.success ? parsed.data : undefined;
}
/**
 * Known local refusal revokes only its read unit. A History page error does not delete a known view.
 * The subscription, like proof/retention observation, belongs to the QueryClient lifetime.
 */
const refusalObservers = new WeakSet<QueryClient>();
export function observeReadRefusals(client: QueryClient): void {
  if (refusalObservers.has(client)) return;
  refusalObservers.add(client);
  client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'error') return;
    receiveReadFailure(client, event.query, event.action.error);
  });
}
/** Full and cursor reads share HTTP refusal semantics. A missing History range does not revoke its Task. */
function receiveReadFailure(client: QueryClient, query: Query, failure: unknown): boolean {
    if (!failedGetAccepted(query, failure)) return false;
    const error = failure as { code?: string; detail?: { status?: number } };
    if (!['forbidden', 'not_found', 'task_not_found'].includes(error.code ?? '') && ![403, 404].includes(error.detail?.status ?? 0)) return false;
    if (client.getQueryCache().get(query.queryHash) !== query) return false;
    const started = readStartedProof(query), index = readIndex(client);
    if (started && index && (started.root !== index.root || started.generation !== index.generation)) return false;
    if (started && index && query.queryKey[0] === 'task' && started.shelfVersion !== index.projectShelfVersion) {
      queueMicrotask(() => { void recoverReads(client, [query.queryKey]); });
      return false;
    }
    if (query.queryKey[0] === 'index') { discardReadResources(client); return true; }
    // A missing History range does not revoke already acquired records or the Task's identity.
    // The failed range stays an error on this same Query; a Task view refusal owns withdrawal of its details.
    if (missingHistoryRange(query.queryKey, error)) return false;
    if ((failure as ApiError).reason?.kind === 'task_archived' && !shelvedReadDetail(failure)) return false;
    applyReadEvidence(client, { kind: 'refused', query });
    return true;
}
function applyReadRefusal(client: QueryClient, query: Query) {
  if (readRefused(query)) return;
  const reads = client.getQueryCache().findAll({ predicate: candidate => readRefusalCovers(query.queryKey, candidate.queryKey) });
  const failure = query.state.error;
  for (const read of reads) refuseRead(read, readIndex(client), failure);
  for (const read of reads) { void read.cancel({ revert: true }); read.setState({ data: undefined, error: failure, status: 'error', fetchStatus: 'idle' }); }
  emitReadEvent(client, { kind: 'remove' });
}
/** One reconnect demand joins standard Queries; it does not cancel an in-flight full/page read. */
export async function recoverReads(client: QueryClient, keys?: readonly QueryKey[]) {
  await ensureReadAnchor(client);
  // The screen's reads made while the scope is still cut (a patch overtook the index) would be discarded: the caller
  // reads again. Named reads (settings, notices) are kept whatever the scope, so they go on.
  if (!keys && readScope(client)?.anchored === false) return;
  const reads: Promise<unknown>[] = [];
  for (const query of client.getQueryCache().getAll()) {
    const kind = String(query.queryKey[0]);
    if (kind === 'index' || (keys ? !keys.some(key => JSON.stringify(key) === JSON.stringify(query.queryKey)) : !query.isActive())) continue;
    // Only index-qualified resources can complete a proof/demand recovery. Files
    // and other ordinary Queries retain Query's own freshness and fetch lifecycle.
    const qualified = !!readCodec(query.queryKey);
    const index = readIndex(client);
    if (qualified && kind !== 'task-history' && query.state.status !== 'error' && query.state.fetchStatus !== 'idle' && index && hasCurrentReadGet(query) && readStartedProof(query)?.startedMarker === readMarker(index, query.queryKey) && !readHasLaterDemand(query)) continue;
    const needsRead = qualified ? assessRead(client, query).needsRead || pendingReadPage(query) : query.isStale();
    if (query.state.status === 'error' || query.state.isInvalidated || needsRead) {
      if (qualified) requestReadRecovery(query);
      reads.push(query.fetch(undefined, { cancelRefetch: false,
        ...(query.state.fetchMeta?.fetchMore && query.state.status === 'error' ? { meta: query.state.fetchMeta } : {}) }));
    }
  }
  await Promise.allSettled(reads);
}

/** Explicit recovery joins the standard complete GET before starting necessary Task reads. */
export async function ensureReadAnchor(client: QueryClient) {
  if (readScope(client)?.anchored === false) await client.fetchQuery({ ...resources.index(), staleTime: 0 });
}

/** Automatic demand is qualified at execution too: refusal or a scope cut can follow its notification. */
function admitsReadDemand(client: QueryClient, key: QueryKey, query: Query | undefined) {
  return (!query || !readRefused(query) || readRecoveryPending(query)) && admitsRead(client, key, captureReadBoundary(client));
}
/** A feature reports lost work; the existing demand observer decides whether and when to fetch. */
export function requestLaterReadDemand(client: QueryClient, key: QueryKey, connect: () => void,
  lost: ReturnType<typeof captureResourceRead> | undefined) {
  observeLaterReadDemand(client);
  // Reconnect a consumer retired with its former scope. The consumer supplies reception, never fetch policy.
  const held = readQuery(client, key);
  if (!admitsReadDemand(client, key, held)) return;
  if (!held || !held.isActive()) connect();
  const query = readQuery(client, key);
  // A current replacement GET already covers the obsolete flight's lost work. Only
  // that obsolete execution itself needs a successor stamp beyond its cancellation.
  const obsolete = query && lost && query === lost.query && readStartedProof(query) === lost.operation;
  if (query && (obsolete || query.state.fetchStatus === 'idle' && assessRead(client, query).needsRead)) requestRead(query);
}
/** A History whose last reader left goes back to its newest events (history-resource). */
const closingObservers = new WeakSet<QueryClient>();
function observeHistoryClosing(client: QueryClient) {
  if (closingObservers.has(client)) return;
  closingObservers.add(client);
  client.getQueryCache().subscribe(event => {
    if (event.type === 'observerRemoved' && event.query.queryKey[0] === 'task-history') queueMicrotask(() => trimClosedHistory(event.query));
  });
}
const demandObservers = new WeakSet<QueryClient>();
function observeLaterReadDemand(client: QueryClient) {
  if (demandObservers.has(client)) return;
  demandObservers.add(client);
  client.getQueryCache().subscribe(event => {
    const query = event.query;
    const success = event.type === 'updated' && event.action.type === 'success' && !event.action.manual;
    const laterRecovery = event.type === 'updated' && event.action.type === 'error' && (readRecoveryPending(query) || readDemandReady(query));
    const demanded = event.type === 'updated' && ['invalidate', 'setState'].includes(event.action.type);
    const cancelled = event.type === 'updated' && event.action.type === 'setState' && event.action.state.fetchStatus === 'idle';
    if (!success && !laterRecovery && !cancelled && !demanded && event.type !== 'observerAdded' && event.type !== 'observerOptionsUpdated') return;
    queueMicrotask(() => queueMicrotask(() => {
      if (client.getQueryCache().get(query.queryHash) !== query || query.state.fetchStatus !== 'idle' || !query.isActive()
        || !admitsReadDemand(client, query.queryKey, query)) return;
      if (pendingReadPage(query) && query.queryKey[0] !== 'task-history' && !query.state.isInvalidated && assessRead(client, query).project) {
        void query.fetch(undefined, { cancelRefetch: false, meta: { fetchMore: { direction: 'forward' } } }).catch(() => {}); return;
      }
      if (readDemandReady(query) || readRecoveryPending(query)) void query.fetch(undefined, { cancelRefetch: false }).catch(() => {});
    }));
  });
}
function readCodecManaged(key: QueryKey) { return ['coordinator', 'task', 'task-history', 'person-settings', 'person-notices', 'task-finished', 'task-shelved', 'project-shelf', 'task-search', 'task-timeline'].includes(String(key[0])); }

/** Root/generation session pins required person reads through real observers, before live recovery. */
export function startRequiredReadSession(client: QueryClient): () => void {
  let scope = '', indexIdentity: Query | undefined, binding = false;
  let observers: QueryObserver[] = [], stops: (() => void)[] = [];
  const detach = () => { stops.forEach(stop => stop()); observers.forEach(observer => observer.destroy()); stops = []; observers = []; };
  const bind = () => {
    if (binding) return;
    const index = readIndex(client), query = readQuery(client, indexKey);
    const next = index ? JSON.stringify([index.root, index.generation]) : '';
    if (scope === next && indexIdentity === query) return;
    binding = true;
    try {
      detach(); scope = next; indexIdentity = query;
      if (index) for (const key of requiredReadKeys(index)) {
        const options = key[0] === 'person-settings' ? resources.personalSettings(index.root) : key[0] === 'person-notices' ? resources.notices(index.root) : undefined;
        if (!options) continue;
        const observer = new QueryObserver(client, options as import('@tanstack/react-query').QueryObserverOptions);
        observers.push(observer); stops.push(observer.subscribe(() => {}));
      }
    } finally { binding = false; }
  };
  const stop = client.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] === 'index' && (event.type === 'removed' || event.type === 'updated' && event.action.type === 'success')) bind();
  });
  bind();
  return () => { stop(); detach(); };
}
