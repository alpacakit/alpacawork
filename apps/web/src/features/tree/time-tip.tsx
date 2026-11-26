import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * What a row's time means, said in words in a box that a press on the time opens (the row's times and the time view's
 * expected report alike). While it is open a press anywhere else only closes it (modal), as do Esc, Back (Popover, with
 * the page's step, as every surface open for a moment), a turn of the wheel and a swipe. `children` is the press itself
 * (an HTML button or an SVG glyph), which the box stands against.
 */
export function TimeTipPopover({ heading, body, children }: {
  /** What the time is ("Elapsed", "Expected report"), over its words; none for a word that says itself. */
  heading: string | null;
  body: ReactNode | ((close: () => void) => ReactNode);
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // A touch press outside closes it on its click (Radix), which a swipe never sends: the swipe closes it as it moves.
    for (const type of ["wheel", "touchmove"]) window.addEventListener(type, close, { passive: true });
    return () => { for (const type of ["wheel", "touchmove"]) window.removeEventListener(type, close); };
  }, [open]);
  return <Popover open={open} onOpenChange={setOpen} modal>
    <PopoverTrigger asChild>{children}</PopoverTrigger>
    <PopoverContent data-time-tip align="end" side="bottom" className="w-auto max-w-72 px-3 py-2 text-sm">
      {heading && <p className="text-xs font-medium text-muted">{heading}</p>}
      {typeof body === "function" ? body(() => setOpen(false)) : body}
    </PopoverContent>
  </Popover>;
}
