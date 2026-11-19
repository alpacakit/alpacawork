import { countUse } from '@/features/telemetry/count';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isFinished } from "@alpacawork/contract/branch";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Icon } from "@/components/ui/icon";
import { StateIcon } from "@/components/ui/state-label";
import { TaskId } from "@/components/ui/task-id";
import { useStateLook } from "@/components/ui/tone";
import { ReadFailure, ReadNote } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useEveryTaskIndex, useReadState, useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { useConnection } from "@/data/connection";
import type { Task } from "@/data/types";
import { childrenOf, pathTo, type TaskIndex } from "@/domain/tasks";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { branchOpen, FAMILY_INDENT_CAP, familyShape, finishedChildren, hasChildren, openOn, shownChildren, type FamilyShape } from "./family";
import type { PanelForm } from "./ReaderPanel";
import { useOrderWord } from "./StartOrder";
import { PanelFirstRow } from "./PanelFirstRow";

/**
 * How far the list has to scroll to bring the row being read into sight, 0 when it is in sight: the root's row stays
 * stuck at the list's top (`data-family-head`), and what has scrolled under it is out of sight.
 */
function toSight(box: HTMLElement, here: HTMLElement) {
  const head = box.querySelector("[data-family-head]");
  if (head?.contains(here)) return 0;
  const row = here.getBoundingClientRect(), view = box.getBoundingClientRect();
  const top = head?.getBoundingClientRect().bottom ?? view.top;
  return row.top < top ? row.top - top : row.bottom > view.bottom ? row.bottom - view.bottom : 0;
}

/**
 * The family as a tree. Each row is a branch's fold mark on the left (only where there are children), the task's
 * state icon, and its title; no counts. The task being read is boxed and said to be shown. The tree remembers, by its
 * root, what the person opened and how far they scrolled (family.ts); each time it opens, the way to the task being
 * read is open and in view, and the focus is on it. It has no head of its own: the entry that opened it already
 * says what it is, and the root's row says whose it is, so that row stays at the top with the panel's × beside it,
 * and a line under it only while rows have gone under it.
 */
