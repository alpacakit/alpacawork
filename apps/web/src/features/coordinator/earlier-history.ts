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
export function useEarlierHistory(root: string, conversation: CoordinatorConversation | null, open: boolean) {
  const client = useQueryClient();
  const boundary = conversation?.earlier?.before ?? null;
  const query = useQuery({ ...coordinatorHistory(client, root, conversation?.id ?? "", boundary ?? ""), enabled: open && !!conversation && !!boundary });
  const held = query.data;
  // The snapshot moved on (turns pushed out of it): the window is read again to end where the snapshot starts now.
  useEffect(() => { if (open && held && boundary && held.until !== boundary) void query.refetch(); }, [open, held, boundary]);
  // Held while it is read again: what serve returned last, until the new range replaces it.
  const range = held && conversation && boundary ? held : undefined;
  return {
    turns: (range?.turns ?? NONE) as readonly CoordinatorTurn[], resets: (range?.resets ?? NONE) as readonly CoordinatorReset[],
    more: range ? range.more !== null : !!boundary, reading: query.isFetching, failed: query.isError && !query.isFetching,
    unread: range ? null : conversation?.earlier?.count ?? 0,
    readMore: () => conversation && range ? readOlderTurns(client, root, conversation.id) : Promise.resolve(),
  };
}
