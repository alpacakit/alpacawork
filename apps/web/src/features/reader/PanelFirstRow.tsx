import type { ComponentProps } from "react";
import { Button, HEAD_MARK } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** A related list has no separate header: its first row stays above scrolling rows with × beside it. */
export function PanelFirstRow({ children, scrolled, closeLabel, onClose, className, ...props }: ComponentProps<"div"> & {
  scrolled: boolean; closeLabel: string; onClose: () => void;
}) {
  return <div {...props} className={cn("sticky top-0 z-3 flex items-center gap-1 bg-raised pt-1.5",
    scrolled && "after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-rule", className)}>
    <div className="min-w-0 flex-1">{children}</div>
    <Button variant="ghost" size="icon" aria-label={closeLabel} title={closeLabel} onClick={onClose}
      className={cn(HEAD_MARK, "touch-none text-muted")}><Icon name="close" /></Button>
  </div>;
}
