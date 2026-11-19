import { i18n } from '@alpacawork/i18n';
import { provenWriteIdentity, rememberWriteIdentity } from './write-identity';
import { writeRestoreId } from './connection';
import { endSendGrace, holdSendGrace, writeGraceMs, type CancelResult } from './send-grace';
import { directOperation, operationUse, undoOfferCopy, writeOperation } from './write-operation';
import { countUse } from '@/features/telemetry/count';
import { workspaceWriteBasis, type WriteBasis } from './connection';
import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod";
import { problemErrorSchema } from "@alpacawork/contract/problem";
import { ApiError, retryOf } from "./client";

/** Frozen display identity of a direct state report; it is never an HTTP or conversation intent. */
const directReaderSchema = z.object({ taskId: z.string(), title: z.string(), turn: z.string(), phase: z.string(),
  answer: z.enum(['done', 'hold', 'stop']).nullable(), recovery: z.enum(['done', 'hold', 'stop', 'restore']) }).strict();
type DirectReader = z.infer<typeof directReaderSchema>;
export type WriteOptions = { reader?: DirectReader; draft?: Record<string, string>; formDraft?: { key: string; revision: string }; admitted?: (entry: WriteIntent) => void };

/** A write is a separate fact from the server's committed task. This record only describes the browser's attempt. */
const entrySchema = z.object({
  status: z.enum(["waiting", "cancelled", "pending", "confirmed", "refused", "conflict", "unconfirmed"]),
  operationId: z.string(),
  due: z.number().optional(),
  recovery: z.object({ path: z.string(), response: z.enum(["task", "placement", "stop", "settings", "personal"]), label: z.string(),
    outcomes: z.literal('all').optional(), body: z.record(z.string(), z.unknown()).optional() }).strict().optional(),
  /** Every write is sent with its operation ID, which the server answers again for a resend. */
  transport: z.literal("receipt"),
  payload: z.unknown(),
  draft: z.record(z.string(), z.string()).optional(),
  formDraft: z.object({ key: z.string(), revision: z.string() }).strict().optional(),
  reader: directReaderSchema.optional(),
  failure: problemErrorSchema.extend({ code: z.string() }).optional(),
  attempt: z.string(),
  at: z.string(),
}).strict();
export type WriteIntent = z.infer<typeof entrySchema>;
export function writeIntentFailure(entry: WriteIntent | undefined) {
  const failure = entry?.failure;
  return failure && new ApiError(failure.message, failure.code, failure.retry, failure.detail, failure.issues, failure.reason);
}
type WriteIntentStatus = "editing" | Exclude<WriteIntent["status"], 'waiting' | 'cancelled'>;
export const intentStatus = (entry?: WriteIntent): WriteIntentStatus => entry?.status === 'waiting' ? 'pending' : entry?.status === 'cancelled' ? 'editing' : entry?.status ?? 'editing';
export type Submission<T> = { kind: 'accepted'; id: string; result: Promise<T> } | { kind: 'rejected'; reason: string };
export const admissionError = (reason: string) => new ApiError(reason, 'unavailable', 'check');
export const reloadedWrites = new Set<string>();
export const reloadedWaiting = new Set<string>();
const cancellations = new Map<string, () => void>();
type SavedRequest = { path: string; response: NonNullable<WriteIntent['recovery']>['response']; body: Record<string, unknown> };
const storageKey = "alpacawork-write-intents-v5";
const storageSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), entrySchema) }).strict();

/**
 * One write's place: the workspace, the operation and what it is about (a Task `T42`, a project Task for its settings,
 * or null). Writes about the same thing wait on one another (`busyOnTask`).
 */
export function intentKey(root: string, operation: string, about: string | null) {
  return JSON.stringify([root, operation, about]);
}

export function intentKeyParts(key: string) {
  const [root, operation, about] = JSON.parse(key) as [string, string, string | null];
  return { root, operation, about };
}

