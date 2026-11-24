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
 * Input only a person makes. Pointer moves are left out because browsers send them when the page changes under a
 * still pointer, and scroll because the thread scrolls itself to a new reply. Text can arrive without a key event
 * (an input method, dictation), so `beforeinput` counts too.
 */
const ACTIONS = ["pointerdown", "keydown", "wheel", "touchstart", "beforeinput"] as const;

/** The opening whose press is still owed what its own first fresh read brings (`opening` settles on it). */
let owed: number | null = null;

/**
 * An open conversation on a visible page reads the completed replies shown when a person acts: the press that opens
 * it reads every completed reply it holds, including folded history, and what its own first fresh read brings; any
 * later input on the page reads what has arrived since. Every screen shares one read state, so a reply that reaches
 * a page nobody acts on (a desktop tab stays "visible" while its person is away, or comes back into view when a tab
 * before it closes) stays unread.
 */
export function useConversationReading(doc: Document, rootScope: string, conversationId: string | null) {
  useEffect(() => {
    const read = () => {
      const state = useConversation.getState();
      if (!state.expanded || !state.conversation || state.root !== rootScope || state.conversation?.id !== conversationId
        || doc.visibilityState !== "visible") return false;
      state.observeSeen(state.conversation.turns.filter(isUnread).map(turn => turn.id));
      return true;
    };
    // Also at mount: a conversation first loaded by the press arrives with a new ID, so with a new subscription.
    const settle = () => {
      const { expanded, opening } = useConversation.getState();
      if (expanded && opening?.settled && opening.id === owed && read()) owed = null;
    };
    const act = () => { read(); };
    const leave = () => useConversation.getState().flushSeen(true);
    const visibility = () => { if (doc.visibilityState !== "visible") leave(); };
    const stop = useConversation.subscribe((next, before) => {
      // Opening is always a person's press (the line, a pull or a drag), taken after its pointerdown has passed.
      if (next.expanded && !before.expanded) { owed = next.opening?.id ?? null; read(); }
      settle();
    });
    for (const type of ACTIONS) doc.addEventListener(type, act, { capture: true, passive: true });
    doc.addEventListener("visibilitychange", visibility);
    doc.defaultView?.addEventListener("pagehide", leave);
    settle();
    return () => {
      stop();
      for (const type of ACTIONS) doc.removeEventListener(type, act, { capture: true });
      doc.removeEventListener("visibilitychange", visibility);
      doc.defaultView?.removeEventListener("pagehide", leave);
    };
  }, [doc, rootScope, conversationId]);
}
