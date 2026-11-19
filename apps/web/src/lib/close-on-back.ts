import { useEffect, useRef } from "react";
import { useNarrow } from "@/state/view-store";
import { onPersonMove } from "./history";

/**
 * What is open for a moment only (a menu, a dialog, the coordinator's card, a picture shown from a draft) is not in the
 * URL: a person's Back closes it with the page's step, the page's own move does not (`onPersonMove`, lib/history.ts;
 * `closeSurface` in state/history-step.ts has the surfaces the URL holds).
 */
export function useCloseOnBack(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    return onPersonMove(() => latest.current());
  }, [open]);
}

/** On a phone, what is open for a moment closes with Back; on a wide screen Back leaves it open. */
export function useCloseOnPhoneBack(open: boolean, close: () => void) {
  useCloseOnBack(useNarrow() && open, close);
}
