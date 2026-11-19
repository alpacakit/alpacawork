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

/** An open conversation on a visible page reads every completed reply, including folded history. */
export function useConversationReading(doc: Document, rootScope: string, conversationId: string | null) {
  useEffect(() => {
    const read = () => {
      const state = useConversation.getState();
      if (!state.expanded || !state.conversation || state.root !== rootScope || state.conversation?.id !== conversationId
        || doc.visibilityState !== "visible") return;
      state.observeSeen(state.conversation.turns.filter(isUnread).map(turn => turn.id));
    };
    const leave = () => useConversation.getState().flushSeen(true);
    const visibility = () => { if (doc.visibilityState === "visible") read(); else leave(); };
    const stop = useConversation.subscribe(read);
    doc.addEventListener("visibilitychange", visibility);
    doc.defaultView?.addEventListener("pagehide", leave);
    read();
    return () => {
      stop();
      doc.removeEventListener("visibilitychange", visibility);
      doc.defaultView?.removeEventListener("pagehide", leave);
    };
  }, [doc, rootScope, conversationId]);
}
