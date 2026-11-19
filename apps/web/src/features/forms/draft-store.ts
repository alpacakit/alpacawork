import { captureReadBoundary, sameReadSession } from '@/data/read-model';
import { queryClient } from '@/data/query-client';
import { isLiveWrite, useWriteIntentStore, type WriteIntent } from '@/data/write-intent';
import { taskIdSchema } from '@alpacawork/contract';
import { editProjectedInput, projectInput, remapInputOwnership, type InputEdit } from '@/features/coordinator/editor/input-ownership';
import { documentSchema } from "@/features/coordinator/editor/document";
import { useMemo } from "react";
import { create } from "zustand";
import { z } from "zod";
import { useWorkspaceInfo } from "@/data/queries";

const entrySchema = z.object({
  values: z.record(z.string(), z.string()),
  /** A captured form edition; a later opening, edit or settlement invalidates it. */
  revision: z.string().optional(),
  expected: z.string().optional(),
  original: z.string().optional(),
  latest: z.object({ hash: z.string(), context: z.string() }).optional(),
  status: z.enum(["editing", "saved"]),
}).strict();
export type DraftEntry = z.infer<typeof entrySchema>;
const storageKey = "alpacawork-input-drafts-v10";
const STORED_VERSION = 6;
/** The inputs a draft is kept for; one of another (an input since removed, such as the body editor) is let go. */
const INPUTS = ["coordinator", "project"] as const;
const identitySchema = z.tuple([z.string(), z.enum(INPUTS), z.string().nullable()]);
/**
 * The stored drafts without those of inputs that no longer exist: they are dropped one by one, so the drafts of the
 * inputs that remain are still read. A draft of a known input that does not read as one still refuses the store.
 */
function withoutRemovedInputs(stored: unknown): unknown {
  if (!stored || typeof stored !== "object" || !("entries" in stored) || !stored.entries || typeof stored.entries !== "object") return stored;
  const removed = (key: string) => {
    try {
      const identity: unknown = JSON.parse(key);
      return Array.isArray(identity) && typeof identity[1] === "string" && !(INPUTS as readonly string[]).includes(identity[1]);
    } catch { return false; }
  };
  return { ...stored, entries: Object.fromEntries(Object.entries(stored.entries).filter(([key]) => !removed(key))) };
}
const storageSchema = z.object({ version: z.literal(STORED_VERSION), entries: z.record(z.string(), entrySchema) }).strict().superRefine(({ entries }, context) => {
  for (const [key, entry] of Object.entries(entries)) {
    try {
      const [, operation, task] = identitySchema.parse(JSON.parse(key));
      const fields = operation === "project" ? ["name", "cwd", "parent"] : ["doc", "requestId"];
      if (fields.some(field => typeof entry.values[field] !== "string")) throw new Error("Missing field");
      if (operation === "coordinator") documentSchema.parse(JSON.parse(entry.values.doc ?? ""));
      if (operation !== "coordinator" && task !== null) taskIdSchema.parse(task);
      if (operation !== "project" && task === null) throw new Error("Missing task");
    } catch { context.addIssue({ code: "custom", message: "Invalid retained draft", path: ["entries", key] }); }
  }
});
export const restoredDraftKeys = new Set<string>();
export function readDrafts(): { entries: Record<string, DraftEntry>; unavailable: boolean } {
  try {
    const raw = sessionStorage.getItem(storageKey);
    const entries = raw ? storageSchema.parse(withoutRemovedInputs(JSON.parse(raw))).entries : {};
    for (const key of Object.keys(entries)) restoredDraftKeys.add(key);
    return { entries, unavailable: false };
  } catch { return { entries: {}, unavailable: true }; }
}
export const useDraftStore = create<{ entries: Record<string, DraftEntry>; unavailable: boolean }>(() => readDrafts());
/** A storage fault keeps every input but closes further draft admission in this tab. */
export const draftStorageUnavailable = () => useDraftStore.setState({ unavailable: true });
/** The one storage write: a storage that refuses it is unavailable from then on. Whether the page keeps what it could not store is the caller's. */
function persist(entries: Record<string, DraftEntry>): boolean {
  if (useDraftStore.getState().unavailable) return false;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ version: STORED_VERSION, entries }));
    return true;
  } catch {
    draftStorageUnavailable();
    return false;
  }
}
export function writeDrafts(entries: Record<string, DraftEntry>, edit?: { input: string; change: InputEdit }): boolean {
  // Keep the in-memory draft either way. The write intent refuses the request if its own snapshot cannot persist.
  entries = remapInputOwnership(useDraftStore.getState().entries, entries, edit);
  const stored = persist(entries);
  useDraftStore.setState({ entries });
  return stored;
}
/** Several entries change in one storage write, published only after it succeeds (`writeDrafts` keeps them in memory instead). */
export function commitDrafts(entries: Record<string, DraftEntry>): boolean {
  entries = remapInputOwnership(useDraftStore.getState().entries, entries);
  if (!persist(entries)) return false;
  useDraftStore.setState({ entries });
  return true;
}
/** What a `draftKey` names: its workspace, its operation and its slot. */
export const draftIdentity = (key: string) => JSON.parse(key) as [root: string, operation: string, task: string | null];
export function draftKey(root: string, operation: string, task: string | null) {
  return JSON.stringify([root, operation, task]);
}
export function updateDraft(key: string, change: Partial<DraftEntry>, edit?: InputEdit): boolean {
  const state = useDraftStore.getState();
  const entry = state.entries[key];
  return !!entry && writeDrafts({ ...state.entries, [key]: { ...entry, ...change, revision: crypto.randomUUID() } }, edit && { input: key, change: edit });
}
/** Transfer a loading draft atomically: a failed storage write never discards its words. */
export function transferDraft(sourceKey: string, targetKey: string, merge: (source: DraftEntry, target?: DraftEntry) => DraftEntry): boolean {
  const state = useDraftStore.getState(), source = state.entries[sourceKey];
  if (!source || state.unavailable) return false;
  const target = state.entries[targetKey];
  const merged = merge(source, target && { ...target, values: projectInput(state.entries, targetKey)! });
  const entries = target ? editProjectedInput(state.entries, targetKey, merged.values) : { ...state.entries, [targetKey]: merged };
  delete entries[sourceKey];
  return writeDrafts(entries);
}
export function discardDraft(key: string): boolean {
  const state = useDraftStore.getState();
  const entry = state.entries[key];
  if (state.unavailable || !entry) return false;
  const entries = { ...state.entries };
  delete entries[key];
  return writeDrafts(entries);
}
export function useStoredDraft(operation: string, task: string | null, initial: () => Omit<DraftEntry, "status">) {
  const root = useWorkspaceInfo((info) => info.root);
  const key = draftKey(root, operation, task);
  // Initialization is synchronous; there is never a second local copy to sync with an effect.
  const opened = useMemo(() => {
    const existing = useDraftStore.getState().entries[key];
    // Opening retained words starts another editing opportunity. An older operation can settle its closed draft,
    // but cannot mark this opening saved (or clear it), even before the person types again.
    const retained: DraftEntry = !existing || existing.status === "saved" ? { ...initial(), status: "editing" } : existing;
    const entry = { ...retained, revision: crypto.randomUUID() };
    writeDrafts({ ...useDraftStore.getState().entries, [key]: entry });
    return entry;
  }, [key]);
  const entry = useDraftStore((state) => state.entries[key]) ?? opened;
  const unavailable = useDraftStore((state) => state.unavailable);
  const change = (name: string, value: string) => {
    const current = useDraftStore.getState().entries[key];
    // An input event starts a new editable edition, including an opening kept across an older confirmation.
    if (current) updateDraft(key, { status: "editing", values: { ...current.values, [name]: value } });
  };
  return { key, entry, unavailable, change };
}

