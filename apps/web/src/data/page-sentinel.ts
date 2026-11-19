import { useEffect, type RefObject } from "react";

/** Fetch the next cached page when its sentinel approaches the visible scroller. */
export function usePageSentinel(target: RefObject<HTMLElement | null>, page: {
  hasNextPage: boolean; isFetching: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean;
  fetchNextPage: (options?: { cancelRefetch?: boolean }) => Promise<unknown>;
}, root?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = target.current;
    if (!node || !page.hasNextPage || page.isFetching || page.isFetchingNextPage || page.isFetchNextPageError
      || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !page.isFetching) void page.fetchNextPage({ cancelRefetch: false });
    }, { root: root?.current ?? null, rootMargin: "120px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, root, page.hasNextPage, page.isFetching, page.isFetchingNextPage, page.isFetchNextPageError, page.fetchNextPage]);
}
