import { writeRestoreId } from '@/data/connection';
import { rememberWriteIdentity, provenWriteIdentity } from '@/data/write-identity';
import { acceptDeliveryNotice, deliveryNoticeId, endDeliveryNotice } from '../delivery-notice';
import { i18n } from '@alpacawork/i18n';
import { notify } from '@/lib/notify';
import { graceReady, holdSendGrace, endSendGrace, writeGraceMs, type CancelResult } from '@/data/send-grace';
import { operationUse, writeOperation, type OperationFacts } from '@/data/write-operation';
import { countUse } from '@/features/telemetry/count';
import { expectedTaskWrites, readerResult, readerSubmissionKey, readerSubmissionSchema, readerTurn, sameReaderTurn, type ReaderSubmission } from '@/features/reader/submission';
import { create } from 'zustand';
import { z } from 'zod';
import { coordinatorAnswersInputSchema, coordinatorIntentSchema, coordinatorMessageDigest } from '@alpacawork/contract/coordinator';
import { commitDrafts, draftStorageUnavailable, draftIdentity, draftKey, restoredDraftKeys, useDraftStore, type DraftEntry } from '@/features/forms/draft-store';
import type { CoordinatorConversation } from '@/data/coordinator';
import type { Task } from '@/data/types';
import { attachmentLocation, attachmentsOf, attachmentsToCopy } from '@/domain/attachments';
import { coordinatorFileUrl } from '@alpacawork/contract';
import { draftDocument, emptyDocument, hasContent, filterDocument, inlines, markReaderOperation, replyIn, taskReferencesIn, type Document } from './document';
import { composing, restored, submitted } from './lifecycle';
import { EDITABLE_INTENT_FIELDS, editableIntentValues, withoutEditableIntent } from './editable-intent';
import { claimInput, consumeInput, retainedInput, retainingInput, recoverRetainedInput, projectInput, editProjectedInput, INPUT_PORTION } from './input-ownership';
import { rememberSent } from '../sent-here';
import { clearingConversation } from '../press';

/**
 * What is sent to the coordinator, from the press until a snapshot of the conversation holds it: one fixed request per
 * request ID, kept on this device (in the drafts' storage, as `coordinator` / `send:<id>`) apart from the input's draft,
 * while the input retains its words until admission is proven. The input's draft and an intent pressed in the reader (its one
 * line and the intent, reader-send.ts) are fixed and sent alike. Every send, resend and resolution passes through here.
 *
 * - `queued`: fixed on this device, awaiting its delivery turn.
 * - `checking`: its answers and skills are being checked and its attachment references copied. Copy receipts resolve
 *   storage names; they are fixed with the posted checkpoint before the message can go to serve.
 * - `posted`: it may have reached serve (its POST went, or was about to). Not known to be accepted: only a snapshot
 *   with its turn (as sent: same words, context and files), or its withdrawal, says so.
 * - `accepted`: HTTP admission is proven; a reader's original input stays until its write result is definitive.
 * - `settled`: only a successful reader submission's identity remains, until the observed Task leaves its turn.
 *   It has no original input or fixed payload and is never drawn as an outgoing message.
 * - `refused`: it did not go, or serve refused it; its words and files wait to go back to the input. `conflict`: serve
 *   holds other words under its ID, so it is never taken for that turn, nor sent again under that ID.
 *
 * While one is checking or posted, nothing new is sent to that conversation (resending the same one is), so serve
 * accepts them in the order they were written. An accepted or refused one does not hold the next.
 */
type Stage = 'queued' | 'checking' | 'posted' | 'accepted' | 'refused';
const fixedSchema = z.object({ conversationId: z.string(), text: z.string(), tasks: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(), attachments: z.array(z.string()), intent: coordinatorIntentSchema.optional(),
  answers: coordinatorAnswersInputSchema.optional(), replyTo: z.string().nullable().optional() });
export type Fixed = z.infer<typeof fixedSchema>;
/** The fixed request and the reader's bindings as this owner stores them in a record's values. */
const fixedOf = (values: Record<string, string>): Fixed => fixedSchema.parse(JSON.parse(values.submitted!));
const readersOf = (reader: string): ReaderSubmission[] => readerSubmissionSchema.array().parse(JSON.parse(reader));
/** `taken`: a conflicting request whose words went back to the input; kept only so its ID stays apart from that turn. */
/**
 * `files`: where each of `fixed.attachments` can be read now, in order. A resend's files stay where the input saved
 * them (a cancelled message's folder) until delivery copies them under its own ID, so its row draws them from there.
 */
export type Outgoing = { key: string; requestId: string; stage: Stage; fixed: Fixed; files: string[]; doc: Document; refusal: string | null; at: string; due?: number; cancelled: boolean; taken: boolean; reader: ReaderSubmission[] | null; returned: string[]; last: 'ask' | 'withdraw' };
/** A read-only presentation of one outbox state. Both kinds of unsent row are canonically `queued`;
 * the deadline alone selects the approved grace display, then the previous-send display. */
export type OutgoingDisplay = { due?: number; stage: 'waiting' | 'queued' | 'sending' | 'unknown' | 'refused' | 'cancelled';
  last?: 'ask' | 'withdraw'; cancelled?: boolean; refusal: string | null; blocked?: boolean };
/** The existing request ID is also its transport operation ID. No continuation may establish new epoch evidence. */
export type OutgoingBlock = 'unproven' | 'restored';
export const outgoingBlockText = (block: OutgoingBlock) => i18n.t(block === 'unproven' ? 'forms:writeFailure.unproven' : 'problem.code.restore_changed');
export function outgoingBlock(root: string, requestId: string): OutgoingBlock | null {
  const pin = provenWriteIdentity(root, requestId);
  if (pin === null) return 'unproven';
  const current = writeRestoreId(root);
  return current !== null && pin !== current ? 'restored' : null;
}
export function outgoingDisplay(item: Outgoing, live: boolean): OutgoingDisplay {
  const blocked = outgoingBlock(draftIdentity(item.key)[0], item.requestId);
  if (item.last === 'ask' && blocked && ['queued', 'checking', 'posted'].includes(item.stage)) return { stage: 'unknown', last: item.last, cancelled: item.cancelled, refusal: outgoingBlockText(blocked), blocked: true };
  const stage = item.stage === 'refused' ? item.last === 'withdraw' && !item.cancelled ? 'cancelled' : 'refused'
    : live || item.stage === 'accepted' ? 'sending'
    : item.stage === 'queued' ? graceReady(item.due) ? 'queued' : 'waiting' : 'unknown';
  // Current cancellation cannot prove the earlier send's result; both row and folded words read this fact.
  if (stage === 'cancelled' && blocked) return { stage, last: item.last, cancelled: item.cancelled, refusal: i18n.t('ui:coordinatorCard.withdrawKeptUnknown'), blocked: true };
  return { stage, last: item.last, cancelled: item.cancelled, refusal: item.refusal, due: item.due };
}
/** All surfaces use the same terminal classification of the outbox's display states. */
export const outgoingFinished = (item: Pick<OutgoingDisplay, 'stage'>) => item.stage === 'refused' || item.stage === 'cancelled';
/** A later recovery outcome must not hide a still unresolved send in the folded conversation. */
export function latestOutgoing<T extends OutgoingDisplay>(items: readonly T[]): T | undefined {
  return items.filter(item => !outgoingFinished(item)).at(-1) ?? items.at(-1);
}
/** The fields this owner adds to the draft's own values; taken off again when the words go back to the input. */
const OWN = [INPUT_PORTION, 'due', 'cancelled', 'last', 'submitted', 'stage', 'from', 'fresh', 'at', 'refusal', 'conflict', 'taken', 'reader', ...EDITABLE_INTENT_FIELDS, 'readerCopies', 'readerReturned', 'readerDraftTask', 'readerDraftTurn'] as const;

