import { countUse } from '@/features/telemetry/count';
import { memo, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@/components/ui/message";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TaskIcon } from "@/components/ui/state-label";
import { TONE, useTaskLook } from "@/components/ui/tone";
import { useFinishWords } from "@/features/people/labels";
import { cn } from "@/lib/utils";
import { usePeopleFor, useReadIds, useReadIdsFor, useTaskIndex, useWorkspaceInfo } from "@/data/queries";
import type { Task } from "@/data/types";
import { pathTo } from "@/domain/tasks";
import { useMarkShownRead } from "@/features/shell/actions";
import { BriefLine } from "@/features/reader/BriefLine";
import { shownInReader, useViewStore } from "@/state/view-store";
import { openGathered, useGathered } from "./gathered";
import { usePrefetch } from "@/data/prefetch";
import { resources } from "@/data/resources";
import { usePageSentinel } from "@/data/page-sentinel";
import { ApiError } from "@/data/client";
import { TaskId } from "@/components/ui/task-id";
import { useListNavigationSource } from "@/features/tree/list-navigation";
import { ReadFailure } from "@/components/ui/loadable";

/** All task based entrances render the same list and selection. */
export function SearchResults() {
  const { t } = useTranslation("chrome");
  const { tasks, lines, words, loading, error, total, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, nextPageError, fetchNextPage, refetch, loadNext } = useGathered();
  const navigation = useMemo(() => ({ ids: [...new Set(tasks?.map(task => task.id) ?? [])], open: openGathered, total,
    loadNext: hasNextPage && !isFetching && !isFetchingNextPage ? loadNext : undefined }), [tasks, total, hasNextPage, isFetching, isFetchingNextPage, loadNext]);
  useListNavigationSource(navigation);
  const sentinel = useRef<HTMLDivElement>(null);
  usePageSentinel(sentinel, { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage });
  const needle = words.trim().toLocaleLowerCase();
  const selected = useViewStore(shownInReader);
  const readIds = useReadIds();
  const index = useTaskIndex();
  const markShownRead = useMarkShownRead();
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-result]");
    if (!row || !event.currentTarget.contains(row)) return;
    // Each result owns one li: move to its neighbor without collecting the whole list.
    const item = row.parentElement;
    const neighbor = event.key === "ArrowDown" ? item?.nextElementSibling : item?.previousElementSibling;
    const next = neighbor?.querySelector<HTMLElement>("[data-result]");
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    next.focus();
    if (useViewStore.getState().reader.open) openGathered(next.dataset.result!);
  };
  // The conditions, the count and what acts on them head the results and scroll away with them: only the bar (with the
  // search's own field) stays over the list, so a row reached by the keyboard is brought into view below the bar alone.
  return <div data-result-list>
    <div data-results-head className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line py-2 text-sm text-muted">
      {words && <QueryChip query={words} />}
      <span role={error || loading ? "status" : undefined} className="tabular-nums">{error ? null : loading ? t("search.loading") : t("search.count", { count: total })}</span>
      <span className="ml-auto flex items-center gap-1">
        {tasks?.some((task) => !readIds.has(task.id)) && <Button variant="quiet" onClick={() => { countUse('markAllRead'); markShownRead(tasks); }}>{t("gathered.markAllRead")}</Button>}
        <Button variant="quiet" onClick={() => useViewStore.getState().clearSearch()}>{t("search.clear")}</Button>
      </span>
    </div>
    {tasks && <ul className="m-0 list-none p-0" onKeyDown={onKeyDown}>
      {tasks.map((task) => {
        const ancestors = pathTo(task.id, index);
        ancestors.pop();
        return <ResultRow key={task.id} task={task} current={task.id === selected} hit={lines[task.id]} needle={needle}
          place={ancestors.map((ancestor) => ancestor.title).join(" › ")} />;
      })}
    </ul>}
    {error && <ReadFailure size="region" what={t("search.failedFirst")} error={nextPageError} retry={() => void refetch()} />}
    {tasks?.length === 0 && !error && <Message tone="empty" icon="search" title={t("search.empty")} description={t("search.emptyHint")} />}
    {hasNextPage && <div ref={sentinel} className="px-2 py-3">
      <Button variant="quiet" disabled={isFetching} onClick={() => void (!isFetching && fetchNextPage())}>{t("search.more")}</Button>
    </div>}
    {isFetchNextPageError && <ReadFailure className="px-2 py-2" what={t("search.failedWhat")} error={nextPageError}
      retry={() => void (nextPageError instanceof ApiError && nextPageError.retry === "reread" ? refetch() : fetchNextPage())} />}
  </div>;
}

