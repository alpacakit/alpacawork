import { queryClient as client } from '@/data/query-client';
import { readIndex, subscribeReads } from '@/data/read-model';
import { useSendGrace } from '@/data/send-grace';
import { replyIn } from './editor/document';
import { createContext, startTransition, useContext, useEffect, useMemo, useSyncExternalStore, useOptimistic, type ReactNode } from "react";
import type { CoordinatorTurn } from "@/data/coordinator";
import { useShallow } from "zustand/react/shallow";
import { useDraftStore } from "@/features/forms/draft-store";
import { useConversation } from "./coordinator";
import { reviseDeliveryNotice } from "./delivery-notice";
import { press, type Press } from "./press";
import { isOutgoingIn, isLive, outgoing, outgoingDisplay, outgoingFinished, useOutbox, type Outgoing, type OutgoingDisplay } from "./editor/outbox";

/** A message as it is drawn: serve's turn, or one sent from here that no snapshot holds yet. */
export type SentTurn = Pick<CoordinatorTurn, "id" | "at" | "ask" | "tasks" | "attachments" | "filesExpired" | "replyTo" | "joinRequested" | "deliveryError"> & { status?: CoordinatorTurn["status"]; waiting?: boolean };
/**
 * A request sent from here that no drawn snapshot holds yet, in the conversation it was sent to (`root`,
 * `conversationId`). `waiting`: fixed here, not sent yet; `sending`: an attempt at it is under way in this page, or serve was seen to have it (never drawn
 * as at work); `unknown`: no attempt is, and whether serve has it is not known (it is resent as it was); `refused`: it
 * did not go (its words wait to go back to the input).
 */
/** `files`: where its attachments are read from until serve holds it (Outgoing.files). */
export type LocalTurn = SentTurn & { root: string; conversationId: string; files?: readonly string[] } & OutgoingDisplay;
export type TailTurn = { kind: 'server'; turn: CoordinatorTurn } | { kind: 'local'; turn: LocalTurn };
export type Shown = {
  turns: CoordinatorTurn[]; local: LocalTurn[];
  /** The partition all conversation surfaces draw, using serve's waiting facts and local send stages. */
  thread: CoordinatorTurn[]; waiting: CoordinatorTurn[]; joined: ReadonlyMap<string, CoordinatorTurn[]>;
  localThread: LocalTurn[]; localWaiting: LocalTurn[]; tail: TailTurn[];
  /** Draws `turn` as sending while `work` runs, in a transition; `work`'s result is returned. */
  send: <T>(turn: LocalTurn, work: () => Promise<T>) => Promise<T>;
  pressed: ReadonlyMap<string, Press['action']>;
  closing: boolean;
  press: (target: string, action: Press['action'], work: () => Promise<void>) => Promise<void>;
};

/** One partition, consumed by the thread, both queues, folded words and the read boundary. No display queue is saved. */
export function partitionTurns(turns: readonly CoordinatorTurn[], local: readonly LocalTurn[] = [], busy = false, sent: readonly SentTurn[] = local) {
  const thread: CoordinatorTurn[] = [], waiting: CoordinatorTurn[] = [];
  const joined = new Map<string, CoordinatorTurn[]>();
  const tail: TailTurn[] = [];
  // A failed message sent again is drawn once, as the message sent in its place; one another message joined stays,
  // as only its own words went again.
  const into = new Set(turns.flatMap(turn => turn.status === "joined" && turn.into ? [turn.into] : []));
  for (const turn of turns) {
    if (turn.sentAgain && !into.has(turn.id)) continue;
    if (turn.status === "joined") {
      if (turn.into) {
        const group = joined.get(turn.into);
        if (group) group.push(turn);
        else joined.set(turn.into, [turn]);
      }
    } else if (turn.waiting) {
      const queued = { ...turn, waiting: true };
      waiting.push(queued);
      tail.push({ kind: 'server', turn: queued });
    }
    else thread.push(turn);
  }
  const localThread: LocalTurn[] = [], localWaiting: LocalTurn[] = [];
  let ahead = busy;
  for (const turn of local) {
    tail.push({ kind: 'local', turn });
    if (outgoingFinished(turn)) localThread.push(turn);
    else { (ahead ? localWaiting : localThread).push(turn); ahead = true; }
  }
  // Keep the request's original timestamp and stable outbox order through local/server transitions.
  const order = new Map<string, { at: string; order: number }>();
  for (let at = 0; at < sent.length; at++) {
    const turn = sent[at]!;
    order.set(turn.id, { at: turn.at, order: at });
  }
  tail.sort((a, b) => {
    const left = order.get(a.turn.id), right = order.get(b.turn.id);
    return (left?.at ?? a.turn.at).localeCompare(right?.at ?? b.turn.at)
      || (left && right ? left.order - right.order : 0);
  });
  return { thread, waiting, joined, localThread, localWaiting, tail };
}

const toLocal = (root: string, item: Outgoing, live: boolean): LocalTurn => ({ id: item.requestId, at: item.at, ask: item.fixed.text,
  ...(item.fixed.tasks ? { tasks: item.fixed.tasks } : {}), attachments: item.fixed.attachments, files: item.files,
  ...(item.fixed.replyTo ? { replyTo: { id: item.fixed.replyTo, answeredAt: replyIn(item.doc)?.answeredAt ?? '', head: '' } } : {}), root, conversationId: item.fixed.conversationId,
  ...outgoingDisplay(item, live) });