const PREFIX = 'send:';
export const outgoingKey = (root: string, requestId: string) => draftKey(root, 'coordinator', `${PREFIX}${requestId}`);
const isOutgoing = (key: string) => draftIdentity(key)[2]?.startsWith(PREFIX) ?? false;
export const isOutgoingIn = (key: string, root: string) => draftIdentity(key)[0] === root && isOutgoing(key);

/**
 * The attempts under way in this page (an attempt is live from its press, or resend, until its answer is taken), and
 * the input's way of resending one as it was (the input owns sending; the thread's rows ask it).
 */
export const useOutbox = create<{ live: ReadonlySet<string>; resend: ((requestId: string, keepalive?: boolean, leaving?: boolean) => Promise<unknown>) | null; cancelled?: (requestId: string) => void }>(() => ({ live: new Set(), resend: null }));
const liveKey = (key: string, intent: 'ask' | 'withdraw') => `${intent}:${key}`;
export const isLive = (key: string, intent?: 'ask' | 'withdraw', live = useOutbox.getState().live): boolean =>
  intent ? live.has(liveKey(key, intent)) : isLive(key, 'ask', live) || isLive(key, 'withdraw', live);
function startLive(key: string, intent: 'ask' | 'withdraw') {
  const at = liveKey(key, intent);
  useOutbox.setState(state => ({ live: new Set([...state.live, at]) }));
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    useOutbox.setState(state => { const live = new Set(state.live); live.delete(at); return { live }; });
  };
}

function read(key: string, entry: DraftEntry): Outgoing | null {
  const stage = entry.values.stage;
  if (entry.status !== 'editing' || (stage !== 'queued' && stage !== 'checking' && stage !== 'posted' && stage !== 'accepted' && stage !== 'refused')) return null;
  try {
    const fixed = fixedOf(entry.values);
    const doc = draftDocument(entry.values);
    return { key, requestId: entry.values.requestId!, stage, fixed, files: savedFiles(entry.values, entry.values.requestId!, fixed.attachments), doc, refusal: entry.values.refusal ?? null, at: entry.values.at ?? '', due: entry.values.due ? Number(entry.values.due) : undefined, cancelled: entry.values.cancelled === '1', taken: !!entry.values.taken, last: entry.values.last === 'withdraw' ? 'withdraw' : 'ask', reader: entry.values.reader ? readersOf(entry.values.reader) : null, returned: returnedSubmissions(entry.values) };
  } catch { return null; }
}
function savedFiles(values: Record<string, string>, requestId: string, names: readonly string[]) {
  const saved = attachmentsOf(values);
  return saved.length === names.length
    ? saved.map(file => { const at = attachmentLocation(file); return coordinatorFileUrl(at.requestId, at.name); })
    : names.map(name => coordinatorFileUrl(requestId, name));
}
/** One fixed request by its ID, or null when this device holds none. */
export function outgoingItem(entries: Record<string, DraftEntry>, root: string, requestId: string): Outgoing | null {
  const key = outgoingKey(root, requestId), entry = entries[key];
  return entry ? read(key, entry) : null;
}
/** This conversation's fixed requests, oldest first. */
export function outgoing(entries: Record<string, DraftEntry>, root: string, conversationId?: string): Outgoing[] {
  return Object.entries(entries).flatMap(([key, entry]) => {
    if (!isOutgoingIn(key, root)) return [];
    const item = read(key, entry);
    return item && (conversationId === undefined || item.fixed.conversationId === conversationId) ? [item] : [];
  }).sort((a, b) => a.at.localeCompare(b.at));
}
/** Accepted by a snapshot that was not drawn: a drawn one is still to come. */
export const awaitsDrawing = (entries: Record<string, DraftEntry>, root: string, conversation: CoordinatorConversation) =>
  outgoing(entries, root, conversation.id).some(item => item.stage === 'accepted' && !item.reader && !conversation.turns.some(turn => turn.id === item.requestId));
/** A withdrawal asked of serve whose answer has not settled it: live here, or left unknown. */
export const awaitsWithdrawal = (item: { stage?: string; last?: string }) => item.last === 'withdraw' && item.stage === 'posted';
const awaitsAdmission = (item: Outgoing) => (item.stage === 'queued' || item.stage === 'checking' || item.stage === 'posted') && (item.last === 'withdraw' || !outgoingBlock(draftIdentity(item.key)[0], item.requestId));
/** The fixed records relevant to reader turns, apart from editable input and other workspaces. */
const isReaderTurnEntry = (key: string, entry: DraftEntry, root: string): entry is DraftEntry & { values: { reader: string } } =>
  isOutgoingIn(key, root) && !!entry.values.reader;
/** A read projection of the same records, retaining each authoritative entry's identity. */
export const readerTurnEntries = (entries: Record<string, DraftEntry>, root: string) =>
  Object.fromEntries(Object.entries(entries).filter(([key, entry]) => isReaderTurnEntry(key, entry, root)));

/** Each unreturned binding belongs to its fixed send, including the minimal fact kept after settlement. */
function readerTurnSubmissions(entries: Record<string, DraftEntry>, root: string, current: ReturnType<typeof readerTurn>) {
  return Object.entries(entries).flatMap(([key, entry]) => {
    if (!isReaderTurnEntry(key, entry, root) || entry.status !== 'editing') return [];
    const binding = readerSubmissionSchema.array().safeParse(JSON.parse(entry.values.reader));
    if (!binding.success) return [];
    const returned = returnedSubmissions(entry.values);
    return binding.data.filter(each => !returned.includes(readerSubmissionKey(each)) && sameReaderTurn(each, current))
      .map(submission => ({ submission, stage: entry.values.stage }));
  });
}
/** Whether a submission on the turn is not yet past `passed`; an explicit operation holds the turn even after its result. */
const holdsUntil = (passed: (stage: string | undefined) => boolean) =>
  (entries: Record<string, DraftEntry>, root: string, current: ReturnType<typeof readerTurn>) =>
    readerTurnSubmissions(entries, root, current).some(({ submission, stage }) => !passed(stage) || expectedTaskWrites(submission) !== null);
/**
 * The next message for the turn. A conversational answer (words or answer labels) holds it only until serve has
 * admitted it: the coordinator takes its messages in order, so the person can go on writing while it answers.
 */
