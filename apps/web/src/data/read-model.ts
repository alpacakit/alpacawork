import { freezeReadJson, readPayloadMatches, isReadDataImmutable } from './read-json';
export { isReadDataImmutable } from './read-json';
import { requestRead, readDemandPending, readFreshnessPending, readRecoveryPending, planRead, completeReadDemand, failReadDemand, retireReadDemand, noteReadInvalidation, type ReadExecution } from './read-demand';
import { coordinatorSnapshotSchema, type CoordinatorSnapshot } from '@alpacawork/contract/coordinator';
import { z } from 'zod';
import { startReadRetention } from './read-retention';
import { hashKey, notifyManager, replaceEqualDeep, type Query as QueryRecord, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { projectShelfSchema, type ProjectShelfDTO, controlTaskHeadSchema, projectedIndexSchema, taskHistorySchema, taskProjectedPageSchema, taskProjectedViewSchema, taskTimelineLaneSchema, taskProjectedTimelineAxisSchema, taskProjectedSearchSchema, closedPageScope,
  type TaskPageRowDTO, type TaskRowDTO, type ProjectedIndexDTO, type TaskProjectedViewDTO, type ControlTaskHeadDTO, type ProjectionResourceKind, type TaskViewPlacementDTO, type TaskViewRunDTO, type PlacementDTO, type ControlRunDTO } from '@alpacawork/contract/control';
import { noticeStateResponseSchema, personalSettingsResponseSchema } from '@alpacawork/contract';
import { analysisBreakdownViewSchema, analysisTasksViewSchema, analysisUnitListSchema, analysisUnitValuesSchema,
  analysisUsageSeriesViewSchema, analysisUsageViewSchema, analysisTraceViewSchema, analysisFindingsViewSchema, analysisAtViewSchema,
  analysisChangesViewSchema } from '@alpacawork/contract/analysis';
import type { QueryCacheNotifyEvent } from '@tanstack/react-query';

type Query = QueryRecord<any, any, any, any>;

/** Managed reads use the standard hash (also required by the checkpoint format), backed solely by QueryCache's own map. */
export function readQuery(client: QueryClient, key: QueryKey): Query | undefined {
  return client.getQueryCache().get(hashKey(key));
}
/** Render subscriptions see the cache once per standard notification batch, after the publishing task completed. */
export function subscribeReads(client: QueryClient, changed: () => void) {
  let pending = false, live = true;
  const stop = client.getQueryCache().subscribe(event => {
    if (!changesReads(event) || pending) return;
    pending = true;
    notifyManager.schedule(() => { pending = false; if (live) changed(); });
  });
  return () => { live = false; stop(); };
}
const readEvents = new WeakMap<object, boolean>(), activeReads = new WeakMap<Query, boolean>();
/**
 * A render's new option functions change no read: each key drew the input, and that alone re-evaluated every read on the
 * screen. Enabling or disabling an observer does change what its Query reports. Asked once per event, by whoever
 * hears it first.
 */
function changesReads(event: QueryCacheNotifyEvent) {
  let known = readEvents.get(event);
  if (known === undefined) {
    const active = event.query.isActive(), was = activeReads.get(event.query);
    activeReads.set(event.query, active);
    known = event.type !== 'observerOptionsUpdated' || was !== active;
    readEvents.set(event, known);
  }
  return known;
}
const indexReadKey = ['index'] as const;
export const readIndex = (client: QueryClient) => readQuery(client, indexReadKey)?.state.data as ProjectedIndexDTO | undefined;

export const READ_DAY = 86_400_000;
export const READ_TASK_AGE = 7 * READ_DAY;
export const READ_BUNDLE_AGE = 14 * READ_DAY;
export const READ_MAX_BYTES = 8 * 1024 * 1024;
export const READ_MAX_TASKS = 100;
const taskKinds = ['task', 'task-history'];
const bundleKinds = ['coordinator', 'person-settings', 'person-notices', 'task-finished', 'task-shelved', 'task-search', 'task-timeline', 'project-shelf', 'analysis-view'];
export function readLifetime(key: QueryKey) {
  if (key[0] === 'task-search') return 60_000;
  return taskKinds.includes(String(key[0])) ? READ_TASK_AGE : bundleKinds.includes(String(key[0])) ? READ_BUNDLE_AGE : undefined;
}
const retentionConfigured = new WeakSet<QueryClient>();
export function configureReadRetention(client: QueryClient) {
  if (retentionConfigured.has(client)) return;
  retentionConfigured.add(client);
  client.setQueryDefaults(['index'], { gcTime: Infinity });
  for (const kind of [...taskKinds, ...bundleKinds]) client.setQueryDefaults([kind], { gcTime: Infinity });
  startReadRetention(client);
}
const pageCodecs = new WeakMap<z.ZodType, { envelope: z.ZodType; page: z.ZodType }>();
const pageProofs = new WeakMap<z.ZodType, WeakSet<object>>(), pageSchemas = new Set<z.ZodType>();
const pageEnvelope = (schema: z.ZodType) => z.object({ pages: z.array(schema).min(1), pageParams: z.array(z.string().nullable()).min(1) })
  .strict().refine(value => value.pages.length === value.pageParams.length && value.pageParams[0] === null
    && new Set(value.pageParams).size === value.pageParams.length);
/** Only these unrefined, key-independent codecs can prove their envelope and pages separately. */
function pages(schema: z.ZodType) {
  const codec = pageEnvelope(schema);
  pageCodecs.set(codec, { envelope: pageEnvelope(z.unknown()), page: schema });
  pageSchemas.add(schema);
  return codec;
}
// The view's own row is part of this very view, never a second version of the Task's identity or body facts.
export const readViewSchema = taskProjectedViewSchema.refine(view =>
  (['id', 'parentId', 'path', 'kind', 'lifecycle', 'title', 'state', 'version', 'hash'] as const)
    .every(field => view.row[field] === view.task[field]));
/** A receipt owns only the document's head. Its History and extras remain the same Task's previously acquired view until the read lands. */
const writtenReadSchema = z.object({ kind: z.literal('written'), task: controlTaskHeadSchema, earlier: readViewSchema.optional() }).strict()
  .refine(value => !value.earlier || value.earlier.task.id === value.task.id && value.earlier.task.version <= value.task.version);
type WrittenRead = z.infer<typeof writtenReadSchema>;
export type TaskRead = TaskProjectedViewDTO | WrittenRead;
export const isWrittenRead = (value: TaskRead): value is WrittenRead => 'kind' in value && value.kind === 'written';
const taskReadSchema = z.union([readViewSchema, writtenReadSchema]);
/** A History window is one continuous page (history-window.ts): never a list of pages to join. */
const historyPages = pages(taskHistorySchema).refine(value => value.pages.length === 1
  && (value.pages as z.infer<typeof taskHistorySchema>[]).every(page => page.events.every(event => event.taskId.length > 0)));
const taskPages = pages(taskProjectedPageSchema), searchPages = pages(taskProjectedSearchSchema);
/** The analysis's reads kept as the list's are, by the command each reads. */
const analysisViews = { tasks: analysisTasksViewSchema, usage: analysisUsageViewSchema, breakdown: analysisBreakdownViewSchema,
  'usage-series': analysisUsageSeriesViewSchema, list: pages(analysisUnitListSchema), task: analysisUnitValuesSchema,
  trace: analysisTraceViewSchema, findings: analysisFindingsViewSchema, at: analysisAtViewSchema, changes: analysisChangesViewSchema };
export function readCodec(key: QueryKey): z.ZodType | undefined {
  const [kind, root, id, scope] = key;
  if (kind === 'index' && key.length === 1) return projectedIndexSchema;
  if (typeof root !== 'string' || !root) return;
  if (['person-settings', 'person-notices'].includes(String(kind)) && key.length === 2)
    return kind === 'person-settings' ? personalSettingsResponseSchema : noticeStateResponseSchema;
  if (kind === 'project-shelf' && key.length === 2) return projectShelfSchema;
  // The analysis as its face draws it: what its tasks and the AI's use count for one choice of days and steps.
  if (kind === 'analysis-view' && key.length === 4 && typeof id === 'string' && Object.hasOwn(analysisViews, id)) return analysisViews[id as keyof typeof analysisViews];
  if (kind === 'coordinator' && key.length === 2) return coordinatorSnapshotSchema.refine(value => value.root === root);
  if (kind === 'task' && key.length === 3 && typeof id === 'string') return taskReadSchema.refine(view => view.task.id === id);
  if (kind === 'task-history' && key.length === 3 && typeof id === 'string') return historyPages;
  if (kind === 'task-finished' && key.length === 4 && typeof id === 'string' && (scope === null || typeof scope === 'string')) return taskPages;
  if (kind === 'task-search' && key.length === 4 && typeof id === 'string' && (scope === null || typeof scope === 'string')) return searchPages;
  if (kind === 'task-timeline' && key.length === 4 && id === 'axis' && typeof scope === 'string') return taskProjectedTimelineAxisSchema;
  if (kind === 'task-timeline' && key.length === 6 && id === 'lane' && key.slice(3).every(value => typeof value === 'string'))
    return taskTimelineLaneSchema.refine(lane => lane.lane === scope);
  if (kind === 'task-shelved' && key.length === 3 && (id === null || typeof id === 'string')) return taskPages;
}
/** Data identity only. Current raw metadata, qualification and acquisition are always evaluated separately. */
export function reuseReadPayload(key: QueryKey, text: string, bases: Iterable<{ key: QueryKey; data: unknown }>): unknown {
  for (const basis of bases) {
    if (key.length !== basis.key.length || !key.every((part, at) => (part === null || typeof part === 'string' || typeof part === 'boolean'
      || typeof part === 'number' && Number.isFinite(part)) && Object.is(part, basis.key[at]))) continue;
    if (readPayloadMatches(basis.data, text)) return basis.data;
  }
}
type NormalizedRead = { data: unknown };
type ReadStructure = { key: QueryKey; pending?: NormalizedRead; pendingParser?: z.ZodType['safeParse'];
  checkpoint?: { parse: z.ZodType['safeParse']; data: ProjectedIndexDTO } };
type ReadShape = { keys: ReadStructure[]; queries: WeakMap<Query, QueryKey> };
const shapes = new WeakMap<object, ReadShape>();
/** The sole codec parse Owner. A successful falsy output is still data. */
function parseReadData(key: QueryKey, data: unknown): NormalizedRead | undefined {
  const parsed = readCodec(key)?.safeParse(data);
  return parsed?.success ? { data: parsed.data } : undefined;
}
/** Structure only. Current authority, demand and freshness never enter this memo. */
function proveReadStructure(key: QueryKey, value: unknown, normalize = false): ReadStructure | undefined {
  // Compare primitive key parts, not their hash: structure depends on the full
  // semantic key, while both Query reads and checkpoint slots share JSON data.
  if (!key.every(part => part === null || ['string', 'number', 'boolean'].includes(typeof part))) return;
  const data = value !== null && typeof value === 'object' ? value : undefined;
  const previous = data && shapes.get(data);
  const known = previous?.keys.find(proof => proof.key.length === key.length && proof.key.every((part, i) => Object.is(part, key[i])));
  if (known) return known;
  if (!freezeReadJson(value)) return;
  const codec = readCodec(key), paged = codec && pageCodecs.get(codec);
  let normalized: NormalizedRead | undefined;
  if (paged && !normalize) {
    if (!paged.envelope.safeParse(value).success) return;
    for (const page of (value as { pages: unknown[] }).pages) {
      const known = !!page && typeof page === 'object' && pageProofs.get(paged.page)?.has(page);
      if (!known && !paged.page.safeParse(page).success) return;
      rememberPage(paged.page, page);
    }
  } else {
    normalized = parseReadData(key, value);
    if (!normalized) return;
    if (paged) for (const page of (value as { pages: unknown[] }).pages) rememberPage(paged.page, page);
  }
  const proof: ReadStructure = { key: Object.freeze([...key]), ...normalized && { pending: normalized, pendingParser: codec?.safeParse } };
  if (data) {
    const shape = previous ?? { keys: [], queries: new WeakMap<Query, QueryKey>() };
    shape.keys.push(proof);
    if (!previous) shapes.set(data, shape);
  }
  return proof;
}
/** A boolean proof only: never retain a parsed output that a normalization caller can mutate. */
function rememberPage(schema: z.ZodType, page: unknown) {
  if (!page || typeof page !== 'object' || !isReadDataImmutable(page)) return;
  let known = pageProofs.get(schema);
  if (!known) { known = new WeakSet(); pageProofs.set(schema, known); }
  known.add(page);
}
/** Transfer an unpublished parse output once; never retain an output after publication. */
export function readNormalized(key: QueryKey, data: unknown): NormalizedRead | undefined {
  const proof = proveReadStructure(key, data, true);
  if (!proof) return;
  const pending = proof.pending;
  delete proof.pending; delete proof.pendingParser;
  return pending ?? parseReadData(key, data);
}
/** Checkpoint selection reads normalized fields without publishing a mutable copy. The same structure owner
 * retains its frozen snapshot, sharing unchanged JSON with the input; mutable normalization still parses afresh. */
export function readCheckpointIndex(data: unknown): ProjectedIndexDTO | undefined {
  const proof = proveReadStructure(indexReadKey, data, true);
  if (!proof) return;
  const parse = projectedIndexSchema.safeParse;
  if (proof.checkpoint?.parse === parse) return proof.checkpoint.data;
  const normalized = proof.pendingParser === parse ? proof.pending ?? parseReadData(indexReadKey, data) : parseReadData(indexReadKey, data);
  delete proof.pending; delete proof.pendingParser;
  if (!normalized) return;
  const snapshot = replaceEqualDeep(data, normalized.data);
  if (!freezeReadJson(snapshot)) return;
  proof.checkpoint = { parse, data: snapshot as ProjectedIndexDTO };
  return proof.checkpoint.data;
}
/**
 * Data made here from parts already read through their codec (an index and a delta, feed.ts) has the structure the codec
 * would prove: reading all of it again for each update held a phone's main thread. Its parts are still frozen.
 */
export function recordReadStructure(key: QueryKey, data: object) {
  if (!freezeReadJson(data) || shapes.has(data)) return;
  shapes.set(data, { keys: [{ key: Object.freeze([...key]), pending: { data }, pendingParser: readCodec(key)?.safeParse }], queries: new WeakMap<Query, QueryKey>() });
}
/** The reads whose answer the transport checks with the very schema their codec holds (resources' requests). */
const checkedKinds = new Set(['task', 'task-history', 'task-finished', 'task-shelved', 'task-search', 'task-timeline']);
/**
 * A read whose answer was already checked with its schema on arrival (resources.readResource): its structure is recorded
 * then, and it is frozen once, so neither drawing it nor a page made of it is checked again. A page of a paged read is
 * remembered as one; anything else is recorded whole.
 */
export function recordCheckedRead(key: QueryKey, value: unknown) {
  if (!checkedKinds.has(String(key[0])) || !object(value) || !freezeReadJson(value)) return;
  const codec = readCodec(key), paged = codec && pageCodecs.get(codec);
  if (paged && !('pages' in value)) { rememberPage(paged.page, value); return; }
  if (!shapes.has(value)) shapes.set(value, { keys: [{ key: Object.freeze([...key]) }], queries: new WeakMap<Query, QueryKey>() });
}
function readShape(read: ReadEntry): boolean {
  const query = read.query;
  const actual = query && query.queryKey === read.key && query.state.data === read.data;
  const data = read.data !== null && typeof read.data === 'object' ? read.data : undefined;
  // A Query's frozen key is an identity index into this same structure proof.
  if (actual && data && shapes.get(data)?.queries.get(query) === read.key) return true;
  if (!proveReadStructure(read.key, read.data)) return false;
  if (actual && data) { Object.freeze(read.key); shapes.get(data)?.queries.set(query, read.key); }
  return true;
}

export const readProofSchema = z.object({ origin: z.string(), root: z.string(), generation: z.string(), rev: z.number().int().nonnegative(),
  acquiredAt: z.number().finite().nonnegative(), marker: z.string().nullable(), sourcePv: z.number().int().nonnegative(), demandPending: z.boolean().optional(), uncertain: z.boolean().optional(), precedingMarker: z.string().nullable().optional(), startedMarker: z.string().nullable().optional(), era: z.number().int().nonnegative().optional(), receiptAwaitingIndex: z.boolean().optional(), minimumVersion: z.number().int().nonnegative().optional(), shelfVersion: z.string().optional() }).strict();
export type ReadProof = z.infer<typeof readProofSchema>;
export type Acquisition = { source: 'get' | 'index-publication' | 'checkpoint' | 'derived'; id: string; issued: number;
  target: WeakRef<object>; canStartCheckpointSlot: boolean };
type GetTicket = { query: Query; client: QueryClient; issued: number; serial: number; boundary: ReturnType<typeof captureReadBoundary>;
  proof?: ReadProof; execution: ReadExecution; receivedAt?: number; accepted?: WeakRef<object>; settled: boolean; started?: boolean; failureAccepted?: boolean;
  cancelled?: { serial: number; errorRef: unknown } };
type ProofState = { minimumVersion?: number; proof?: ReadProof; target?: WeakRef<object>; acquisition?: Acquisition;
  usedAt: number; serial: number; refusal?: number; pending?: GetTicket; uncertain?: boolean; refused?: boolean; active?: boolean };
const proofs = new WeakMap<object, ProofState>();
const stateFor = (query: Query): ProofState => {
  let state = proofs.get(query);
  if (!state) { state = { usedAt: Date.now(), serial: 0 }; proofs.set(query, state); }
  return state;
};
const results = new WeakMap<object, GetTicket>();
const failedResults = new WeakMap<object, GetTicket>();
export function recordReadError(ticket: GetTicket | undefined, error: unknown) { if (ticket && object(error)) failedResults.set(error, ticket); }
const object = (value: unknown): value is object => !!value && typeof value === 'object';
export const readGetTicket = (query: Query) => stateFor(query).pending;
export function readAcquisition(query: Query) {
  const acquisition = stateFor(query).acquisition;
  return acquisition?.target.deref() === query.state.data ? acquisition : undefined;
}
export function recordCheckpointAcquisition(query: Query, id: string) {
  if (object(query.state.data)) stateFor(query).acquisition = { source: 'checkpoint', id, issued: 0, target: new WeakRef(query.state.data), canStartCheckpointSlot: false };
}
/** A receipt inherits the acquisition's checkpoint basis. Read evaluation decides whether its value can be stored. */
export function deriveReadAcquisition(query: Query) {
  const state = stateFor(query), previous = state.acquisition;
  if (!previous || !object(query.state.data)) return;
  state.acquisition = { ...previous, source: 'derived', target: new WeakRef(query.state.data) };
}
// Monotonic transport causality. Restore, receipts and live publication cannot invent a GET.
let issuedSequence = 0;
export const readIssuedSequence = () => issuedSequence;
export const readRefusalSequence = (query: Query) => stateFor(query).refusal ?? 0;
export function readAcceptedSequence(query: Query): number {
  const acquisition = readAcquisition(query);
  return acquisition?.source === 'get' ? acquisition.issued : 0;
}
/** One refusal unit, shared by reception and the checkpoint's finite qualification slots. */
export function readRefusalCovers(source: QueryKey, candidate: QueryKey): boolean {
  const id = readTaskId(source);
  return hashKey(source) === hashKey(candidate) || source[0] === 'task' && source[1] === candidate[1]
    && id !== undefined && id === readTaskId(candidate);
}
// Origin is constant for this realm; cross-origin navigation creates a new realm and module.
const realmOrigin = typeof location === 'undefined' ? '' : location.origin;
export const readOrigin = () => realmOrigin;
export function readTaskId(key: QueryKey): string | undefined {
  return (key[0] === 'task' || key[0] === 'task-history') && typeof key[2] === 'string' ? key[2] : undefined;
}
export function readGroup(key: QueryKey, hash: string) {
  const id = readTaskId(key); return id ? `task:${id}` : hash;
}
// An immutable index's row lookup is pure evidence, never a cached qualification or another row value.
const indexRows = new WeakMap<ProjectedIndexDTO, Map<string, TaskRowDTO>>();
function indexTask(index: ProjectedIndexDTO, id: string | undefined) {
  if (id === undefined) return;
  if (!isReadDataImmutable(index)) return index.tasks.find(row => row.id === id);
  let rows = indexRows.get(index);
  if (!rows) { rows = new Map(index.tasks.map(row => [row.id, row])); indexRows.set(index, rows); }
  return rows.get(id);
}
/**
 * The resources a read's freshness is measured on: their kind and keys in the index's `requiredPv`. A row's time strip
 * is its row's entry; the axis is made from its rows, so it has theirs. Reads outside the projection (index, person,
 * coordinator, shelf) have none.
 */
export function projectionResource(key: QueryKey): { kind: ProjectionResourceKind; ids: string[] } | undefined {
  const [kind, , id, scope] = key;
  if (kind === 'task' && typeof id === 'string') return { kind: 'view', ids: [id] };
  if (kind === 'task-history' && typeof id === 'string') return { kind: 'history', ids: [id] };
  if (kind === 'task-finished') return { kind: 'page', ids: [closedPageScope('finished', id === 'root' ? null : String(id), scope as string | null)] };
  if (kind === 'task-shelved') return { kind: 'page', ids: [closedPageScope('shelved', null, id as string | null)] };
  if (kind === 'task-search') return { kind: 'search', ids: [typeof scope === 'string' ? scope : 'root'] };
  // The axis's key holds its rows; a strip's, its row.
  if (kind === 'task-timeline') return { kind: 'timeline', ids: String(scope).split(',').filter(Boolean) };
}
/**
 * The version a read must come from to be current: the newest of its resources'. A resource the index does not name has
 * not changed this generation.
 */
export function requiredVersion(index: ProjectedIndexDTO, key: QueryKey): number | undefined {
  const resource = projectionResource(key);
  if (!resource) return;
  const versions = index.requiredPv[resource.kind] as Record<string, number>;
  return resource.ids.reduce((newest, id) => Math.max(newest, versions[id] ?? 0), 0);
}
/**
 * Dependency evidence, not another copy of data: what a read's freshness depends on, compared as it moves.
 * A projected resource's is its required version; no wall-clock freshness rule.
 */
export function readMarker(index: ProjectedIndexDTO, key: QueryKey): string | null {
  const kind = key[0];
  if (kind === 'index') return `${index.rev}`;
  if (kind === 'project-shelf') return index.projectShelfVersion;
  // What the analysis counts may move with any record of the workspace: it is the index's revision it was read at.
  if (kind === 'analysis-view') return `${index.rev}`;
  if (kind === 'coordinator') return index.person.coordinator?.revision ?? null;
  if (kind === 'person-settings') return index.person.settings;
  if (kind === 'person-notices') return index.person.notices;
  const required = requiredVersion(index, key);
  return required === undefined ? null : `${required}`;
}
type Scope = { root: string; generation: string; era: number; anchored: boolean; restored: boolean; session: object };
const scopes = new WeakMap<QueryClient, { query: Query; scope: Scope }>();
const indexScopes = new WeakMap<ProjectedIndexDTO, Scope>();
export function readScope(client: QueryClient): Scope | undefined {
  const query = readQuery(client, ['index']), index = readIndex(client);
  if (!query || !index) return;
  let held = scopes.get(client);
  if (!held || held.query !== query || held.scope.root !== index.root || held.scope.generation !== index.generation) {
    held = { query, scope: { root: index.root, generation: index.generation, era: 0, anchored: true, restored: false, session: {} } };
    scopes.set(client, held);
  }
  indexScopes.set(index, held.scope);
  return held.scope;
}
export function restoreReadScope(client: QueryClient, cut: boolean) {
  const scope = readScope(client); if (scope) scope.restored = true;
  if (cut) cutReadScope(client);
}
export function receiveReadScope(client: QueryClient) { const scope = readScope(client); if (scope) scope.restored = false; }
export const captureReadBoundary = (client: QueryClient) => { const scope = readScope(client); return scope && { ...scope }; };
export function sameReadSession(client: QueryClient, boundary: ReturnType<typeof captureReadBoundary>) {
  return !!boundary && readScope(client)?.session === boundary.session;
}
export function cutReadScope(client: QueryClient) {
  const scope = readScope(client);
  if (!scope || !scope.anchored) return;
  scope.era++; scope.anchored = false;
  readQuery(client, ['index'])?.setState({});
}
export function anchorReadScope(client: QueryClient, started: ReturnType<typeof captureReadBoundary>) {
  const scope = readScope(client);
  if (!scope || !started || scope.session !== started.session || scope.era !== started.era) return;
  scope.anchored = true;
  const query = readQuery(client, ['index'])!;
  recordReadProof(query, captureReadProof(readIndex(client)!, query.queryKey));
}
export function admitsRead(client: QueryClient, key: QueryKey, started: ReturnType<typeof captureReadBoundary>) {
  // History can never reintroduce a Task identity that its canonical view has withdrawn.
  const task = key[0] === 'task-history' ? readQuery(client, ['task', key[1], key[2]]) : undefined;
  if (task && readRefused(task)) return false;
  if (!taskBearing(key)) return true;
  const scope = readScope(client);
  if (!scope && !started) return true;
  return !!scope && !!started && scope.session === started.session && scope.era === started.era && scope.anchored && started.anchored;
}
const taskBearing = (key: QueryKey) => key[0] === 'index' || String(key[0]).startsWith('task') || key[0] === 'coordinator' || key[0] === 'project-shelf';
export function captureReadProof(index: ProjectedIndexDTO, key: QueryKey): ReadProof {
  // A response is made from the projection the server caught up to on its arrival, never older than this index's.
  return { origin: readOrigin(), root: index.root, generation: index.generation, rev: index.rev, sourcePv: index.sourcePv,
    acquiredAt: Date.now(), shelfVersion: index.projectShelfVersion, ...(key[0] === 'coordinator' ? { precedingMarker: index.person.coordinator?.id ?? null } : {}), era: indexScopes.get(index)?.era ?? 0, marker: readMarker(index, key), startedMarker: readMarker(index, key) };
}
export function recordReadProof(query: Query, proof: ReadProof, usedAt = Date.now()) {
  const state = stateFor(query);
  state.minimumVersion = Math.max(state.minimumVersion ?? 0, proof.minimumVersion ?? 0); state.proof = proof; state.usedAt = usedAt; state.uncertain = !!proof.uncertain; state.refused = false;
  const data = query.state.data;
  state.target = data && typeof data === 'object' ? new WeakRef(data) : undefined;
  query.setState({});
}
/** Index publication records transport evidence in the same proof Owner. It never certifies a written union as a GET. */
export function recordIndexProof(client: QueryClient, index: ProjectedIndexDTO) {
  const indexQuery = readQuery(client, ['index'])!;
  recordReadProof(indexQuery, captureReadProof(index, ['index']));
  if (object(indexQuery.state.data)) stateFor(indexQuery).acquisition = { source: 'index-publication', id: crypto.randomUUID(),
    issued: ++issuedSequence, target: new WeakRef(indexQuery.state.data), canStartCheckpointSlot: true };
  for (const query of client.getQueryCache().getAll()) {
    if (query.queryKey[0] !== 'task' || query.queryKey[1] !== index.root) continue;
    const state = stateFor(query), proof = state.proof, value = query.state.data as TaskRead | undefined;
    if (!proof?.receiptAwaitingIndex || proof.root !== index.root || proof.generation !== index.generation || !value || !isWrittenRead(value)) continue;
    const row = indexTask(index, value.task.id);
    if (!row || row.version !== value.task.version || row.hash !== value.task.hash) continue;
    // The list now publishes this write: the receipt is as new as the index that holds it.
    state.proof = { ...proof, receiptAwaitingIndex: false, sourcePv: Math.max(proof.sourcePv, index.sourcePv), marker: readMarker(index, query.queryKey) };
    query.setState({});
  }
}
export function getReadProof(query: Query): ReadProof | undefined {
  const state = stateFor(query);
  if (state.refused || !state.proof) return;
  return { ...state.proof, minimumVersion: state.minimumVersion, uncertain: state.uncertain || state.target?.deref() !== query.state.data,
    demandPending: readFreshnessPending(query) || state.proof.demandPending };
}
export const readRefused = (query: Query) => !!stateFor(query).refused;
export const readUsedAt = (query: Query) => stateFor(query).usedAt;
export const readStartedProof = (query: Query) => stateFor(query).pending?.proof ?? stateFor(query).proof;
export function recordReadAcquired(query: Query, at: number) {
  const state = stateFor(query);
  if (!state.pending) return;
  const append = !!query.state.fetchMeta?.fetchMore || state.pending.execution.plan.kind !== 'full';
  state.pending.receivedAt = Math.min(state.pending.receivedAt ?? Infinity, at, append ? state.proof?.acquiredAt ?? Infinity : Infinity);
}
export function preserveReadProof(query: Query) { failReadDemand(query, stateFor(query).pending?.execution); }
export const readSerial = (query: Query) => stateFor(query).serial;
export function beginReadReceipt(query: Query) {
  const state = stateFor(query), interrupted = !!state.pending && !state.pending.settled && readDemandPending(query);
  state.serial++;
  void query.cancel({ revert: true });
  // The receipt cancels a transport, but cannot pay its demand or make it a failed GET generation.
  if (interrupted) requestRead(query);
}
export function refuseRead(query: Query, index?: ProjectedIndexDTO, error: unknown = query.state.error) {
  const state = stateFor(query);
  if (index) state.proof = captureReadProof(index, query.queryKey);
  state.refused = true; state.refusal = ++issuedSequence; state.serial++;
  if (state.pending && !state.pending.settled) state.pending.cancelled = { serial: state.serial, errorRef: error };
}
/** The Query execution may wait for an anchor; capture the actual GET's basis at transport issue. */
export function beginResourceGet(client: QueryClient, query: Query) {
  const ticket = stateFor(query).pending;
  if (!ticket || ticket.started) return;
  ticket.started = true; ticket.issued = ++issuedSequence;
  ticket.boundary = captureReadBoundary(client);
  const index = readIndex(client); ticket.proof = index ? captureReadProof(index, query.queryKey) : undefined;
}
/** Index reception is a publication of an actual full GET, not a competing manual receipt. */
export function recordIndexGetResult(client: QueryClient, query: Query, ticket: GetTicket | undefined, raw: ProjectedIndexDTO): boolean {
  if (!ticket?.started || ticket.settled || stateFor(query).pending !== ticket || readQuery(client, ['index']) !== query) return false;
  ticket.serial = readSerial(query); ticket.boundary = captureReadBoundary(client);
  ticket.proof = captureReadProof(raw, ['index']); ticket.receivedAt = getReadProof(query)?.acquiredAt ?? Date.now();
  results.set(raw, ticket); return true;
}
/** Attach the raw HTTP result to this exact Query execution, never a copy of its payload. */
export function recordReadResult(query: Query, raw: unknown, ticket = stateFor(query).pending) {
  if (ticket && object(raw)) results.set(raw, ticket);
}
function resultTicket(raw: unknown): GetTicket | undefined {
  if (!object(raw)) return;
  const direct = results.get(raw);
  if (direct && !direct.settled) return direct;
  const pages = (raw as { pages?: unknown[] }).pages;
  return Array.isArray(pages) ? pages.map(page => object(page) ? results.get(page) : undefined).find(t => t && !t.settled) : undefined;
}
/** Execution identity and scope survive settlement; settling only closes the reducer window. */
function sameGetContext(ticket: GetTicket) {
  const { query, client, boundary } = ticket;
  return readQuery(client, query.queryKey) === query && stateFor(query).serial === ticket.serial
    && admitsRead(client, query.queryKey, boundary) && (!ticket.proof || (() => { const index = readIndex(client);
      return !!index && index.root === ticket.proof.root && index.generation === ticket.proof.generation; })());
}
function admitsGet(ticket: GetTicket) { return !ticket.settled && sameGetContext(ticket); }
/** Recovery may join only a transport that can still commit in the current read scope. */
export function hasCurrentReadGet(query: Query): boolean {
  const ticket = readGetTicket(query);
  return !!ticket?.started && admitsGet(ticket);
}
/** A basis floor covers both completed acquisitions and transports still in the reducer window. */
export function readGetCoveredByBasis(query: Query, through: number): boolean {
  const acquired = readAcquisition(query), pending = readGetTicket(query);
  return !readRefused(query) && (acquired?.source === 'get' && acquired.issued <= through
    || !!pending?.started && pending.issued <= through && admitsGet(pending));
}
/** Failure reducers, like success reducers, may be overtaken after queryFn settles. */
export function failedGetAccepted(query: Query, error: unknown): boolean {
  const ticket = object(error) ? failedResults.get(error) : undefined;
  return !ticket || ticket.query !== query || ticket.failureAccepted !== false;
}
function receiveFailedGet(client: QueryClient, query: Query, error: unknown) {
  const ticket = object(error) ? failedResults.get(error) : undefined;
  if (!ticket || ticket.query !== query) { failReadDemand(query, stateFor(query).pending?.execution); return; }
  ticket.failureAccepted = admitsGet(ticket);
  failReadDemand(query, ticket.execution);
  if (ticket.failureAccepted || readQuery(client, query.queryKey) !== query) return;
  const state = stateFor(query), cancelled = ticket.cancelled;
  if (cancelled && state.refused && cancelled.serial === state.serial)
    query.setState({ data: undefined, error: cancelled.errorRef, status: 'error' });
  else if (!state.refused && state.serial !== ticket.serial && state.target?.deref() === query.state.data && query.state.data !== undefined)
    query.setState({ error: null, status: 'success' });
}
/** Public sharing hook also runs for manual/select/placeholder values; those have no flight ticket. */
function resolveReadData(old: unknown, incoming: unknown): unknown {
  const ticket = resultTicket(incoming);
  if (ticket && !admitsGet(ticket) && old !== undefined) return old;
  const shared = replaceEqualDeep(old, incoming);
  // Sharing can construct a new root around proven children. Register that actual Query value too,
  // so retention and checkpoint sizing reuse its immutable byte count instead of serializing it on every sweep.
  if (ticket) freezeReadJson(shared);
  // It says the same as the answer it shares with, so the answer's structure proof holds for it as it is.
  const proven = object(incoming) ? shapes.get(incoming) : undefined;
  if (proven && object(shared) && shared !== incoming && !shapes.has(shared) && freezeReadJson(shared))
    shapes.set(shared, { keys: proven.keys.map(proof => ({ key: proof.key })), queries: new WeakMap<Query, QueryKey>() });
  // Paged values are proven page by page: a page sharing rebuilt says the same as the checked page it was built from.
  const pages = object(incoming) && object(shared) && shared !== incoming ? (incoming as { pages?: unknown }).pages : undefined;
  if (Array.isArray(pages)) pages.forEach((page, at) => {
    const built = (shared as { pages?: unknown[] }).pages?.[at];
    if (built === page || !object(page) || !object(built)) return;
    for (const schema of pageSchemas) if (pageProofs.get(schema)?.has(page) && freezeReadJson(built)) rememberPage(schema, built);
  });
  return shared;
}
export function acceptedGet(ticket: GetTicket | undefined, raw: unknown): boolean {
  return !!ticket && acceptedGetTarget(ticket) && object(raw) && results.get(raw) === ticket;
}
/** onSuccess receives queryFn's raw value after sharing and all synchronous success observers. */
function acceptGet(client: QueryClient, raw: unknown, query: Query) {
  const ticket = resultTicket(raw);
  if (!ticket || ticket.query !== query || ticket.client !== client) return;
  const state = stateFor(query);
  if (!admitsGet(ticket)) {
    const cancelled = ticket.cancelled;
    if (readQuery(client, query.queryKey) === query && cancelled && state.refused && state.serial === cancelled.serial)
      query.setState({ data: undefined, error: cancelled.errorRef as Error, status: 'error', fetchStatus: 'idle' });
    return;
  }
  const target = query.state.data;
  if (!object(target) || replaceEqualDeep(target, raw) !== target || !ticket.proof) return;
  const proof = { ...ticket.proof, acquiredAt: ticket.receivedAt ?? Date.now() };
  if (query.queryKey[0] === 'coordinator') {
    const value = target as CoordinatorSnapshot;
    proof.marker = value.revision; proof.receiptAwaitingIndex = value.conversation.id !== readIndex(client)?.person.coordinator?.id;
  }
  if (query.queryKey[0] === 'project-shelf') proof.marker = (target as ProjectShelfDTO).revision;
  if (query.queryKey[0] === 'person-settings' || query.queryKey[0] === 'person-notices') proof.marker = (target as { revision: string | null }).revision;
  // A response that names its own source proves at least that version (a History window keeps its oldest, history-window.ts).
  const source = projectionSource(query, raw as object);
  if (source) { if (source.generation !== proof.generation) return; proof.sourcePv = source.sourcePv; }
  ticket.accepted = new WeakRef(target);
  if (query.queryKey[0] !== 'index' || state.acquisition?.source !== 'index-publication')
    state.acquisition = { source: query.queryKey[0] === 'index' ? 'index-publication' : 'get', id: crypto.randomUUID(),
      issued: ticket.issued, target: new WeakRef(target), canStartCheckpointSlot: true };
  recordReadProof(query, proof);
  // Completion is deliberately later than the reducer's synchronous success listener window.
  queueMicrotask(() => {
    if (!acceptedGetTarget(ticket)) { failReadDemand(query, ticket.execution); return; }
    completeReadDemand(query, ticket.execution);
    query.setState({});
  });
}
/**
 * The projection a held value says it was made from: its own `sourcePv`, or for paged reads the lowest of its pages'
 * (each page was answered by its own read). A History window's is its oldest part's (history-window.ts).
 */
const sourceOfHistory = new WeakMap<object, { generation: string; sourcePv: number }>();
export function recordHistorySource(window: object, source: { generation: string; sourcePv: number }) { sourceOfHistory.set(window, source); }
type Source = { generation: string; sourcePv: number };
const ownSource = (value: unknown): Source | undefined => object(value) && typeof (value as Source).generation === 'string'
  && typeof (value as Source).sourcePv === 'number' ? { generation: (value as Source).generation, sourcePv: (value as Source).sourcePv } : undefined;
function projectionSource(query: Query, value: object): Source | undefined {
  if (query.queryKey[0] === 'task-history') return sourceOfHistory.get(value);
  if (!projectionResource(query.queryKey)) return;
  const pages = (value as { pages?: unknown[] }).pages;
  if (!Array.isArray(pages)) return ownSource(value);
  const sources = pages.map(ownSource);
  if (!sources.length || sources.some(source => !source || source.generation !== sources[0]!.generation)) return;
  return { generation: sources[0]!.generation, sourcePv: Math.min(...sources.map(source => source!.sourcePv)) };
}
/** Closes one execution's reducer window, for the Query whose notification closed it. */
function settleTicket(query: Query, ticket: GetTicket) {
  ticket.settled = true; ticket.cancelled = undefined;
  const state = stateFor(query);
  if (state.pending === ticket) state.pending = undefined;
}
function acceptedGetTarget(ticket: GetTicket) {
  return !!ticket.accepted && ticket.accepted.deref() === ticket.query.state.data && sameGetContext(ticket);
}
export type ReadEntry = { key: QueryKey; data: unknown; proof?: ReadProof; active?: boolean; pending?: boolean; refused?: boolean; query?: Query };
export type ReadAssessment = { state: 'current' | 'unverified' | 'obsolete' | 'invalid' | 'refused' | 'missing';
  display: boolean; project: boolean; persist: boolean; acquiredAt: number | null; needsRead: boolean };
export const isDatedRead = (read: ReadAssessment) => read.display && read.state !== 'current';
/** Transport evidence is independent of whether a just-acquired value has been published in the index. */
function readQualification(index: ProjectedIndexDTO | undefined, read: ReadEntry) {
  const scope = index && indexScopes.get(index);
  return { pending: !!(read.proof?.uncertain || read.pending || read.proof?.demandPending),
    inSession: !taskBearing(read.key) || !scope || scope.anchored && (read.proof?.era ?? 0) === scope.era };
}
/** Explicit answer verification may explain a not-yet-published value, but never a revoked/uncertain acquisition. */
export function verifiedReadAcquisition(client: QueryClient, query: Query): boolean {
  readScope(client);
  const index = readIndex(client), read = readEntry(query), qualification = readQualification(index, read);
  const assessment = evaluateRead(index, read);
  return !qualification.pending && qualification.inSession && !['invalid', 'refused', 'missing'].includes(assessment.state);
}
export function evaluateRead(index: ProjectedIndexDTO | undefined, read: ReadEntry): ReadAssessment {
  return evaluateReadAgainstIndex(index, read, true);
}
/** Matching contents and transport qualification share one classifier, with qualification layered on only when needed. */
function evaluateReadAgainstIndex(index: ProjectedIndexDTO | undefined, read: ReadEntry, qualify: boolean): ReadAssessment {
  const scope = index && indexScopes.get(index);
  const qualification = readQualification(index, read);
  // Restoring a value changes its server authority, not whether its displayed contents match the saved index.
  const restored = taskBearing(read.key) && !!scope?.restored;
  const result = (state: ReadAssessment['state'], acquiredAt = read.proof?.acquiredAt ?? null): ReadAssessment => {
    if (qualify && state === 'current' && qualification.pending) state = 'unverified';
    return { state,
    display: ['current', 'unverified'].includes(state) || state === 'obsolete' && !!read.active,
    project: state === 'current' && !restored, persist: ['current', 'unverified'].includes(state), acquiredAt, needsRead: state !== 'current' || restored }; };
  if (read.refused) return result('refused');
  if (read.data === undefined) return result('missing');
  if (!index || !readShape(read)) return result('invalid');
  const proof = read.proof;
  if (!proof || proof.origin !== readOrigin() || proof.root !== index.root || proof.generation !== index.generation || proof.rev > index.rev
    || read.key[0] !== 'index' && read.key[1] !== index.root) return result('invalid');
  const kind = String(read.key[0]);
  if (kind === 'coordinator') {
    const value = read.data as CoordinatorSnapshot;
    if (value.root !== index.root || value.generation !== index.generation || value.revision !== proof.marker) return result('invalid');
    if (value.conversation.id !== index.person.coordinator?.id) {
      // This kind's preceding marker is the predecessor conversation ID, not its changing view digest.
      // Only a response accepted in this session may precede the index. Hydration never carries this right.
      const ahead = !!read.query && !scope?.restored && proof.receiptAwaitingIndex
        && proof.precedingMarker === (index.person.coordinator?.id ?? null);
      return ahead ? { ...result('unverified'), persist: false } : result('invalid');
    }
    if (qualify && !qualification.inSession) return result('unverified');
    return result(value.revision === index.person.coordinator?.revision ? 'current' : 'unverified');
  }
  if (kind === 'project-shelf') {
    const revision = (read.data as ProjectShelfDTO).revision;
    return result(revision === proof.marker && revision === index.projectShelfVersion
      ? qualify && !qualification.inSession ? 'unverified' : 'current' : 'unverified');
  }
  // Listed membership is a server fact. The web never walks project ancestors to decide visibility.
  if (kind === 'task') {
    const value = read.data as TaskRead;
    const project = isWrittenRead(value) ? value.earlier?.row.projectId ?? (value.task.kind === 'project' ? value.task.id : undefined) : value.row.projectId;
    if (project && !index.projects.some(item => item.id === project)) return result('invalid');
    if (!isWrittenRead(value) && value.generation !== index.generation) return result('invalid');
  }
  if (qualify && !qualification.inSession) return result('unverified');
  if (kind === 'index') return result('current');
  // Read before the workspace last moved: still shown (and kept for offline) while the analysis reads it again.
  if (kind === 'analysis-view') return result(proof.marker === readMarker(index, read.key) ? 'current' : 'unverified');
  if (['person-settings', 'person-notices'].includes(kind)) {
    const marker = readMarker(index, read.key), revision = (read.data as { revision: string | null }).revision;
    return result(revision === proof.marker && (revision === marker || proof.precedingMarker !== undefined && marker === proof.precedingMarker) ? 'current' : 'unverified');
  }
  // One rule for every projected resource: within this generation, a read made from the version its resource
  // requires, or a later one, is current; any other is read again.
  const required = requiredVersion(index, read.key);
  if (required === undefined) return result('invalid');
  const fresh = proof.sourcePv >= required;
  const id = readTaskId(read.key);
  if (id && index.staleIds.includes(id)) return result('unverified');
  if (kind === 'task') {
    const value = read.data as TaskRead;
    if (isWrittenRead(value)) {
      const row = indexTask(index, id);
      return result(row && row.version > value.task.version || !proof.receiptAwaitingIndex && !fresh ? 'obsolete' : 'unverified');
    }
    // The version floor: a view older than what this screen has already shown never comes back.
    if (value.task.version < (proof.minimumVersion ?? 0)) return result('unverified');
    return result(fresh ? 'current' : 'obsolete');
  }
  // A History, a search and a time line stay on screen while they are read again; a closed page is its own dated rows.
  if (kind === 'task-finished' || kind === 'task-shelved') return result(fresh ? 'current' : 'obsolete');
  const assessment = result(fresh ? 'current' : 'unverified');
  return kind === 'task-search' ? { ...assessment, persist: false } : assessment;
}
/** The same Query identity and proof select the view for Reader admission, content and write access. */
export function readEntry(query: Query): ReadEntry {
  return { query, key: query.queryKey, data: query.state.data, proof: readRefused(query) ? stateFor(query).proof : getReadProof(query), active: query.isActive(), refused: readRefused(query) };
}
/** Current conversation projection shared by the card and startup restoration. */
export function coordinatorReadState(client: QueryClient, root: string) {
  readScope(client);
  const key = ['coordinator', root], query = readQuery(client, key);
  const assessment = evaluateRead(readIndex(client), query ? readEntry(query) : { key, data: undefined });
  return { query, assessment, snapshot: assessment.display ? query?.state.data as CoordinatorSnapshot | undefined : undefined };
}
/**
 * An opened Task's reads: its view, judged alone, and its History, judged on its own and drawn without waiting for the
 * view (only the view's refusal withdraws it).
 */
export function taskReadState(client: QueryClient, root: string, id: string, reports = false) {
  readScope(client);
  const index = readIndex(client);
  const query = readQuery(client, ['task', root, id]);
  const history = reports ? readQuery(client, ['task-history', root, id]) : undefined;
  const assessment = evaluateRead(index, query ? readEntry(query) : { key: ['task', root, id], data: undefined });
  const historyAssessment = history && assessment.state !== 'refused' ? evaluateRead(index, readEntry(history)) : undefined;
  // Drawing held contents and retiring their reading request are separate decisions. Only this Task's adopted
  // read can finish that request; unrelated required reads and write qualification do not gate placement.
  const viewSettled = !!query && query.state.status === 'success' && query.state.fetchStatus === 'idle'
    && assessment.state === 'current' && !readDemandPending(query) && !readRecoveryPending(query);
  return { assessment, historyAssessment, query, viewSettled, view: assessment.display ? query?.state.data as TaskRead | undefined : undefined,
    history: historyAssessment?.display ? history?.state.data : undefined };
}
const observed = new WeakSet<QueryClient>();
/** QueryCache notifications record transport evidence only. Options/meta updates cannot erase it. */
export function observeReadProofs(client: QueryClient) {
  configureReadRetention(client);
  if (observed.has(client)) return;
  observed.add(client);
  for (const prefix of ['task', 'person-settings', 'person-notices', 'coordinator', 'task-history', 'task-finished', 'task-shelved', 'task-search', 'task-timeline', 'project-shelf', 'analysis-view'])
    client.setQueryDefaults([prefix], { ...client.getQueryDefaults([prefix]), structuralSharing: resolveReadData });
  const cache = client.getQueryCache(), success = cache.config.onSuccess, settled = cache.config.onSettled, failure = cache.config.onError;
  cache.config.onError = (error, query) => { if (failedGetAccepted(query, error)) failure?.(error, query); };
  cache.config.onSuccess = (raw, query) => { acceptGet(client, raw, query); success?.(raw, query); };
  cache.config.onSettled = (raw, error, query) => {
    const failed = object(error) ? failedResults.get(error) : undefined;
    const ticket = failed?.query === query && !failed.settled ? failed : resultTicket(raw);
    settled?.(raw, error, query);
    if (ticket) settleTicket(query, ticket);
  };
  cache.subscribe(event => {
    const query = event.query, state = stateFor(query);
    if (event.type === 'removed') {
      retireReadDemand(query);
      const index = readIndex(client);
      if (index && query.queryKey[0] !== 'index') {
        const remaining = cache.getAll().map(readEntry);
        if (losesReadProtection(index, [...remaining, readEntry(query)], remaining)) cutReadScope(client);
      }
    }
    if (event.type === 'observerAdded' || event.type === 'observerRemoved' || event.type === 'observerOptionsUpdated') {
      const active = query.isActive(); if (active || state.active) state.usedAt = Date.now(); state.active = active;
    }
    if (event.type !== 'updated') return;
    if (query.state.fetchStatus === 'idle' && (event.action.type === 'error' || event.action.type === 'success' && !event.action.manual)) state.usedAt = Date.now();
    if (event.action.type === 'invalidate') noteReadInvalidation(query);
    if (event.action.type === 'fetch') {
      const index = readIndex(client); readScope(client);
      const execution = planRead(query);
      state.pending = { query, client, issued: 0, serial: state.serial, boundary: captureReadBoundary(client),
        proof: index ? captureReadProof(index, query.queryKey) : undefined, execution, settled: false };
    }
    if (event.action.type === 'setState' && event.action.state.fetchStatus === 'idle' && query.state.fetchStatus === 'idle' && state.pending) {
      const ticket = state.pending; failReadDemand(query, ticket.execution);
      setTimeout(() => settleTicket(query, ticket), 0);
    }
    if (event.action.type === 'error') receiveFailedGet(client, query, event.action.error);
    if (event.action.type === 'success' && event.action.manual) { state.serial++; if (state.target?.deref() !== query.state.data) state.uncertain = true; }
  });
}

export const minimumTaskVersion = (query: Query) => stateFor(query).minimumVersion ?? 0;
export function requireTaskVersion(query: Query, version: number) {
  const state = stateFor(query); state.minimumVersion = Math.max(state.minimumVersion ?? 0, version);
}
export function requiredReadKeys(index: Pick<ProjectedIndexDTO, 'root'>): QueryKey[] {
  return [['index'], ['person-settings', index.root], ['person-notices', index.root]];
}

type RowPages = { pages: { rows: TaskPageRowDTO[]; ancestors?: TaskPageRowDTO[] }[] };
const rowPageKinds = ['task-finished', 'task-shelved', 'task-search'];
/** The reads whose page rows count as evidence of a Task's version. A time line's rows do not. */
export const holdsRowPages = (key: QueryKey) => rowPageKinds.includes(String(key[0]));
/** Those rows, each page's ancestors before its own. */
export const rowsOfPages = (data: unknown) => (data as RowPages).pages.flatMap(page => [...(page.ancestors ?? []), ...page.rows]);
/** Closed rows live in their bounded page queries. This is a screen projection, never a second fetch path. */
const projectedPages = new WeakMap<TaskPageRowDTO, TaskRowDTO>();
export function pageRow(row: TaskPageRowDTO): TaskRowDTO {
  const previous = projectedPages.get(row);
  if (previous) return previous;
  const { movedAt, stateMark, latestReport, childCounts: _childCounts, ...fields } = row;
  const stateLog = [stateMark, latestReport].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index)
    .sort((a, b) => a.at.localeCompare(b.at));
  const projected = { ...fields, ball: fields.ball ?? null, question: fields.question ?? "", startOrder: fields.startOrder ?? null,
    stateLog, movedAt };
  projectedPages.set(row, projected);
  return projected;
}