export function FamilyTree({ form, root, current, index, onPick, onClose }: {
  form: PanelForm; root: Task; current: string; index: TaskIndex; onPick: (id: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation("reader");
  const narrow = useNarrow();
  const [shape] = useState<FamilyShape>(() => {
    const remembered = familyShape(root.id);
    openOn(remembered, current, index);
    return remembered;
  });
  const [, redraw] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);
  // Going back to where the list was, until it is there or the person moves it themselves (a wheel, a touch, a press, a
  // key on it). Until then a change of its scroll is the list's own (given back, or held to its height as rows come and
  // go), and the remembered position is kept.
  const restoring = useRef(true);
  const takeOver = () => { restoring.current = false; };
  // The task read changes while the panel stays open (picked here, Back, a link): the same rule as opening applies (the
  // way to it opens, the way to the one before stays open), and its row is brought just into view if it is not; the list
  // does not jump to it.
  // Moved in the page with the reader's slot, the list is back at its top with no scroll to say so.
  useEffect(() => { if (list.current) setScrolled(list.current.scrollTop > 0); });
  const seen = useRef(current);
  if (seen.current !== current) { openOn(shape, current, index); seen.current = current; }
  useEffect(() => {
    const box = list.current, here = box?.querySelector<HTMLElement>("[data-family-here]");
    if (restoring.current || !box || !here) return;   // still being placed: placing brings it into view
    box.scrollTop += toSight(box, here);
    shape.position.scroll = box.scrollTop;
  }, [current, shape]);

  // Opened: once the surface has put the list on the screen (a sheet comes up after this draws), the list goes back to
  // where it was. Its branches' finished children may still be coming (their pages are read again once the cache let
  // them go), so it keeps going back as the content grows, until it gets there or nothing is coming any more. Then the
  // task being read is brought into view if it is not there. The focus goes to it as soon as the list is placed.
  useEffect(() => {
    let frame = 0, tries = 0, watch: ResizeObserver | null = null;
    const settle = () => {
      const box = list.current;
      if (!box || !restoring.current) return;
      box.scrollTop = shape.position.scroll;
      // Short of it while children are still coming: wait for them (their rows growing the list settle it again).
      if (box.scrollTop !== shape.position.scroll && box.querySelector("[data-family-loading]") !== null) return;
      finish(box);
    };
    const finish = (box: HTMLDivElement) => {
      if (!restoring.current) return;
      restoring.current = false;
      watch?.disconnect();
      const here = box.querySelector<HTMLElement>("[data-family-here]");
      if (here && toSight(box, here) !== 0) {
        const row = here.getBoundingClientRect(), view = box.getBoundingClientRect();
        box.scrollTop += row.top - view.top - (view.height - row.height) / 2;
      }
      shape.position.scroll = box.scrollTop;
    };
    const place = () => {
      const box = list.current;
      if (!box) return;
      // Wait to be on the page, then a few frames more for a height (a page without layout never gets one).
      if ((!box.isConnected || box.clientHeight === 0 && tries < 30) && tries < 300) {
        tries++;
        frame = requestAnimationFrame(place);
        return;
      }
      box.querySelector<HTMLElement>("[data-family-here] [data-family-go]")?.focus({ preventScroll: true });
      if (typeof ResizeObserver !== "undefined" && box.firstElementChild) {
        watch = new ResizeObserver(settle);
        watch.observe(box.firstElementChild);
      }
      settle();
    };
    frame = requestAnimationFrame(place);
    return () => { cancelAnimationFrame(frame); watch?.disconnect(); };
  }, [shape]);
  // After "N more", the first task that appeared takes the focus: the button pressed is gone.
  useEffect(() => {
    if (!focusNext.current) return;
    list.current?.querySelector<HTMLElement>(`[data-family-row="${focusNext.current}"] [data-family-go]`)?.focus({ preventScroll: true });
    focusNext.current = null;
  });

  const toggle = (id: string) => {
    shape.folds.set(id, !branchOpen(shape, id, current, index));
    redraw((n) => n + 1);
  };
  const showRest = (parent: string) => {
    const before = new Set<string>();
    for (const task of shownChildren(shape, parent, current, index).shown) before.add(task.id);
    shape.more.add(parent);
    focusNext.current = childrenOf(parent, index).find((task) => !before.has(task.id))?.id ?? null;
    redraw((n) => n + 1);
  };

  const step = narrow ? 14 : 16, mark = narrow ? 40 : 28;
  const depthOf = (id: string) => pathTo(id, index).length - 1;
  const branch = (task: Task): ReactNode => {
    const depth = depthOf(task.id), indent = Math.min(depth, FAMILY_INDENT_CAP);
    const kids = hasChildren(task.id, index), open = kids && branchOpen(shape, task.id, current, index);
    const { shown, rest } = open ? shownChildren(shape, task.id, current, index) : { shown: [], rest: 0 };
    const row = <FamilyRow task={task} depth={depth} here={task.id === current} indent={indent * step} mark={mark}
      fold={kids ? { open, press: () => { countUse('tree.fold'); toggle(task.id); } } : null} onPick={id => { countUse('tree.go'); onPick(id); }} />;
    const finished = open ? finishedChildren(task.id, index) : null;
    return <li key={task.id} className="relative">
      {Array.from({ length: indent }, (_, level) =>
        <span key={level} aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-1 w-px bg-rule" style={{ left: level * step + mark / 2 }} />)}
      {task.id !== root.id ? row
        : <PanelFirstRow data-family-head scrolled={scrolled} closeLabel={t("family.close")} onClose={onClose} className="pr-1.5">{row}</PanelFirstRow>}
      {open && <ul>
        {shown.map(branch)}
        {finished && finished.count > 0 && <FinishedOf parent={task.id} joined={finished.joined} />}
        {rest > 0 && <li>
          <button type="button" data-family-more={task.id} onClick={() => { countUse('tree.more'); showRest(task.id); }}
            style={{ paddingLeft: Math.min(depth + 1, FAMILY_INDENT_CAP) * step + mark + 2 } as CSSProperties}
            className="flex h-7.5 w-full items-center rounded-full text-left text-xs text-muted hover:bg-hover narrow:h-10 narrow:text-sm">
            {t("family.more", { count: rest })}
          </button>
        </li>}
      </ul>}
    </li>;
  };

  return <div data-family-panel className={cn("flex flex-col", form !== "under" && "min-h-0 flex-1")}>
    {/* On a phone the strip around the grip is held to size the sheet, as the conversation's head is (PhoneSheet: data-card-grab):
        tall enough for a finger, as a browser moves a press near a button onto it. */}
    {narrow && <div data-card-grab className="h-8 flex-none touch-none" />}
    {/* scroll-pt: a row the keyboard's focus comes to stops under the root's row, not behind it. */}
    <div ref={list} onWheel={takeOver} onTouchMove={takeOver} onPointerDown={takeOver} onKeyDown={takeOver}
      onScroll={(event) => { setScrolled(event.currentTarget.scrollTop > 0); if (!restoring.current) shape.position.scroll = event.currentTarget.scrollTop; }}
      className={cn("isolate scroll-pt-9 overflow-auto overscroll-contain px-1.5 pb-1.5 narrow:scroll-pt-12", form === "under" ? "max-h-54" : "min-h-0 flex-1",
        form === "sheet" && "pb-[max(0.5rem,env(safe-area-inset-bottom))]")}>
      <ul aria-label={t("family.tree", { title: root.title })}>{branch(root)}</ul>
    </div>
  </div>;
}

/** One task's row: the fold mark, then the state icon, the task's ID and its title, which open the task. The ID is never cut: a long title gives way. */
function FamilyRow({ task, depth, here, indent, mark, fold, onPick }: {
  task: Task; depth: number; here: boolean; indent: number; mark: number;
  fold: { open: boolean; press: () => void } | null; onPick: (id: string) => void;
}) {
  const { t } = useTranslation("reader");
  const { word } = useStateLook(task.state, task.ball);
  const order = useOrderWord(task);
  const finished = isFinished(task.state);
  const deep = depth > FAMILY_INDENT_CAP;
  const name = t("family.rowName", { id: task.id, title: task.title, state: word }) + (here ? t("family.rowHere") : "")
    + (deep ? t("family.rowDeep", { count: depth }) : "");
  // The row's layers, bottom up: the pointer's tint (the row's own ground; nothing inside has one), then the branch
  // lines (z-1, in the tree above).
  // A row is a band with round ends inside the list's 6px inset, so it follows the surface's round corners. The
  // shown task stands on a tint a step deeper than the pointer's, over the branch lines (z-2), in its heavier words and
  // with "here": no ring to draw the eye from the rest. 2px between rows keeps two tinted bands apart.
  return <div data-family-row={task.id} data-family-here={here || undefined} style={{ paddingLeft: indent }}
    className={cn("relative my-0.5 flex items-center rounded-full hover:has-[[data-family-go]:hover]:bg-hover",
      here && "z-2 bg-[color-mix(in_oklab,var(--ink)_10%,var(--raised))] hover:has-[[data-family-go]:hover]:bg-[color-mix(in_oklab,var(--ink)_10%,var(--raised))]")}>
    {fold
      ? <button type="button" data-family-fold aria-expanded={fold.open} onClick={fold.press} style={{ width: mark }}
          aria-label={t(fold.open ? "family.fold" : "family.unfold", { title: task.title })}
          className="grid h-7.5 flex-none place-items-center rounded-full text-muted hover:text-ink narrow:h-10">
          <Icon name="right" className={cn("size-3.5 transition-transform", fold.open && "rotate-90")} />
        </button>
      : <span aria-hidden="true" className="flex-none" style={{ width: mark }} />}
    <button type="button" data-family-go onClick={() => onPick(task.id)} aria-current={here ? "page" : undefined} aria-label={name} title={task.title}
      className="flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-full pr-3 pl-0.5 text-left text-sm narrow:h-10 narrow:text-base">
      <StateIcon state={task.state} ball={task.ball} className="size-4 flex-none" />
      <TaskId id={task.id} className="flex-none text-xs tabular-nums text-muted" />
      <span className={cn("min-w-0 flex-1 truncate", finished && "text-muted", here && "font-semibold")}>{task.title}</span>
      {order && <span data-family-order className="flex-none text-xs tabular-nums text-muted">{order.shown}</span>}
      {deep && <span aria-hidden="true" className="flex-none text-xs text-muted tabular-nums">{t("family.deep", { count: depth })}</span>}
      {here && <span aria-hidden="true" className="flex-none text-xs text-ink max-[359px]:hidden">{t("family.here")}</span>}
    </button>
  </div>;
}

/**
 * A branch's finished children: the live index holds only the work still going, so an open branch reads its finished
 * children's pages, as the list's tree does (`resources.finished`); they join the index as they come and take their
 * places in ID order. A branch is small, so all its pages are read at once. Until the rows the server counts under the
 * branch (`joined`) are in the list, the branch is marked as still coming, for the list's way back to where it was.
 */
function FinishedOf({ parent, joined }: { parent: string; joined: boolean }) {
  const workspace = useWorkspaceInfo((info) => info.root);
  const options = resources.finished(workspace, parent);
  const page = useInfiniteQuery(options);
  const read = useReadState(options.queryKey);
  const offline = useConnection((state) => state.offline);
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = page;
  useEffect(() => {
    if (read.assessment.project && !offline && hasNextPage && !isFetching && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage({ cancelRefetch: false });
  }, [read.assessment.project, offline, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  if (offline) return read.assessment.display ? null : <li><ReadNote kind="absent" /></li>;
  if (read.error) return <li>
    <ReadFailure error={read.error} retry={read.retry} />
  </li>;
  if (read.fetching) return <li data-family-loading><RegionSkeleton shape="rows" rows={1} /></li>;
  // Read, but its rows not yet in the list (they join the index a moment after): still coming, without a mark to see.
  return joined ? null : <li data-family-loading hidden />;
}