export const holdsReaderTurn = holdsUntil(stage => stage === 'accepted' || stage === 'settled');
/** The card's own controls (Done, a press, a swipe) wait for a submission's result, so they never race the answer it carries. */
export const awaitsReaderResult = holdsUntil(stage => stage === 'settled');
/** The automatic deck skips a submitted turn until the Task leaves it, even when completed free text allows follow-up. */
export function hasReaderSubmission(entries: Record<string, DraftEntry>, root: string, current: ReturnType<typeof readerTurn>) {
  return readerTurnSubmissions(entries, root, current).length > 0;
}
/** A successful result releases the original input; its minimal submission fact lasts until a fresh Task observation ends that turn. */
export function observeReaderTurns(root: string, tasks: readonly Task[]) {
  const state = useDraftStore.getState();
  const remove = Object.entries(state.entries).filter(([key, entry]) => {
    if (!isReaderTurnEntry(key, entry, root) || entry.values.stage !== 'settled') return false;
    return readersOf(entry.values.reader).every(reader => { const task = tasks.find(task => task.id === reader.taskId); return !!task && !sameReaderTurn(reader, readerTurn(task)); });
  }).map(([key]) => key);
  if (remove.length) commitDrafts(Object.fromEntries(Object.entries(state.entries).filter(([key]) => !remove.includes(key))));
}
const deliveryHead = (entries: Record<string, DraftEntry>, root: string, conversationId: string) =>
  outgoing(entries, root, conversationId).find(awaitsAdmission);
/** Whether an unresolved delivery holds its followers. */
export const holds = (entries: Record<string, DraftEntry>, root: string, conversationId: string) => !!deliveryHead(entries, root, conversationId);

/** The sole delivery-order gate. A posted item needs explicit same-ID checking before its followers can go. */
export function nextDelivery(entries: Record<string, DraftEntry>, root: string, conversationId: string) {
  const first = deliveryHead(entries, root, conversationId);
  return first?.stage === 'queued' && graceReady(first.due) ? first : null;
}
/** File work stays with its request while the original input moves between the active and card-specific slots. */
export function inputDraftFiles(root: string, requestId: string) {
  return {
    project: projectInput,
    identity: draftKey(root, 'coordinator', `files:${requestId}`), locate: () =>
      Object.entries(useDraftStore.getState().entries).find(([name, entry]) => {
        const [workspace, kind] = draftIdentity(name);
        return workspace === root && kind === 'coordinator' && entry.values.requestId === requestId;
      })?.[0] ?? ''
  };
}
const parkedKey = (root: string, conversationId: string, taskId: string) => draftKey(root, 'coordinator', `reader-draft:${conversationId}:${taskId}`);
/** Saved words stay explicitly recoverable even after their question has ended; the UI only projects this owner. */
export const parkedReaderDraft = (entries: Record<string, DraftEntry>, root: string, conversationId: string, taskId: string): DraftEntry | null =>
  entries[parkedKey(root, conversationId, taskId)] ?? null;
/** A failed answer opens on its card; another card's unsent draft is moved aside, never copied or overwritten.
 * `blocked` means a payload remains but cannot safely enter this input; the recovery entrance must stay available.
 * false means there is nothing to move (or this input already holds it), rather than a failed recovery.
 * A panel observation supplies its current turn; explicit recovery may take back the original words for editing.
 */
export function restoreReaderDraft(root: string, conversationId: string, taskId: string | null, current?: ReturnType<typeof readerTurn>): boolean | 'blocked' {
  if (!taskId) return false;
  const entries = useDraftStore.getState().entries;
  const destination = draftKey(root, 'coordinator', conversationId), draft = entries[destination];
  // A prepared-looking input can still retain a pending message's body. Observation has no
  // authority to replace that input; explicit recovery keeps using the original's move below.
  if (current && pendingInput(entries, root, destination)) return false;
  // An editable draft already belongs to this card. A later failure must not overwrite those words.
  if (draft?.values.readerDraftTask === taskId) return false;
  const source = parkedKey(root, conversationId, taskId), saved = parkedReaderDraft(entries, root, conversationId, taskId);
  if (saved && draft) {
    // A returned answer retains its submitted turn when it moves into a draft. Browsing must not revive a past turn.
    if (current && saved.values.readerDraftTask) {
      const bound = saved.values.readerDraftTurn && readerSubmissionSchema.safeParse(JSON.parse(saved.values.readerDraftTurn));
      if (!bound || !bound.success || !sameReaderTurn(bound.data, current)) return false;
    }
    const parked = readerDraftRoom(destination, draft, taskId);
    if (!parked) return 'blocked';
    return commitDrafts(Object.fromEntries(Object.entries({ ...entries, ...parked, [destination]: saved }).filter(([key]) => key !== source))) || 'blocked';
  }
  const matches = (reader: ReaderSubmission, returned: readonly string[]) => reader.taskId === taskId &&
    returned.includes(readerSubmissionKey(reader)) && (!current || sameReaderTurn(reader, current));
  const item = outgoing(entries, root).find(item => !item.taken && item.reader?.some(reader => matches(reader, item.returned)));
  if (!item || isLive(item.key)) return false;
  const target = item.reader!.find(reader => matches(reader, item.returned))!;
  return restore(item.key, recoveryPlace(root, entries[item.key]!, destination), undefined, target) || 'blocked';
}

/** Result and source payload have separate lifetimes: preserve a failed payload until its card takes it back. */
const returnedSubmissions = (values: Record<string, string>): string[] => values.stage === 'refused' && values.reader
  ? readersOf(values.reader).map(readerSubmissionKey) : JSON.parse(values.readerReturned ?? '[]');
export function returnReaderSubmission(root: string, requestId: string, reason = '', target?: ReaderSubmission) {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  if (!entry?.values.reader) return;
  const readers = readersOf(entry.values.reader);
  const returned = [...new Set([...returnedSubmissions(entry.values), ...readers.filter(reader => !target || readerSubmissionKey(reader) === readerSubmissionKey(target)).map(readerSubmissionKey)])];
  write(key, values => ({
    ...values, readerReturned: JSON.stringify(returned),
    ...(readers.every(reader => returned.includes(readerSubmissionKey(reader))) ? { stage: 'refused', refusal: reason } : {})
  }));
}

/**
 * The press: what is sent becomes a fixed request under the request ID in `values` (with its words and files), in one
 * storage write. The input's draft (`input`) retains its words under a fresh ID in the same write; an
 * intent is a request of its own beside the draft, which it leaves as it is. A failed storage write submits nothing;
 * earlier requests stay ahead in delivery order.
 */