export function readWriteIntents(): { entries: Record<string, WriteIntent>; unavailable: boolean } {
  try {
    const raw = sessionStorage.getItem(storageKey);
    const entries = raw ? storageSchema.parse(JSON.parse(raw)).entries : {};
    // Neither an interrupted request nor a lost response proves the server's result.
    // Recheck every unresolved delivery after connecting, before publishing its old failure.
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.status === "waiting") reloadedWaiting.add(key);
      if (entry.status === "pending" || entry.status === "unconfirmed") { entry.status = "unconfirmed"; reloadedWrites.add(key); }
      if (entry.payload !== undefined) entry.payload = snapshot(entry.payload);
      if (entry.recovery) entry.recovery = snapshot(entry.recovery);
      if (entry.reader) entry.reader = snapshot(entry.reader);
      if (entry.draft) entry.draft = snapshot(entry.draft);
      if (entry.failure) entry.failure = snapshot(entry.failure);
    }
    return { entries, unavailable: false };
  } catch { return { entries: {}, unavailable: true }; }
}

export const useWriteIntentStore = create<{ entries: Record<string, WriteIntent>; unavailable: boolean }>(() => readWriteIntents());

/** Follow only a new operation admitted during this subscription. A Check changes its attempt, not its identity.
 * Admission is observed synchronously, even when React batches pending and confirmed into one render.
 * The caller owns what confirmation does and qualifies the opening/read session it may affect.
 */
export function watchNewWriteConfirmation(key: string, onConfirmed: () => void) {
  let operationId: string | undefined;
  const check = () => {
    const entry = useWriteIntentStore.getState().entries[key];
    if (operationId === undefined || entry?.operationId !== operationId || entry.status !== 'confirmed') return;
    operationId = undefined;
    onConfirmed();
  };
  const stop = useWriteIntentStore.subscribe((state, previous) => {
    const entry = state.entries[key];
    if ((entry?.status === 'pending' || entry?.status === 'waiting') && entry.operationId !== previous.entries[key]?.operationId) operationId = entry.operationId;
    check();
  });
  return { check, stop: () => { operationId = undefined; stop(); } };
}

function write(entries: Record<string, WriteIntent>): boolean {
  const state = useWriteIntentStore.getState();
  if (state.unavailable) return false;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, entries }));
    useWriteIntentStore.setState({ entries });
    return true;
  } catch {
    useWriteIntentStore.setState({ unavailable: true });
    return false;
  }
}

function replace(key: string, entry: WriteIntent | undefined): boolean {
  const entries = { ...useWriteIntentStore.getState().entries };
  if (entry) {
    // String-key insertion order is the persisted admission order, independent of the wall clock. Settling or
    // retrying the same operation keeps its place; a new operation in a reused slot takes the newest place.
    if (entries[key]?.operationId !== entry.operationId) delete entries[key];
    entries[key] = entry;
  } else delete entries[key];
  return write(entries);
}

function finish(key: string, attempt: string, status: WriteIntent["status"], error?: unknown) {
  const current = useWriteIntentStore.getState().entries[key];
  if (current?.attempt === attempt && current.status === "pending") replace(key, { ...current, status, failure: error instanceof ApiError
      ? { code: error.code, message: error.message, retry: error.retry, reason: error.reason, detail: error.detail, issues: [...error.issues] } : error === undefined ? undefined : { code: 'client_error', message: String(error), retry: 'fix' } });
}

/** A write still under way: waiting to go, going, or gone without a known result. Nothing else may start beside it. */
export const isLiveWrite = (status: WriteIntent["status"] | undefined) => status === "waiting" || status === "pending" || status === "unconfirmed";

export function busyOnTask(entries: Record<string, WriteIntent>, key: string): boolean {
  const { root, about: task } = intentKeyParts(key);
  if (task === null) return false;
  return Object.entries(entries).some(([other, entry]) => {
    if (other === key || !isLiveWrite(entry.status)) return false;
    const { root: otherRoot, about: otherTask } = intentKeyParts(other);
    return root === otherRoot && task === otherTask;
  });
}