// Live attempts retain the initiating read session; a reload has no old callback/session to revive.
const formBoundaries = new Map<string, { revision: string; boundary: ReturnType<typeof captureReadBoundary> }>();

/** Link the immutable operation to this edition, before admitting it. */
export function captureFormDraft(key: string) {
  if (!updateDraft(key, {})) throw new Error('Cannot retain form draft');
  const entry = useDraftStore.getState().entries[key]!;
  formBoundaries.set(key, { revision: entry.revision!, boundary: captureReadBoundary(queryClient) });
  return { draft: { ...entry.values }, formDraft: { key, revision: entry.revision! } };
}

/** Initial delivery, Check and boot confirmation all settle through the operation's saved final state.
 * The edition and values guard also makes replay idempotent, without touching newer input.
 * Unknown, refusal and cancellation keep the editable original.
 */
function settleFormDraft(entry: WriteIntent) {
  if (!entry.formDraft || isLiveWrite(entry.status)) return;
  const { key, revision } = entry.formDraft;
  const live = formBoundaries.get(key);
  const boundary = live?.revision === revision ? live.boundary : undefined;
  if (live?.revision === revision) formBoundaries.delete(key);
  if (entry.status !== 'confirmed') return;
  const current = useDraftStore.getState().entries[key];
  if (!current || current.revision !== revision || JSON.stringify(current.values) !== JSON.stringify(entry.draft)) return;
  // A late response from a departed read session confirms transport only. Invalidate this edition so a later boot
  // cannot reapply that old completion to an input opened in the new session (including generation ABA).
  if (boundary && !sameReadSession(queryClient, boundary)) { updateDraft(key, {}); return; }
  updateDraft(key, { status: 'saved' });
}
// Like the two stores, this projection lives for the page, not for a mounted form or an attempt's promise.
useWriteIntentStore.subscribe((state, before) => {
  for (const [key, entry] of Object.entries(state.entries)) if (entry !== before.entries[key]) settleFormDraft(entry);
});
for (const entry of Object.values(useWriteIntentStore.getState().entries)) settleFormDraft(entry);
