import { useLayoutEffect, useRef, type ReactNode } from "react";
import { watchLayerHeight } from "@/lib/scroll-away";
import { cn } from "@/lib/utils";
import { useBar } from "@/state/bar";

/** The bar laid over the list (`state/bar.ts`): it slides up out of sight while the list is read downwards. */
/**
 * Out of sight, keeping its place: the list and its bar while the reader stands over them beside a diff (Workbench),
 * still seen while the reader moves over them (lib/motion.ts moveAcross).
 */
export const AWAY = "invisible in-data-panel-moving:visible";
/** `away`: AWAY, while a diff or a file stands beside the reader over the list (Workbench). */
export function Bar({ children, inert, away }: { children: ReactNode; inert?: boolean; away?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const hidden = useBar((state) => state.hidden);
  useLayoutEffect(() => watchLayerHeight(box.current!, useBar.getState().setHeight), []);
  return <div ref={box} data-bar={hidden ? "hidden" : "shown"} inert={inert || hidden}
    className={cn("fixed inset-x-0 top-0 z-(--layer-bar) bg-bg transition-transform duration-(--motion-base) ease-(--bar-ease) motion-reduce:transition-none",
      hidden && "-translate-y-full", away && AWAY)}>{children}</div>;
}

/** The room a list under the bar keeps at its top, as tall as the bar. */
export function BarRoom() {
  return <div aria-hidden="true" className="h-(--bar-h) flex-none" />;
}
