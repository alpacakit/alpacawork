import { parseReadJson, readPayload, sameReadPayload } from './read-json';
import { requestRead } from './read-demand';
import { create } from 'zustand';
import { z } from 'zod';
import { dehydrate, hashKey, hydrate, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import { minimumTaskVersion, readGetTicket, readAcquisition, readGetCoveredByBasis, recordCheckpointAcquisition, readRefusalSequence, readIssuedSequence, readRefused, readRefusalCovers,
  readIndex, readScope, restoreReadScope, cutReadScope, readEntry, losesReadProtection, configureReadRetention, evaluateRead, reuseReadPayload, readCheckpointIndex,
  getReadProof, READ_BUNDLE_AGE, READ_DAY, READ_MAX_BYTES, readCodec, readOrigin, readProofSchema, readUsedAt,
  recordReadProof, requiredReadKeys, readLifetime, type Acquisition } from './read-model';
import { coversTimelineWindow, protectReadRefusals, readDataSize, readSize, selectGroups } from './read-retention';
import { later } from '@/lib/later';

export const useReadPersistence = create<{
  restore: 'pending' | 'restored' | 'skipped';
  restoredAt: number | null; savedAt: number | null; status: 'idle' | 'saved' | 'partial' | 'over-budget' | 'unavailable' | 'superseded'; unsavedTasks: number; error?: string;
}>(() => ({ restore: 'pending', restoredAt: null, savedAt: null, unsavedTasks: 0, status: 'idle' }));
const DATABASE = 'alpacawork-read-checkpoint', FORMAT = 17, VERSION = 3;
const READ_STARTUP_BUDGET_MS = 500;
const SAVE_IDLE_LIMIT_MS = 1000;
const READ_OPEN_LIMIT_MS = 1000;
const READ_MAX_PENDING_REFUSALS = 1024;
export const READ_MAX_PENDING_REFUSAL_BYTES = 8 * 1024 * 1024;
const time = z.number().finite().nonnegative();
const serializableQuery = z.object({ queryKey: z.array(z.unknown()), queryHash: z.string(), dehydratedAt: time,
  queryType: z.literal('infinite').optional(),
  state: z.object({ data: z.unknown(), dataUpdateCount: z.number().int().nonnegative(), dataUpdatedAt: time,
    error: z.null(), errorUpdateCount: z.literal(0), errorUpdatedAt: z.literal(0), fetchFailureCount: z.literal(0),
    fetchFailureReason: z.null(), fetchMeta: z.null(), isInvalidated: z.boolean(), status: z.literal('success'), fetchStatus: z.literal('idle') }).strict(),
}).strict();
const scopeSchema = z.object({ origin: z.string(), root: z.string(), generation: z.string() }).strict();
const controlSchema = z.object({ format: z.literal(FORMAT), epoch: z.string().min(1), revision: z.number().int().nonnegative(),
  scope: scopeSchema.nullable(), savedAt: time.nullable(), cut: z.boolean(), indexReceivedAt: time.nullable() }).strict();
const slotSchema = z.object({ key: z.array(z.unknown()), hash: z.string(), slotId: z.string().min(1), acquisitionId: z.string().min(1),
  acquiredAt: time, usedAt: time, qualification: z.object({ proof: readProofSchema, cut: z.boolean() }).strict(), query: serializableQuery }).strict();
// The raw boundary contains metadata plus one primitive text; domain Slots retain their ordinary data.
const rawSlotSchema = slotSchema.extend({ payload: z.string(), query: serializableQuery.extend({ state: serializableQuery.shape.state.omit({ data: true }) }) }).strict();
type Control = z.infer<typeof controlSchema>;
type Slot = z.infer<typeof slotSchema>;
function encodeSlot(slot: Slot): z.infer<typeof rawSlotSchema> {
  const { data, ...metadata } = slot.query.state;
  return { ...slot, payload: readPayload(data).text, query: { ...slot.query, state: metadata } };
}
type Checkpoint = { control: Control; slots: Slot[] };
/** This session's last commit, as stored rows. Data is weak: a collected row parses its payload again. */
type Written = { epoch: string; revision: number; rows: Map<string, { slot: Slot; data: unknown }> };
// Rows this session writes get the schema check a decode would give them, once, when written.
const decodable = (record: unknown) => rawSlotSchema.safeParse(record).success;
// Trust: every writer advances control.revision, so while epoch and revision are still those of our last commit,
// each row we wrote holds what we wrote; it skips the schema and payload comparison. Any other write re-checks all rows.
function remember(control: Control, slots: Slot[], undecodable: ReadonlySet<string>): Written {
  return { epoch: control.epoch, revision: control.revision, rows: new Map(slots.filter(slot => !undecodable.has(slot.hash)).map(slot => {
    const data = slot.query.state.data;
    return [slot.hash, { slot: slotRecord(slot, null) as Slot, data: data !== null && typeof data === 'object' ? new WeakRef(data) : data }];
  })) };
}
function recall(written: Written | undefined, control: Control, raw: unknown): Slot | undefined {
  if (!written || written.epoch !== control.epoch || written.revision !== control.revision || !raw || typeof raw !== 'object') return;
  const row = raw as Partial<Slot>, known = typeof row.hash === 'string' ? written.rows.get(row.hash) : undefined;
  if (!known || known.slot.slotId !== row.slotId || known.slot.acquisitionId !== row.acquisitionId) return;
  const data = known.data instanceof WeakRef ? known.data.deref() : known.data;
  if (data === undefined) return;
  const { slot } = known;
  return { ...slot, query: { ...slot.query, state: { ...slot.query.state, data } } };
}
type Binding = { slotId?: string; acquisitionId?: string; target?: WeakRef<object>; initialPresent?: boolean; committedRefusalSerial: number };
const bindings = new WeakMap<Query, Binding>();
const storageBinding = (query: Query) => { let binding = bindings.get(query); if (!binding) { binding = { committedRefusalSerial: 0 }; bindings.set(query, binding); } return binding; };
type Candidate = { query: Query; target: unknown; slot: Slot; acquisition: Acquisition; binding: Binding };
type ReadEvents = (changed: (event: { kind: 'live'; scopeChanged: boolean } | { kind: 'clear' | 'remove' }) => void) => () => void;
type Session = { db?: IDBDatabase; expectedEpoch?: string; basisFloor: number; restore?: Promise<void>;
  stopped: boolean; terminal: boolean; pinsActive: boolean; generation: number; localEpoch: number; intent: number; writing: boolean;
  erase: boolean; revoke: boolean; globalRemoval: boolean; written?: Written; fault?: (error: unknown) => void; wake?: () => void; cancel?: () => void };
const sessions = new WeakMap<QueryClient, Session>();
const freshControl = (): Control => ({ format: FORMAT, epoch: crypto.randomUUID(), revision: 0, scope: null, savedAt: null, cut: false, indexReceivedAt: null });
function session(client: QueryClient) {
  let state = sessions.get(client);
  if (!state) { configureReadRetention(client); state = { basisFloor: 0, stopped: false, terminal: false, pinsActive: false,
    generation: 0, localEpoch: 0, intent: 0, writing: false, erase: false, revoke: false, globalRemoval: false }; sessions.set(client, state); }
  return state;
}
export function hasPendingReadRefusal(query: Query, client?: QueryClient) {
  // A Query has one session writer. The predicate itself remains here, including the committed serial.
  const state = queryWriters.get(query) ?? (client ? sessions.get(client) : undefined);
  return !!state?.pinsActive && !state.stopped && readRefusalSequence(query) > storageBinding(query).committedRefusalSerial;
}
const queryWriters = new WeakMap<Query, Session>();
function unavailable(state: Session, error: unknown) {
  useReadPersistence.setState({ status: 'unavailable', error: String(error instanceof Error ? error.message : error) }); state.fault?.(error);
}
function terminateWriter(client: QueryClient, state: Session, reason: string, superseded = false) {
  if (state.terminal) return;
  state.terminal = true; state.cancel?.(); state.erase = false; state.revoke = false;
  useReadPersistence.setState({ status: superseded ? 'superseded' : 'unavailable', error: reason });
  cutReadScope(client);
  state.pinsActive = false;
  state.fault?.(new Error(reason));
  // Wake the memory controller after the special pins have actually been released.
  for (const query of client.getQueryCache().getAll()) if (readRefusalSequence(query)) query.setState({});
}
function open(versionChanged: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error('Read storage open blocked or unavailable')); }, READ_OPEN_LIMIT_MS);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Deliberate boundary break: no old reader, transformation or compatibility path.
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      db.createObjectStore('control'); db.createObjectStore('slots', { keyPath: 'hash' });
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new Error('Cannot open read storage')); };
    request.onsuccess = () => {
      clearTimeout(timer); const db = request.result;
      if (expired) { db.close(); return; }
      db.onversionchange = () => { db.close(); versionChanged(); }; resolve(db);
    };
  });
}
/** Both stores share one transaction. No HTTP/non-IDB await runs in its callback. */
function transact<T>(db: IDBDatabase, change: (held: { control: unknown; slots: unknown[] }, tx: IDBTransaction) => T, durability?: IDBTransactionDurability): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['control', 'slots'], 'readwrite', durability ? { durability } : undefined);
    const control = tx.objectStore('control').get('current'), slots = tx.objectStore('slots').getAll();
    let result: T, remaining = 2, failure: unknown;
    const read = () => { if (--remaining) return; try { result = change({ control: control.result, slots: slots.result }, tx); }
      catch (error) { failure = error; tx.abort(); } };
    control.onsuccess = read; slots.onsuccess = read;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('Read storage transaction aborted', 'AbortError'));
  });
}
const slotRecord = (slot: Slot, data: unknown) => ({ ...slot, query: { ...slot.query, state: { ...slot.query.state, data } } });
const slotBytes = (slot: Slot) => readDataSize(slot.query.state.data, data => slotRecord(slot, data));
/** Compare every metadata field independent of property order; proven shared payloads need no serialization. */
const sameSlot = (before: Slot | undefined, after: Slot) => !!before
  && hashKey([slotRecord(before, null)]) === hashKey([slotRecord(after, null)])
  && (before.query.state.data === after.query.state.data
    || sameReadPayload(before.query.state.data, after.query.state.data));
