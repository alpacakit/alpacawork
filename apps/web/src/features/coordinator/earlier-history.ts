import { useCallback, useEffect, useRef, useState } from "react";
import { readCoordinatorTurns, type CoordinatorConversation, type CoordinatorReset, type CoordinatorTurn } from "@/data/coordinator";
import { recordFailure } from "@/lib/notify";

/**
 * The turns older than the snapshot's, read a page at a time on request, and the snapshot's own turns that newer ones
 * have pushed out of it while it was shown, so what was on screen stays there. `more`: where the next page starts,
 * none when the first turn is here.
 */
type Earlier = { conversationId: string | null; turns: readonly CoordinatorTurn[]; resets: readonly CoordinatorReset[]; more: string | null;
  loaded: boolean; reading: boolean; failed: boolean };
const NONE: Earlier = { conversationId: null, turns: [], resets: [], more: null, loaded: false, reading: false, failed: false };

const byTime = (a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at);
/** `older` before `newer`, each ID once (a newer copy wins: it may have changed since). */
function joined<T extends { id: string; at: string }>(older: readonly T[], newer: readonly T[]): T[] {
  const ids = new Set(newer.map(item => item.id));
  return [...older.filter(item => !ids.has(item.id)), ...newer].sort(byTime);
}

export function useEarlierHistory(conversation: CoordinatorConversation | null) {
  const [state, setState] = useState<Earlier>(NONE);
  const id = conversation?.id ?? null;
  const current = state.conversationId === id ? state : { ...NONE, conversationId: id };
  if (current !== state) setState(current);
  // What the snapshot held and holds no longer: its oldest turns, pushed out by newer ones.
  const held = useRef<{ conversationId: string | null; turns: Map<string, CoordinatorTurn> }>({ conversationId: null, turns: new Map() });
  useEffect(() => {
    if (!conversation) return;
    if (held.current.conversationId !== conversation.id) held.current = { conversationId: conversation.id, turns: new Map() };
    const now = new Set(conversation.turns.map(turn => turn.id)), out: CoordinatorTurn[] = [];
    for (const [turnId, turn] of held.current.turns) if (!now.has(turnId)) out.push(turn);
    held.current.turns = new Map(conversation.turns.map(turn => [turn.id, turn]));
    if (out.length) setState(before => before.conversationId === conversation.id ? { ...before, turns: joined(before.turns, out) } : before);
  }, [conversation]);
  const cursor = current.loaded ? current.more : conversation?.earlier?.before ?? null;
  const reading = useRef(false);
  /** The next page, before the oldest turn here; false when there was none to read or it could not be read. */
  const readMore = useCallback(async (): Promise<boolean> => {
    if (!id || !cursor || reading.current) return false;
    reading.current = true;
    setState(before => ({ ...before, reading: true, failed: false }));
    try {
      const page = await readCoordinatorTurns(id, { before: cursor });
      setState(before => before.conversationId !== id ? before : { ...before, turns: joined(page.turns, before.turns),
        resets: joined(page.resets, before.resets), more: page.more, loaded: true, reading: false });
      return true;
    } catch (error) {
      recordFailure(error, "coordinator earlier turns");
      setState(before => before.conversationId !== id ? before : { ...before, reading: false, failed: true });
      return false;
    } finally { reading.current = false; }
  }, [id, cursor]);
  return { turns: current.turns, resets: current.resets, more: cursor !== null, reading: current.reading, failed: current.failed, readMore,
    /** Turns older than the snapshot's that it counts but this page has not read. */
    unread: current.loaded ? null : conversation?.earlier?.count ?? 0 };
}