/** New user admission only. Continuations must read the immutable pin and never call this entrance. */
export function admitOutgoingIdentity(root: string, requestId: string): boolean {
  try { const epoch = writeRestoreId(root); return epoch !== null && rememberWriteIdentity(root, requestId, epoch) !== null; }
  catch { draftStorageUnavailable(); return false; }
}
export function freeze(root: string, fixed: Fixed, values: Record<string, string>, input?: { from: string }, reader?: readonly ReaderSubmission[]): string | null {
  const state = useDraftStore.getState(), requestId = values.requestId;
  if (!requestId || state.unavailable || input && pendingInput(state.entries, root, input.from, values) || reader?.some(each => holdsReaderTurn(state.entries, root, each))) return null;
  const key = outgoingKey(root, requestId);
  if (state.entries[key]) return null;
  // Pin a new admission before the input is moved. Failure leaves the input and any prior record intact.
  if (!admitOutgoingIdentity(root, requestId)) return null;
  const copies = attachmentsToCopy(values, requestId);
  const copyOps: Record<string, string> = copies.length ? { readerCopies: JSON.stringify(Object.fromEntries(copies.map(file => [file.path, crypto.randomUUID()]))) } : {};
  const facts = outgoingOperation(root, fixed, reader);
  const grace = writeOperation(facts).grace === 'deferred' ? writeGraceMs() : 0;
  const own = { ...(grace > 0 ? { due: String(Date.now() + grace) } : {}), ...copyOps, submitted: JSON.stringify(fixed), stage: 'queued', last: 'ask', ...reader?.length ? { reader: JSON.stringify(reader) } : {}, at: new Date().toISOString(), ...input && { from: input.from, fresh: crypto.randomUUID() } };
  const entries = { ...state.entries };
  if (input) {
    const current = entries[input.from];
    const source = current && current.values.requestId === requestId ? current : { status: 'editing' as const, values };
    const draft = { ...source, revision: source.revision ?? crypto.randomUUID() };
    entries[input.from] = draft;
    Object.assign(own, { [INPUT_PORTION]: claimInput(entries, input.from) });
    // All outstanding portions still belong to this input as its next press rotates the draft identity.
    for (const [name, entry] of Object.entries(entries)) if (isOutgoingIn(name, root)
      && entry.values.from === input.from && entry.values.fresh === draft.values.requestId
      && retainingInput(entry.values))
      entries[name] = amended(entry, { fresh: own.fresh! });
    entries[input.from] = { ...draft, values: submitted(draft.values, own.fresh!) };
  }
  entries[key] = { status: 'editing', values: { ...withoutEditableIntent(values), ...own } };
  if (!commitDrafts(entries)) return null;
  rememberSent(requestId, fixed.tasks ?? []);
  countUse(operationUse(facts));
  return requestId;
}

function outgoingOperation(root: string, fixed: Fixed, reader?: readonly ReaderSubmission[]): OperationFacts {
  return { key: JSON.stringify([root, 'coordinator/messages', fixed.intent?.task ?? reader?.[0]?.taskId ?? null]), payload: fixed,
    subject: { action: fixed.intent?.action ?? 'message', taskId: fixed.intent?.task ?? reader?.[0]?.taskId, label: reader?.[0]?.title ?? fixed.text } };
}
/** Called only after freeze and local reader admission succeeded. */
export function offerOutgoingUndo(root: string, requestId: string, document: globalThis.Document) {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key], item = entry && read(key, entry);
  if (!item || item.stage !== 'queued' || !item.due) return;
  holdSendGrace({ id: requestId, until: item.due, document, cancel: () => cancelUnsent(root, requestId),
    start: (keepalive, leaving) => {
      const current = useDraftStore.getState().entries[key];
      if (current?.values.stage !== 'queued') return;
      if (!releaseFromGrace(key)) return;
      if (keepalive) void useOutbox.getState().resend?.(requestId, keepalive, leaving);
    } });
}
/** One cancellation entrance; posted requests are left to server-side withdrawal. */
export function cancelUnsent(root: string, requestId: string): CancelResult {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  if (!entry) return 'gone';
  if (entry.values.stage !== 'queued' || isLive(key)) return 'already_dispatched';
  if (!write(key, values => ({ ...values, cancelled: '1', last: 'withdraw', stage: 'refused', refusal: '' }))) throw new Error('Cannot save unsent cancellation');
  const result = refuse(root, requestId, '');
  if (result === 'gone') return 'gone';
  endSendGrace(requestId);
  useOutbox.getState().cancelled?.(requestId);
  return 'cancelled';
}
/** A restored queued request has no live grace clock and never recreates its original offer. */
export function resumeQueuedOutgoing(root: string) {
  for (const key of [...restoredDraftKeys]) {
    if (!isOutgoingIn(key, root)) continue;
    restoredDraftKeys.delete(key);
    const entry = useDraftStore.getState().entries[key];
    if (entry?.values.stage === 'queued' && entry.values.due && !outgoingBlock(root, entry.values.requestId!)) releaseFromGrace(key);
  }
}
/** Leaving has no time for asynchronous preflight or file copying. Other queued requests remain saved for reload. */
export function simpleOutgoing(entry: DraftEntry) {
  const fixed = fixedOf(entry.values);
  return !entry.values.readerCopies && !inlines(draftDocument(entry.values)).some(node => node.type === 'skillLabel')
    && !fixed.intent && !fixed.answers?.length;
}
export function flushLeavingOutbox(root: string) {
  const entries = useDraftStore.getState().entries;
  for (const conversationId of new Set(outgoing(entries, root).map(item => item.fixed.conversationId))) {
    const head = deliveryHead(useDraftStore.getState().entries, root, conversationId);
    if (!head || head.stage !== 'queued' || !simpleOutgoing(entries[head.key]!)) continue;
    if (releaseFromGrace(head.key)) void useOutbox.getState().resend?.(head.requestId, true, true);
  }
}

const amended = (entry: DraftEntry, fields: Record<string, string>): DraftEntry => ({ ...entry, values: { ...entry.values, ...fields } });
function write(key: string, change: (values: Record<string, string>) => Record<string, string> | null, extra: Record<string, DraftEntry | null> = {}) {
  const state = useDraftStore.getState(), entry = state.entries[key];
  if (!entry) return false;
  const values = change(entry.values);
  const entries = { ...state.entries };
  if (values) entries[key] = { ...entry, values }; else delete entries[key];
  for (const [name, value] of Object.entries(extra)) if (value) entries[name] = value; else delete entries[name];
  return commitDrafts(entries);
}
/** Its grace is over: it may go as soon as it reaches the head, with no undo offered any more. */
const releaseFromGrace = (key: string) => write(key, values => ({ ...values, due: '0' }));

type Attempt = { requestId: string; key: string; fixed: Fixed; files: string[]; doc: Document; checked: boolean;
  /** Posted may reach serve; retained means it settled meanwhile; unavailable means its checkpoint could not be saved. */
  check: (attachments?: string[]) => 'posted' | 'retained' | 'unavailable'; finish: () => void };