const checkpointBytes = (control: Control, slots: Slot[]) => readSize({ control, slots: [] })
  + slots.reduce((bytes, slot) => bytes + slotBytes(slot), 0) + Math.max(0, slots.length - 1);
function decode(held: { control: unknown; slots: unknown[] }, client: QueryClient, written?: Written): Checkpoint | undefined {
  const control = controlSchema.safeParse(held.control);
  if (!control.success) return;
  const now = Date.now();
  if (control.data.savedAt !== null && control.data.savedAt > now + READ_DAY || control.data.indexReceivedAt !== null && control.data.indexReceivedAt > now + READ_DAY) return;
  const slots = held.slots.flatMap((raw, at) => {
    // getAll owns a disposable snapshot. Keep this row locally, releasing the
    // request's reference before decoding; durable records and row order stay intact.
    held.slots[at] = undefined;
    const ours = recall(written, control.data, raw);
    if (ours) return [ours];
    const slot = rawSlotSchema.safeParse(raw);
    if (!slot.success) return [];
    const query = client.getQueryCache().get(slot.data.hash);
    const bases = query ? [query.state.data, bindings.get(query)?.target?.deref()].map(data => ({ key: query.queryKey, data })) : [];
    let data = reuseReadPayload(slot.data.key, slot.data.payload, bases);
    if (data === undefined) {
      try { data = parseReadJson(slot.data.payload); }
      catch (error) { if (error instanceof SyntaxError) return []; throw error; }
      if (data === undefined) return [];
    }
    const { payload: _payload, ...metadata } = slot.data;
    return [{ ...metadata, query: { ...metadata.query, state: { ...metadata.query.state, data } } }];
  });
  if (checkpointBytes(control.data, slots) > READ_MAX_BYTES) return;
  return { control: control.data, slots };
}
function slotEntry(slot: Slot) { return { key: slot.key, data: slot.query.state.data, proof: slot.qualification.proof }; }
function validSlot(slot: Slot, index: ProjectedIndexDTO, now: number) {
  const proof = slot.qualification.proof;
  return slot.hash === hashKey(slot.key) && slot.hash === slot.query.queryHash && hashKey(slot.query.queryKey) === slot.hash
    && slot.usedAt <= now + READ_DAY && slot.acquiredAt <= now + READ_DAY && slot.query.state.dataUpdatedAt <= now + READ_DAY
    && slot.acquiredAt === proof.acquiredAt && proof.rev <= index.rev && !!readCodec(slot.key)
    && (slot.key[0] !== 'task-history' || slot.query.queryType === undefined) && evaluateRead(index, slotEntry(slot)).persist;
}
function checkpointIndex(checkpoint: Checkpoint): ProjectedIndexDTO | undefined {
  const slot = checkpoint.slots.find(slot => slot.hash === hashKey(['index']));
  const normalized = slot && readCheckpointIndex(slot.query.state.data);
  if (!normalized || !checkpoint.control.scope) return;
  // This detached checkpoint context must not inherit the source object's live scope.
  const index = { ...normalized }, scope = checkpoint.control.scope;
  return checkpoint.control.indexReceivedAt === slot!.acquiredAt && scope.origin === readOrigin() && scope.root === index.root && scope.generation === index.generation && validSlot(slot!, index, Date.now()) ? index : undefined;
}
function selection(control: Control, slots: Slot[], index: ProjectedIndexDTO, now: number, active: ReadonlySet<string>) {
  const required = new Set(requiredReadKeys(index).map(hashKey));
  const window = (slot: Slot) => ({ key: slot.key, data: slot.query.state.data, acquiredAt: slot.acquiredAt });
  const kept = slots.filter(slot => active.has(slot.hash) || !slots.some(later => coversTimelineWindow(window(later), window(slot))));
  const selected = selectGroups(kept.map(slot => ({ value: slot, key: slot.key, hash: slot.hash, data: slot.query.state.data, usedAt: slot.usedAt,
    bytes: slotBytes(slot), required: required.has(slot.hash), protected: active.has(slot.hash) })), now, checkpointBytes(control, []), true);
  const values = selected.selected.map(item => item.value), present = new Set(values.map(slot => slot.hash));
  return { ...selected, slots: values, absent: [...required].filter(hash => !present.has(hash)) };
}
/** Startup's cache budget is not a storage fault. Late completion still establishes the writer basis. */
export function restoreReadPersistence(client: QueryClient, fault?: (error: unknown) => void): Promise<void> {
  const state = session(client); state.fault = fault;
  if (state.restore) return state.restore;
  state.restore = (async () => {
    let expired = false, restored = false, timer: ReturnType<typeof setTimeout> | undefined;
    useReadPersistence.setState({ restore: 'pending' });
    const skip = () => {
      expired = true;
      if (valid()) useReadPersistence.setState({ restore: 'skipped' });
    };
    const localEpoch = state.localEpoch, generation = state.generation, deadline = performance.now() + READ_STARTUP_BUDGET_MS;
    // Stop/restart invalidates the continuation; local erase/refusal intents still need the late writer basis.
    const valid = () => !state.stopped && !state.terminal && generation === state.generation;
    const restore = (async () => {
      const db = await open(() => { state.db = undefined; terminateWriter(client, state, 'Read storage version changed'); });
      if (!valid()) { db.close(); return; } state.db = db;
      const checkpoint = await transact(db, (held, tx) => {
        const parsed = decode(held, client);
        if (parsed) return parsed;
        const control = freshControl(); tx.objectStore('slots').clear(); tx.objectStore('control').put(control, 'current'); return { control, slots: [] };
      });
      if (!valid()) return;
      state.expectedEpoch = checkpoint.control.epoch; state.basisFloor = readIssuedSequence();
      const hashes = new Set(checkpoint.slots.map(slot => slot.hash));
      for (const query of client.getQueryCache().getAll()) {
        const present = hashes.has(query.queryHash);
        storageBinding(query).initialPresent = present;
        if (!present && readGetCoveredByBasis(query, state.basisFloor)) requestRead(query);
      }
      const index = checkpointIndex(checkpoint), now = Date.now();
      if (!expired && !state.stopped && localEpoch === state.localEpoch && !readIndex(client) && index
        && checkpoint.control.indexReceivedAt !== null && now - checkpoint.control.indexReceivedAt < READ_BUNDLE_AGE) {
        // Startup does not wait for this: a read this session already holds, asked for or was refused, or a version it
        // already wrote, is newer than any stored copy, and the copy never takes its place.
        const eligible = checkpoint.slots.filter(slot => validSlot(slot, index, now) && !heldThisSession(client.getQueryCache().get(slot.hash)));
        const selected = selection(checkpoint.control, eligible, index, now, new Set());
        if (valid() && !expired && performance.now() < deadline && !selected.unavailable && !selected.absent.includes(hashKey(['index']))) {
          hydrate(client, { mutations: [], queries: selected.slots.map(slot => slot.query) });
          for (const slot of selected.slots) {
            const query = client.getQueryCache().get(slot.hash)!;
            recordReadProof(query, { ...slot.qualification.proof, era: 0 }, slot.usedAt);
            recordCheckpointAcquisition(query, slot.acquisitionId);
            Object.assign(storageBinding(query), { slotId: slot.slotId, acquisitionId: slot.acquisitionId, target: new WeakRef(query.state.data as object), initialPresent: true });
          }
          const cut = checkpoint.control.cut || selected.slots.some(slot => slot.qualification.cut)
            || losesReadProtection(index, eligible.map(slotEntry), selected.slots.map(slotEntry));
          restoreReadScope(client, cut);
          restored = true;
          useReadPersistence.setState({ restore: 'restored', restoredAt: checkpoint.control.indexReceivedAt, savedAt: checkpoint.control.savedAt,
            status: selected.absent.length ? 'partial' : 'saved', unsavedTasks: 0, error: undefined });
        }
      }
      if (valid() && !restored) skip();
      if (valid()) state.wake?.();
    })();
    // One owner reports real IDB failures, including failures after startup has continued.
    const ready = restore.catch(error => { if (valid()) { skip(); unavailable(state, error); } });
    try { await Promise.race([ready, new Promise<void>(resolve => {
      timer = setTimeout(() => { skip(); resolve(); }, READ_STARTUP_BUDGET_MS);
    })]); }
    finally { clearTimeout(timer); }
  })();
  return state.restore;
}
/** Whether this session's own reads already own a Query: its data, a GET under way, a refusal, or a version it wrote. */
function heldThisSession(query: Query | undefined): boolean {
  return !!query && (query.state.data !== undefined || query.state.fetchStatus !== 'idle' || !!readGetTicket(query)
    || readRefused(query) || readRefusalSequence(query) > 0 || minimumTaskVersion(query) > 0);
}
/**
 * The reads a save writes. An open History window is left as it was last stored while it is read (it changes with every
 * event): it is written when its reader closes it, or when the tab is left (`leaving`).
 */
