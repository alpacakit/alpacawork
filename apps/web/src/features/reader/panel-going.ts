import { useEffect, type RefObject } from "react";
import { leave } from "@/lib/motion";
import { useViewStore } from "@/state/view-store";

type ViewState = ReturnType<typeof useViewStore.getState>;

/**
 * A panel closed by the view store (its ×, Escape, Back or a swipe alike: `gone` says when, from the state before and
 * now) goes the way it came (lib/motion.ts leave), seen as the store turns, before React takes it off the page.
 */
export function usePanelGoing(panel: RefObject<HTMLElement | null>, gone: ((now: ViewState, before: ViewState) => boolean) | null,
  to: Parameters<typeof leave>[1], deps: readonly unknown[]) {
  useEffect(() => gone ? useViewStore.subscribe((now, before) => { if (gone(now, before)) leave(panel.current, to); }) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `gone` and `to` are read from what `deps` name
    deps);
}