/** Pure closure rule shared by memory eviction, disk selection and restore filtering. */
export function readProtections(index: ProjectedIndexDTO, reads: ReadEntry[]) {
    const versions = new Map<string, number>(), refusals = new Set<string>();
    const offer = (id: string, version: number) => versions.set(id, Math.max(versions.get(id) ?? 0, version));
    for (const read of reads) {
      const proof = read.proof;
      if (!proof || proof.origin !== readOrigin() || proof.root !== index.root || proof.generation !== index.generation
        || read.key[0] !== 'index' && read.key[1] !== index.root) continue;
      if (!readCodec(read.key)) continue;
      const id = readTaskId(read.key);
      if (read.refused) { if (read.key[0] === 'task' && id && read.key.length === 3) refusals.add(id); continue; }
      if (read.key[0] === 'task' && id && proof.minimumVersion) offer(id, proof.minimumVersion);
      if (read.data === undefined || !readShape(read)) continue;
      if (read.key[0] === 'index') for (const row of (read.data as ProjectedIndexDTO).tasks) offer(row.id, row.version);
      else if (read.key[0] === 'task') {
        const value = read.data as TaskRead; offer(value.task.id, value.task.version);
        const view = isWrittenRead(value) ? value.earlier : value;
        if (view) offer(view.row.id, view.row.version);
      } else if (holdsRowPages(read.key)) for (const row of rowsOfPages(read.data)) offer(row.id, row.version);
    }
    return { versions, refusals };
}
export function losesReadProtection(index: ProjectedIndexDTO, before: ReadEntry[], remaining: ReadEntry[]): boolean {
  const a = readProtections(index, before), b = readProtections(index, remaining);
  return [...a.refusals].some(id => !b.refusals.has(id)) || [...a.versions].some(([id, version]) => (b.versions.get(id) ?? 0) < version);
}
/**
 * A view's placement or Run in the list's shape. What activity files say (a placement's last output and tool, a Run's
 * activity) reaches the screen through the list alone: a view carries none, so one the list does not hold has none yet,
 * and the list's own entry is always the one kept (folds put the list first).
 */
