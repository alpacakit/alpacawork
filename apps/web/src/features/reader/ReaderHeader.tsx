import { countUse } from '@/features/telemetry/count';
import { useLayoutEffect, useRef, type ReactNode, type Ref, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button, HEAD_MARK, HEAD_MARK_GAP } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { useWorked } from "@/components/ui/copy-button";
import { BackButton } from "@/components/ui/back-button";
import { TaskId } from "@/components/ui/task-id";
import { ProjectTile } from "@/components/ui/project-tile";
import { useMarksTasks, useProjectMarks } from "@/data/project-marks";
import { useTaskIndex, useWorkspaceInfo, useWorkspaceWritable } from "@/data/queries";
import { useViewAncestors } from "@/data/view-ancestors";
import type { Task } from "@/data/types";
import { pathTo } from "@/domain/tasks";
import { listNeighbours, useListNavigation } from "@/features/tree/list-navigation";
import { useViewStore } from "@/state/view-store";
import { closeReaderStep } from "@/state/history-step";
import { readerBack, useReaderBehind } from "@/state/reader-position";
import type { ReaderPane } from "@/state/view-store";
import type { ReaderMode } from "./Reader";
import { navigate, readerNow } from "@/lib/history";
import { useSheetControl } from "./TaskSheet";
import { cn } from "@/lib/utils";
import { useTaskCardOn } from "@/features/coordinator/TaskCard";
import { taskInDraft } from "@/features/coordinator/editor/draft";

/**
 * The reader's head: one head for whatever the reader shows, which gives it nothing of its own.
 * Row 1, left to right: Back (`ReaderBack`, only when there is a place to go back to), the path down to this task in IDs,
 * its id and its insert mark (InsertButton), the pager of the gathered, and at the top-right corner the frame's own buttons, Expand and ×
 * (`FrameButtons`). The head writes no title: the reports keep theirs in the text. Context (About) and the files are
 * not kept in the head: their entries stand under the title beside the Task tree (`ReaderEntries`), and a report's
 * links open its files. No footer row: Esc and × close the reader.
 *
 * What the path says depends on what fits, by one rule, at any width, text size or ID's length, so moving between
 * tasks never changes the head's height. The nav is one line tall and lays out in reverse, from the right of what it holds:
 * this ID and its insert mark first, then the parent, the older ancestors (under a 600px head never) and last the project's
 * square; `order` says that, while the document keeps reading order. What does not fit goes to a second line, which the
 * clip hides, and `useClipInert` takes out of Tab's and a reader's reach (the clip's margin keeps a focus ring whole where a
 * browser knows it, short of that line). So the square gives way first, the parent last, and the row wraps
 * under Back only when Back, this ID and its insert mark do not fit (`min-w-min`).
 */