/** The words searched for, pressed to take them away. */
function QueryChip({ query }: { query: string }) {
  const { t } = useTranslation("chrome");
  const label = t("search.queryCondition", { query });
  return <Button variant="outline" data-condition="q" title={t("search.removeCondition")} aria-label={t("search.removeNamedCondition", { name: label })}
    onClick={() => useViewStore.getState().setQuery("")} className="min-h-control-xs max-w-60 gap-1.5 rounded-full px-2.5 text-sm text-ink narrow:min-h-8 narrow:max-w-32">
    <span className="flex min-w-0 items-center gap-1.5 truncate">{label}</span><Icon name="close" className="size-2.5 flex-none text-muted" />
  </Button>;
}

/** `text` with each place the normalized search `needle` is in it marked. */
function Marked({ text, needle }: { text: string; needle: string }) {
  const lower = text.toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  for (let from = 0; from < text.length;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) { parts.push(text.slice(from)); break; }
    parts.push(text.slice(from, at), <mark key={at} className="rounded-xs bg-found text-ink">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  return <>{parts}</>;
}

/**
 * One gathered task, read the way its card is: the state's words and the id, the title, the card's lead line (two lines at
 * most; the report is in the detail) and where it sits. Found by words only in its body, it also says the body's line
 * with them, marked, so why it is in the list is read without opening it. The words searched for are the chip above the list.
 */
const ResultRow = memo(function ResultRow({ task, current, hit, needle, place }: {
  task: Task; current: boolean; hit?: string; needle: string; place: string;
}) {
  const root = useWorkspaceInfo((info) => info.root);
  const prefetch = usePrefetch(task.id);
  const people = usePeopleFor(task.id);
  const unread = !useReadIdsFor(task.id).has(task.id);
  const { word, tone, over } = useTaskLook(task);
  // When end words are known they stand in the word's place, unless the Task is said as waiting or failed, as the list says it.
  const known = useFinishWords(task.id), finish = over ? null : known;
  return <li><Button variant="ghost" data-result={task.id} aria-current={current || undefined}
    className="relative flex w-full scroll-mt-(--bar-in) items-start justify-normal gap-2.5 rounded-none border-b border-solid border-line px-2 py-2.5 text-left whitespace-normal before:absolute before:inset-y-0 before:left-0 before:w-0.5 aria-[current]:bg-hover aria-[current]:before:bg-ink"
    onClick={() => openGathered(task.id)} {...prefetch}>
    <TaskIcon task={task} className="mt-0.5 size-3.5 flex-none" />
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2 text-xs tabular-nums text-muted">
        <span className={cn("min-w-0 truncate text-sm", TONE[finish?.tone ?? tone])}>{finish?.short ?? word}</span>
        <TaskId id={task.id} className="flex-none" />
        {unread && <i aria-hidden="true" className="size-1.5 flex-none rounded-full bg-changed" />}
      </span>
      <strong className="block truncate text-md font-medium text-ink narrow:line-clamp-2 narrow:whitespace-normal">{task.title}</strong>
      <BriefLine task={task} people={people} className="line-clamp-2" />
      {hit && <small data-hit className="block truncate text-sm text-muted"><Marked text={hit} needle={needle} /></small>}
      {place && <small className="block truncate text-xs text-muted">{place}</small>}
    </span>
  </Button></li>;
});