function candidates(client: QueryClient, leaving = false): Candidate[] {
  const snapshot = dehydrate(client, { shouldDehydrateMutation: () => false, shouldRedactErrors: () => false,
    shouldDehydrateQuery: query => query.state.data !== undefined && !!readCodec(query.queryKey) && query.queryKey[0] !== 'task-search'
      && (leaving || query.queryKey[0] !== 'task-history' || !query.isActive()) });
  return snapshot.queries.flatMap(raw => {
    const query = client.getQueryCache().get(raw.queryHash)!, acquisition = readAcquisition(query), proof = getReadProof(query);
    if (!acquisition || !proof) return [];
    const binding = storageBinding(query), { promise: _promise, meta: _meta, ...serialized } = raw;
    const queryValue = { ...serialized, state: { ...serialized.state, error: null, errorUpdateCount: 0 as const, errorUpdatedAt: 0 as const,
      fetchFailureCount: 0 as const, fetchFailureReason: null, fetchMeta: null, status: 'success' as const, fetchStatus: 'idle' as const, isInvalidated: true } };
    const slot: Slot = { key: query.queryKey as unknown[], hash: query.queryHash, slotId: binding.slotId ?? crypto.randomUUID(), acquisitionId: acquisition.id,
      acquiredAt: proof.acquiredAt, usedAt: query.isActive() ? Date.now() : readUsedAt(query), qualification: { proof, cut: !readScope(client)?.anchored }, query: { ...queryValue, queryKey: [...queryValue.queryKey] } };
    return [{ query, target: query.state.data, slot, acquisition, binding }];
  });
}
/** How far a stored read's use clock may lag its use: a tenth of its lifetime, and at most ten minutes. */
const usedAtStep = (lifetime: number) => Math.min(lifetime / 10, 10 * 60_000);
/** Unique same-key decision before a single shared group selection, inside the transaction. */
function composeCheckpoint(client: QueryClient, state: Session, held: Checkpoint, current: Candidate[]) {
  const now = Date.now(), sources = client.getQueryCache().getAll();
  const refused = sources.filter(readRefused);
  // Completed refusals still fence older acquisitions; sources with no refusal cannot raise the floor.
  const revocations = sources.filter(source => readRefusalSequence(source) > 0);
  const negative = (key: QueryKey) => refused.some(source => readRefusalCovers(source.queryKey, key));
  const candidateIndex = current.find(candidate => candidate.slot.key[0] === 'index');
  const previousIndex = checkpointIndex(held);
  const index = candidateIndex?.slot.query.state.data as ProjectedIndexDTO | undefined;
  if (!index) return;
  const scope = { origin: readOrigin(), root: index.root, generation: index.generation };
  const sameScope = held.control.scope && JSON.stringify(held.control.scope) === JSON.stringify(scope);
  if (sameScope && previousIndex && previousIndex.rev > index.rev) return;
  const rows = new Map((sameScope ? held.slots : []).filter(slot => !negative(slot.key) && validSlot(slot, index, now)).map(slot => [slot.hash, slot]));
  for (const candidate of current) {
    const { slot, acquisition, binding } = candidate;
    if (negative(slot.key) || !validSlot(slot, index, now)) continue;
    const floor = Math.max(0, ...revocations.filter(source => readRefusalCovers(source.queryKey, slot.key)).map(readRefusalSequence));
    if (acquisition.issued <= floor && floor > 0 || acquisition.source !== 'index-publication' && binding.initialPresent === false && acquisition.issued <= state.basisFloor) continue;
    const old = rows.get(slot.hash), inherited = binding.slotId !== undefined && binding.acquisitionId === slot.acquisitionId;
    if (!inherited && !acquisition.canStartCheckpointSlot) continue;
    if (!old) {
      // Absence at the same epoch is a legal selection result, not a permanent tombstone.
      rows.set(slot.hash, { ...slot, slotId: crypto.randomUUID() }); continue;
    }
    if (inherited && old.slotId !== binding.slotId) continue;
    if (!inherited && old.slotId !== slot.slotId) {
      const before = evaluateRead(index, slotEntry(old)), after = evaluateRead(index, slotEntry(slot));
      const oldTask = (old.query.state.data as { task?: { version: number } })?.task;
      const nextTask = (slot.query.state.data as { task?: { version: number } })?.task;
      if (oldTask && nextTask && oldTask.version > nextTask.version || old.qualification.proof.rev > slot.qualification.proof.rev
        || before.state === 'current' && after.state !== 'current') continue;
    }
    const next = { ...slot, slotId: inherited ? old.slotId : crypto.randomUUID() };
    // Success-only snapshots have no pending promise: keep their actual serialization time on a no-op.
    // The required index has no recency lifetime; its activity clock alone does not change the stored snapshot.
    // A read in use moves its clock on every save; within a step of its lifetime that alone does not either, or every
    // save wrote each read on screen again, its whole text with it.
    // Select and budget this exact stored slot, rather than ignoring fields only when issuing puts.
    const lifetime = readLifetime(slot.key);
    const snapshot = { ...next, usedAt: lifetime === undefined || next.usedAt - old.usedAt < usedAtStep(lifetime) ? old.usedAt : next.usedAt,
      query: { ...next.query, dehydratedAt: old.query.dehydratedAt } };
    rows.set(slot.hash, sameSlot(old, snapshot) ? old : next);
  }
  const eligible = [...rows.values()].filter(slot => !negative(slot.key) && validSlot(slot, index, now));
  const indexSlot = eligible.find(slot => slot.key[0] === 'index');
  if (!indexSlot) return;
  // Only actual index reception can renew this checkpoint's 14-day envelope.
  const indexReceivedAt = indexSlot.acquiredAt;
  if (now - indexReceivedAt >= READ_BUNDLE_AGE) return;
  const control: Control = { ...held.control, scope, indexReceivedAt, savedAt: now, revision: held.control.revision + 1,
    cut: !readScope(client)?.anchored, epoch: sameScope || !held.control.scope ? held.control.epoch : crypto.randomUUID() };
  const active = new Set(current.filter(candidate => candidate.query.isActive() && evaluateRead(index, readEntry(candidate.query)).display).map(candidate => candidate.slot.hash));
  const selected = selection(control, eligible, index, now, active);
  if (selected.unavailable) return { unavailable: true as const };
  // A bare control is not an existing coherent checkpoint and cannot bypass the first required gate.
  if (!previousIndex && selected.absent.some(hash => { const query = client.getQueryCache().get(hash); return !query || !readRefused(query); })) return;
  control.cut ||= losesReadProtection(index, eligible.map(slotEntry), selected.slots.map(slotEntry));
  const unsavedTasks = new Set(current.filter(candidate => active.has(candidate.slot.hash) && !selected.slots.some(slot => slot.hash === candidate.slot.hash))
    .flatMap(candidate => candidate.slot.key[0] === 'task' || candidate.slot.key[0] === 'task-history' ? [candidate.slot.key[2]] : [])).size;
  return { unavailable: false as const, control, slots: selected.slots,
    partial: selected.partial || selected.absent.length > 0 || unsavedTasks > 0, expiresAt: selected.expiresAt, unsavedTasks };

}
export function startReadPersistence(client: QueryClient, subscribe: ReadEvents): () => void {
  const state = session(client); state.stopped = false; state.pinsActive = !state.terminal;
  for (const query of client.getQueryCache().getAll()) queryWriters.set(query, state);
  protectReadRefusals(client, query => hasPendingReadRefusal(query, client));
  // One pending deadline owns normal, immediate and retry work. Busy callbacks leave it intact.
  let timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let dueAt: number | undefined, retries = 0, leaving = false, leavingWrite = false;
  // A save waiting for an idle moment keeps its own limit while more changes come; it ends only when written or cleared.
  let idle: number | undefined;
  const consumeTimer = () => { clearTimeout(timer); timer = undefined; };
  const consumeIdle = () => { if (idle !== undefined) cancelIdleCallback(idle); idle = undefined; };
  const setExpiry = (at?: number) => {
    clearTimeout(expiry);
    expiry = at !== undefined && Number.isFinite(at) ? setTimeout(flush, Math.min(2_147_483_647, Math.max(1, at - Date.now()))) : undefined;
  };
  const clearTimers = () => { consumeTimer(); consumeIdle(); setExpiry(); dueAt = undefined; };
  state.cancel = clearTimers;
  function service() {
    consumeTimer();
    if (state.stopped || state.terminal || dueAt === undefined) return;
    const delay = dueAt - performance.now();
    if (delay > 0) timer = setTimeout(service, delay);
    else if (leaving || state.erase || state.revoke) void pump();
    // A save due while the screen is drawing (a Task just opened, its rows coming) waits until the page is idle, so its
    // storage callbacks do not land among that drawing; a page busy for longer saves after SAVE_IDLE_LIMIT_MS.
    else if (typeof requestIdleCallback === 'function') { if (idle === undefined) idle = requestIdleCallback(() => { idle = undefined; void pump(); }, { timeout: SAVE_IDLE_LIMIT_MS }); }
    else later(() => void pump(), { orNow: true });
  }
  function reserve(delay: number) {
    if (state.stopped || state.terminal) return;
    dueAt = Math.min(dueAt ?? Infinity, performance.now() + delay);
    service();
  }
  const checkPins = () => {
    const pending = client.getQueryCache().getAll().filter(query => hasPendingReadRefusal(query, client));
    const metadata = pending.map(query => ({ queryKey: query.queryKey, refusalSerial: readRefusalSequence(query), committedRefusalSerial: storageBinding(query).committedRefusalSerial }));
    if (pending.length > READ_MAX_PENDING_REFUSALS || readSize(metadata) > READ_MAX_PENDING_REFUSAL_BYTES)
      terminateWriter(client, state, 'Pending read refusal metadata exceeds protection budget');
  };
  const schedule = () => reserve(250);
  async function pump() {
    if (state.writing || state.stopped || state.terminal || !state.db || !state.expectedEpoch || dueAt === undefined || performance.now() < dueAt) return;
    state.writing = true;
    let attemptErase = false, attemptRevoke = false;
    try {
      while (!state.stopped && !state.terminal && dueAt !== undefined && performance.now() >= dueAt) {
        consumeTimer(); consumeIdle(); dueAt = undefined;
        const erase = state.erase, revoke = state.revoke, localEpoch = state.localEpoch, intent = state.intent, expectedEpoch = state.expectedEpoch;
        const leavingSave = leavingWrite; leavingWrite = false;
        attemptErase = erase; attemptRevoke = revoke;
        state.erase = false; state.revoke = false;
        const captured = client.getQueryCache().getAll().filter(query => hasPendingReadRefusal(query, client)).map(query => ({ query, serial: readRefusalSequence(query) }));
        const result = await transact(state.db, (raw, tx) => {
          const held = decode(raw, client, state.written);
          if (!held || held.control.epoch !== expectedEpoch) { terminateWriter(client, state, 'Read storage scope changed in another tab', true); return; }
          if (localEpoch !== state.localEpoch || state.terminal) return;
          const slots = tx.objectStore('slots'), controls = tx.objectStore('control');
          if (erase || revoke) {
            const kept = erase ? [] : held.slots.filter(slot => !captured.some(({ query }) => readRefusalCovers(query.queryKey, slot.key)));
            const control = { ...held.control, epoch: crypto.randomUUID(), revision: held.control.revision + 1,
              ...(erase ? { scope: null, indexReceivedAt: null, savedAt: null, cut: false } : {}) };
            if (erase) slots.clear(); else for (const slot of held.slots) if (!kept.includes(slot)) slots.delete(slot.hash);
            controls.put(control, 'current');
            return { control, selected: undefined, current: [] as Candidate[], localEpoch, intent, captured, undecodable: new Set<string>() };
          }
          const current = candidates(client, leavingSave), next = composeCheckpoint(client, state, held, current);
          if (!next) return;
          if (next.unavailable) { useReadPersistence.setState({ status: 'over-budget', error: undefined }); return; }
          const previous = new Map(held.slots.map(slot => [slot.hash, slot]));
          const undecodable = new Set<string>();
          for (const slot of next.slots) if (!sameSlot(previous.get(slot.hash), slot)) {
            const record = encodeSlot(slot); slots.put(record);
            if (!decodable(record)) undecodable.add(slot.hash);
          }
          for (const slot of held.slots) if (!next.slots.some(next => next.hash === slot.hash)) slots.delete(slot.hash);
          controls.put(next.control, 'current');
          return { control: next.control, selected: next, current, localEpoch, intent, captured, undecodable };
        }, erase || revoke ? 'strict' : undefined);
        if (!result) continue;
        // Every successful self commit advances the CAS basis, even when a newer local intent arrived meanwhile.
        state.expectedEpoch = result.control.epoch;
        state.written = result.selected ? remember(result.control, result.selected.slots, result.undecodable) : undefined;
        retries = 0;
        for (const { query, serial } of result.captured) {
          storageBinding(query).committedRefusalSerial = Math.max(storageBinding(query).committedRefusalSerial, serial);
          query.setState({});
        }
        if (state.stopped || result.localEpoch !== state.localEpoch || result.intent !== state.intent || state.terminal) continue;
        const stable = result.current.every(candidate => client.getQueryCache().get(candidate.query.queryHash) === candidate.query
          && candidate.target === candidate.query.state.data && readAcquisition(candidate.query)?.id === candidate.slot.acquisitionId);
        if (!stable) continue;
        if (result.selected) {
          for (const candidate of result.current) {
            const slot = result.selected.slots.find(slot => slot.hash === candidate.slot.hash && slot.acquisitionId === candidate.slot.acquisitionId);
            if (slot) Object.assign(storageBinding(candidate.query), { slotId: slot.slotId, acquisitionId: slot.acquisitionId, target: new WeakRef(candidate.target as object) });
          }
          useReadPersistence.setState({ status: result.selected.partial ? 'partial' : 'saved', savedAt: result.control.savedAt,
            unsavedTasks: result.selected.unsavedTasks, error: undefined });
          setExpiry(result.selected.expiresAt);
        } else { if (readIndex(client)) schedule(); useReadPersistence.setState({ status: 'idle', ...(erase ? { savedAt: null, restoredAt: null } : {}), error: undefined }); }
      }
    } catch (error) {
      const nextDue = dueAt;
      state.erase ||= attemptErase; state.revoke ||= attemptRevoke; clearTimers();
      if (state.stopped || state.terminal) return;
      unavailable(state, error);
      const transient = error instanceof DOMException && ['AbortError', 'UnknownError'].includes(error.name);
      if (transient && retries < 2) reserve([250, 1000][retries++]!);
      // Only a new operation may restart a permanent failure. Requests received while busy survive it.
      if (nextDue !== undefined) reserve(Math.max(0, nextDue - performance.now()));
    } finally {
      state.writing = false;
      service();
    }
  }
  function flush() { setExpiry(); leaving = true; reserve(0); leaving = false; }
  /** Leaving the tab writes now, open History windows too. */
  function leave() { leavingWrite = true; flush(); }
  state.wake = flush;
  const stopCache = client.getQueryCache().subscribe(event => {
    const query = event.query; queryWriters.set(query, state);
    if (event.type === 'removed' && !state.globalRemoval && hasPendingReadRefusal(query, client)) terminateWriter(client, state, 'Read refusal removed before storage commit');
    checkPins();
    // Files, host polling and other reads outside this codec have no checkpoint slot to change.
    // Their cache activity must not renew active slots and clone those payloads into IndexedDB.
    if ((event.type === 'removed' || event.type === 'observerAdded' || event.type === 'observerRemoved'
      || event.type === 'updated' && ['success', 'error', 'invalidate'].includes(event.action.type))
      && readCodec(query.queryKey)) { state.intent++; schedule(); }
  });
  const stopReads = subscribe(event => {
    if (state.stopped || state.terminal) return;
    if (event.kind === 'clear' || event.kind === 'live' && event.scopeChanged) {
      state.globalRemoval = true; queueMicrotask(() => { state.globalRemoval = false; });
      state.localEpoch++; state.intent++; state.erase = true; clearTimers(); reserve(0);
    } else if (event.kind === 'remove') { state.localEpoch++; state.intent++; state.revoke = true; checkPins(); reserve(0); }
    if (event.kind === 'live') useReadPersistence.setState({ restoredAt: null });
    if (event.kind !== 'clear') schedule();
  });
  const hidden = () => { if (document.visibilityState === 'hidden') leave(); };
  document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leave);
  checkPins(); schedule();
  return () => { state.stopped = true; state.generation++; state.localEpoch++; state.pinsActive = false; state.wake = undefined; clearTimers(); stopCache(); stopReads();
    document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leave); state.db?.close(); };
}
