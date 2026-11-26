import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { readCoordinatorTurns, type CoordinatorReset, type CoordinatorTurn } from "./coordinator";

/**
 * The turns older than a conversation snapshot's, as serve returns them: one window, in serve's order, that ends right
 * before the snapshot's first turn (`until`, the snapshot's `earlier.before` when it was read), so nothing between it and
 * the snapshot is missing. `more`: where the next older page starts; null once the conversation's first turn is here.
 * `resets`: those serve returned for these turns.
 */
export type CoordinatorHistory = { until: string; turns: CoordinatorTurn[]; resets: CoordinatorReset[]; more: string | null };

const key = (root: string, conversationId: string) => ['coordinator-history', root, conversationId] as const;
/** Windows whose next read is one page further back, rather than the window read again. */
const widen = new WeakSet<object>();

type Pages = { turns: CoordinatorTurn[]; resets: CoordinatorReset[]; more: string | null };
/** Pages read back from `before` while `enough` does not hold of what is read (one page at least): serve's order. */
async function readBack(conversationId: string, before: string, enough: (turns: readonly CoordinatorTurn[]) => boolean, signal: AbortSignal): Promise<Pages> {
  let turns: CoordinatorTurn[] = [], resets: CoordinatorReset[] = [], cursor: string | null = before;
  do {
    const page = await readCoordinatorTurns(conversationId, { before: cursor }, signal);
    turns = [...page.turns, ...turns]; resets = [...page.resets, ...resets]; cursor = page.more;
  } while (cursor && !enough(turns));
  return { turns, resets, more: cursor };
}
/** Each reset once, older first: one read again replaces the held one. */
const joinResets = (older: readonly CoordinatorReset[], newer: readonly CoordinatorReset[]) => {
  const ids = new Set(newer.map(reset => reset.id));
  return [...older.filter(reset => !ids.has(reset.id)), ...newer];
};

/** A turn whose files the cleaning can still remove: it has some, and serve has not said they are gone. */
const cleanable = (turn: CoordinatorTurn) => !turn.filesExpired && (turn.attachments.length > 0 || !!turn.answerFiles?.length);
/**
 * The held window checked against serve for what the cleaning may have changed since: only the pages that hold a turn
 * with files still there are read (each page ending right after such a turn), and serve's turns replace those held. A
 * window with no such turn reads nothing.
 */
async function recheckFiles(conversationId: string, held: CoordinatorHistory, signal: AbortSignal): Promise<CoordinatorHistory> {
  const fresh = new Map<string, CoordinatorTurn>();
  for (let at = held.turns.length - 1; at >= 0; at--) {
    const turn = held.turns[at]!;
    if (!cleanable(turn) || fresh.has(turn.id)) continue;
    const page = await readCoordinatorTurns(conversationId, { before: held.turns[at + 1]?.id ?? held.until }, signal);
    for (const each of page.turns) fresh.set(each.id, each);
  }
  return fresh.size ? { ...held, turns: held.turns.map(turn => fresh.get(turn.id) ?? turn) } : held;
}
/**
 * What the window becomes for where the snapshot starts now (`boundary`):
 * - none held: the first page;
 * - the snapshot moved on: only the turns pushed out of it since are read (back to the window's end, `held.until`) and
 *   put after the window, so reading costs what moved, not what is held;
 * - the same boundary (stale, or the screen came back): the pages whose files the cleaning may have removed since.
 */
async function readWindow(conversationId: string, boundary: string, held: CoordinatorHistory | undefined, signal: AbortSignal): Promise<CoordinatorHistory> {
  if (!held) return { until: boundary, ...await readBack(conversationId, boundary, () => true, signal) };
  if (held.until !== boundary) {
    const gap = await readBack(conversationId, boundary, turns => turns.some(turn => turn.id === held.until), signal);
    const from = gap.turns.findIndex(turn => turn.id === held.until);
    // Not reached (the window's end is gone): what was read is the window now.
    if (from < 0) return { until: boundary, ...gap };
    return { until: boundary, turns: [...held.turns, ...gap.turns.slice(from)], resets: joinResets(held.resets, gap.resets), more: held.more };
  }
  return recheckFiles(conversationId, held, signal);
}
/** One page before the window's oldest turn, put before it: the page ends where the window starts. */
async function readOlder(conversationId: string, held: CoordinatorHistory, signal: AbortSignal): Promise<CoordinatorHistory> {
  if (!held.more) return held;
  const page = await readCoordinatorTurns(conversationId, { before: held.more }, signal);
  return { ...held, turns: [...page.turns, ...held.turns], resets: joinResets(page.resets, held.resets), more: page.more };
}

/**
 * The window as a Query, read when the history is opened (`boundary`: where the snapshot starts now). It is read again
 * when it is stale and the screen comes back (files cleaned since show as removed) and when the snapshot moves on;
 * `readOlderTurns` widens it by a page.
 */
export const coordinatorHistory = (client: QueryClient, root: string, conversationId: string, boundary: string) => queryOptions({
  queryKey: key(root, conversationId),
  queryFn: ({ signal }) => {
    const query = client.getQueryCache().find<CoordinatorHistory>({ queryKey: key(root, conversationId), exact: true });
    const held = query?.state.data;
    const wider = !!query && widen.delete(query);
    return wider && held && held.until === boundary ? readOlder(conversationId, held, signal) : readWindow(conversationId, boundary, held, signal);
  },
  staleTime: 60_000,
  refetchOnWindowFocus: true,
});

/**
 * The window's next read on request: one page further back, or, with none held yet (its first read failed), its first
 * page. Either way the same Query reads it, so a retry is a read like any other.
 */
export function readOlderTurns(client: QueryClient, root: string, conversationId: string) {
  const query = client.getQueryCache().find({ queryKey: key(root, conversationId), exact: true });
  if (!query) return Promise.resolve();
  widen.add(query);
  return query.fetch(undefined, { cancelRefetch: false }).then(() => undefined, () => undefined);
}