/** A live attempt at one fixed request: refused ones are taken back, not sent; one already under way is not doubled. */
export function begin(root: string, requestId: string): Attempt | null {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  const item = entry && read(key, entry);
  if (!item || outgoingBlock(root, requestId) || item.stage === 'refused' || item.stage === 'accepted' || item.last === 'withdraw' || isLive(key) || clearingConversation(root, item.fixed.conversationId)) return null;
  const ahead = deliveryHead(useDraftStore.getState().entries, root, item.fixed.conversationId);
  if (ahead?.requestId !== requestId || item.stage === 'queued' && !graceReady(item.due)) return null;
  if (item.stage === 'queued' && !write(key, values => ({ ...values, stage: 'checking' }))) return null;
  endSendGrace(requestId);
  const finish = startLive(key, 'ask');
  return { requestId, key, fixed: item.fixed, files: item.files, doc: item.doc, checked: item.stage === 'posted',
    check: attachments => {
      const current = useDraftStore.getState().entries[key];
      if (!current || current.values.last === 'withdraw' || current.values.stage === 'refused') return 'retained';
      if (current.values.stage === 'posted') return 'posted';
      // Copy receipts establish the names actually stored under this send ID. Persist them
      // with the posted checkpoint, before a POST can leave or be replayed after reload.
      const fixed = { ...item.fixed, attachments: attachments ?? item.fixed.attachments };
      // Replace only the attachments inside the frozen text, so the rest of the fixed meaning stays byte-for-byte as frozen.
      if (!write(key, values => ({ ...values, stage: 'posted',
        submitted: JSON.stringify({ ...JSON.parse(values.submitted ?? JSON.stringify(item.fixed)), attachments: fixed.attachments }) }))) return 'unavailable';
      Object.assign(item.fixed, fixed);
      return 'posted';
    }, finish };
}

/** The words and files as the draft had them, without what this owner added. */
function draftValues(values: Record<string, string>) {
  const draft = { ...values };
  for (const field of OWN) delete draft[field];
  return draft;
}
/**
 * Whether the words can go back into the input without losing any: `fresh`, it is still the draft the send left,
 * untouched (lifecycle.ts); taken back by hand, nothing is written or attached in it.
 */
function empty(draft: DraftEntry | undefined, fresh?: string) {
  if (!draft || draft.status !== 'editing') return false;
  if (fresh !== undefined) return draft.values.requestId === fresh && !composing(draft.values);
  if (draft.values.uploadOps || attachmentsOf(draft.values).length) return false;
  try { const doc = draftDocument(draft.values); return !composing(draft.values) || !hasContent(doc) && !replyIn(doc); }
  catch { return false; }
}
/** An empty input, or another card's draft which can move aside atomically. No reader document copy is kept. */
function readerDraftRoom(destination: string, draft: DraftEntry, taskId: string): Record<string, DraftEntry> | null {
  draft = { ...draft, values: projectInput(useDraftStore.getState().entries, destination, draft.values)! };
  if (empty(draft)) return {};
  // Only the document's single explicit recipient can own unsent words; the viewed panel grants no ownership.
  const named = [...taskReferencesIn(draftDocument(draft.values), [])];
  const other = draft.values.readerDraftTask ?? (named.length === 1 ? named[0] : undefined);
  if (!other || other === taskId) return null;
  // A refused submission already owns this unchanged original. Opening another answer must not
  // create a parked copy which could resurrect the same answer after its explicit recovery.
  if (Object.values(useDraftStore.getState().entries).some(entry => entry.values.reader && entry.values.stage === 'refused' && !entry.values.taken
    && retainsOriginal(entry, destination, draft) && sameInput(entry.values, draft.values))) return {};
  const [root, , conversationId] = draftIdentity(destination);
  const key = parkedKey(root, conversationId!, other);
  return useDraftStore.getState().entries[key] ? null : { [key]: draft };
}
/**
 * Back into the chosen input, in one write: its words and files under a fresh request ID (old file references remain for copying);
 * the input keeps the context it has now. A reader draft takes its card's slot, moving another card's draft aside;
 * a mixed payload returns only the failed card's portion. Other originals move aside; later free writing in the same input stays in place.
 */
function restore(key: string, { input: from, entry, origin }: RecoveryPlace, fresh?: string, target?: ReaderSubmission): boolean {
  const readers = entry.values.reader ? readersOf(entry.values.reader) : [];
  const returned = returnedSubmissions(entry.values);
  const reader = target ?? readers.find(reader => returned.includes(readerSubmissionKey(reader)));
  const failed = reader ? readers.filter(each => each.taskId === reader.taskId && returned.includes(readerSubmissionKey(each))) : [];
  const fixed = fixedOf(entry.values);
  const draft = useDraftStore.getState().entries[from] ?? { status: 'editing' as const, values: { doc: JSON.stringify(emptyDocument()), phase: 'prepared' } };
  const visible = { ...draft, values: projectInput(useDraftStore.getState().entries, from, draft.values)! };
  if (!restorable(useDraftStore.getState().entries[key]!)) return false;
  const retained = retainsOriginal(entry, from, draft);
  const recovered = retained ? recoverRetainedInput(entry.values, draft) : null;
  if (retained && !recovered) return false;
  // A retained original shares this input with later free writing. Only an explicitly
  // recovered card owns a separate visible draft that must move aside with its words.
  const parked = target && (!retained || draft.values.readerDraftTask) ? readerDraftRoom(from, draft, target.taskId) : retained ? {} : empty(visible, fresh) ? {} : null;
  if (!parked) return false;
  // The retained draft already has a fresh ID; keep later queued portions bound to it.
  // Other recovery allocates one. A conflicting source stays, taken, so its old ID remains apart
  // from the other words held at serve.
  const conflict = !!entry.values.conflict;
  const own: Record<string, string> = { requestId: retained ? draft.values.requestId! : crypto.randomUUID(), ...reader ? { readerDraftTask: reader.taskId, readerDraftTurn: JSON.stringify(reader), ...fixed.intent && failed.some(each => each.taskId === fixed.intent!.task) ? editableIntentValues(fixed.intent, reader) : {} } : {} };
  const source = draftDocument(entry.values), failedIds = new Set(failed.map(each => each.taskId));
  // Split the single original document when one of a message's targets returns; never restore another target's input.
  const part = (selected: ReaderSubmission[]) => {
    if (readers.every(each => selected.some(target => readerSubmissionKey(target) === readerSubmissionKey(each)))) return source;
    let taskId: string | null = null, question: string | null = null;
    return filterDocument(source, node => {
      if (node.type === 'taskLabel') { taskId = node.attrs.id; question = null; }
      else if (node.type === 'answerLabel') { taskId = node.attrs.task; question = node.attrs.question; }
      else if (node.type === 'text' && node.marks?.some(mark => mark.type === 'readerOperation') && fixed.intent) { taskId = fixed.intent.task; question = fixed.intent.question ?? null; }
      return selected.some(each => each.taskId === taskId && (!question || each.turn === question));
    });
  };
  const doc = reader ? part(failed) : source, kept = readers.filter(each => !failed.some(target => readerSubmissionKey(target) === readerSubmissionKey(each)));
  // Recovering the whole original keeps words added after the press. A partial return still
  // restores only its selected answers; the remaining targets stay with their fixed submission.
  const retainedWhole = retained && kept.length === 0;
  if (retained && kept.length && !sameInput(entry.values, draft.values)) return false;
  const remainingReturned = returned.filter(key => kept.some(each => readerSubmissionKey(each) === key));
  const remainder = kept.length ? {
    ...entry.values, reader: JSON.stringify(kept), readerReturned: JSON.stringify(remainingReturned), doc: JSON.stringify(part(kept)),
    stage: remainingReturned.length === kept.length ? 'refused' : 'accepted'
  } : null;
  // A pre-send cancellation has no server tombstone. Retain its terminal ID after recovery,
  // just as a conflicting ID stays apart, so a stale action can never start a server withdrawal.
  const retainId = conflict || entry.values.cancelled === '1';
  const released = { ...useDraftStore.getState().entries, ...origin };
  // Snapshot recovery replaces this original through the same ownership boundary as admission,
  // then edits only the visible input. Other outgoing originals keep their own hidden portions.
  if (!retainedWhole) consumeInput(released, entry);
  delete released[key];
  // Reveal this original, keeping other submissions' portions hidden. If another card's
  // visible draft moves aside, only the requested original enters its place.
  const recoveredValues = retainedWhole && !Object.keys(parked).length
    ? projectInput(released, from, { ...draft.values, doc: JSON.stringify(recovered!) })! : null;
  const values = {
    ...restored(recoveredValues ?? draftValues(entry.values), draft.values), ...own,
    doc: recoveredValues?.doc ?? JSON.stringify(reader && fixed.intent && failedIds.has(fixed.intent.task) ? markReaderOperation(doc) : doc),
  };
  if (!released[from]) released[from] = draft;
  const input = editProjectedInput(released, from, values);
  return write(key, values => remainder ?? (retainId ? { ...values, taken: '1' } : null), { ...origin, ...input, ...parked });
}
const sameInput = (left: Record<string, string>, right: Record<string, string>) =>
  JSON.stringify(draftDocument(left)) === JSON.stringify(draftDocument(right))
  && JSON.stringify(attachmentsOf(left)) === JSON.stringify(attachmentsOf(right)) && left.uploadOps === right.uploadOps;
