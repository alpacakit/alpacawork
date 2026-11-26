import type { HTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";
import { UNDER_BAR } from "@/state/bar";

/**
 * The scroller in the list's place (the list of tasks, a search's results, the analysis): it runs under the bar
 * (`UNDER_BAR`) and clear of what stands at the screen's foot (`--list-foot`). Its content runs to its right edge, where
 * a scrollbar drawn over what scrolls (a Mac's, a phone's) would stand over it: `room` moves the scroller's edge into the
 * page's margin beside it by a scrollbar's width and keeps that much clear inside, so the bar stands in the margin and
 * the content keeps its place and width. The list of tasks leaves it out: its time strip ends in the band past now.
 */
export function ListScroll({ ref, room = false, className, children, ...props }: HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement>; room?: boolean;
}) {
  return <div ref={ref} data-list-scroll {...UNDER_BAR} {...props}
    className={cn("relative min-h-75 flex-1 basis-0 overflow-auto overscroll-contain scroll-pb-(--list-foot) pb-(--list-foot) narrow:min-h-67.5",
      room && "-me-3 pe-3", className)}>{children}</div>;
}
