import { isAgentView } from '@/lib/agent-view';
import { deliveryNotice, deliveryNoticeId } from './delivery-notice';
import { useSyncExternalStore } from 'react';
import { CancelledError, QueryObserver } from '@tanstack/react-query';
import { resources, fetchAcceptedResource, acceptCoordinatorSnapshot, cancelResourceRead, cancelCapturedResourceRead, captureResourceRead, admitResourceRead, requestLaterReadDemand } from '@/data/resources';
import { sameReadSession, captureReadProof, readIndex, readScope, readQuery, coordinatorReadState, subscribeReads } from '@/data/read-model';
import { requestRead } from '@/data/read-demand';
import { queryClient } from '@/data/query-client';
import type { WriteBasis } from '@/data/connection';
import { notify, recordFailure } from "@/lib/notify";
import { ownsReaderSend, reconcileReaderSends, dismissRecoveredReaderSends, closeReaderConversation, observeReaderConversation } from './reader-send';
import { awaitsDrawing, isolateConflicts, outgoing, reconcileOutbox, rejectWithdrawal, beginWithdrawal, confirmStarted, cancelOutgoing, cancelBeforeSend, outgoingKey, isLive, resumeQueuedOutgoing, settleInterrupted, useOutbox } from './editor/outbox';
import { draftKey, useDraftStore } from '@/features/forms/draft-store';
import { withdrawalStarted } from './delivery-copy';
import { clearingConversation } from './press';
import { ApiError, heldByRelease, retryOf } from "@/data/client";
import { i18n } from "@alpacawork/i18n";
import { create } from "zustand";
import { coordinatorAnswersInputSchema, type CoordinatorAnswers, type CoordinatorIntent } from "@alpacawork/contract/coordinator";
import { onBackInReach, useConnection } from "@/data/connection";
import { allRead, hasAnswer, learn, opening, type Opening } from "./read-boundary";
import { askCoordinator, coordinatorMessageAction, clearCoordinator, resetCoordinator, readCoordinatorMessage, markCoordinatorSeen, type CoordinatorConversation, type CoordinatorSnapshot, type CoordinatorMessageResponse } from "@/data/coordinator";