const listedPlacements = new WeakMap<TaskViewPlacementDTO, PlacementDTO>(), listedRuns = new WeakMap<TaskViewRunDTO, ControlRunDTO>();
export function listedPlacement(placement: TaskViewPlacementDTO): PlacementDTO {
  let listed = listedPlacements.get(placement);
  if (!listed) { listed = { ...placement, runtime: { ...placement.runtime, lastOutputAt: null, activityKind: null, toolName: null } }; listedPlacements.set(placement, listed); }
  return listed;
}
export function listedRun(run: TaskViewRunDTO): ControlRunDTO {
  let listed = listedRuns.get(run);
  if (!listed) { listed = { ...run, activity: null }; listedRuns.set(run, listed); }
  return listed;
}
/** The versions this screen's writes reached, by Task: no row older than one of them is a current fact (the version floor). */
export function writtenFloors(client: QueryClient, root: string): Map<string, number> {
  const floor = new Map<string, number>();
  for (const query of client.getQueryCache().findAll({ queryKey: ['task', root] }))
    if (query.queryKey.length === 3 && minimumTaskVersion(query)) floor.set(String(query.queryKey[2]), minimumTaskVersion(query));
  return floor;
}
/** The list's numbers a view does not carry, for a Task the list does not hold (a closed one opened directly). */
export const unlistedAggregates = { movedAt: 0, usageBelow: null, runsBelow: [],
  rowFacts: { status: null, childrenRunning: 0, runningRuns: 0, warning: null, kind: null, position: null } } satisfies Partial<TaskRowDTO>;