const retainsOriginal = (entry: DraftEntry, input: string, draft: DraftEntry) =>
  entry.values.from === input && entry.values.fresh === draft.values.requestId
  && retainedInput(entry.values, draft);

/** A next message is projected from the same position ownership that admission consumes. */
export function availableInput(entries: Record<string, DraftEntry>, _root: string, input: string, values = entries[input]?.values): Record<string, string> | undefined {
  return projectInput(entries, input, values);
}

/** An unchanged draft is still waiting for its send. Editing it permits the ordinary next message. */
export function pendingInput(entries: Record<string, DraftEntry>, root: string, input: string, values = entries[input]?.values): boolean {
  const available = availableInput(entries, root, input, values);
  return !!values && !!available && !hasContent(draftDocument(available), attachmentsOf(available)) && !available.uploadOps
    && Object.entries(entries).some(([key, entry]) => isOutgoingIn(key, root)
      && entry.values.from === input && entry.values.fresh === values.requestId
      && entry.values.stage !== 'refused' && entry.values.stage !== 'accepted');
}
/** Every proof of admission consumes its input through this one transition, before retiring its outbox payload. */
function recordAdmission(entries: Record<string, DraftEntry>, key: string) {
  const entry = entries[key]!;
  const released = consumeInput(entries, entry);
  // Admission ends this request's ownership even if its payload must remain for a reader or a late snapshot.
  const { fresh: _fresh, [INPUT_PORTION]: _portion, ...values } = entry.values;
  entries[key] = { ...entry, values: { ...values, stage: 'accepted' } };
  return released || entry.values.fresh !== undefined || entry.values.stage !== 'accepted';
}
/** Files uploaded under a conflicting ID cannot follow its words to another ID; such a request stays to be copied. */
const restorable = (entry: DraftEntry) => !entry.values.conflict || !attachmentsOf(entry.values).length;
/** The input is another conversation's than the one this request was fixed for: that one has been cleared. */
const inOtherConversation = (input: string, fixed: Fixed) => draftIdentity(input)[2] !== fixed.conversationId;
/** Where a fixed request's words go back, and as what. */
type RecoveryPlace = { input: string; entry: DraftEntry; origin: Record<string, DraftEntry> };
/**
 * The one answer: the input in sight when there is one in this workspace, else the input they left, else (a reader's
 * words, which left none) their conversation's. A cleared conversation's files cannot be read in another, so the words
 * go without them.
 */
function recoveryPlace(root: string, entry: DraftEntry, visibleInput?: string | null): RecoveryPlace {
  const fixed = fixedOf(entry.values);
  const inSight = visibleInput && draftIdentity(visibleInput)[0] === root ? visibleInput : null;
  const input = inSight ?? entry.values.from ?? draftKey(root, 'coordinator', fixed.conversationId);
  if (!inOtherConversation(input, fixed)) return { input, entry, origin: {} };
  const before = useDraftStore.getState().entries, entries = { ...before };
  const origin = consumeInput(entries, entry) ? Object.fromEntries(Object.entries(entries)
    .filter(([key, value]) => key !== outgoingKey(root, entry.values.requestId!) && value !== before[key])) : {};
  const { attachments: _files, uploadOps: _uploads, removeOps: _removals, completedUploads: _completed, readerCopies: _copies, ...words } = entry.values;
  return { input, origin, entry: { ...entry, values: { ...words, submitted: JSON.stringify({ ...fixed, attachments: [] }) } } };
}
/** Back on its own, the words take only the draft the send left there: it is still `fresh` when they went back to where they left. */
const freshAt = ({ input, entry }: RecoveryPlace) => input === entry.values.from ? entry.values.fresh : undefined;
/**
 * It did not reach serve, or serve refused it: back into the input when the input is still as the send left it;
 * otherwise kept, refused, until it is taken back. An intent has no input to go back to: it is dropped (its card comes
 * back, and the reader's notice says why).
 */
export function refuse(root: string, requestId: string, reason: string, conflict = false, visibleInput?: string | null): 'restored' | 'kept' | 'dropped' | 'gone' {
  endDeliveryNotice(root, requestId);
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  if (!entry) return 'gone';
  if (entry.values.reader) {
    returnReaderSubmission(root, requestId, reason);
    if (conflict) write(key, values => ({ ...values, conflict: '1' }));
    const stored = useDraftStore.getState().entries[key];
    if (!stored) return 'kept';
    const back = recoveryPlace(root, stored, visibleInput);
    if (!conflict && inOtherConversation(back.input, fixedOf(stored.values)) && restore(key, back)) return 'restored';
    if (back.entry !== stored) write(key, () => back.entry.values, back.origin);
    return 'kept';
  }
  if (!entry.values.from) { write(key, values => values.cancelled === '1' ? { ...values, taken: '1' } : null); return 'dropped'; }
  const back = recoveryPlace(root, entry, visibleInput);
  if (!conflict && restore(key, back, freshAt(back))) return 'restored';
  write(key, () => ({ ...back.entry.values, stage: 'refused', refusal: reason, ...conflict ? { conflict: '1' } : {} }), back.origin);
  return 'kept';
}
/** Recovery may use an empty input or the original already retained there; never overwrite another draft. */
export function canTakeBack(entries: Record<string, DraftEntry>, root: string, requestId: string, visibleInput?: string | null): boolean {
  const entry = entries[outgoingKey(root, requestId)];
  if (entry?.values.stage !== 'refused' || entry.values.taken) return false;
  const { input } = recoveryPlace(root, entry, visibleInput);
  const draft = entries[input], visible = draft && { ...draft, values: projectInput(entries, input)! };
  return (!draft || empty(visible) || retainsOriginal(entry, input, draft) && recoverRetainedInput(entry.values, draft) !== null) && restorable(entry);
}
/** A refused request taken back by hand, into an empty input. */
export function takeBack(root: string, requestId: string, visibleInput?: string | null): boolean {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  const recovered = !!entry && entry.values.stage === 'refused' && !entry.values.taken && !isLive(key) && restore(key, recoveryPlace(root, entry, visibleInput));
  if (recovered) endDeliveryNotice(root, requestId);
  return recovered;
}

