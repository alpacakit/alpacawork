import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { TAB, TAB_COUNT, TAB_ROW, TabLabel, TabMarker } from "@/components/ui/tabs";
import type { Task, TaskDetail } from "@/data/types";
import { relatedListsOf } from "./related-lists";
import { panelEntry, toggleReaderPanel, useReaderPanel, type ReaderPanelKind } from "./reader-panel";
import { Popup } from "@/components/ui/popup";
import { menuRow, MenuTick } from "@/components/ui/menu-rows";
import { moveMenuFocus } from "@/features/chrome/menu-move";
import { useFileShelves } from "./files/file-shelves";
import { useViewStore, type ReaderPane } from "@/state/view-store";
import { useReaderIndex } from "@/data/queries";

/** One tab of the row: a pane of the reader, or a related list that opens its panel beside what is shown. */
type Entry = { key: string; icon: IconName; iconClassName?: string; label: string; count?: string; spoken?: string;
  /** Pressed: a pane shown (it always stands in the row), a related list's panel open. */
  on: boolean; related?: ReaderPanelKind; press: () => void };

/**
 * The task's one row of tabs, under its title on every pane, so the title and the way between panes never leave.
 * Drawn as every row of tabs (tabs.tsx). Left, the reader's panes: History (the reports), Context, Files when the
 * task has any or they are shown, numbered by its deliverables, and Analysis; the one shown is marked.
 * After a gap, the related lists that open beside what is shown (Task tree, Dependencies), when the task has them; one
 * open is inked, its panel standing under the row.
 * The panes come first so History and Context keep their places from task to task. The row never wraps or scrolls:
 * the tabs that do not fit (a phone) go, from the end, into More (⋯) at its end, which lists them; the tab shown
 * always stands in the row.
 */
export function ReaderEntries({ task, detail, pane }: { task: Task; detail: TaskDetail | undefined; pane: ReaderPane }) {
  const { t } = useTranslation("reader");
  const index = useReaderIndex(task);
  const lists = relatedListsOf(task, index);
  const panel = useReaderPanel(state => state.kind);
  // The tab stands for any file; its number counts only the deliverables, the files the user looks at.
  const deliverables = useFileShelves(detail)?.deliverables.length ?? 0;
  const show = (to: ReaderPane) => { if (to !== pane) useViewStore.getState().setReaderPane(to); };
  const paneEntry = (key: ReaderPane, icon: IconName, label: string, more?: Partial<Entry>): Entry =>
    ({ key, icon, label, on: pane === key, press: () => show(key), ...more });
  const relatedEntry = (kind: ReaderPanelKind, icon: IconName, label: string, count: number): Entry =>
    ({ key: kind, icon, label, count: String(count), spoken: `${label} ${t("family.count", { count })}`, on: panel === kind, related: kind, press: () => toggleReaderPanel(kind) });
  const entries: Entry[] = [
    paneEntry("task", "history", t("entries.history")),
    // The page the task's premises are written on. Upright, it stands narrower in its grid than the other marks,
    // so it gives that room back to keep the same space beside its word.
    paneEntry("about", "file", t("entries.context"), { iconClassName: "-mx-0.5" }),
    ...!!detail?.files.length || pane === "files" ? [paneEntry("files", "folder", t("entries.files"),
      deliverables ? { count: t("entries.count", { count: deliverables }), spoken: `${t("entries.files")} ${t("entries.count", { count: deliverables })}` } : {})] : [],
    ...task.kind === "task" ? [paneEntry("analysis", "chart", t("entries.analysis"))] : [],
    ...lists.family?.entry ? [relatedEntry("family", "family", t("family.entry"), lists.family.count)] : [],
    ...lists.dependencies?.entry ? [relatedEntry("dependencies", "swap", t("entries.dependencies"), lists.dependencies.count)] : [],
  ];
  const firstRelated = entries.findIndex(entry => entry.related);
  const { row, measure, shown } = useFitting(entries);
  const hidden = entries.filter(entry => !shown.includes(entry));
  const face = (entry: Entry) => <EntryFace icon={entry.icon} iconClassName={entry.iconClassName} label={entry.label} count={entry.count} />;
  return <div ref={row} data-reader-entries className={cn(TAB_ROW, "-mx-1 overflow-x-clip py-1.5 narrow:py-2")}>
    <TabMarker current="[aria-current=page]" />
    {shown.map(entry => <Fragment key={entry.key}>
      {entry.related && entry === shown.find(each => each.related) && entry !== shown[0] ? <span aria-hidden className="w-2 flex-none" /> : null}
      {entry.related
        ? <button type="button" data-family-entry={entry.key === "family" ? "" : undefined} data-reader-panel-entry={entry.key}
          aria-haspopup="dialog" aria-expanded={entry.on} aria-label={entry.spoken} onClick={entry.press} ref={panelEntry[entry.related]} className={TAB}>{face(entry)}</button>
        : <button type="button" data-reader-entry={entry.key} aria-current={entry.on ? "page" : undefined} aria-label={entry.spoken}
          onClick={entry.press} className={cn(TAB, "group")}>{face(entry)}</button>}
    </Fragment>)}
    {hidden.length > 0 && <MoreEntries entries={hidden} face={face} row={row} />}
    {/* Every tab drawn once more, unseen and out of the way, so each one's width is known whether it stands or not. */}
    <div ref={measure} aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1 px-1">
      {entries.map((entry, at) => <Fragment key={entry.key}>{at === firstRelated && <span data-measure="spacer" className="w-2 flex-none" />}
        <span data-measure={entry.key} className={TAB}>{face(entry)}</span></Fragment>)}
      <span data-measure="more" className={TAB}><Icon name="more" className="size-3.5" /></span>
    </div>
  </div>;
}

