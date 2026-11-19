import { ApiError } from "@/data/client";
import { useConnection } from "@/data/connection";
import type { useReadState } from "@/data/queries";
import { isDatedRead } from "@/data/read-model";
import { ReadFailure, ReadNote } from "@/components/ui/loadable";

export type ReadView = ReturnType<typeof useReadState>;
/**
 * A page list's end: the next page coming, or a read that failed. Out of reach, a page this device does not hold says
 * so instead (it is read once serve is back: resources.recoverReads); a list kept as of an earlier time says its time
 * only through the offline mark.
 */
export type PageRead = { data?: unknown; hasNextPage: boolean; isFetchingNextPage: boolean;
  isPending: boolean; isFetching: boolean; isError: boolean; isFetchNextPageError: boolean;
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>; refetch: () => Promise<unknown>; error: Error | null };

/** Page acquisition has the same absence, refusal and explicit recovery policy in every page list. */
export function PageReadFailure({ page, read, className = "py-1.5 pr-2 pl-4" }: { page: PageRead; read: ReadView; className?: string }) {
  const offline = useConnection((state) => state.offline);
  const dated = isDatedRead(read.assessment);
  const absent = offline && !dated && !page.isFetching && (page.data === undefined || page.isFetchNextPageError);
  return absent ? <ReadNote kind="absent" className={className} />
      : page.isError && !dated && !offline && <ReadFailure error={page.error} retry={() => void (page.isFetchNextPageError
      && !(page.error instanceof ApiError && page.error.retry === "reread") ? (!page.isFetching && page.fetchNextPage({ cancelRefetch: false })) : page.refetch())} />;
}