/**
 * Checks cut off (the page reloaded or closed while they ran): nothing went, so it is refused as interrupted, and goes
 * back to the input as above. Only an attempt in this page is live, so any other `checking` one was cut off.
 */
export function settleInterrupted(root: string, reason: string) {
  for (const [key, entry] of Object.entries(useDraftStore.getState().entries))
    if (isOutgoingIn(key, root) && entry.values.stage === 'checking' && !isLive(key))
      refuse(root, entry.values.requestId!, reason);
}

/**
 * Serve's receipt of a request: the digest of the input it took, as serve computed it, on its turn when the turn is among
 * the recent ones and on the message's own status otherwise. Never recomputed here: serve alone knows what it admitted.
 */
const receipt = (conversation: CoordinatorConversation, requestId: string): string | undefined =>
  conversation.turns.find(each => each.id === requestId)?.inputDigest ?? conversation.admitted[requestId]?.digest;
/** The one delivery-evidence rule, shared by POST failure checks, snapshot reconciliation and withdrawal. */
export function deliveryOutcome(conversation: CoordinatorConversation | null | undefined, requestId: string, fixed: Fixed, last: 'ask' | 'withdraw' = 'ask'): 'accepted' | 'cancelled' | 'conflict' | 'unknown' {
  if (conversation?.id !== fixed.conversationId) return 'unknown';
  if (conversation.cancelled.includes(requestId)) return 'cancelled';
  const taken = receipt(conversation, requestId);
  if (taken === undefined) return 'unknown';
  // Ask fixes its content; withdraw names only the ID, including a row admitted by another page.
  return last === 'withdraw' || taken === coordinatorMessageDigest({ ...fixed, id: requestId }) ? 'accepted' : 'conflict';
}
/** The one proof of HTTP admission; both reconciliation and a late transport failure use this exact identity. */
export const hasSubmission = (conversation: CoordinatorConversation, requestId: string, fixed: Fixed) =>
  deliveryOutcome(conversation, requestId, fixed) === 'accepted';
/** A withdrawal that has ended, by serve or by the local undo alike (outgoingDisplay tells those apart). */
export const isWithdrawn = (values: Record<string, string>) => values.stage === 'refused' && values.last === 'withdraw';
/** The cancellation fact is terminal. Recovery uses the same path as refusal, always under a fresh request ID. */
export function cancelOutgoing(root: string, requestId: string, visibleInput: string | null): 'restored' | 'kept' | 'dropped' | 'gone' {
  endDeliveryNotice(root, requestId);
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  if (!entry) return 'gone';
  // Current cancellation closes admission; it cannot establish what an earlier, unproven send did.
  // A local queued/undone send is proven unsent and needs no such qualification.
  const unknown = entry.values.stage !== 'queued' && entry.values.cancelled !== '1' && !!outgoingBlock(root, requestId);
  if (!isWithdrawn(entry.values) && !write(key, values => ({ ...values, stage: 'refused', last: 'withdraw', refusal: '' }))) return 'kept';
  // A reader intent has no original input. A draft, including an answer, uses the same recovery owner as refusal.
  if (!entry.values.from) { write(key, () => null); return 'dropped'; }
  const stored = useDraftStore.getState().entries[key]!, back = recoveryPlace(root, stored, visibleInput);
  if (!restore(key, back, freshAt(back))) {
    // Beside words in the input of a conversation that replaced its own, it stands in that one: a cleared conversation's rows are not drawn.
    if (back.entry !== stored) write(key, () => ({ ...back.entry.values, submitted: JSON.stringify({ ...fixedOf(back.entry.values), conversationId: draftIdentity(back.input)[2]! }) }), back.origin);
    return 'kept';
  }
  const message = unknown
    ? back.input === visibleInput ? 'ui:coordinatorCard.withdrawRestoredUnknown' : 'ui:coordinatorCard.withdrawRecoveredUnknown'
    : back.input === visibleInput ? 'ui:coordinatorCard.withdrawRestored' : 'ui:coordinatorCard.withdrawn';
  notify.success(i18n.t(message), { id: deliveryNoticeId(root, requestId), from: 'coordinator' });
  return 'restored';
}
/** The local queue never reached serve, so cancellation needs no HTTP and never touches its predecessor. */
export function cancelQueued(root: string, requestId: string, visibleInput: string | null): ReturnType<typeof cancelOutgoing> | null {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  if (entry?.values.stage !== 'queued' || isLive(key)) return null;
  const result = cancelOutgoing(root, requestId, visibleInput);
  endSendGrace(requestId);
  useOutbox.getState().cancelled?.(requestId);
  const after = useDraftStore.getState().entries[key];
  return !after || isWithdrawn(after.values) ? result : null;
}
/** The outbox owns the boundary between grace, local delivery order, and a possible server send. */
export function outgoingCancellation(root: string, requestId: string): 'grace' | 'queued' | 'server' {
  const key = outgoingKey(root, requestId), entry = useDraftStore.getState().entries[key];
  const item = entry && read(key, entry);
  return item?.stage === 'queued' ? graceReady(item.due) ? 'queued' : 'grace' : 'server';
}
/** One pre-send cancellation entrance for every surface; null leaves server withdrawal to its owner. */
export function cancelBeforeSend(root: string, requestId: string, visibleInput: string | null): ReturnType<typeof cancelQueued> | 'undone' {
  switch (outgoingCancellation(root, requestId)) {
    case 'grace': return cancelUnsent(root, requestId) === 'cancelled' ? 'undone' : null;
    case 'queued': return cancelQueued(root, requestId, visibleInput);
    case 'server': return null;
  }
}
/** Persist withdrawal before HTTP. It may race admission, but never another withdrawal. */
export function beginWithdrawal(root: string, requestId: string, conversation?: CoordinatorConversation | null): { finish: () => void } | null {
  const key = outgoingKey(root, requestId), state = useDraftStore.getState();
  let entry = state.entries[key];
  if (!entry) {
    if (!conversation) return null;
    const turn = conversation.turns.find(turn => turn.id === requestId);
    if (turn && turn.status !== 'queued') return null;
    // A server row has no recoverable original document. Retain only this withdrawal's intent; never resend it.
    const fixed: Fixed = { conversationId: conversation.id, text: turn?.ask ?? '', attachments: turn?.attachments ?? [],
      ...turn?.tasks ? { tasks: turn.tasks } : {}, ...turn?.replyTo ? { replyTo: turn.replyTo.id } : {} };
    entry = { status: 'editing', values: { requestId, doc: JSON.stringify(emptyDocument()), submitted: JSON.stringify(fixed), stage: 'posted', at: turn?.at ?? new Date().toISOString() } };
  }
  const queuedAtServe = entry.values.stage === 'accepted' && conversation?.turns.some(turn => turn.id === requestId && turn.status === 'queued');
  if ((entry.values.stage !== 'posted' && entry.values.stage !== 'checking' && !queuedAtServe) || isLive(key, 'withdraw')) return null;
  if (!commitDrafts({ ...state.entries, [key]: amended(entry, { stage: 'posted', last: 'withdraw' }) })) return null;
  return { finish: startLive(key, 'withdraw') };
}
/** A fresh queued turn proves this withdrawal failed; the request itself remains owned by serve. */
export function rejectWithdrawal(root: string, requestId: string) {
  const state = useDraftStore.getState(), key = outgoingKey(root, requestId), entry = state.entries[key];
  if (!entry || !awaitsWithdrawal(entry.values)) return;
  endDeliveryNotice(root, requestId);
  const entries = { ...state.entries };
  recordAdmission(entries, key);
  entries[key] = amended(entries[key]!, { last: 'ask' });
  commitDrafts(entries);
}
/** A withdrawal refused because work started proves admission even before the next drawable snapshot. */
export function confirmStarted(root: string, requestId: string) {
  endDeliveryNotice(root, requestId);
  const state = useDraftStore.getState(), key = outgoingKey(root, requestId), entry = state.entries[key];
  if (entry && entry.values.stage !== 'refused') {
    const entries = { ...state.entries }; recordAdmission(entries, key); commitDrafts(entries);
  }
}
/**
 * Requests from here whose ID a snapshot gives to other words: refused, `conflict`, kept apart. Answers every such ID
 * in this conversation (marked now or before), so no reader takes those turns for what was sent from here.
 */