export function ReaderHeader({ task, mode, canDock, onFollow, walking, pane, ruled }: {
  task: Task; mode: ReaderMode; canDock: boolean; onFollow: (id: string) => void; walking: boolean; pane: ReaderPane; ruled: boolean }) {
  const { t } = useTranslation("reader");
  const index = useTaskIndex();
  const sheet = useSheetControl();
  const path = useRef<HTMLElement>(null);
  useClipInert(path);
  // The opened view names every ancestor, finished ones too; until it is held, the list's rows name those it lists.
  const root = useWorkspaceInfo((info) => info.root);
  const heads = useViewAncestors(root, task.id);
  const ancestors: Pick<Task, "id" | "title">[] = heads ?? pathTo(task.id, index).slice(0, -1);
  const parentId = ancestors.at(-1)?.id;
  const behind = useReaderBehind();
  // A walk through the waiting questions goes on by itself: going back to the question before is not this Back.
  // Over the analysis face, Back goes back to it (and its list) from any pane.
  const overAnalysis = useViewStore(state => state.analysis !== null);
  const back = !!behind && !(walking && behind.task !== task.id) || pane !== "task" || overAnalysis;
  return (
    // On a phone's sheet the header moves the sheet as its grip does.
    <header {...sheet?.grip} className={`${readerHeadBox(mode)} @container/reader ${ruled ? "border-rule" : "border-transparent"}`}>
      {/* The row owns the left alignment and clip together; its contents never overhang that clip. What stands first (the
          project's square, a step, this ID) starts on the title's line: on a computer the row comes 4px out for the steps'
          own padding, on a phone, where they have none, it does not. Back keeps its place either way: its arrow alone is
          centred in its press, so it cannot stand on the line. At its other end ×'s circle ends on the title's right edge; the
          12px the row takes from the head's room keeps its focus ring whole. */}
      <div data-reader-head-row className={`-ml-1 flex min-w-0 items-start -mr-3 narrow:ml-0 overflow-x-clip pr-3 text-xs whitespace-nowrap text-muted ${HEAD_MARK_GAP}`}>
        <div data-reader-head-flow className={`flex min-w-0 flex-1 items-center overflow-x-clip @max-[480px]/reader:flex-wrap ${HEAD_MARK_GAP} ${HEAD_ROW}`}>
          {back && <ReaderBack />}
          <nav ref={path} data-reader-path aria-label={t("readerHeader.path")} className="flex h-head min-w-min flex-[1_1_0%] flex-row-reverse flex-wrap content-start items-center justify-end gap-x-0.5 gap-y-2 overflow-clip [overflow-clip-margin:0.25rem] narrow:h-11 narrow:gap-x-0">
            <PathProject task={task} />
            {ancestors.map((ancestor, at) => (
              <span key={ancestor.id} style={{ order: ancestors.length - at }} className={`flex flex-none items-center gap-0.5 narrow:gap-0 ${ancestor.id === parentId ? "" : "@max-[600px]/reader:hidden"}`}>
                <PathStep task={ancestor} onFollow={onFollow} />
                <Icon name="right" data-reader-path-separator className="mx-1 w-2.5 flex-none" />
              </span>
            ))}
            {/* On a phone the insert mark's 6px reach past its face (HEAD_MARK) stays inside the path's clip. */}
            <div className={`flex flex-none items-center gap-0.5 narrow:mr-1.5 narrow:gap-0 ${HEAD_ROW}`}>
              <TaskId id={task.id} data-reader-task-id aria-current="page" className="flex-none px-1 text-xs font-medium tabular-nums text-ink narrow:px-0" />
              <InsertButton task={task} />
            </div>
          </nav>
        </div>
        <span data-reader-actions className={`flex flex-none items-center ${HEAD_ROW}`}><ListPager id={task.id} /></span>
        <FrameButtons canDock={canDock} />
      </div>
    </header>
  );
}

/**
 * Puts this task's label in the input, where its caret is, as # does (taskInDraft), and the input comes up with focus
 * right after it. It says it worked where it was pressed: the mark turns to ✓ for a moment, as a copy mark does.
 * The mark is the one the empty list's examples go into the input with (`enter`). Where the workspace takes no writes
 * it is not offered, as the input's own # is not.
 */
function InsertButton({ task }: { task: Task }) {
  const { t } = useTranslation("reader");
  const writable = useWorkspaceWritable();
  const [put, press] = useWorked(() => taskInDraft(task));
  const name = t(put ? "readerHeader.inserted" : "readerHeader.insert", { id: task.id });
  return <Button variant="quiet" size="icon" disabled={!writable} data-insert={put ? "done" : ""} aria-label={name} title={name} className={`text-muted hover:text-ink ${HEAD_MARK}`}
    onClick={press}>
    {put ? <Icon key="check" name="check" className="size-3.5 animate-pop" /> : <Icon key="enter" name="enter" className="size-3.5" />}
  </Button>;
}

/**
 * What the path's clip hides is out of reach, so Tab never stops on an ancestor no one sees. Whether a step went to
 * the hidden line changes with the head's width, the text's size and the IDs, so changed steps or sizes recheck it.
 */
function useClipInert(path: RefObject<HTMLElement | null>) {
  const recheck = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const nav = path.current;
    if (!nav) return;
    let steps: HTMLElement[] = [];
    const mark = () => {
      const bottom = nav.getBoundingClientRect().bottom;
      const hidden = steps.map(step => step.getBoundingClientRect().top >= bottom);
      for (const [at, step] of steps.entries()) if (step.inert !== hidden[at]) step.inert = hidden[at]!;
    };
    const observer = new ResizeObserver(mark);
    const watch = () => {
      const next = [...nav.children] as HTMLElement[];
      if (next.length === steps.length && next.every((step, at) => step === steps[at])) return;
      observer.disconnect();
      steps = next;
      observer.observe(nav);
      for (const step of steps) observer.observe(step);
      mark();
    };
    recheck.current = watch;
    // A subscribed child (such as the project mark) can commit without rerendering this header.
    const children = new MutationObserver(watch);
    children.observe(nav, { childList: true });
    watch();
    return () => { recheck.current = null; children.disconnect(); observer.disconnect(); };
  }, [path]);
  // Parent state commits do not move the clip. Sizes belong to ResizeObserver; replaced steps are rebound here.
  useLayoutEffect(() => { recheck.current?.(); });
}

