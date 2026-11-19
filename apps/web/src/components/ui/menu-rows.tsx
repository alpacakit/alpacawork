import { cn } from "@/lib/utils";
import { Icon } from "./icon";

/**
 * The rows a floating card picks from (the model picker, the state card), one look for both: a quiet bold name over a
 * group, and rows whose picked one is filled, bold and ticked at its start.
 */
export const MENU_GROUP = "px-2 pt-2 pb-0.5 text-xs font-semibold text-muted";

/** A row's face; a row that is a hidden radio's label shows that radio's focus, a row that is a button its own. */
export const menuRow = (checked: boolean) => cn(
  "relative flex w-full min-h-control-sm cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-base outline-none hover:bg-hover",
  "focus-visible:outline-2 focus-visible:outline-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-muted",
  "disabled:cursor-default disabled:opacity-38 narrow:min-h-control-lg pointer-coarse:min-h-control-lg",
  checked && "bg-hover font-semibold");

/** The tick before a row: drawn on the picked row, kept as room on the others so their words line up. */
export function MenuTick({ checked }: { checked: boolean }) {
  return <span className={cn("size-3.5 flex-none", checked ? "text-ink" : "text-transparent")}><Icon name="check" className="size-3.5" /></span>;
}
