import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { coordinatorHistory, forgetHistory, historyFull, readOlderTurns } from "@/data/coordinator-history";
import type { CoordinatorConversation, CoordinatorReset, CoordinatorTurn } from "@/data/coordinator";

const NONE: readonly never[] = [];

/**
 * The turns older than the snapshot's, read once the history is opened (`open`) and let go when it is folded: serve's
 * window that ends where the snapshot starts, read again when the snapshot has moved on. `unread`: how many the
 * snapshot counts before it while none are read. `full`: the window holds as many as the screen keeps, and older ones
 * are not read.
 */
export function useEarlierHistory(root: string, id: string | null, earlier: CoordinatorConversation['earlier'], open: boolean) {
  const client = useQueryClient();
  const boundary = earlier?.before ?? null;
  const query = useQuery({ ...coordinatorHistory(client, root, id ?? "", boundary ?? ""), enabled: open && !!id && !!boundary });
  const held = query.data;
  // The snapshot moved on (turns pushed out of it): the window is read again to end where the snapshot starts now.
  useEffect(() => { if (open && held && boundary && held.until !== boundary) void query.refetch(); }, [open, held, boundary]);
  // Folded, what was read is not held: the screen and the memory are as before it was opened.
  useEffect(() => { if (!open && id) forgetHistory(client, root, id); }, [open, client, root, id]);
  // Held while it is read again: what serve returned last, until the new range replaces it.
  const range = open && held && id && boundary ? held : undefined;
  const full = !!range && historyFull(range);
  return {
    turns: (range?.turns ?? NONE) as readonly CoordinatorTurn[], resets: (range?.resets ?? NONE) as readonly CoordinatorReset[],
    more: range ? range.more !== null && !full : !!boundary, full, reading: query.isFetching, failed: query.isError && !query.isFetching,
    unread: range ? null : earlier?.count ?? 0,
    // The next page, or the first again after it could not be read: the Query decides which.
    readMore: () => id && boundary ? readOlderTurns(client, root, id) : Promise.resolve(),
  };
}