/**
 * The project the task is in, when the view holds more than one project: its square only, its name and ID said on
 * hover and to a reader. It stands before the first ID as on a list's row, at that row's distance
 * (8px on a phone, on a computer 6px with the ID's own padding); the › is for going down from task to task.
 */
function PathProject({ task }: { task: Task }) {
  const shows = useMarksTasks();
  const mark = useProjectMarks().get(task.projectId);
  if (!shows || !mark || task.kind === "project") return null;
  return <ProjectTile name={mark.name} color={mark.color} size={18} label={`${mark.name} ${mark.id}`} className="order-last ml-1 narrow:ml-0 narrow:mr-2" />;
}

/**
 * The head's box, the reader's and the one standing while a task is looked up. On a computer its row is a head's row
 * (`min-h-head`, the app bar's 32px controls at the browser's own text size, growing with the text as the bar does)
 * and stands on the bar's head line, beside the bar (styles.css, Head line): a window keeps its head's room over the
 * row (`pt-head-room`, under the window's margin from the screen's top, `readerBox`), and the full screen, which starts
 * at the screen's top, comes down to the line (`pt-head`), so Expand moves nothing in the row. The path keeps the row's
 * height too. The list steps and frame buttons stay on that line; the path and Back give them room. Under the
 * row is the lower half of the 44px it had (6px), so the title keeps its place under the path. On a phone's sheet the
 * row is 44px under the grip, which the sheet's own finger holds. The row clips only across, so a focused button's
 * ring shows whole. The reader's mode picks the box, not a style sheet's selector on it: a still copy keeps the marks
 * style sheets select on (lib/motion.ts), and a copy is no reader.
 */
export const HEAD_ROW = "min-h-head narrow:min-h-11";
export const readerHeadBox = (mode: ReaderMode) => `reader-header flex-none border-b px-4 narrow:px-3 ${{
  sheet: "", docked: "pt-head-room pb-1.5", overlay: "pt-head pb-1.5" }[mode]}`;

/**
 * The reader's one Back, at the head's left end wherever the reader is: back to the place the step left, as it was
 * (`readerBack`). It names no place: going back is enough to know. Its face is the head's buttons': their
 * height and corner; its words give way in a narrow header. The row around its face keeps it on the first line
 * even where enlarged text needs more reading room on the left.
 */
// Back's word gives way before the path does: keep it above 24rem of header content (384px at 16px text), or 408px on a
// phone with its two 12px insets, where full Back (~60), the parent's ID and its › (44), the ID (26), Copy (32 and its
// 6px reach), the project's square (26) and four 32px faces with their 12px gaps (HEAD_MARK, HEAD_MARK_GAP) fit. Rem keeps this budget with enlarged text. Without its word, Back on a
// phone stands 36px wide, so a 360px phone holds a parent with its 4-digit child.
function ReaderBack() {
  const { t } = useTranslation("reader");
  return <span className={`flex flex-none items-center ${HEAD_ROW}`}><BackButton data-reader-back label={t("readerHeader.back")}
    className="@max-[24rem]/reader:w-8 @max-[24rem]/reader:p-0 narrow:@max-[24rem]/reader:-ml-1 narrow:@max-[24rem]/reader:w-9 narrow:@max-[24rem]/reader:pl-0"
    labelClassName="@max-[24rem]/reader:hidden" onClick={() => { countUse('reader.back'); readerBack(); }} /></span>;
}

/**
 * The frame's own buttons, at the head's top-right corner whatever the reader shows (a task, one still being looked
 * up, one that failed) and on every screen: Expand (↗↙) and last, in the corner, ×. They look and sit the same
 * everywhere; only what Expand grows is the frame's: a phone's sheet the whole screen, a computer's window the full width.
 * They are the list head's ⚙ (`bar`); their row keeps the head's height (`HEAD_ROW`) whether or not anything else stands in it.
 */
export function FrameButtons({ canDock }: { canDock: boolean }) {
  const { t } = useTranslation("reader");
  const grow = useGrow(canDock);
  return <span data-reader-frame-buttons className={`flex flex-none items-center ${HEAD_MARK_GAP} ${HEAD_ROW}`}>
    {grow && <FrameButton data-reader-grow icon={grow.grown ? "minimize" : "maximize"} label={grow.label} pressed={grow.grown} onPress={grow.toggle} />}
    <FrameButton icon="close" label={t("readerHeader.close")} title={t("readerHeader.closeShort")} onPress={closeReaderStep} />
  </span>;
}

