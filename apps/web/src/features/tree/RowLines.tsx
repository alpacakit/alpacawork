import { useId, type ReactNode } from "react";
import { isFinished } from "@alpacawork/contract/branch";
import type { Task } from "@/data/types";
import { Icon } from "@/components/ui/icon";
import { CapStrut } from "@/components/ui/text-mark";
import { TONE, useTaskLook } from "@/components/ui/tone";
import type { PeopleIndex } from "@/domain/people";
import { ReportTime, RowKindWord, RunningRuns, StatusNotes, StatusTime, WaitedNote } from "./RowStatus";
import { RowProjectTile } from "./RowProjectTile";
import { SentArc, SentWord } from "./SentArc";
import { cn } from "@/lib/utils";

/**
 * A phone's list row, one form in every group. A quiet line (the id, the kind of what waits on you, the
 * children's count, what is so of its state, and the row's one time at its end; domain/row-status) is drawn over its title,
 * which takes the whole lower line; a screen reader hears the state's word, the title, then that line. The group's
 * heading says the state, so no row repeats it, and no row says the work's words: they are read in the task.
 */
export function RowLines({ task, people, lifted, counts, title, unread }: {
  task: Task; people: PeopleIndex;
  /** The id of the parent of a row lifted away from it, said before its own id (quiet: only its own id takes its colour). */
  lifted: string | null;
  /** The children's progress; null when it has none. */
  counts: ReactNode | null;
  /** The title's press, which carries the row's keys; it takes the layout given with its content, and is described by the meta line. */
  title: (content: ReactNode, layout: string, describedBy: string) => ReactNode;
  /** The unread dot, drawn in its own place at the line with the id. */
  unread: ReactNode;
}) {
  const look = useTaskLook(task);
  // One grid for the row. Its marks (the unread dot, the state icon) share the id's line: they sit on its baseline, centred on
  // its capitals whatever font draws it; the press lays out the marks, the line and the title on the row's columns (subgrid).
  // Its two lines (the id's, the title's) take their steps' heights and fill the phone's 48px row with 2px over and under.
  // The meta line stands beside the press, not in it, so its times can be presses of their own (TimeTip); the press's cover
  // (after:, from the caller) lies over the rest of the line, so a press there still opens the task, and the press is
  // described by the line, so a reader hears the state's word and the title, then the line.
  const meta = useId();
  return <div data-row-lines className="relative grid min-w-0 flex-1 grid-cols-[var(--spacing-list-lead)_auto_minmax(0,1fr)] items-baseline py-0.5 pr-3">
    {title(<>
      <span className="sr-only">{look.word}</span>
      <SentWord task={task} />
      <span data-row-marks aria-hidden="true" className="col-span-2 row-start-1 grid grid-cols-subgrid items-center text-xs">
        {/* A strut as high as the id's capitals, from its baseline, first in the grid's order so it gives the marks their baseline: they
            centre on it. A browser without text-box keeps the strut a whole line high, and the marks sit 1-2px low there. */}
        <CapStrut className="col-start-1 row-start-1" />
        <span className="col-start-1 row-start-1 flex pl-list-mark">{unread}</span>
        {/* The icon says the state where no heading does (a lifted row, a parent's band); its word is in the press for a reader. */}
        <span className="col-start-2 row-start-1 flex pr-2">
          <span className="relative flex"><Icon name={look.icon} className={cn("size-list-icon", TONE[look.tone])} /><SentArc task={task} say={false} /></span>
        </span>
      </span>
      {/* Read title first; drawn under the line above it. */}
      <span data-row-title-line className="col-start-3 row-start-2 mt-px flex min-w-0">{titleText(task)}</span>
    </>, "col-span-3 col-start-1 row-span-2 row-start-2 grid min-w-0 grid-cols-subgrid grid-rows-subgrid items-baseline text-left", meta)}
    {/* The press's two rows are the row's (subgrid): the marks share this line's baseline, the title takes the next. */}
    <span id={meta} data-row-meta className={cn("col-start-3 row-start-2 flex min-w-0 items-baseline gap-2 text-xs tabular-nums", TONE.aside)}>
      <RowProjectTile project={task.projectId} className="self-center" />
      <span data-row-id className="flex-none">
        {lifted && `${lifted} › `}<span data-row-own-id>{task.id}</span>
      </span>
      <RowKindWord task={task} />
      {/* What is under it gives way before the id and the times, which are never cut: a count that does not fit drops
          whole onto a hidden second line, last first, never cut to "Work". */}
      {counts && <span data-row-counts className="flex h-lh min-w-0 shrink-[100] flex-wrap gap-x-2 overflow-hidden whitespace-nowrap">
        {/* An empty first item holds the first line, so even the first count drops whole when it does not fit; it carries a
            zero-width character so the line keeps the text's baseline and the row its height. */}
        <span aria-hidden="true" className="-mr-2 h-lh w-0">{"\u200b"}</span>{counts}</span>}
      {/* What is so of its state is cut with "…" rather than dropped: it is the reason to look at the row. */}
      <WaitedNote task={task} />
      <StatusNotes task={task} className="shrink" />
      {/* The time's step keeps the line's height on a row with no time, so every row is as high; it puts the end's words
          at the line's end. */}
      <span aria-hidden="true" className="ml-auto w-0 text-sm">{"\u200b"}</span>
      {/* The expected report, then the row's one time: each a short time whose press says what it is. */}
      <ReportTime task={task} people={people} />
      <RunningRuns task={task} className="text-sm" />
      <StatusTime task={task} className="text-sm" />
    </span>
  </div>;
}

function titleText(task: Task) {
  return <span data-row-title dir="auto" className={cn("min-w-0 flex-1 truncate text-base",
    isFinished(task.state) ? "text-muted" : "text-ink")}>{task.title}</span>;
}
