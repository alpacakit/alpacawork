import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

function Bar({ className }: { className?: string }) {
  return <div className={cn("animate-placeholder rounded-sm bg-placeholder", className)} />;
}

/** Lengths the bars take row by row, fixed, so the blocks read as different lines without reading any data. */
const LENGTHS = ["w-3/5", "w-4/5", "w-1/2", "w-2/3", "w-3/4"];
const length = (row: number) => LENGTHS[row % LENGTHS.length];

/**
 * A row of the list as it stands: the state mark, then on a computer the ID and the title on one line, on a phone the
 * ID, the latest word and the time over the title. The unread dot is left out (most rows have none). On a phone the two
 * lines stand where the row's two lines of text will, which leaves about as much room under the title as over the ID.
 */
function ListRow({ row }: { row: number }) {
  return <div data-skeleton-row className="flex h-7.75 items-center gap-1.5 border-b border-rule pr-2 pl-5.5 narrow:h-12 narrow:items-start narrow:gap-2 narrow:pt-1 narrow:pr-3">
    <Bar className="size-3.5 flex-none narrow:size-4" />
    <div className="flex min-w-0 flex-1 items-center gap-1.5 narrow:flex-col narrow:items-stretch">
      <div className="flex flex-none items-center gap-2 narrow:h-4"><Bar className="h-3 w-10" /><Bar className="hidden h-3.5 flex-1 narrow:block" /><Bar className="hidden h-3.5 w-12 narrow:block" /></div>
      <Bar className={cn("h-3.5 narrow:h-4", length(row))} />
    </div>
  </div>;
}

/** A group's heading: its coloured square and its name (on a computer it sits low, over the rows, and groups stand apart). */
function GroupHead({ first }: { first: boolean }) {
  return <div className={cn("flex h-8 items-end border-b border-rule pb-2 pl-2 narrow:h-11 narrow:items-center narrow:pb-0", !first && "mt-3 narrow:mt-0")}>
    <div className="flex items-center gap-1.5"><Bar className="size-2 rounded-xs" /><Bar className="h-3.5 w-14" /></div>
  </div>;
}

/** A quiet line of the report feed: when, and what happened, in one line. */
function FeedLine({ row }: { row: number }) {
  return <li className="flex min-h-11 items-center gap-2 border-b border-rule pl-4"><Bar className="h-2.5 w-7.5 flex-none" /><Bar className={cn("h-3.5", length(row))} /></li>;
}

/** The shape of each region that waits for data, as it will stand once drawn; not every element, only where the blocks go. */
const SHAPES = {
  // The list: the clock row on a computer, then groups (a heading and rows); each row has its strip beside it on a computer.
  time: () => <div className="relative min-h-75 flex-1 basis-0 overflow-hidden narrow:min-h-67.5">
    <div className="flex h-7.5 border-b border-rule narrow:hidden"><div className="w-90 border-r border-rule max-[900px]:w-82.5" /></div>
    {[2, 5, 3].map((count, group) => <div key={group}>
      <GroupHead first={group === 0} />
      {Array.from({ length: count }, (_, at) => <div key={at} className="flex">
        <div className="w-90 flex-none border-r border-rule max-[900px]:w-82.5 narrow:w-full narrow:border-r-0"><ListRow row={group + at} /></div>
        <div className="flex flex-1 items-center justify-end border-b border-rule pr-12 narrow:hidden"><Bar className={cn("h-0.5", length(group * 2 + at + 1))} /></div>
      </div>)}
    </div>)}
  </div>,
  // The app bar's project name.
  title: () => <Bar className="h-5 w-32 narrow:w-24" />,
  // The detail panel before its task is known: the header's ID and buttons, the title, then the reports.
  reader: () => <>
    <div className="flex-none border-b border-rule px-4 pt-4 pb-3 narrow:px-3">
      <div className="flex items-center gap-2"><Bar className="h-3.5 w-14" /><Bar className="size-4" /><Bar className="ml-auto size-4" /><Bar className="ml-4 size-4" /></div>
      <div className="mt-5 space-y-2.5 pr-8"><Bar className="h-5.5 w-full" /><Bar className="h-5.5 w-1/2" /></div>
    </div>
    <div className="px-4 py-2 narrow:px-3">{SHAPES.reports()}</div>
  </>,
  // A task's reports along their rail: quiet lines, the latest report open (its mark on the rail, when, its title, its
  // body), then folded reports.
  reports: () => <ol className="m-0 ml-2 flex list-none flex-col border-l border-rule p-0">
    <FeedLine row={0} />
    <li className="relative border-b border-rule pt-3 pb-5 pl-4">
      <Bar className="absolute top-4.5 -left-1.5 size-2.5 rounded-xs" />
      <div className="flex gap-2"><Bar className="mt-1.5 h-2.5 w-7.5 flex-none" /><div className="flex-1 space-y-2"><Bar className="h-4.5 w-11/12" /><Bar className="h-4.5 w-2/5" /></div></div>
      <div className="mt-4 space-y-2.5"><Bar className="h-4 w-full" /><Bar className="h-4 w-full" /><Bar className="h-4 w-11/12" /><Bar className="h-4 w-3/5" /></div>
    </li>
    {[1, 2, 3].map((row) => <FeedLine key={row} row={row} />)}
  </ol>,
  // Only the unread History range, below the latest report or at the end of the pages already read.
  reportLines: () => <ol className="m-0 ml-2 flex list-none flex-col border-l border-rule p-0">
    {[0, 1, 2].map(row => <FeedLine key={row} row={row} />)}
  </ol>,
  // More rows of the list coming (a page scrolled to), in the title column.
  rows: (rows = 2) => <div className="flex flex-col">{Array.from({ length: rows }, (_, row) => <ListRow key={row} row={row} />)}</div>,
  // A written body (a request's text).
  text: () => <div className="space-y-2.5"><Bar className="h-4 w-full" /><Bar className="h-4 w-11/12" /><Bar className="h-4 w-4/6" /></div>,
};

export type SkeletonShape = keyof typeof SHAPES;

/** How long a wait goes unseen: a read that ends sooner shows no placeholder at all. */
export const PLACEHOLDER_WAIT_MS = 150;

/**
 * What a region shows while `Loadable` waits for its data: the region's shape in pale blocks. The box it sits in
 * (the detail panel's window) comes from `className` when the region draws it itself once loaded.
 * `waitFrom` (performance.now()) is when the wait it stands for began, for a placeholder drawn for a wait already under
 * way: its blocks then come in on that wait's time (unseen for its first PLACEHOLDER_WAIT_MS, then slowly), not on their
 * own, so one placeholder taking over from another as the read moves on goes on as the same one.
 */
export function RegionSkeleton({ shape, rows, className, waitFrom }: { shape: SkeletonShape; rows?: number; className?: string; waitFrom?: number }) {
  const { t } = useTranslation("ui");
  // Taken once, as the blocks are put on the page: their animations start then, so a later redraw must not move it.
  const [at] = useState(() => waitFrom === undefined ? undefined
    : { "--placeholder-at": `${Math.round(waitFrom + PLACEHOLDER_WAIT_MS - performance.now())}ms` } as CSSProperties);
  return <div role="status" aria-label={t("loading")} aria-busy="true" data-skeleton={shape} data-placeholder-at={at ? "" : undefined} style={at} className={className}>
    {shape === "rows" ? SHAPES.rows(rows) : SHAPES[shape]()}
  </div>;
}