const ShownConversation = createContext<Shown | null>(null);
const NO_PRESSES: readonly Press[] = [];
const subscribeRestore = (changed: () => void) => subscribeReads(client, changed);

/**
 * The one projection of the conversation the card draws (its thread, queue and folded line): serve's drawn snapshot is
 * the source of what was accepted; the outbox (editor/outbox.ts) of what was sent from here and is not settled, live
 * or not (so a card mounted again, or a page reloaded, draws it as before); and the send's action draws its request
 * through useOptimistic from the press, in the conversation it was sent to. A request is drawn once, by its ID: from
 * the moment a drawn snapshot holds it, it is serve's turn (whichever of the POST's answer and the event comes first).
 */
export function ShownConversationProvider({ children }: { children: ReactNode }) {
  // What the projection reads, each by itself: a new usage figure or reset changes none of them.
  const id = useConversation(state => state.conversation?.id);
  const turns = useConversation(state => state.conversation?.turns);
  const cancelled = useConversation(state => state.conversation?.cancelled);
  const busy = useConversation(state => state.conversation?.busy);
  const conversation = useMemo(() => id === undefined ? null : { id, turns: turns ?? [], cancelled: cancelled ?? [], busy: busy ?? false },
    [id, turns, cancelled, busy]);
  const root = useConversation(state => state.root);
  // An input edit changes drafts too, but only fixed outgoing requests belong to the conversation.
  const entries = useDraftStore(useShallow(state => Object.fromEntries(Object.entries(state.entries)
    .filter(([key]) => isOutgoingIn(key, root)))));
  const live = useOutbox(state => state.live);
  const graceRevision = useSendGrace(state => state.revision);
  const restoreId = useSyncExternalStore(subscribeRestore, () => readIndex(client)?.restoreId ?? null);
  const base = useMemo(() => {
    const local: LocalTurn[] = [];
    if (conversation) for (const item of outgoing(entries, root)) {
      if (!item.taken) local.push(toLocal(root, item, isLive(item.key, item.last, live)));
    }
    return local;
  }, [conversation?.id, entries, root, live, graceRevision, restoreId]);
  // The notice and its row consume the same restore fact, without creating another event or reviving a hidden one.
  useEffect(() => {
    for (const item of outgoing(entries, root)) {
      const display = outgoingDisplay(item, isLive(item.key, item.last, live));
      if (item.last === 'ask' && display.blocked && display.refusal) reviseDeliveryNotice(root, item.requestId, display.refusal);
    }
  }, [root, restoreId, entries, live]);
  const [rows, addSending] = useOptimistic(base, (current: LocalTurn[], turn: LocalTurn) => current.some(row => row.id === turn.id) ? current : [...current, turn]);
  const [presses, addPress] = useOptimistic<readonly Press[], Press>(NO_PRESSES, (current, next) => [...current, next]);
  const value = useMemo<Shown>(() => {
    const turns = conversation?.turns ?? [];
    const settled = new Set<string>();
    for (const turn of turns) settled.add(turn.id);
    for (const id of conversation?.cancelled ?? []) settled.add(id);
    // Unsettled sends belong to their conversation. Refused words remain recoverable in the visible conversation, even
    // when serve holds other words under its ID (it was kept apart from that turn).
    const local: LocalTurn[] = [];
    for (const row of rows) {
      if (row.root === root && (row.conversationId === conversation?.id || row.stage === 'refused') && (row.stage === "refused" || row.stage === "cancelled" || !settled.has(row.id)))
        local.push(row);
    }
    const pressed = new Map<string, Press['action']>();
    for (const each of presses) if (each.root === root && each.conversationId === conversation?.id) pressed.set(each.target, each.action);
    return { turns, local, ...partitionTurns(turns, local, conversation?.busy, rows), pressed, closing: pressed.get(conversation?.id ?? '') === 'clear',
      press: (target, action, work) => conversation ? press({ root, conversationId: conversation.id, target, action }, work, addPress) : Promise.resolve(),
      send: (turn, work) => new Promise((resolve, reject) => startTransition(async () => {
        addSending(turn);
        try { resolve(await work()); } catch (error) { reject(error); }
      })) };
  }, [conversation, root, rows, addSending, presses, addPress]);
  return <ShownConversation.Provider value={value}>{children}</ShownConversation.Provider>;
}
/** Outside the card (a lone input in a test), what serve holds, with nothing drawn ahead of it. */
const alone: Shown = { turns: [], local: [], ...partitionTurns([]), pressed: new Map(), closing: false, press: (_target, _action, work) => work(), send: (_turn, work) => work() };
export function useShownConversation(fallback?: CoordinatorTurn[]): Shown {
  const shown = useContext(ShownConversation);
  const turns = useConversation(state => state.conversation?.turns);
  return shown ?? { ...alone, turns: fallback ?? turns ?? [], ...partitionTurns(fallback ?? turns ?? []) };
}