/**
 * Which tabs stand in the row: all that fit, from the start, with room left for More when some do not; the tab shown
 * takes the place of the last that would have stood, so it is never only in More.
 */
function useFitting(entries: Entry[]) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(Infinity);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const keys = entries.map(entry => `${entry.key}:${entry.label}:${entry.count ?? ""}`).join("|");
  useLayoutEffect(() => {
    const box = row.current, ruler = measure.current;
    if (!box || !ruler) return;
    const read = () => {
      // The gap between tabs too, as the row draws it (it grows with the text's size).
      const next: Record<string, number> = { gap: parseFloat(getComputedStyle(ruler).columnGap) || 0 };
      for (const item of ruler.querySelectorAll<HTMLElement>("[data-measure]")) next[item.dataset.measure!] = item.offsetWidth;
      setWidths(was => Object.keys(next).length === Object.keys(was).length && Object.entries(next).every(([key, width]) => was[key] === width) ? was : next);
      // The row's own room, inside its padding.
      const style = getComputedStyle(box);
      setRoom(box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) || Infinity);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(box);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, [keys]);
  return { row, measure, shown: standing(entries, widths, room) };
}

/**
 * The tabs that stand in a row `room` wide, each `widths[key]` wide with More's `widths.more`, `widths.gap` between
 * them and `widths.spacer` more before the related lists: all of them when they fit; else as many as fit from the
 * start beside More, the pane shown taking the last place when it is not among them.
 */
export function standing<T extends { key: string; on: boolean; related?: unknown }>(entries: T[], widths: Record<string, number>, room: number): T[] {
  const gap = widths.gap ?? 0, spacer = (widths.spacer ?? 0) + gap;
  // A related list stands after a gap from the panes: the first of them standing has it.
  const width = (list: T[]) => list.reduce((sum, entry, at) => sum + (widths[entry.key] ?? 0) + (at ? gap : 0)
    + (at > 0 && entry.related && list.findIndex(each => each.related) === at ? spacer : 0), 0);
  if (!entries.some(entry => entry.key in widths) || width(entries) <= room) return entries;
  const more = (widths.more ?? 0) + gap;
  const pinned = entries.filter(entry => entry.on && !entry.related);
  const pick = (n: number) => { const head = entries.slice(0, n); return [...head, ...pinned.filter(entry => !head.includes(entry))]; };
  let count = entries.length;
  while (count > 0 && width(pick(count)) + more > room) count--;
  const chosen = new Set(pick(count));
  return entries.filter(entry => chosen.has(entry));
}

/**
 * More (⋯): the tabs the row has no room for, as a menu; pressing one does what the tab does, a related list's ticked
 * while its panel is open. A pane chosen comes into the row and takes the focus; a related list's panel, closed, gives
 * it back to More, where its tab is.
 */
function MoreEntries({ entries, face, row }: { entries: Entry[]; face: (entry: Entry) => ReactNode; row: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation("reader");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const related = entries.flatMap(entry => entry.related ? [entry.related] : []);
  const hold = (element: HTMLButtonElement | null) => {
    trigger.current = element;
    const releases = related.map(kind => panelEntry[kind](element));
    return () => { trigger.current = null; releases.forEach(release => release()); };
  };
  const pick = (entry: Entry) => {
    setOpen(false);
    entry.press();
    if (!entry.related) requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(`[data-reader-entry="${entry.key}"]`)?.focus());
  };
  return <>
    <button ref={hold} type="button" data-reader-entries-more aria-haspopup="menu" aria-expanded={open}
      aria-label={t("entries.more")} title={t("entries.more")} onClick={() => setOpen(value => !value)} className={TAB}>
      <Icon name="more" className="size-3.5" />
    </button>
    {open && <Popup open onOpenChange={setOpen} label={t("entries.more")} align="end" className="w-56 p-1" anchorRef={trigger}>
      <div role="menu" aria-label={t("entries.more")} onKeyDown={moveMenuFocus}>
        {entries.map(entry => <button key={entry.key} type="button" role={entry.related ? "menuitemcheckbox" : "menuitem"}
          aria-checked={entry.related ? entry.on : undefined} data-reader-entry-more={entry.key} aria-label={entry.spoken}
          onClick={() => pick(entry)} className={cn(menuRow(entry.on), "gap-1.5 text-sm")}>
          {face(entry)}{entry.related && <span className="ms-auto"><MenuTick checked={entry.on} /></span>}
        </button>)}
      </div>
    </Popup>}
  </>;
}

/** A count is a number on a chip; the tab's name read out says it in words (its aria-label). */
function EntryFace({ icon, iconClassName, label, count }: { icon: IconName; iconClassName?: string; label: string; count?: string }) {
  return <>
    <Icon name={icon} className={cn("size-3.5 flex-none", iconClassName)} />
    <TabLabel>{label}</TabLabel>
    {count && <span className={TAB_COUNT}>{count}</span>}
  </>;
}
