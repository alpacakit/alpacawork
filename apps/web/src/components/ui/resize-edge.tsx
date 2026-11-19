import { useEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The edge a window is resized by (the reader's left edge): a drag follows the pointer (`onPointer` gets its clientX),
 * an arrow key steps it (`onStep` gets -1 or 1: left or right, and the edge), a double press gives the default size back.
 */
export function ResizeEdge({ label, onPointer, onStep, onReset, onHold, className, ...props }: {
  label: string; onPointer: (at: number) => void; onStep: (sign: -1 | 1, edge: HTMLElement) => void; onReset: () => void;
  /** The edge is taken by a pointer (true) and let go (false). */
  onHold?: (held: boolean) => void; className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "onKeyDown" | "onPointerDown" | "onPointerMove" | "onDoubleClick" | "onLostPointerCapture">) {
  const keys = ["ArrowLeft", "ArrowRight"];
  // Held and then gone (the window closed or became a sheet under the pointer), the edge is let go as well.
  const held = useRef(false), hold = useRef(onHold);
  hold.current = onHold;
  const take = (next: boolean) => { if (held.current === next) return; held.current = next; hold.current?.(next); };
  useEffect(() => () => take(false), []);
  return <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} {...props}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); take(true); }}
    onLostPointerCapture={() => take(false)}
    onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onPointer(event.clientX); }}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      const at = keys.indexOf(event.key);
      if (at < 0) return;
      event.preventDefault();
      onStep(at === 0 ? -1 : 1, event.currentTarget);
    }}
    className={cn("group/edge absolute z-30 flex touch-pinch-zoom items-center justify-center outline-none",
      "inset-y-0 left-0 w-4 cursor-col-resize", className)}>
    <span className="h-10 w-0.5 rounded-full bg-lit-line group-hover/edge:h-full group-hover/edge:bg-muted group-focus-visible/edge:h-full group-focus-visible/edge:bg-muted" />
  </div>;
}
