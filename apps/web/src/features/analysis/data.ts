import { useEffect } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { commandRoute } from "@alpacawork/contract/command-path";
import { api } from "@/data/resources";
import { useWorkspaceInfo } from "@/data/queries";
import { tasksViewSchema, unitListSchema, unitValuesSchema, usageViewSchema, type Bucket, type Group } from "./contract";
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

export function useTasksView(project: string | null, span: Span, bucket: Bucket, by: Group) {
  const root = useWorkspaceInfo(info => info.root);
  const input = { ...scope(project, span), bucket, by };
  return useQuery({ queryKey: ["analysis", root, "tasks", input], placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.request(route("tasks", input), tasksViewSchema, signal) });
}

export function useUsageView(project: string | null, span: Span, bucket: Bucket, by: Group) {
  const root = useWorkspaceInfo(info => info.root);
  const input = { ...scope(project, span), bucket, by };
  return useQuery({ queryKey: ["analysis", root, "usage", input], placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.request(route("usage", input), usageViewSchema, signal) });
}

export const LIST_PAGE = 100;
export function useUnitList(project: string | null, span: Span, list: ListPlace | null) {
  const root = useWorkspaceInfo(info => info.root);
  const input = list ? { ...scope(project, span), set: list.set, value: list.value, by: list.group, key: list.member, limit: String(LIST_PAGE) } : null;
  return useInfiniteQuery({ queryKey: ["analysis", root, "list", input], enabled: !!input, initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.request(route("list", { ...input!, cursor: pageParam }), unitListSchema, signal),
    getNextPageParam: page => page.cursor });
}

export function useUnitValues(unit: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: ["analysis", root, "task", unit], enabled: !!unit,
    queryFn: ({ signal }) => api.request(route("task", { task: unit }), unitValuesSchema, signal) });
}

/** Today's finished tasks, for their marks beside Done on the list of tasks. */
export function useTodayFinished(project: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  const input = { project, period: "today", set: "finished", limit: String(LIST_PAGE) };
  return useQuery({ queryKey: ["analysis", root, "list", input, "marks"],
    queryFn: ({ signal }) => api.request(route("list", input), unitListSchema, signal) });
}

/** Asks the analysis read on screen again a few seconds after the workspace's index changes. */
export function useAnalysisFreshness() {
  const client = useQueryClient();
  const rev = useWorkspaceInfo(info => info.rev);
  useEffect(() => {
    const later = setTimeout(() => void client.invalidateQueries({ queryKey: ["analysis"] }), 4000);
    return () => clearTimeout(later);
  }, [client, rev]);
}