async function deliver<Payload, Result>(key: string, record: WriteIntent, send: (payload: Payload, operationId: string, basis?: WriteBasis, keepalive?: boolean) => Promise<Result>, basis?: WriteBasis, keepalive = false): Promise<Result> {
  try {
    const result = await send(JSON.parse(JSON.stringify(record.payload)) as Payload, record.operationId, basis, keepalive);
    finish(key, record.attempt, "confirmed");
    return result;
  } catch (error) {
    finish(key, record.attempt, retryOf(error) === "check" ? "unconfirmed" : retryOf(error) === "reread" ? "conflict" : "refused", error);
    throw error;
  }
}

// The stored request is a JSON snapshot, never a live reference to editable input or a transport's mutable object.
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, each: unknown) => each && typeof each === "object" ? Object.freeze(each) : each) as T;
}

/** Non-React callers share the same admission and durable snapshot as the hook. */
export function submitWriteIntent<Payload, Result>(key: string, build: (operationId: string) => Payload,
  send: (payload: Payload, operationId: string, basis?: WriteBasis, keepalive?: boolean) => Promise<Result>, operationId: string = crypto.randomUUID(), draft?: Record<string, string>, recovery?: WriteIntent["recovery"], options?: WriteOptions): Promise<Result> | undefined {
  const current = useWriteIntentStore.getState();
  const held = current.entries[key];
  if (current.unavailable || busyOnTask(current.entries, key) || held?.status === "waiting" || held?.status === "pending" || held?.status === "unconfirmed") return;
  const [root] = JSON.parse(key) as [string];
  try { rememberWriteIdentity(root,operationId,writeRestoreId(root)); }
  catch { useWriteIntentStore.setState({unavailable:true}); return; }
  const facts = directOperation(key, build(operationId), recovery?.label ?? '');
  if (options?.draft?.choice) facts.subject.action = `report:${options.draft.choice}`;
  const grace = writeOperation(facts).grace === 'deferred' ? writeGraceMs() : 0;
  const record: WriteIntent = { status: grace > 0 ? "waiting" : "pending", due: grace > 0 ? Date.now() + grace : undefined, operationId, transport: "receipt", payload: snapshot(facts.payload), formDraft: options?.formDraft && snapshot(options.formDraft), reader: options?.reader && snapshot(options.reader), draft: (options?.draft ?? draft) && snapshot(options?.draft ?? draft), recovery: recovery && snapshot(recovery), attempt: crypto.randomUUID(), at: new Date().toISOString() };
  if (!replace(key, record)) return;
  let result: Promise<Result>;
  if (record.status === 'waiting') {
    result = new Promise<Result>((resolve, reject) => {
      cancellations.set(record.operationId, () => reject(new ApiError('Operation cancelled before sending', 'cancelled', 'fix')));
      holdSendGrace({ id: record.operationId, until: record.due!, document,
        cancel: () => cancelWaitingWrite(key), start: keepalive => {
          const held = useWriteIntentStore.getState().entries[key];
          if (held?.operationId !== record.operationId || held.status !== 'waiting') return;
          const pending = { ...held, status: 'pending' as const };
          if (!replace(key, pending)) { reject(admissionError('Cannot save delivery start')); return; }
          cancellations.delete(record.operationId);
          void deliver(key, pending, send, undefined, keepalive).then(resolve, reject);
        } }, { id: record.operationId, at: Date.parse(record.at), until: record.due!, from: document, ...undoOfferCopy(facts) });
    });
    // Admission has its own result channel; a control may close before anyone awaits delivery.
    void result.catch(() => {});
  } else result = deliver(key, record, send);
  options?.admitted?.(record);
  countUse(operationUse(facts));
  return result;
}

/**
 * Whether this tab still holds the evidence an admitted operation needs to go again. One fact: the check obeys it and
 * every place that offers the check reads it, so nothing offers what the check would refuse.
 */
export function canCheckWrite(root: string, operationId: string): boolean {
  return provenWriteIdentity(root, operationId) !== null;
}

