import { useState, type ReactNode } from "react";
import { useScrollMore } from "@/lib/scroll-more";
import { cn } from "@/lib/utils";

/**
 * A table cell never folds narrower than its own words on one line or 12em, whichever is less: a short cell
 * keeps its natural width, a long one at least about 12 Japanese characters a line. Japanese text, a URL or a path may
 * fold at any letter, so without this floor a wide table crushed its columns to a letter or two each. When the floors
 * together outrun the place, the table alone scrolls sideways in its frame; when they fit, the table stays inside and
 * its columns widen to their words (the frame's edge fades where more lies beyond: `scroll-more-x`). The
 * floor is the cell's words laid out unseen (`data-fit`, unread and unselectable), so it is measured in the cell's own
 * font and follows the reader's text size. A picture or a video counts as long words: it would shrink to anything.
 */
export const CELL_FLOOR = "before:invisible before:block before:h-0 before:w-max before:max-w-[12em] before:overflow-hidden before:content-[attr(data-fit)] has-[img,video]:min-w-[12em]";

/**
 * A table's own frame: it scrolls sideways when the table outruns it, and marks the sides where more lies beyond
 * (`data-more`, drawn by `scroll-more-x`), measured again as it scrolls and as it or the table changes size.
 */
export function TableFrame({ className, children }: { className?: string; children: ReactNode }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return <div ref={setFrame} data-table-frame="" data-more={useScrollMore(frame)} className={cn("max-w-full overflow-x-auto pb-px scroll-more-x", className)}>{children}</div>;
}
