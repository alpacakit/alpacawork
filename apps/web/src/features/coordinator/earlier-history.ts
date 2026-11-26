import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { coordinatorHistory, readOlderTurns } from "@/data/coordinator-history";
import type { CoordinatorConversation, CoordinatorReset, CoordinatorTurn } from "@/data/coordinator";

const NONE: readonly never[] = [];

/**
 * The turns older than the snapshot's, read once the history is opened (`open`): serve's window that ends where the
 * snapshot starts, read again when the snapshot has moved on. `unread`: how many the snapshot counts before it while
 * none are read.
 */
export function useEarlierHistory(root: string, id: string | null, earlier: CoordinatorConversation['earlier'], open: boolean) {
  const client = useQueryClient();
  const boundary = earlier?.before ?? null;
  const query = useQuery({ ...coordinatorHistory(client, root, id ?? "", boundary ?? ""), enabled: open && !!id && !!boundary });
  const held = query.data;
  // The snapshot moved on (turns pushed out of it): the window is read again to end where the snapshot starts now.
  useEffect(() => { if (open && held && boundary && held.until !== boundary) void query.refetch(); }, [open, held, boundary]);
  // Held while it is read again: what serve returned last, until the new range replaces it.
  const range = held && id && boundary ? held : undefined;
  return {
    turns: (range?.turns ?? NONE) as readonly CoordinatorTurn[], resets: (range?.resets ?? NONE) as readonly CoordinatorReset[],
    more: range ? range.more !== null : !!boundary, reading: query.isFetching, failed: query.isError && !query.isFetching,
    unread: range ? null : earlier?.count ?? 0,
    // The next page, or the first again after it could not be read: the Query decides which.
    readMore: () => id && boundary ? readOlderTurns(client, root, id) : Promise.resolve(),
  };
}