/** The direct-write owner decides whether a check can preserve its attempt, and why it cannot. */
export function writeCheckFailure(root: string, operationId: string): ApiError | undefined {
  if (useWriteIntentStore.getState().unavailable) return new ApiError(() => i18n.t('forms:draft.storageUnavailable'), 'unavailable', 'check');
  if (!canCheckWrite(root, operationId)) return new ApiError(() => i18n.t('forms:writeFailure.unproven'), 'write_unavailable', 'check');
}

/** Explicit confirmation resends the same immutable snapshot under its operation ID; the server answers it again. */
export function checkWriteIntent<Payload, Result>(key: string, send: (payload: Payload, operationId: string, basis?: WriteBasis, keepalive?: boolean) => Promise<Result>, resume = false) {
  const held = useWriteIntentStore.getState().entries[key];
  if (!held || held.status !== "unconfirmed" && !(resume && held.status === "waiting")) return;
  const [root] = JSON.parse(key) as [string];
  // A persisted attempt is never a new admission, even when its epoch evidence is missing or unsupported.
  // Keep the original record for receipt lookup; absence after restore does not prove non-execution.
  const failure = writeCheckFailure(root, held.operationId);
  if (failure) return Promise.reject(failure);
  endSendGrace(held.operationId);
  const record = { ...held, status: "pending" as const, attempt: crypto.randomUUID() };
  if (!replace(key, record)) return Promise.reject(admissionError('Cannot preserve the confirmation attempt'));
  const confirmation = Object.freeze({});
  confirmations.set(confirmation, { root, payload: JSON.stringify(record.payload), opId: record.operationId, key, attempt: record.attempt });
  const basis: WriteBasis = { ...workspaceWriteBasis(), root, kind: 'confirmation', confirmation };
  return deliver(key, record, send, basis);
}

/** New submission never substitutes an older fixed request. Checking it is an explicit, separate command. */
export async function sendWriteIntent<Payload, Result>(key: string, build: (operationId: string) => Payload,
  send: (payload: Payload, operationId: string, basis?: WriteBasis, keepalive?: boolean) => Promise<Result>, recovery: NonNullable<WriteIntent["recovery"]>, options?: WriteOptions): Promise<Result> {
  const result = submitWriteIntent(key, build, send, undefined, undefined, recovery, options);
  if (!result) throw new ApiError("Check the saved operation before submitting a new one, or check browser storage", "unavailable", "check");
  return result;
}

function cancelWaitingWrite(key: string): CancelResult {
  const entry = useWriteIntentStore.getState().entries[key];
  if (!entry) return 'gone';
  if (entry.status !== 'waiting') return 'already_dispatched';
  if (!replace(key, { ...entry, status: 'cancelled' })) throw admissionError('Cannot save cancellation');
  endSendGrace(entry.operationId);
  cancellations.get(entry.operationId)?.(); cancellations.delete(entry.operationId);
  return 'cancelled';
}

export function confirmWriteIntent(key: string): boolean {
  const held = useWriteIntentStore.getState().entries[key];
  return !!held && (held.status === "pending" || held.status === "unconfirmed") && replace(key, { ...held, status: "confirmed" });
}
export function conflictWriteIntent(key: string): boolean {
  const held = useWriteIntentStore.getState().entries[key];
  return !!held && held.status === "unconfirmed" && replace(key, { ...held, status: "conflict" });
}
function resetWriteIntent(key: string): boolean {
  const held = useWriteIntentStore.getState().entries[key];
  return !!held && !isLiveWrite(held.status) && replace(key, undefined);
}

/**
 * The writes whose result a place on screen is asking to be checked now (a dialog's own Check, from the press that made
 * it): the same check is not said a second time as a toast while that place shows it; when it closes, the toast takes
 * over (features/reader/recovery.tsx). Counted, as two places can show one.
 */
