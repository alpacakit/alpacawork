import { useDeferredValue, useMemo, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTaskIndex, useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { ApiError } from "@/data/client";
import type { Task } from "@/data/types";
import { useViewStore } from "@/state/view-store";

/** The one projection from the search to an ordered task list. */
export function useGathered() {
  const index = useTaskIndex();
  const root = useWorkspaceInfo((info) => info.root);
  const query = useViewStore((state) => state.query);
  // A search finds the tasks in view: in the project the list is narrowed to (its nested projects' included), else in
  // every project.
  const project = useViewStore((state) => state.project);
  const words = useDeferredValue(query);
  const settledWords = useRef(words);
  const search = useInfiniteQuery(resources.taskSearch(root, words.toLowerCase(), project));
  if (search.data && !search.isPlaceholderData) settledWords.current = words;
  const displayedWords = search.isPlaceholderData ? settledWords.current : words;
  const loadNext = async () => {
    if (search.isPlaceholderData || search.isFetching || !search.hasNextPage) return null;
    const stillHere = () => { const current = useViewStore.getState(); return current.query === query && current.project === project; };
    const known = new Set(search.data?.pages.flatMap(page => page.rows.map(row => row.id)) ?? []);
    const result = await search.fetchNextPage({ cancelRefetch: false });
    if (result.isFetchNextPageError && result.error instanceof ApiError && result.error.retry === "reread") {
      const refreshed = await search.refetch();
      const ids = refreshed.data?.pages.flatMap(page => page.rows.map(row => row.id)) ?? [];
      const at = ids.indexOf(useViewStore.getState().selected ?? "");
      return at < 0 || !stillHere() ? null : ids[at + 1] ?? null;
    }
    return stillHere() ? result.data?.pages.flatMap(page => page.rows.map(row => row.id)).find(id => !known.has(id)) ?? null : null;
  };
  const pages = search.data?.pages;
  // Keep the server's page order for search. Sorting only the loaded prefix would
  // move a later page ahead of the reader's current task and break its pager.
  const tasks = useMemo(() => {
    if (!pages) return undefined;
    const tasks: Task[] = [];
    for (const page of pages) for (const row of page.rows) {
      const task = index.byId.get(row.id);
      if (task) tasks.push(task);
    }
    return tasks;
  }, [pages, index.byId]);
  const lines = useMemo(() => {
    const lines: Record<string, string> = {};
    if (pages) for (const page of pages) Object.assign(lines, page.lines);
    return lines;
  }, [pages]);
  return {
    tasks,
    lines,
    words: displayedWords,
    loading: !pages && !search.isError,
    error: pages ? search.isRefetchError : search.isError,
    total: pages?.[0]?.total ?? 0,
    hasNextPage: !!pages && !search.isPlaceholderData && search.hasNextPage,
    isFetchingNextPage: !!pages && search.isFetchingNextPage,
    isFetchNextPageError: !!pages && search.isFetchNextPageError,
    nextPageError: search.error,
    isFetching: search.isFetching,
    fetchNextPage: () => search.isFetching ? Promise.resolve(search) : search.fetchNextPage({ cancelRefetch: false }),
    refetch: search.refetch,
    loadNext,
  };
}

/** Read a row without changing its gathering, and restore its focus on close. */
export function openGathered(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-result="${CSS.escape(id)}"]`);
  row?.scrollIntoView?.({ block: "nearest" });
  useViewStore.getState().openTask(id, { reader: true, returnTo: row ?? undefined });
}
