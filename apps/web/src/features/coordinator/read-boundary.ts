import { useEffect } from "react";
import { partitionTurns } from "./shown";
import type { CoordinatorConversation, CoordinatorTurn } from "@/data/coordinator";
import { useConversation } from "./coordinator";

/** Request IDs identify completed replies; timestamps never imply that a different reply was read. */
export const hasAnswer = (turn: CoordinatorTurn) => turn.answeredAt !== null && ["succeeded", "failed"].includes(turn.status);
/** Only replies are read or unread: never what you said, nor work still under way. */
export const isUnread = (turn: CoordinatorTurn) => hasAnswer(turn) && !turn.seen;
export const allRead = (conversation: CoordinatorConversation | null) => !(conversation?.turns ?? []).some(isUnread);

/** Presentation only: an opening anchors the latest exchange without re-folding it when new replies arrive. */
let openings = 0;
export function opening(turns: readonly CoordinatorTurn[], waitFor?: number) {
  return { id: ++openings, latest: partitionTurns(turns).thread.at(-1)?.id ?? null,
    waitFor: waitFor ?? 0, settled: waitFor === undefined };
}
export type Opening = ReturnType<typeof opening>;
/** The opening's first fresh snapshot supplies its position; later reads do not move an established opening. */
export function learn(taken: Opening, turns: readonly CoordinatorTurn[], request: number): Opening {
  return taken.settled ? taken : { ...taken, latest: partitionTurns(turns).thread.at(-1)?.id ?? null,
    settled: request >= taken.waitFor };
}

/**
 * How long a person's last action on a page keeps it reading what arrives. Every screen shares one read state, so a
 * page left open with nobody at it (a desktop tab stays "visible" while its person is away) must not read for them.
 */
export const ATTENDED_MS = 30_000;
/**
 * Only input a person makes: pointer moves are left out because browsers send them when the page changes under a
 * still pointer, and scroll because the thread scrolls itself to a new reply.
 */
const ACTIONS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** When a person last acted on each page; kept across conversations, so the press that opens one still counts. */
const actedAt = new WeakMap<Document, number>();
const attended = (doc: Document) => Date.now() - (actedAt.get(doc) ?? -Infinity) <= ATTENDED_MS;

/**
 * An open conversation on a visible page that a person has acted on recently reads every completed reply, including
 * folded history; a reply that arrives at an unattended page stays unread until the next action or showing.
 */
export function useConversationReading(doc: Document, rootScope: string, conversationId: string | null) {
  useEffect(() => {
    const read = () => {
      const state = useConversation.getState();
      if (!state.expanded || !state.conversation || state.root !== rootScope || state.conversation?.id !== conversationId
        || doc.visibilityState !== "visible" || !attended(doc)) return;
      state.observeSeen(state.conversation.turns.filter(isUnread).map(turn => turn.id));
    };
    const act = () => { actedAt.set(doc, Date.now()); read(); };
    const leave = () => useConversation.getState().flushSeen(true);
    // Bringing the page into view is itself a person's action.
    const visibility = () => { if (doc.visibilityState === "visible") act(); else leave(); };
    const stop = useConversation.subscribe(read);
    for (const type of ACTIONS) doc.addEventListener(type, act, { capture: true, passive: true });
    doc.addEventListener("visibilitychange", visibility);
    doc.defaultView?.addEventListener("pagehide", leave);
    read();
    return () => {
      stop();
      for (const type of ACTIONS) doc.removeEventListener(type, act, { capture: true });
      doc.removeEventListener("visibilitychange", visibility);
      doc.defaultView?.removeEventListener("pagehide", leave);
    };
  }, [doc, rootScope, conversationId]);
}
