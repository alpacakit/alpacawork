import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { TAB, TAB_COUNT, TAB_ROW, TabLabel, TabMarker } from "@/components/ui/tabs";
import type { Task, TaskDetail } from "@/data/types";
import { relatedListsOf } from "./related-lists";
import { panelEntry, toggleReaderPanel, useReaderPanel, type ReaderPanelKind } from "./reader-panel";
import { useFileShelves } from "./files/file-shelves";
import { useViewStore, type ReaderPane } from "@/state/view-store";
import { useReaderIndex } from "@/data/queries";

/**
 * The task's one row of tabs, under its title on every pane, so the title and the way between panes never leave.
 * Drawn as every row of tabs (tabs.tsx). Left, the reader's panes: History (the reports), Context, and Files when the
 * task has any or they are shown, numbered by its deliverables, and Analysis (its causes and timeline); the one shown
 * is marked.
 * After a gap, the related lists that open beside what is shown (Task tree, Dependencies), when the task has them; one
 * open is inked, its panel standing under the row.
 * The panes come first so History and Context keep their places from task to task. The row never wraps: where it does
 * not fit (a phone), it scrolls sideways with every word kept, and brings the tab shown into view; an edge with more
 * beyond it fades, so what is out of sight is seen to be there.
 */
export function ReaderEntries({ task, detail, pane }: { task: Task; detail: TaskDetail | undefined; pane: ReaderPane }) {
  const { t } = useTranslation("reader");
  const row = useRef<HTMLDivElement>(null);
  const [beyond, setBeyond] = useState({ start: false, end: false });
  const measure = () => {
    const box = row.current;
    if (!box) return;
    const start = box.scrollLeft > 1, end = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
    setBeyond(was => was.start === start && was.end === end ? was : { start, end });
  };
  useLayoutEffect(() => {
    const box = row.current;
    if (!box) return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const child of box.children) observer.observe(child);
    return () => observer.disconnect();
  });
  // The tab stands for any file; its number counts only the deliverables, the files the user looks at.
  const deliverables = useFileShelves(detail)?.deliverables.length ?? 0;
  useLayoutEffect(() => {
    const shown = row.current?.querySelector<HTMLElement>("[aria-current]");
    if (!row.current || !shown) return;
    const bounds = row.current.getBoundingClientRect(), place = shown.getBoundingClientRect();
    if (place.left < bounds.left) row.current.scrollLeft -= bounds.left - place.left;
    else if (place.right > bounds.right) row.current.scrollLeft += place.right - bounds.right;
    measure();
  }, [pane, task.id]);
  const fade = `linear-gradient(to right, ${beyond.start ? "transparent, #000 2rem" : "#000"}, ${beyond.end ? "#000 calc(100% - 2rem), transparent" : "#000"})`;
  return <div ref={row} data-reader-entries onScroll={measure} style={beyond.start || beyond.end ? { maskImage: fade } : undefined} className={cn(TAB_ROW, "-mx-1 py-1.5 narrow:py-2")}>
    <TabMarker current="[aria-current=page]" />
    <PaneEntry pane="task" shown={pane} icon="history" label={t("entries.history")} />
    {/* The page the task's premises are written on. Upright, it stands narrower in its grid than the other marks,
        so it gives that room back to keep the same space beside its word. */}
    <PaneEntry pane="about" shown={pane} icon="file" iconClassName="-mx-0.5" label={t("entries.context")} />
    {(!!detail?.files.length || pane === "files") && <PaneEntry pane="files" shown={pane} icon="folder" label={t("entries.files")} count={deliverables ? t("entries.count", { count: deliverables }) : undefined} />}
    <PaneEntry pane="analysis" shown={pane} icon="activity" label={t("entries.analysis")} />
    <RelatedEntries task={task} />
  </div>;
}

/**
 * The way to the task's parent and child tasks, and what it waits on. Each opens and closes the related-task
 * panel (ReaderPanel), which stands beside what the reader shows rather than over it, on any pane.
 * A task alone under its project (no parent, no children) shows no Task tree.
 */
function RelatedEntries({ task }: { task: Task }) {
  const { t } = useTranslation("reader");
  const index = useReaderIndex(task);
  const lists = relatedListsOf(task, index);
  const family = lists.family?.entry, dependencies = lists.dependencies?.entry;
  if (!family && !dependencies) return null;
  return <>
    <span aria-hidden className="w-2 flex-none" />
    {family && <RelatedEntry kind="family" icon="family" label={t("family.entry")} count={lists.family!.count} />}
    {dependencies && <RelatedEntry kind="dependencies" icon="swap" label={t("entries.dependencies")} count={lists.dependencies!.count} />}
  </>;
}

function RelatedEntry({ kind, icon, label, count }: { kind: ReaderPanelKind; icon: IconName; label: string; count: number }) {
  const { t } = useTranslation("reader");
  const open = useReaderPanel(state => state.kind === kind);
  return <button type="button" data-family-entry={kind === "family" ? "" : undefined} data-reader-panel-entry={kind}
    aria-haspopup="dialog" aria-expanded={open} aria-label={`${label} ${t("family.count", { count })}`} onClick={() => toggleReaderPanel(kind)} ref={panelEntry[kind]}
    className={TAB}>
    <EntryFace icon={icon} label={label} count={String(count)} />
  </button>;
}

function PaneEntry({ pane, shown, icon, iconClassName, label, count }: { pane: ReaderPane; shown: ReaderPane; icon: IconName; iconClassName?: string; label: string; count?: string }) {
  const current = pane === shown;
  return <button type="button" data-reader-entry={pane} aria-current={current ? "page" : undefined}
    aria-label={count ? `${label} ${count}` : undefined}
    onClick={() => { if (!current) useViewStore.getState().setReaderPane(pane); }}
    className={cn(TAB, "group")}>
    <EntryFace icon={icon} iconClassName={iconClassName} label={label} count={count} />
  </button>;
}

/** A count is a number on a chip; the tab's name read out says it in words (its aria-label). */
function EntryFace({ icon, iconClassName, label, count }: { icon: IconName; iconClassName?: string; label: string; count?: string }) {
  return <>
    <Icon name={icon} className={cn("size-3.5 flex-none", iconClassName)} />
    <TabLabel>{label}</TabLabel>
    {count && <span className={TAB_COUNT}>{count}</span>}
  </>;
}