/** One question's answer in the input: its task, the asking it answers and its number there. */
export type AnswerAt = { task: string; question: string; n: string };
/** The server owns messages and session; this store only keeps the card's local presentation state. */
type View = {
  root: string;
  conversation: CoordinatorConversation | null;
  /** Derived from the server-confirmed reply IDs, including ACKs not yet present in a GET. */
  read: boolean;
  /** Presentation anchor for this opening; never a copy of unread facts or a condition for reading. */
  opening: Opening | null;
  seen: ReadonlySet<string>;
  pendingSeen: ReadonlySet<string>;
  seenError: unknown;
  observeSeen: (ids: readonly string[]) => void;
  resumeSeen: () => void;
  flushSeen: (keepalive?: boolean) => void;
  /**
   * Its input is up from a press on the one line at the foot until what is written is sent or it is put down (Esc,
   * a tap away). Down, the input is one line.
   */
  open: boolean;
  /** The conversation shown (opened from its folded line); folded, answers wait as one line and a purple dot. */
  expanded: boolean;
  /**
   * An explicit focus handoff, consumed once when the input is connected: `true` at the end of what is written, an
   * answer (its task, question and number) right after its chip, where its words go; a task's label (`{ label: <its id> }`) right
   * after it.
   */
  focusRequested: boolean | AnswerAt | { label: string };
  /**
   * Answers written into the input from outside it (a report's choices, Other), counted: a tap that writes one has
   * turned to the input, though on a phone it asks no focus (editor/draft.ts → answerInDraft).
   */
  written: number;
  /**
   * The person has turned to it (written in its input, opened its conversation, pressed its microphone):
   * from then on what only writing needs is loaded (the skill catalog).
   */
  engaged: boolean;
  /** The one line's microphone pressed: the input comes up and records as soon as it can take the words. */
  listen: boolean;
  /**
   * The one line pressed before the conversation was read: the input comes up once it is. Any move that puts the input
   * up or down (or a new workspace) takes the press back, so a late answer opens only what is still asked for.
   */
  wanted: boolean;
  /** The conversation is being read, or is to be read again shortly: the line says it is loading, not that it failed. */
  trying: boolean;
  /** How many requests this page has sent (ask: from the input, or sent again): the conversation goes to its end. */
  asked: number;
  /**
   * Single messages' statuses this page has learnt, in their conversation (learnStatus): a snapshot holds recent turns
   * only and names no withdrawal, so the conversation carries what these say (withLearnt).
   */
  learnt: { conversationId: string; statuses: Readonly<Record<string, CoordinatorMessageResponse['message']>> } | null;
  /** The last read failed: said by its toast (READ_FAILURE) until a read succeeds. */
  error: string | null;
  /** Closing the input folds the conversation too. */
  setOpen: (open: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  refresh: () => Promise<void>;
  /** The person asks for the conversation again (the line, the toast's retry): a failure they hid is said again. */
  retry: () => void;
  /**
   * The conversation's version the index announced (`<generation>:<revision>`): read when it is new, whether its input
   * is up or down (what stands at the foot says its last words).
   */
  follow: () => void;
  /**
   * `intent`: a press's meaning (reader-send); `answers`: the questions a draft's choices answer. The server decides
   * which AI the turn starts with (the conversation's `nextLaunch`).
   */
  ask: (input: { conversationId: string; id: string; text: string; tasks?: string[]; skills?: string[]; attachments: string[];
    intent?: CoordinatorIntent; answers?: CoordinatorAnswers; replyTo?: string | null; retryOf?: string }, basis?: WriteBasis, keepalive?: boolean) => Promise<boolean>;
  messageAction: (action: "withdraw" | "send-now", id: string) => Promise<void>;
  clear: () => Promise<void>;
  /** The coordinator starts again from the next message, with its memo; the conversation stays. */
  reset: () => Promise<void>;
};
let revision = 0;
/**
 * Requests are ordered at reception, before the Query can commit. Resources own subsequent demand.
 */
/**
 * Every read and write of the conversation answers its whole snapshot, numbered in the order it was sent (`sent`).
 * An answer is shown unless one sent after it is already shown (`shown`): an earlier answer arriving late (a send's,
 * made while the turn was still queued) does not replace a newer one, and a later request that fails takes nothing
 * from an earlier one that succeeds.
 */
let sent = 0, shown = 0;
/**
 * A failed read is one event, said by one toast (sayReadFailure): read again on its own and failing again, it stays the
 * one (hidden, it stays hidden); it ends once a read succeeds or the workspace changes, and a retry asks anew.
 */
const READ_FAILURE = 'coordinator-read';
let readFailure: unknown = null;
/** What its toast says now: the failure, the read its retry asked for (`asked`, kept until that read ends), or nothing. */
let readFailureSaid: 'failed' | 'asked' | null = null, askedByToast = false;
/**
 * The one rule for what the failed read's toast says: it failed, nothing more is tried, and serve is in reach. Tried
 * again, it is loading again: asked from the toast, the toast says so in its place (a second press lands on it, not on
 * what is under it); otherwise it goes down meanwhile. Hidden in either, the event stays hidden until asked again. Out of reach, the connection's line says it (ProgressLine), and
 * it is read again once back (onBackInReach). Said each time it comes to be so, not on every change meanwhile.
 */
/**
 * Whether the conversation's read failed only because an update holds the workspace: read from the failure this Owner
 * keeps as it came (its `error` is the text shown), so the notice and the page that reads it again agree.
 */
export const conversationHeldByRelease = () => !!useConversation.getState().error && heldByRelease(readFailure);
function sayReadFailure() {
  const { conversation, error, trying } = useConversation.getState();
  const said = conversation || !error || useConnection.getState().offline || conversationHeldByRelease() ? null : !trying ? 'failed' : askedByToast ? 'asked' : null;
  if (said === readFailureSaid) return;
  readFailureSaid = said;
  if (said !== 'asked') askedByToast = false;
  if (said === 'asked') notify.pending(i18n.t("ui:coordinatorCard.loading"), { id: READ_FAILURE, ongoing: true, from: "coordinator" });
  else if (said === 'failed') notify.failure(readFailure, { about: "coordinator read", id: READ_FAILURE, ongoing: true, from: "coordinator",
    text: i18n.t("ui:coordinatorCard.loadFailed"), action: { label: i18n.t("translation:retry"), run: () => { askedByToast = true; useConversation.getState().retry(); } } });
  else notify.suspend(READ_FAILURE);
}
type Origin = { revision: number; root: string; id: string | null; proof: ReturnType<typeof captureReadProof> | undefined; reception: ReturnType<typeof captureResourceRead> };
const capture = (): Origin => {
  const root = useConversation.getState().root, index = readIndex(queryClient);
  return { revision, proof: index ? captureReadProof(index, ['coordinator', root]) : undefined,
    reception: captureResourceRead(queryClient, ['coordinator', root]), root,
    id: useConversation.getState().conversation?.id ?? null };
};
/** A read or write about to go: where it was sent from, and its number in the order sent (`sent`). */
type Sending = Origin & { request: number };
const sending = (): Sending => ({ ...capture(), request: ++sent });
/** Whether what `origin` captured still speaks of this store's scope: the same root, revision and conversation. */
const sameScope = (origin: Origin, current: { root: string; conversation: { id: string } | null }) =>
  origin.root === current.root && origin.revision === revision && origin.id === (current.conversation?.id ?? null);
/** Presentation owns the visible input; outbox recovery receives its key at the moment it restores. */
const currentInputKey = () => {
  const { root, conversation } = useConversation.getState();
  return conversation ? draftKey(root, 'coordinator', conversation.id) : null;
};
/** One recovery rule for a pressed operation: one read, then fulfilled, still pending, or unknown. */
type Action = 'send-now' | 'withdraw' | 'clear' | 'reset';
type ActionResult = 'done' | 'pending' | 'unknown';
function actionResult(action: Action, conversationId: string, id: string | undefined, next: CoordinatorConversation | null): ActionResult {
  if (!next) return 'unknown';
  if (next.id !== conversationId || id && next.cancelled.includes(id)) return 'done';
  if (action === 'clear') return 'pending';
  const turn = next.turns.find(turn => turn.id === id);
  if (!turn) return 'unknown';
  if (turn.status !== 'queued' || action === 'send-now' && turn.joinRequested && !turn.deliveryError) return 'done';
  return 'pending';
}
async function checkAction(action: Action, conversationId: string, id?: string): Promise<ActionResult> {
  try {
    const read = (await readConversationSnapshot()).conversation;
    // A message the snapshot no longer holds may have been withdrawn: its own status says so (a snapshot names none).
    if (id && action !== 'clear' && read.id === conversationId && !read.turns.some(turn => turn.id === id))
      learnStatus(conversationId, await readCoordinatorMessage(id));
  }
  catch (error) {
    recordFailure(error, 'coordinator action check');
    // A newer accepted snapshot may already prove completion even if this read failed.
    return actionResult(action, conversationId, id, useConversation.getState().conversation) === 'done' ? 'done' : 'unknown';
  }
  return actionResult(action, conversationId, id, useConversation.getState().conversation);
}
function sayActionFailure(action: Action, result: ActionResult, error: unknown, tell = (text: string) => { notify.error(text, { from: 'coordinator' }); }) {
  recordFailure(error, `coordinator ${action}`);
  const text = action === 'withdraw'
    ? result === 'pending' ? i18n.t('ui:coordinatorCard.withdrawFailed') : i18n.t('ui:coordinatorCard.withdrawUnknown')
    : action === 'clear'
    ? result === 'unknown' ? i18n.t('ui:coordinatorCard.clearUnknown') : i18n.t('ui:coordinatorCard.clearFailed')
    : action === 'reset'
    ? result === 'unknown' ? i18n.t('ui:coordinatorCard.reset.unknown') : i18n.t('ui:coordinatorCard.reset.failed')
    : result === 'unknown' ? i18n.t('ui:coordinatorCard.sendNowUnknown') : i18n.t('ui:coordinatorCard.sendNowFailed');
  // This Owner has checked the operation's result; the original transport retry no longer classifies its words.
  tell(text);
}
/**
 * Send-now and clear: one POST answered by a snapshot. No automatic POST again: one read may recover an answer lost
 * after commit. This Owner says the checked outcome; callers only record the fault it propagates.
 */
async function checkedAction(action: 'send-now' | 'clear', conversationId: string, id: string | undefined, post: () => Promise<CoordinatorSnapshot>, replace = false): Promise<void> {
  const origin = sending();
  try {
    if (takeSnapshot(await post(), origin, replace) === 'satisfied') await useConversation.getState().refresh();
  } catch (error) {
    const result = await checkAction(action, conversationId, id);
    if (result === 'done') return;
    sayActionFailure(action, result, error);
    throw error;
  }
}
/** Before it is sent it is cancelled here; after, serve is asked, and may answer that the work has already started. */
async function withdraw(root: string, conversation: CoordinatorConversation, messageId: string): Promise<void> {
  const id = conversation.id;
  const localCancellation = cancelBeforeSend(root, messageId, currentInputKey());
  if (localCancellation !== null) {
    if (localCancellation === 'undone') return; // The undo offer and its recovery already settled it.
    reconcileReaderSends({ ...conversation, turns: [], cancelled: [messageId] }, root);
    if (localCancellation === 'restored') dismissRecoveredReaderSends(messageId, { root, conversationId: id });
    return;
  }
  const withdrawal = beginWithdrawal(root, messageId, conversation);
  if (!withdrawal) return;
  const origin = sending();
  try {
    const next = await coordinatorMessageAction('withdraw', id, messageId);
    if (next.conversation.id === id && next.message.id !== messageId)
      throw new ApiError('Withdrawal response does not identify this request', 'invalid_response', 'check');
    learnStatus(next.conversation.id, next.message);
    const holdsTurn = next.message.status !== 'withdrawn' && next.message.status !== 'missing';
    if (next.root === origin.root && next.conversation.id === id && holdsTurn) confirmStarted(root, messageId);
    if (takeSnapshot(next, origin) === 'satisfied') await useConversation.getState().refresh();
  } catch (error) {
    const started = withdrawalStarted(error);
    if (started) confirmStarted(root, messageId);
    // No automatic POST: one read may recover an answer lost after commit.
    const result = await checkAction('withdraw', id, messageId);
    const received = useConversation.getState().conversation;
    if (received?.id === id) {
      if (received.cancelled.includes(messageId)) return;
      if (!started && received.turns.some(turn => turn.id === messageId && turn.status !== 'queued')) return;
    }
    if (error instanceof ApiError && error.reason?.kind === 'conversation_has_changed') {
      if (cancelOutgoing(root, messageId, currentInputKey()) === 'restored') dismissRecoveredReaderSends(messageId, { root, conversationId: id });
      return;
    }
    if (received && received.id !== id) return;
    if (started) notify.error(i18n.t('ui:coordinatorCard.withdrawStarted'), { id: deliveryNoticeId(root, messageId), from: 'coordinator' });
    else {
      if (result === 'pending') rejectWithdrawal(root, messageId);
      sayActionFailure('withdraw', result, error, text => deliveryNotice(root, messageId, text, { kind: result === 'pending' ? 'operation' : 'withdrawal-unknown', action: { label: i18n.t('ui:coordinatorCard.withdraw'), run: () => {
        void useConversation.getState().messageAction('withdraw', messageId).catch(error => recordFailure(error, 'coordinator withdraw'));
      } } }));
    }
    throw error;
  } finally { withdrawal.finish(); }
}
type Learnt = Pick<CoordinatorConversation, 'cancelled' | 'admitted'>;
const NOTHING_LEARNT: Learnt = { cancelled: [], admitted: {} };
/** What the learnt statuses say, worked out once per set of them: the same arrays for every projection until it changes. */
const learntOf = new WeakMap<object, Learnt>();
function learnt(statuses: Readonly<Record<string, CoordinatorMessageResponse['message']>>): Learnt {
  let said = learntOf.get(statuses);
  if (!said) {
    const all = Object.values(statuses);
    said = all.length ? { cancelled: all.flatMap(status => status.status === 'withdrawn' ? [status.id] : []),
      admitted: Object.fromEntries(all.flatMap(status => 'inputDigest' in status
        ? [[status.id, { digest: status.inputDigest, ended: !['queued', 'sending', 'running'].includes(status.status) }]] : [])) } : NOTHING_LEARNT;
    learntOf.set(statuses, said);
  }
  return said;
}
/** Serve's conversation with what this page has learnt of its messages: those withdrawn, and the inputs serve took. */
export function withLearnt(conversation: CoordinatorSnapshot['conversation'], known = useConversationUi.getState().learnt): CoordinatorConversation {
  return { ...conversation, ...known?.conversationId === conversation.id ? learnt(known.statuses) : NOTHING_LEARNT };
}
/**
 * Statuses are kept while a send of this page's still waits to be settled by them: once its record is settled (drawn,
 * withdrawn, refused), nothing reads its status again, so it is let go rather than kept for every send of the session.
 */
function keepLearntFor(root: string) {
  const known = useConversationUi.getState().learnt;
  if (!known) return;
  const open = new Set(outgoing(useDraftStore.getState().entries, root, known.conversationId).map(item => item.requestId));
  const ids = Object.keys(known.statuses), kept = ids.filter(id => open.has(id));
  if (kept.length === ids.length) return;
  useConversationUi.setState({ learnt: kept.length ? { conversationId: known.conversationId,
    statuses: Object.fromEntries(kept.map(id => [id, known.statuses[id]!])) } : null });
}
/**
 * One sent message's status read from serve, for a send whose answer was lost: what it says is kept (learnStatus), and
 * the conversation given is returned with it.
 */
export async function withStatus(conversation: CoordinatorSnapshot['conversation'], id: string): Promise<CoordinatorConversation> {
  learnStatus(conversation.id, await readCoordinatorMessage(id));
  return withLearnt(conversation);
}
/**
 * What one message's status says, kept for its conversation (a new conversation starts with none): withdrawn, or taken
 * with the digest of its input. Missing says nothing to keep.
 */
function learnStatus(conversationId: string, message: CoordinatorMessageResponse['message']): boolean {
  if (message.status === 'missing') return false;
  const known = useConversationUi.getState().learnt, statuses = known?.conversationId === conversationId ? known.statuses : {};
  const before = statuses[message.id];
  // A withdrawal is final: a status read before it (an older answer arriving late) does not undo it.
  if (before?.status === 'withdrawn' || before?.status === message.status && ('inputDigest' in before) === ('inputDigest' in message)) return false;
  useConversationUi.setState({ learnt: { conversationId, statuses: { ...statuses, [message.id]: message } } });
  return true;
}
type Taken = 'shown' | 'satisfied' | 'scope-lost';
function take(received: CoordinatorSnapshot['conversation'], origin: Sending, replace = false, drawable = true): Taken {
  const next = withLearnt(received);
  const conflict = i18n.t('ui:coordinatorCard.conflict');
  // Facts are received even when this snapshot loses the display race; a turn under a sent request's ID with other
  // words is not a fact about that request.
  const isolated = isolateConflicts(next, origin.root, conflict);
  if (sameReadSession(queryClient, origin.reception.boundary)) reconcileReaderSends(isolated.size ? { ...next, turns: next.turns.filter(turn => !isolated.has(turn.id)) } : next, origin.root);
  const taken = drawable ? draw(next, origin, replace) : 'scope-lost';
  if (taken === 'shown') observeReaderConversation({root:origin.root,conversationId:next.id});
  // What it holds is accepted, from whichever answer (a send's, or a read after the event) brings it first; it is
  // settled once a drawn snapshot holds it, so it is never out of sight. Not drawn, a newer read is asked for.
  const reconcile = (conversation: CoordinatorConversation, drawn: boolean) => {
    const result = reconcileOutbox(conversation, origin.root, currentInputKey(), drawn, conflict);
    for (const id of result.restored) dismissRecoveredReaderSends(id, { root: origin.root, conversationId: conversation.id });
    return result.undrawn;
  };
  if (reconcile(next, taken === 'shown') && taken !== 'scope-lost') {
    // The drawn snapshot may hold it already (the event's read came first): then that one settles it.
    const drawn = taken === 'shown' ? next : useConversation.getState().conversation;
    if (drawn) reconcile(drawn, true);
    if (!drawn || awaitsDrawing(useDraftStore.getState().entries, origin.root, drawn)) void useConversation.getState().refresh();
  }
  // Every snapshot drawn, the same as the one held or not, is a moment to ask after sends it does not hold.
  if (taken === 'shown') { keepLearntFor(origin.root); void askAbsentSends(origin.root, next); }
  return taken;
}
function draw(next: CoordinatorConversation, origin: Sending, replace: boolean): Taken {
  const current = useConversation.getState();
  if (!admitResourceRead(queryClient, origin.reception)) return 'scope-lost';
  if (!sameScope(origin, current)) return 'scope-lost';
  if (!replace && next.id !== origin.id) return 'scope-lost';
  if (next.id !== origin.id && origin.id !== null) {
    closeReaderConversation({ root: origin.root, conversationId: origin.id });
    revision++;
  } else {
    confirmSeen(next.turns.filter(turn => turn.seen).map(turn => turn.id));
    if (origin.request < shown) return 'satisfied';
  }
  shown = Math.max(shown, origin.request);
  receive(next, origin.request);
  return 'shown';
}

/**
 * The read marks this page holds: those of the turns served now only. Older ones count as read (serve's rule), so every
 * way a mark arrives (a read, a drawing, a read receipt's answer) keeps the set within the range.
 */
function heldSeen(ids: Iterable<string>, conversation: Pick<CoordinatorConversation, 'turns'> | null): Set<string> {
  const served = new Set(conversation?.turns.map(turn => turn.id));
  return new Set([...ids].filter(id => served.has(id)));
}
function receive(next: CoordinatorConversation, request: number) {
  const state = useConversation.getState();
  const seen = heldSeen([...state.conversation?.id === next.id ? state.seen : [], ...next.turns.flatMap(turn => turn.seen ? [turn.id] : [])], next);

  const previous = useConversation.getState().conversation;
  // The opening learns from this conversation's reads (another conversation takes its own: the store's subscription).
  const taken = state.opening && (previous === null || previous.id === next.id)
    ? learn(state.opening, next.turns, request)
    : state.opening;
  if (previous?.id === next.id && next.turns.some(turn => turn.deliveryError && !ownsReaderSend(turn.id, { root: useConversation.getState().root, conversationId: next.id }) &&
    previous.turns.find(item => item.id === turn.id)?.deliveryError !== turn.deliveryError))
    notify.error(i18n.t("ui:coordinatorCard.deliveryRefused"), { from: "coordinator" });
  // Pressed while it was being read, the input comes up now, as the press asked.
  const wanted = previous === null && useConversation.getState().wanted;
  useConversation.setState({ seen, error: null, opening: taken,
    ...(wanted ? { wanted: false, open: true, engaged: true, focusRequested: true } : {}) });
}
type Ui = Omit<View, 'conversation' | 'read' | 'trying'>;
const useConversationUi = create<Ui>((set) => {
  const get = () => useConversation.getState();
  return ({
  root: '', opening: null,
  seen: new Set(), pendingSeen: new Set(), seenError: null, open: false, expanded: false, focusRequested: false, written: 0, engaged: false, listen: false, wanted: false, asked: 0, learnt: null, error: null,
  observeSeen: ids => {
    if (isAgentView() || readScope(queryClient)?.restored) return;
    const state = get(), valid = new Set(state.conversation?.turns.filter(hasAnswer).map(turn => turn.id));
    const pending = new Set(state.pendingSeen);
    for (const id of ids) if (valid.has(id) && !state.seen.has(id)) pending.add(id);
    if (pending.size !== state.pendingSeen.size) set({ pendingSeen: pending });
    queueSeen();
  },
  resumeSeen: () => {
    const error = get().seenError;
    // Invalid input/authorization need a changed scope or snapshot, not another identical POST.
    if (error && ['fix', 'reread'].includes(retryOf(error))) return;
    if (error) set({ seenError: null });
    queueSeen();
  },
  flushSeen: (keepalive = false) => {
    if (keepalive && [...get().pendingSeen].some(id => !seenFlight || !seenFlight.ids.includes(id))) keepaliveScope = capture();
    void sendSeen();
  },
  setOpen: open => {
    set(open ? { open, engaged: true, wanted: false } : { open, expanded: false, listen: false, focusRequested: false, wanted: false });
    if (open) void get().refresh();
  },
  setExpanded: expanded => {
    // Taken with the press in one update; the press's own read is the next one sent.
    const pressed = expanded && !get().expanded ? { opening: opening(get().conversation?.turns ?? [], sent + 1) } : {};
    set({ expanded, wanted: false, ...pressed, ...(expanded ? { open: true, engaged: true } : {}) });
    if (expanded) { get().resumeSeen(); void get().refresh(); }
  },
  refresh: async () => {
    const previous = conversationObserver, observer = bindConversation();
    if (!observer) return;
    const query = observer.getCurrentQuery();
    if (previous === observer || query.state.fetchStatus === 'idle') {
      requestRead(readQuery(queryClient, query.queryKey)!);
      if (query.state.fetchStatus !== 'idle') cancelResourceRead(query);
      void observer.refetch({ cancelRefetch: true });
    }
    await latestRead?.catch(() => {});
  },
  retry: () => {
    notify.dismiss(READ_FAILURE);
    void get().refresh();
    // Query render subscriptions are batched; a toast Retry must replace its hit target in this click.
    sayReadFailure();
  },
  follow: () => { get().resumeSeen(); bindConversation(true); },
  ask: async (input, basis, keepalive = false) => {
    // All senders (the input, retries and reader submissions) meet this same clear boundary.
    const closing = clearingConversation(get().root, input.conversationId);
    if (closing) await closing.catch(() => {});
    get().resumeSeen();
    const origin = sending();
    if (!input.conversationId) throw new Error("Coordinator request has no conversation scope");
    if (input.conversationId !== origin.id) throw new ApiError("Coordinator conversation has changed", "conflict", "reread", undefined, [], { kind: "conversation_has_changed" });
    if (useDraftStore.getState().entries[outgoingKey(origin.root, input.id)]?.values.last === 'withdraw' || get().conversation?.cancelled.includes(input.id)) return false;
    const { answers, ...message } = input;
    const captured = answers === undefined ? undefined : coordinatorAnswersInputSchema.safeParse(answers);
    if (captured?.success === false)
      throw new ApiError(i18n.t('ui:input.questionsChanged'), 'conflict', 'reread');
    set(state => ({ asked: state.asked + 1 }));
    const next = await askCoordinator({ ...message, ...captured ? { answers: captured.data } : {} }, basis, keepalive);
    if (next.conversation.id !== input.conversationId || next.message.id !== input.id || next.message.status === 'missing')
      throw new ApiError('Coordinator response does not identify this request', 'unavailable', 'check');
    learnStatus(next.conversation.id, next.message);
    takeSnapshot(next, origin);
    return inScope(origin);
  },
  messageAction: async (action, messageId) => {
    const { root, conversation } = get(), id = conversation?.id;
    if (!id) throw new Error("Coordinator conversation is not loaded");
    if (action === 'withdraw') await withdraw(root, conversation, messageId);
    else await checkedAction('send-now', id, messageId, () => coordinatorMessageAction('send-now', id, messageId));
  },
  clear: async () => {
    const id = get().conversation?.id;
    if (!id) return;
    revision++;
    await checkedAction('clear', id, undefined, () => clearCoordinator(id), true);
  },
  reset: async () => {
    const id = get().conversation?.id;
    if (!id) return;
    // One press is one operation: serve keeps the reset it made under it, so a lost answer is checked by asking again
    // with the same one (answered with that reset, or making it now), never by reading what the conversation holds.
    const opId = crypto.randomUUID();
    const post = async () => { const origin = sending(); if (takeSnapshot(await resetCoordinator(id, opId), origin) === 'satisfied') await get().refresh(); };
    try { await post(); }
    catch (error) {
      if (retryOf(error) !== 'check') { sayActionFailure('reset', 'pending', error); throw error; }
      try { await post(); }
      catch (again) { sayActionFailure('reset', retryOf(again) === 'check' ? 'unknown' : 'pending', again); throw again; }
    }
  },
});
});
/** The sole displayed conversation is a projection of QueryCache and session ACK evidence. */
let projected: { ui: Ui; root: string; data: CoordinatorSnapshot['conversation'] | null; trying: boolean; view: View } | undefined;
function conversationView(): View {
  const ui = useConversationUi.getState();
  const root = ui.root || readIndex(queryClient)?.root || '';
  const query = readQuery(queryClient, ['coordinator', root]);
  const data = coordinatorReadState(queryClient, root).snapshot?.conversation ?? null;
  const trying = !!query && query.state.fetchStatus !== 'idle';
  if (projected?.ui === ui && projected.root === root && projected.data === data && projected.trying === trying) return projected.view;
  const known = data && withLearnt(data, ui.learnt);
  const conversation = known && known.turns.some(turn => !turn.seen && ui.seen.has(turn.id))
    ? { ...known, turns: known.turns.map(turn => ui.seen.has(turn.id) && !turn.seen ? { ...turn, seen: true } : turn) } : known;
  const view: View = { ...ui, root, conversation, read: allRead(conversation), trying };
  projected = { ui, root, data, trying, view }; return view;
}
function subscribeConversation(listener: (next: View, before: View) => void) {
  let before = conversationView();
  const changed = () => { const next = conversationView(); if (next !== before) { const previous = before; before = next; listener(next, previous); } };
  const stopUi = useConversationUi.subscribe(changed), stopReads = subscribeReads(queryClient, changed);
  return () => { stopUi(); stopReads(); };
}
export const useConversation = Object.assign(<T = View>(select: (view: View) => T = (view => view as unknown as T)) =>
  useSyncExternalStore(subscribeConversation, () => select(conversationView()), () => select(conversationView())), {
  getState: conversationView, getInitialState: useConversationUi.getInitialState,
  setState: useConversationUi.setState, subscribe: subscribeConversation,
});
// Wait for reception without retaining a raw DTO or failure outside the Query owner.
let latestRead: Promise<void> | undefined;
let conversationObserver: QueryObserver<CoordinatorSnapshot, Error, CoordinatorSnapshot, CoordinatorSnapshot, readonly ['coordinator', string]> | undefined, observerRoot = '', stopObserver: (() => void) | undefined;
/** Resources own demand; the card supplies acceptance before Query commits. */
function bindConversation(initialDemand = false) {
  const root = useConversation.getState().root, index = readIndex(queryClient);
  if (!root || index?.root !== root) return;
  const query = readQuery(queryClient, ['coordinator', root]);
  if (conversationObserver && observerRoot === root && Object.is(query, conversationObserver.getCurrentQuery())) return conversationObserver;
  stopObserver?.(); conversationObserver?.destroy(); observerRoot = root;
  const options = resources.coordinator(queryClient, root, fetchSnapshot), load = options.queryFn;
  if (typeof load !== 'function') throw new Error('Conversation resource has no read function');
  const observer = new QueryObserver(queryClient, { ...options, queryFn: context => {
    const reading = Promise.resolve(load(context));
    latestRead = reading.then(() => undefined, () => undefined);
    return reading;
  } });
  conversationObserver = observer;
  if (initialDemand && observer.getCurrentQuery().state.data === undefined) requestRead(readQuery(queryClient, observer.getCurrentQuery().queryKey)!);
  stopObserver = observer.subscribe(() => {});
  return observer;
}
/** A check consumes the exact accepted GET, after the store's raw reception has kept its business facts. */
export async function readConversationSnapshot(): Promise<CoordinatorSnapshot> {
  const refreshing = useConversation.getState().refresh();
  const root = useConversation.getState().root;
  const [, snapshot] = await Promise.all([refreshing,
    fetchAcceptedResource(queryClient, { ...resources.coordinator(queryClient, root, fetchSnapshot), staleTime: 0 })]);
  return snapshot;
}
function takeSnapshot(snapshot: CoordinatorSnapshot, origin: Sending, replace = false): Taken {
  if (!origin.proof || snapshot.root !== origin.root)
    throw new ApiError('Conversation response answered another scope', 'invalid_response', 'check');
  // Persisted delivery facts survive a serve generation change; only drawing requires its read proof.
  const taken = take(snapshot.conversation, origin, replace, snapshot.generation === origin.proof.generation);
  // The read keeps the snapshot alone: an answer's own facts (its message, its reset) are not part of it.
  const { root, generation, revision, conversation } = snapshot;
  if (taken === 'shown') acceptCoordinatorSnapshot(queryClient, { root, generation, revision, conversation }, origin.proof);
  return taken;
}
async function fetchSnapshot(fetch: () => Promise<CoordinatorSnapshot>): Promise<CoordinatorSnapshot> {
  const origin = sending(), { request } = origin;
  try {
    const next = await fetch();
    if (!origin.proof || next.root !== origin.root)
      throw new ApiError('Conversation answered another scope', 'invalid_response', 'later');
    if (next.generation !== origin.proof.generation) {
      take(next.conversation, origin, true, false);
      throw new ApiError('Conversation answered another scope', 'invalid_response', 'later');
    }
    const taken = take(next.conversation, origin, true);
    if (taken === 'scope-lost') { cancelCapturedResourceRead(queryClient, origin.reception); throw new CancelledError({ revert: true }); }
    return next;
  } catch (error) {
    const current = useConversation.getState();
    if (origin.root !== current.root) throw error;
    if (!admitResourceRead(queryClient, origin.reception) || !sameScope(origin, current)) {
      requestLaterReadDemand(queryClient, ['coordinator', current.root], () => { bindConversation(true); }, origin.reception);
      // The successor owns the lost demand. A fault from the obsolete flight must
      // retire here instead of entering the current scope's retry/backoff policy.
      cancelCapturedResourceRead(queryClient, origin.reception);
      throw error instanceof CancelledError ? error : Object.assign(new CancelledError({ revert: true }), { cause: error });
    }
    if (error instanceof CancelledError) throw error;
    if (shown <= request) { recordFailure(error, "coordinator read"); readFailure = error; useConversation.setState({ error: String(error) }); }
    throw error;
  }
}
/** A single transport for this store; a superseded scope may finish, but cannot confirm the new one. */
let seenFlight: { origin: Origin; ids: string[] } | null = null, seenQueued = false;
let keepaliveScope: Origin | null = null;
const inScope = (origin: Origin): boolean => {
  const current = useConversation.getState();
  return sameReadSession(queryClient, origin.reception.boundary) && origin.id !== null && sameScope(origin, current);
};
function confirmSeen(ids: readonly string[]) {
  const current = useConversation.getState(), seen = heldSeen([...current.seen, ...ids], current.conversation);
  if (seen.size === current.seen.size && [...seen].every(id => current.seen.has(id))) return;
  useConversation.setState({ seen });
}
function queueSeen() {
  if (seenQueued || seenFlight || !useConversation.getState().pendingSeen.size || useConversation.getState().seenError) return;
  seenQueued = true;
  queueMicrotask(() => { seenQueued = false; void sendSeen(); });
}
async function sendSeen() {
  const state = useConversation.getState();
  const keepalive = keepaliveScope !== null && inScope(keepaliveScope);
  if (seenFlight || !state.conversation || !state.pendingSeen.size || state.seenError && (!keepalive || ['fix', 'reread'].includes(retryOf(state.seenError)))) return;
  const flight = { origin: capture(), ids: [...state.pendingSeen].slice(0, 128) };
  seenFlight = flight;
  keepaliveScope = null;
  try {
    const ack = await markCoordinatorSeen(state.conversation.id, flight.ids, keepalive);
    if (!inScope(flight.origin)) return;
    const accepted = new Set(ack.seen);
    if (ack.conversationId !== flight.origin.id || accepted.size !== flight.ids.length || flight.ids.some(id => !accepted.has(id)))
      throw new ApiError('Read acknowledgement does not identify the submitted replies', 'invalid_response', 'check');
    const current = useConversation.getState(), pending = new Set(current.pendingSeen);
    // An ACK knows only its request, never the observations added while it was in flight. Confirmed in the same
    // update that drops them from pending, so no observer meets the same replies neither pending nor seen; those the
    // range has left meanwhile are read already.
    for (const id of flight.ids) pending.delete(id);
    const seen = heldSeen([...current.seen, ...flight.ids], current.conversation);
    useConversation.setState({ pendingSeen: pending, seen, seenError: null });
  } catch (error) {
    if (!inScope(flight.origin)) return;
    useConversation.setState({ seenError: error });
    recordFailure(error, 'coordinator read receipt');
    if (retryOf(error) === 'reread') void useConversation.getState().refresh();
  } finally {
    seenFlight = null;
    if (keepaliveScope && inScope(keepaliveScope) && useConversation.getState().pendingSeen.size) void sendSeen();
    else queueSeen(); // Success drains a batch; failure waits for an existing recovery signal.
  }
}
// Reset only at the existing workspace/conversation/close boundaries, including direct workspace updates.
useConversation.subscribe((next, before) => {
  // A failed read ends once one succeeds, and with its workspace: another workspace's read has not failed.
  if (before.error && !next.error || next.root !== before.root) { readFailureSaid = null; askedByToast = false; notify.dismiss(READ_FAILURE); }
  if (next.root !== before.root && next.error) { readFailure = null; useConversation.setState({ error: null }); }
  sayReadFailure();
  const scopeChanged = next.root !== before.root || next.conversation?.id !== before.conversation?.id;
  if (next.root !== before.root) { revision++; stopObserver?.(); conversationObserver?.destroy(); conversationObserver = undefined; }
  const closed = !next.expanded && before.expanded;
  // Another conversation replacing the open one (cleared) is opened as a read has already drawn it; one gone waits,
  // as at a press, for the next read sent (the first to arrive is learnt in `receive`).
  const replaced = scopeChanged && next.expanded && before.conversation !== null;
  if (scopeChanged || closed) {
    useConversation.setState({
      ...(scopeChanged ? {
        seen: new Set(next.root === before.root ? next.conversation?.turns.filter(turn => turn.seen).map(turn => turn.id) : []),
        pendingSeen: new Set(), seenError: null,
      } : {}),
      opening: replaced ? next.conversation ? opening(next.conversation.turns) : opening([], sent + 1) : next.expanded ? next.opening : null,
    });
  }
});
// What was cut off goes on once there is a conversation for it: a send whose checks ended with nothing sent goes back, one
// held for a grace the page before this one started goes. That can be left by a reload, seen when the conversation
// arrives or changes, or by a new read session ending an attempt here, seen when the attempt ends.
const recoverOutbox = (root: string) => {
  settleInterrupted(root, i18n.t('ui:coordinatorCard.interrupted'));
  resumeQueuedOutgoing(root);
};
/**
 * A send serve took that its snapshot no longer holds was withdrawn (here or on another page), or has ended among the
 * turns older than the snapshot's: its own status says which. It is asked while the send's record stands unsettled (one
 * question at a time); once its status settles the record, nothing is left to ask about.
 */
const statusAsking = new Set<string>();
/**
 * Sends serve said it does not have (missing): asked again only once that can have changed, the page back in reach or a
 * send attempted again (a new snapshot alone does not change it).
 */
const statusMissing = new Set<string>();
/** `received`: the snapshot just taken, before the read holds it (a first read has nothing held yet). */
async function askAbsentSends(root: string, received: CoordinatorConversation) {
  const conversation = received;
  const absent = outgoing(useDraftStore.getState().entries, root, conversation.id).filter(item => (item.stage === 'posted' || item.stage === 'accepted')
    && !statusAsking.has(item.requestId) && !statusMissing.has(item.requestId) && !isLive(item.key) && !conversation.turns.some(turn => turn.id === item.requestId)
    // Withdrawn is final: its record settles with what is known.
    && !conversation.cancelled.includes(item.requestId));
  let learnt = false;
  for (const item of absent) {
    statusAsking.add(item.requestId);
    try {
      const status = await readCoordinatorMessage(item.requestId);
      if (status.status === 'missing') statusMissing.add(item.requestId);
      learnt = learnStatus(conversation.id, status) || learnt;
    }
    catch (error) { recordFailure(error, 'coordinator message status'); return; }
    finally { statusAsking.delete(item.requestId); }
  }
  const now = useConversation.getState();
  // Only what a status newly said can settle anything here.
  if (learnt && now.root === root && now.conversation?.id === conversation.id) {
    // As a snapshot's facts are taken: other words under its ID kept apart, then the rest settled.
    isolateConflicts(now.conversation, root, i18n.t('ui:coordinatorCard.conflict'));
    const result = reconcileOutbox(now.conversation, root, currentInputKey());
    for (const id of result.restored) dismissRecoveredReaderSends(id, { root, conversationId: conversation.id });
    reconcileReaderSends(now.conversation, root);
    // Newly known to be taken and still at work, yet not in this snapshot: a newer one holds it. Asked once per status
    // learnt, so a snapshot that keeps lacking it waits for the next change rather than reading again and again.
    if (result.undrawn) void useConversation.getState().refresh();
  }
}
useConversation.subscribe((next, before) => {
  if (next.conversation && (next.root !== before.root || next.conversation !== before.conversation)) recoverOutbox(next.root);
});
useOutbox.subscribe((next, before) => {
  // A send attempted again (here, or a resend) can have reached serve since it was missing.
  if ([...next.live].some(key => !before.live.has(key))) statusMissing.clear();
  const { root, conversation } = useConversation.getState();
  // Drafts that cannot be saved cannot change: the attempt has said so, and recovering would only take that notice away.
  if (conversation && next.live.size < before.live.size && !useDraftStore.getState().unavailable) recoverOutbox(root);
});
useConnection.subscribe((next, before) => { if (next.offline !== before.offline) sayReadFailure(); });
onBackInReach(() => {
  statusMissing.clear();
  const state = useConversation.getState();
  if (state.error) void state.refresh();
  state.resumeSeen();
});
