import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A strut as high as the capitals of the words round it, over their baseline (text-box). First in a grid cell, it gives
 * the cell its baseline, and a mark centred in that cell centres on the capitals: TextMark, and the list's marks beside a
 * row's id (RowLines). A browser without text-box keeps the strut a whole line high and centres the marks on the line.
 */
export function CapStrut({ className }: { className?: string }) {
  return <span className={cn("cap-strut", className)} />;
}

/**
 * A mark beside words (who a History row was between, its arrow, an agent's logo before its name), centred on their
 * capitals whatever their size and the font that draws them. The strut is the box's first item, so it gives the box its
 * baseline, and the mark centres on it: set in a line of text, or in a row that lines its items up on their baseline
 * (`items-baseline`), the mark stands with the words. Laid out where it is
 * drawn, not moved there, so its row is as tall as it draws and nothing round it cuts it. Centred on the line box
 * instead, it stood 0.5px over the words on a phone and 0.6px over them on a computer.
 */
export function TextMark({ className, children }: { className?: string; children: ReactNode }) {
  return <span aria-hidden="true" className={cn("inline-grid flex-none items-center", className)}>
    <CapStrut className="col-start-1 row-start-1" />
    <span className="col-start-1 row-start-1 flex">{children}</span>
  </span>;
}