export const useCheckedHere = create<Readonly<Record<string, number>>>(() => ({}));
export function useCheckShownHere(key: string | undefined, shown: boolean) {
  useEffect(() => {
    if (!key || !shown) return;
    useCheckedHere.setState(state => ({ ...state, [key]: (state[key] ?? 0) + 1 }), true);
    return () => useCheckedHere.setState(state => {
      const { [key]: count = 1, ...rest } = state;
      return count > 1 ? { ...rest, [key]: count - 1 } : rest;
    }, true);
  }, [key, shown]);
}

/** What a write that did not go leaves to write again: what it would have sent, and the form's words. */
export const retainedInput = <Payload = unknown>(entry: WriteIntent | undefined) => entry && ['cancelled', 'refused', 'conflict'].includes(entry.status)
  ? { payload: entry.payload as Payload, draft: entry.draft } : undefined;

/** The only owner of admission, retry identity and the result of one write. Callers supply the operation and its display. */
export function useWriteIntent<Payload, Result>(key: string, request?: (input: Payload) => SavedRequest) {
  const entry = useWriteIntentStore(state => state.entries[key]);
  const unavailable = useWriteIntentStore(state => state.unavailable);
  const blocked = useWriteIntentStore(state => busyOnTask(state.entries, key));
  const status = intentStatus(entry);
  const submit = (build: (operationId: string) => Payload, send: (payload: Payload, operationId: string, basis?: WriteBasis, keepalive?: boolean) => Promise<Result>, operationId?: string, draft?: Record<string, string>) =>
    submitWriteIntent(key, build, send, operationId, draft, request ? (() => {
      const saved = request(build(operationId ?? ''));
      return { ...saved, label: intentKeyParts(key).about ?? '' };
    })() : undefined);
  const retrySame = (send: (payload: Payload, operationId: string, basis?: WriteBasis, keepalive?: boolean) => Promise<Result>): Promise<Result> | undefined => {
    return checkWriteIntent(key, send);
  };
  const reset = () => resetWriteIntent(key);
  const confirm = () => confirmWriteIntent(key);
  const conflict = () => conflictWriteIntent(key);
  const currentAttempt = () => useWriteIntentStore.getState().entries[key]?.attempt;
  const unproven = status === 'unconfirmed' && !!entry && !!writeCheckFailure(intentKeyParts(key).root, entry.operationId);
  return { status, unproven, retainedInput: retainedInput<Payload>(entry), payload: entry?.payload as Payload | undefined, draft: entry?.draft, operationId: entry?.operationId,
    at: entry?.at, failure: writeIntentFailure(entry), unavailable, blocked, submit, retrySame, reset, confirm, conflict, currentAttempt };
}

export type IntentConfirmation = object;
const confirmations = new WeakMap<IntentConfirmation, { root: string; payload: string; wire?: string; opId: string; key: string; attempt: string }>();
export function validIntentConfirmation(token: IntentConfirmation, root: string, payload?: unknown, opId?: string) {
  const proof = confirmations.get(token), entry = proof && useWriteIntentStore.getState().entries[proof.key];
  return !!proof && proof.root === root && entry?.attempt === proof.attempt && entry.status === 'pending'
    && entry.operationId === proof.opId && JSON.stringify(entry.payload) === proof.payload
    && (payload === undefined || JSON.stringify(payload) === (proof.wire ?? proof.payload) && opId === proof.opId);
}

/** An operation adapter translates its verified fixed input once, without changing the stored intent. */
export function bindIntentTransport(basis: WriteBasis, original: unknown, wire: unknown, opId: string | undefined): WriteBasis {
  if (basis.kind !== 'confirmation') return basis;
  const proof = confirmations.get(basis.confirmation), body = JSON.stringify(wire);
  if (!proof || !validIntentConfirmation(basis.confirmation, basis.root) || JSON.stringify(original) !== proof.payload || opId !== proof.opId || proof.wire !== undefined && proof.wire !== body)
    throw new ApiError('Recorded operation changed before transport', 'write_unavailable', 'later');
  proof.wire = body; return basis;
}