export function isolateConflicts(conversation: CoordinatorConversation, root: string, reason: string): ReadonlySet<string> {
  const state = useDraftStore.getState(), entries = { ...state.entries }, isolated = new Set<string>();
  let changed = false;
  for (const item of outgoing(state.entries, root, conversation.id)) {
    if (entries[item.key]!.values.conflict) { isolated.add(item.requestId); continue; }
    // Other words under its ID, whether its turn is drawn or only its status said so.
    if (item.stage === 'refused' || deliveryOutcome(conversation, item.requestId, item.fixed, item.last) !== 'conflict') continue;
    endDeliveryNotice(root, item.requestId);
    entries[item.key] = amended(entries[item.key]!, { stage: 'refused', refusal: reason, conflict: '1' });
    isolated.add(item.requestId); changed = true;
  }
  if (changed) commitDrafts(entries);
  return isolated;
}
/**
 * A snapshot that holds a request's turn as it was sent, or names it withdrawn, says serve has it. A drawn snapshot
 * (`drawn`) settles it; one that lost the race to be drawn marks it accepted, kept to draw until a drawn one holds
 * it, and reports `undrawn` so its reader asks for one. Restored input IDs let the reader retire consumed recovery entrances. Absence settles nothing (an older snapshot, or one read before the
 * POST arrived); other words under its ID isolate it (isolateConflicts).
 * Presentation supplies its current input key independently of whether this snapshot was drawn.
 */
export function reconcileOutbox(conversation: CoordinatorConversation, root: string, visibleInput: string | null, drawn = true, conflictReason = ''): { undrawn: boolean; restored: string[] } {
  const recovered: string[] = [];
  for (const item of outgoing(useDraftStore.getState().entries, root, conversation.id))
    if (deliveryOutcome(conversation, item.requestId, item.fixed, item.last) === 'cancelled' && cancelOutgoing(root, item.requestId, visibleInput) === 'restored') recovered.push(item.requestId);
  isolateConflicts(conversation, root, conflictReason);
  const state = useDraftStore.getState(), entries = { ...state.entries };
  let changed = false, undrawn = false;
  // A drawn snapshot is of the open conversation, so a request sent to another one was sent to a conversation cleared
  // since (here or elsewhere). Serve takes no message for it any more and none of it is read, so nothing could settle
  // an unresolved request: it goes with its conversation. Refused words remain available for explicit recovery. One
  // still under way here ends first (refused as the conversation changed); the next drawn snapshot takes it.
  if (drawn) for (const [key, entry] of Object.entries(state.entries)) {
    if (!isOutgoingIn(key, root) || isLive(key)) continue;
    const item = read(key, entry);
    if (item && !item.reader && item.fixed.conversationId !== conversation.id && !(item.stage === 'refused' && !item.taken)) { endDeliveryNotice(root, item.requestId); delete entries[key]; changed = true; }
  }
  for (const item of outgoing(state.entries, root, conversation.id)) {
    if (item.stage === 'refused') continue;
    const turn = conversation.turns.find(each => each.id === item.requestId);
    const outcome = deliveryOutcome(conversation, item.requestId, item.fixed, item.last), cancelled = outcome === 'cancelled';
    if (!turn && !cancelled && outcome === 'accepted' && !conversation.admitted[item.requestId]?.ended) {
      // Serve took it and it is still at work, so a snapshot holds it: one without it is older. It asks for a newer one
      // (as an answer that lost the race to be drawn does), which holds it or says how it ended.
      undrawn = true;
      continue;
    }
    // Out of the recent turns once its work ended, its own status settles it as its turn would.
    if (!turn && !cancelled && outcome !== 'accepted') continue;
    // A queued turn proves admission, but cannot settle an unanswered withdrawal still allowed to arrive.
    if (awaitsWithdrawal(item) && turn?.status === 'queued' && !cancelled) continue;
    if (turn && recordAdmission(entries, item.key)) changed = true;
    acceptDeliveryNotice(root, item.requestId);
    const returned = item.reader?.filter(reader => cancelled || turn?.result && readerResult(reader, turn.result).status === 'refused').map(readerSubmissionKey) ?? [];
    if (item.reader && returned.length === item.reader.length) {
      // Its notice says why; the input's line says only that it was not carried out, never a code.
      entries[item.key] = amended(entries[item.key]!, { stage: 'refused', refusal: '', readerReturned: JSON.stringify(returned) }); changed = true;
      continue;
    }
    if (returned.length) { entries[item.key] = amended(entries[item.key]!, { readerReturned: JSON.stringify(returned) }); changed = true; }
    const keepPayload = turn?.status === 'queued' && turn.waiting || item.reader && (!turn?.result || returned.length > 0 || item.reader.some(reader => readerResult(reader, turn.result!).status === 'unconfirmed'));
    if (drawn && !keepPayload) {
      if (item.reader) entries[item.key] = { status: 'editing', values: { doc: JSON.stringify(emptyDocument()), requestId: item.requestId, reader: JSON.stringify(item.reader), stage: 'settled' } };
      else delete entries[item.key];
      changed = true;
    }
    else {
      if (!drawn) undrawn = true;
      if (item.stage !== 'accepted') { entries[item.key] = amended(entries[item.key]!, { stage: 'accepted' }); changed = true; }
    }
  }
  if (changed) commitDrafts(entries);
  return { undrawn, restored: recovered };
}