/** What Expand grows, if this frame can: a phone's sheet to the whole screen and back, a docked window to the full width and back. */
function useGrow(canDock: boolean) {
  const { t } = useTranslation("reader");
  const sheet = useSheetControl();
  const full = useViewStore((state) => state.readerFull);
  const setReaderFull = useViewStore((state) => state.setReaderFull);
  if (sheet) return { grown: sheet.whole, label: t(sheet.whole ? "sheet.toShare" : "sheet.toWhole"), toggle: sheet.toggleWhole };
  if (canDock) return { grown: full, label: t(full ? "readerHeader.dock" : "readerHeader.full"), toggle: () => setReaderFull(!full) };
  return null;
}

function FrameButton({ icon, label, title = label, pressed, disabled, onPress, ...data }: { icon: IconName; label: string; title?: string; pressed?: boolean; disabled?: boolean; onPress: () => void; [data: `data-${string}`]: unknown }) {
  // Every one is the head's 32px circle (HEAD_MARK). The last, ×, ends its circle on the title's right edge, clear of
  // the window's round corner, as a related list's × ends on its rows' edge.
  return <Button variant="ghost" size="icon" {...data} disabled={disabled} aria-pressed={pressed} aria-label={label} title={title} onClick={onPress}
    className={HEAD_MARK}><Icon name={icon} /></Button>;
}

/**
 * The title scrolls with the reading and takes the column's whole width; its heading is also a sheet grip. It is read,
 * not edited, on the screen (the agents retitle a task). Opened from a control, the reader puts the focus here.
 */
export function ReaderTitle({ task, titleRef }: { task: Task; titleRef?: Ref<HTMLHeadingElement> }) {
  const sheet = useSheetControl();
  return <div {...sheet?.grip} className="min-w-0">
    <h2 ref={titleRef} tabIndex={-1} data-reader-title={task.id} dir="auto" className="mb-1 text-xl text-ink outline-none narrow:text-lg [overflow-wrap:anywhere]">{task.title}</h2>
  </div>;
}

/**
 * An ancestor is its id (no title, at any width), and a reader hears its title. Resting a pointer on it shows the
 * shared task card (useTaskCardOn), but a press on any screen follows it at once: the path is for going there, so
 * a finger is not stopped at the card the way a task's ID in a text is. Its box hugs that id, with the current ID's padding, so the › after it stands as far from it as from
 * the next ID. A finger's 44px runs on from the id over its ›: it may stand first in the row, whose clip would cut anything
 * left of it.
 */
function PathStep({ task, onFollow }: { task: Pick<Task, "id" | "title">; onFollow: (id: string) => void }) {
  const { anchor, trigger, card } = useTaskCardOn<HTMLButtonElement>(task.id, () => onFollow(task.id), { opens: true });
  return <><Button ref={anchor} variant="ghost" aria-label={`${task.id} ${task.title}`} className="relative min-h-6 flex-none justify-start px-1 text-xs tabular-nums text-muted after:absolute after:inset-y-0 after:left-0 after:w-[max(100%+0.5rem,2.75rem)] after:content-[''] hover:bg-transparent hover:underline narrow:min-h-11 narrow:px-0"
    {...trigger}>{task.id}</Button>{card}</>;
}

/** The current list's ordinary row-opening action, in its displayed order. */
export function ListPager({ id }: { id: string }) {
  const { t } = useTranslation("reader");
  const list = useListNavigation();
  const { at, previous, next } = listNeighbours(list.ids, id);
  return <span data-list-pager data-gathered-pager={list.total !== undefined && at >= 0 ? "" : undefined} className={`flex flex-none items-center text-xs tabular-nums text-muted ${HEAD_MARK_GAP}`}>
    {list.total !== undefined && at >= 0 && <span data-list-position className="px-1 @max-[600px]/reader:hidden">{t("gathered.position", { current: at + 1, total: list.total })}</span>}
    <FrameButton data-list-previous icon="left" label={t("readerHeader.previous")} disabled={!previous}
      onPress={() => { if (previous) list.open(previous); }} />
    <FrameButton data-list-next icon="right" label={t("readerHeader.next")} disabled={at < 0 || !next && !list.loadNext}
      onPress={() => {
        if (next) list.open(next);
        else if (at >= 0 && list.loadNext) {
          // A late page may move only the reader and list from which it was requested.
          const from = readerNow();
          void list.loadNext().then(next => {
            if (next) navigate(() => list.open(next), from);
          });
        }
      }} />
  </span>;
}
