import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { commandRoute } from "@alpacawork/contract/command-path";
import { api, resources } from "@/data/resources";
import { useWorkspaceInfo } from "@/data/queries";
import { tasksViewSchema, unitListSchema, unitValuesSchema, usageViewSchema, type Bucket, type Group, type UnitList } from "./contract";
import { spanQuery, type ListPlace, type Span } from "./place";

/**
 * The analysis reads its numbers from the same commands an AI reads them with (`alpacawork analysis …`), by their GET
 * routes. Each answer is kept under what was asked, and asked again when the workspace has moved on (a few seconds after
 * its index changes, so a burst of writes asks once).
 */
const route = (name: string, input: Record<string, string | null | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== null && value !== undefined && value !== "") query.set(key, value);
  return `${commandRoute(`analysis/${name}`)}?${query}`;
};
const scope = (project: string | null, span: Span) => ({ project, ...spanQuery(span) });

/**
 * The face's two answers, each for one choice of days, step of time and breakdown, read as the list of tasks reads (kept
 * for offline, shown again at the next start until read anew: resources.analysisView). `enabled`: false while it is not
 * wanted yet (the other look, a breakdown not yet near the screen); what it last answered stays.
 */
export function useTasksView(project: string | null, span: Span, bucket: Bucket, by: Group | null, enabled = true) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ ...resources.analysisView(root, "tasks", { ...scope(project, span), bucket, by }, tasksViewSchema), enabled });
}

export function useUsageView(project: string | null, span: Span, bucket: Bucket, by: Group | null, enabled = true) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ ...resources.analysisView(root, "usage", { ...scope(project, span), bucket, by }, usageViewSchema), enabled });
}

/**
 * Whether a part of the face has come near the screen (within half a screen of it, in the scrolling `root`), so
 * what only it needs is read then and not before. Once near, it stays so. Where nothing can tell, it is near at once.
 */
export function useNear(root: HTMLElement | null): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !node || !root) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setNear(true); },
      { root, rootMargin: "50% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, node, root]);
  return [setNode, near];
}

export const LIST_PAGE = 100;
export function useUnitList(project: string | null, span: Span, list: ListPlace | null) {
  const root = useWorkspaceInfo(info => info.root);
  // A list opened from a chart's bin is for that bin's days; one opened from a number, for the span.
  const days = list?.days ? { project, from: list.days.from, to: list.days.to } : scope(project, span);
  const input = list ? { ...days, set: list.set, value: list.value, by: list.group, key: list.member, limit: String(LIST_PAGE) } : null;
  return useInfiniteQuery({ queryKey: ["analysis", root, "list", input], enabled: !!input, initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.request(route("list", { ...input!, cursor: pageParam }), unitListSchema, signal),
    getNextPageParam: page => page.cursor });
}

export function useUnitValues(unit: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: ["analysis", root, "task", unit], enabled: !!unit,
    queryFn: ({ signal }) => api.request(route("task", { task: unit }), unitValuesSchema, signal) });
}

/**
 * Today's finished tasks, for their marks beside Done on the list of tasks: every page of them (they come oldest first,
 * so the newest are on the last), read again when the workspace changes as the analysis is.
 */
export function useTodayFinished(project: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  useAnalysisFreshness();
  const input = { project, period: "today", set: "finished", limit: String(LIST_PAGE) };
  const query = useInfiniteQuery({ queryKey: ["analysis", root, "list", input, "marks"], initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.request(route("list", { ...input, cursor: pageParam }), unitListSchema, signal),
    getNextPageParam: page => page.cursor, retry: false });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  // The next page is asked for once each: a page that failed is not asked again until the workspace changes.
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage(); },
    [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  return useCompleteMarks(query.data?.pages, !hasNextPage, JSON.stringify([root, input]));
}

/**
 * The marks of a reading only once every page of it is read: until then the last whole reading stands (or none), so a
 * count of a part is never shown as the day's. It stands as an answer for what it was read for (`asked`): for another
 * project it is not current (`Answer`).
 */
export function useCompleteMarks(pages: UnitList[] | undefined, whole: boolean, asked: string): Answer<{ total: number; rows: UnitList["rows"] }> | null {
  const last = useRef<{ asked: string; data: { total: number; rows: UnitList["rows"] } } | null>(null);
  if (pages && whole) {
    const rows = pages.flatMap(page => page.rows);
    if (last.current?.asked !== asked || last.current.data.rows.length !== rows.length || last.current.data.rows.some((row, at) => row !== rows[at]))
      last.current = { asked, data: { total: pages[0]!.total, rows } };
  }
  const kept = last.current;
  return useMemo(() => kept && { data: kept.data, current: kept.asked === asked }, [kept, asked]);
}

/**
 * An answer and whether it was read for what is chosen now (the project, the span, the look, the step of time, the
 * breakdown, the face). One that is not stands dimmed and out of reach (`Shown`), so nothing on screen opens what it
 * does not show.
 */
export type Answer<T> = { data: T; current: boolean };
export const answerOf = <T,>(query: { data: T | undefined; isPlaceholderData: boolean }): Answer<T> | null =>
  query.data === undefined ? null : { data: query.data, current: !query.isPlaceholderData };

/**
 * Asks the analysis read on screen again a few seconds after the workspace's index changes: once for a burst of changes
 * (the first change starts the wait; those during it are covered by the same reading), so steady work still refreshes it.
 * The index it is mounted with is already read.
 */
export function useAnalysisFreshness() {
  const client = useQueryClient();
  const rev = useWorkspaceInfo(info => info.rev);
  const first = useRef(rev);
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (rev === first.current || waiting.current) return;
    waiting.current = setTimeout(() => {
      waiting.current = null;
      for (const kind of ["analysis", "analysis-view"]) void client.invalidateQueries({ queryKey: [kind] });
    }, FRESH_AFTER_MS);
  }, [client, rev]);
  useEffect(() => () => { if (waiting.current) clearTimeout(waiting.current); }, []);
}
export const FRESH_AFTER_MS = 4000;