const viewRows = new WeakMap<object, { listed: TaskRowDTO | undefined; row: TaskRowDTO }>(), viewMade = new WeakSet<TaskRowDTO>();
/**
 * A view's own fields over the list's numbers: what descendants decide is the list's alone. The same row while the
 * view names the same version of it (its other parts, a body or a reply, may change without changing the row).
 */
export function viewRow(view: TaskProjectedViewDTO, listed: TaskRowDTO | undefined): TaskRowDTO {
  // A row this view made is no list's: it adds no numbers of its own.
  if (listed && viewMade.has(listed)) listed = undefined;
  const held = viewRows.get(view.row);
  if (held && held.listed === listed && held.row.version === view.row.version && held.row.hash === view.row.hash) return held.row;
  const row = { ...unlistedAggregates, ...listed, ...view.row };
  if (!listed) viewMade.add(row);
  viewRows.set(view.row, { listed, row }); return row;
}
const serverFacts = new WeakMap<QueryClient, { inputs: unknown[]; facts: ProjectedIndexDTO }>();
const displayFacts = new WeakMap<QueryClient, { inputs: unknown[]; facts: ProjectedIndexDTO }>();
function foldReadFacts(client: QueryClient, display: boolean): ProjectedIndexDTO | undefined {
  readScope(client);
  const indexQuery = readQuery(client, ['index']), index = readIndex(client);
  if (!index || !evaluateRead(index, readEntry(indexQuery!))[display ? 'display' : 'project']) return;
  const reads = client.getQueryCache().getAll().filter(query => query.queryKey[0] === 'task' || holdsRowPages(query.queryKey));
  const refused = new Set(reads.filter(query => readRefused(query) && query.queryKey[0] === 'task' && query.queryKey[1] === index.root).map(query => String(query.queryKey[2])));
  const values = reads.filter(query => {
    const read = readEntry(query), assessment = evaluateRead(index, read);
    // A held view can remain readable without agreeing with this list. Only matching views add list facts;
    // a cut, restoration or pending demand alone must not remove a matching frame.
    if (display && assessment.display && query.queryKey[0] === 'task' && !isWrittenRead(read.data as TaskRead))
      return evaluateReadAgainstIndex(index, read, false).state === 'current';
    // Obsolete lists are shown only by their own dated rows, never as current workspace facts.
    return display ? assessment.display && (assessment.state !== 'obsolete' || query.queryKey[0] === 'task') : assessment.project;
  }).map(query => query.state.data as object);
  const inputs = [index, ...values, ...refused, ...reads.flatMap(query => [query, query.state.data, minimumTaskVersion(query)])];
  const cache = display ? displayFacts : serverFacts, previous = cache.get(client);
  if (previous && inputs.length === previous.inputs.length && inputs.every((input, i) => input === previous.inputs[i])) return previous.facts;
  const listed = new Set(index.projects.map(project => project.id));
  // A view newer than the list does not take the Task's row out of the facts: a write's last word is the server's
  // hash and revision, and the list catches up by its own patch. A write's receipt does: a row older than what this
  // screen wrote never comes back (the version floor).
  const floor = writtenFloors(client, index.root);
  const blocked = (row: TaskRowDTO) => !listed.has(row.projectId) || refused.has(row.id) || index.staleIds.includes(row.id)
    || row.version < (floor.get(row.id) ?? 0);
  const rows = new Map(index.tasks.filter(row => listed.has(row.projectId) && (display || !blocked(row))).map(row => [row.id, row]));
  const placements = new Map<string, ProjectedIndexDTO['placements'][number]>(), runs = new Map<string, ProjectedIndexDTO['runs'][number]>();
  const offer = (row: TaskRowDTO) => {
    if (!listed.has(row.projectId) || !display && blocked(row)) return;
    const held = rows.get(row.id);
    if (!held || row.version > held.version || viewMade.has(held) && row.version === held.version) rows.set(row.id, row);
  };
  for (const data of values) {
    if ('pages' in data) {
      for (const row of rowsOfPages(data)) offer(pageRow(row));
    } else {
      const value = data as TaskRead;
      if (isWrittenRead(value)) {
        // A document changes only the displayed document fields of an existing row; it invents no location or turn.
        const row = rows.get(value.task.id);
        if (display && row && value.task.version >= row.version) rows.set(row.id, { ...row, title: value.task.title, lifecycle: value.task.lifecycle, version: value.task.version, hash: value.task.hash });
        continue;
      }
      // The view's own row carries no aggregate: it renews only a listed row's own fields, which keeps the list's.
      const row = rows.get(value.row.id);
      if (row && value.row.version > row.version && (display || !blocked(row))) rows.set(row.id, viewRow(value, row));
      // A Task no list holds (a closed one opened directly) is a fact of what the server last said by its view, so a
      // write to it is checked against it; it invents no row on screen (only lists and pages draw rows).
      else if (!row && !display) offer(viewRow(value, undefined));
      for (const placement of value.placements) if (display || !refused.has(placement.taskId)) placements.set(placement.id, listedPlacement(placement));
      for (const run of value.runs) if (display || !refused.has(run.taskId)) runs.set(run.id, listedRun(run));
    }
  }
  // The list's own facts first, in its order: a read that only repeats them changes nothing, and what a read adds follows.
  const folded = <T extends { id: string; taskId: string }>(own: readonly T[], read: ReadonlyMap<string, T>) => {
    const listed = own.filter(each => display || !refused.has(each.taskId)), held = new Set(listed.map(each => each.id));
    return [...listed, ...[...read.values()].filter(each => !held.has(each.id))];
  };
  const tasks = [...rows.values()], ids = new Set(tasks.map(row => row.id));
  for (const data of values) if ('task' in data && !isWrittenRead(data as TaskRead)) ids.add((data as TaskProjectedViewDTO).task.id);
  const people = folded(index.placements, placements).filter(each => display || ids.has(each.taskId)), activity = folded(index.runs, runs).filter(each => display || ids.has(each.taskId));
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  const facts = previous?.inputs[0] === index && same(previous.facts.tasks, tasks) && same(previous.facts.placements, people) && same(previous.facts.runs, activity)
    ? previous.facts : { ...index, tasks, placements: people, runs: activity };
  cache.set(client, { inputs, facts }); return facts;
}
export const serverReadFacts = (client: QueryClient) => foldReadFacts(client, false);
export const displayReadFacts = (client: QueryClient) => foldReadFacts(client, true);
type ReaderPresentation = { kind: 'absent' | 'refused' } | { kind: 'written'; document: ControlTaskHeadDTO; earlier?: TaskProjectedViewDTO; acquiredAt: number | null }
  | { kind: 'view'; view: TaskProjectedViewDTO; state: 'current' | 'unverified'; acquiredAt: number | null };
export function readerPresentation(client: QueryClient, root: string, id: string): ReaderPresentation {
  const { assessment, view } = taskReadState(client, root, id);
  if (assessment.state === 'refused') return { kind: 'refused' };
  if (!view) return { kind: 'absent' };
  return isWrittenRead(view) ? { kind: 'written', document: view.task, earlier: view.earlier, acquiredAt: assessment.acquiredAt }
    : { kind: 'view', view, state: assessment.project ? 'current' : 'unverified', acquiredAt: assessment.acquiredAt };
}
