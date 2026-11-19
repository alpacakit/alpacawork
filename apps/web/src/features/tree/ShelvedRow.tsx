import { isDatedRead } from '@/data/read-model';
import { errorText } from "@/data/client";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Caret, DisclosureSummary } from "@/components/ui/caret";
import { useClosedCounts, useReadState, useShelved, useWorkspaceInfo, useWriteDisabled } from "@/data/queries";
import { rowWriteBasis } from "@/data/connection";
import { useViewStore } from "@/state/view-store";
import { resources } from "@/data/resources";
import { usePageSentinel } from "@/data/page-sentinel";
import { useLifecycle } from "@/features/forms/lifecycle";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { PageReadFailure } from "./PageReadFailure";

/**
 * "Archived or deleted nitems" at the end of Done: tasks taken out of
 * the tree keep their record and can be restored. Deleting is logical, so a
 * deleted task is listed here as well; restoring checks the hash on screen.
 */
export function ShelvedRow() {
  const { t } = useTranslation("tree");
  const { t: tr } = useTranslation();
  const shelved = useShelved();
  const root = useWorkspaceInfo((info) => info.root);
  // Of the project in view (its nested projects' included) or of every project, as the index counts them.
  const project = useViewStore((state) => state.project);
  const counts = useClosedCounts();
  const [open, setOpen] = useState(false);
  const options = resources.shelved(root, project);
  const page = useInfiniteQuery({ ...options, enabled: open });
  // A list kept as of an earlier time (its Query obsolete while shown) lists its own rows under its time; none can be
  // restored from it, and none joins the workspace's (Done uses the same retained read).
  const read = useReadState(options.queryKey);
  const dated = isDatedRead(read.assessment);
  const rows = useMemo(() => {
    const rows: { task: { id: string; title: string; hash: string }; lifecycle: string; dated: boolean }[] = [];
    if (dated) {
      if (page.data) for (const part of page.data.pages) for (const row of part.rows) {
        rows.push({ task: { id: row.id, title: row.title, hash: row.hash }, lifecycle: row.lifecycle, dated: true });
      }
    } else {
      const pageIds = new Set<string>();
      if (page.data) for (const part of page.data.pages) for (const row of part.rows) pageIds.add(row.id);
      for (const { task, lifecycle } of shelved) if (pageIds.has(task.id)) rows.push({ task, lifecycle, dated: false });
    }
    return rows;
  }, [page.data, shelved, dated]);
  const sentinel = useRef<HTMLLIElement>(null);
  usePageSentinel(sentinel, page);
  const writeDisabled = useWriteDisabled();
  const restore = useLifecycle();
  if (!counts.shelved) return null;
  return (
    <li className="list-none">
      <details data-shelved onToggle={(event) => setOpen(event.currentTarget.open)} className="group w-(--col,326px) px-2 text-sm text-muted">
        <DisclosureSummary className="min-h-control-sm gap-1.5">
          <Caret className="group-open:rotate-90" />{t("shelved.count", { count: counts.shelved })}
        </DisclosureSummary>
        <ul className="m-0 list-none p-0 pl-4.5">
          {rows.map(({ task, lifecycle, dated }) => (
            <li key={task.id} className="flex items-center gap-2 py-1" data-dated={dated || undefined}>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted" title={task.title}>{task.title}</span>
              <span className="text-xs">{lifecycle === "archived" ? t("shelved.archived") : t("shelved.deleted")}</span>
              <RestoreButton task={task} disabled={writeDisabled || dated || restore.isPending} restore={restore} label={t("shelved.restore")} />
            </li>
          ))}
          <li ref={sentinel} className="list-none text-xs" data-shelved-tail>
            {(page.isPending && page.isFetching || page.isFetchingNextPage) && <RegionSkeleton shape="rows" />}
            <PageReadFailure page={page} read={read} className="py-1" />
          </li>
        </ul>
      </details>
    </li>
  );
}

function RestoreButton({ task, disabled, restore, label }: { task: { id: string; hash: string }; disabled: boolean; restore: ReturnType<typeof useLifecycle>; label: string }) {
  const denied = useWriteDisabled(rowWriteBasis(task.id, task.hash));
  return <Button variant="outline" className="min-h-6 px-2 text-xs" disabled={disabled || denied}
    onClick={() => restore.mutate({ action: 'restore', id: task.id, expectedTaskHash: task.hash })}>{label}</Button>;
}
