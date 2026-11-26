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

/**
 * A window read again from where the snapshot now starts (`boundary`), down to its oldest turn: serve's turns, order and
 * resets for the whole range replace the held ones, so turns withdrawn or cleaned since, and turns pushed out of the
 * snapshot since, are as serve has them. The first read (none held) is the first page.
 */
async function readWindow(conversationId: string, boundary: string, held: CoordinatorHistory | undefined, signal: AbortSignal): Promise<CoordinatorHistory> {
  const oldest = held?.turns[0]?.id;
  let turns: CoordinatorTurn[] = [], resets: CoordinatorReset[] = [], cursor: string | null = boundary;
  do {
    const page = await readCoordinatorTurns(conversationId, { before: cursor }, signal);
    turns = [...page.turns, ...turns]; resets = [...page.resets, ...resets]; cursor = page.more;
  } while (cursor && oldest && !turns.some(turn => turn.id === oldest));
  return { until: boundary, turns, resets, more: cursor };
}
/** One page before the window's oldest turn, put before it: the page ends where the window starts. */
async function readOlder(conversationId: string, held: CoordinatorHistory, signal: AbortSignal): Promise<CoordinatorHistory> {
  if (!held.more) return held;
  const page = await readCoordinatorTurns(conversationId, { before: held.more }, signal);
  return { ...held, turns: [...page.turns, ...held.turns], resets: [...page.resets, ...held.resets], more: page.more };
}

/**
 * The window as a Query, read when the history is opened (`boundary`: where the snapshot starts now). Reading it again
 * (its staleness, the screen coming back, the snapshot moving on) revalidates the whole range; `readOlderTurns` widens
 * it by a page.
 */
export const coordinatorHistory = (client: QueryClient, root: string, conversationId: string, boundary: string) => queryOptions({
  queryKey: key(root, conversationId),
  queryFn: ({ signal }) => {
    const query = client.getQueryCache().find<CoordinatorHistory>({ queryKey: key(root, conversationId), exact: true });
    const held = query?.state.data;
    if (query && widen.has(query)) { widen.delete(query); if (held && held.until === boundary) return readOlder(conversationId, held, signal); }
    return readWindow(conversationId, boundary, held, signal);
  },
  staleTime: 60_000,
});

/** The next older page: the same Query, asked to widen once. */
export function readOlderTurns(client: QueryClient, root: string, conversationId: string) {
  const query = client.getQueryCache().find({ queryKey: key(root, conversationId), exact: true });
  if (!query) return Promise.resolve();
  widen.add(query);
  return query.fetch(undefined, { cancelRefetch: false }).then(() => undefined, () => undefined);
}
