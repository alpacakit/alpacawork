import { useEffect, useState } from "react";
import { recordFailure } from "@/lib/notify";
import type { CodeFile, DiffColours, StructuredDiffDocument } from "./diff-types";

/**
 * Colours already painted, by what they paint (a file's path, which names its language, and its text): a diff or a file
 * opened again is drawn in its colours from its first frame, not plain first. The last KEPT texts are kept.
 */
const painted = new Map<string, DiffColours>();
const KEPT = 64;
const keyOf = (diff: StructuredDiffDocument | CodeFile) => `${diff.kind === "file" ? diff.path : ""}\n${diff.text}`;
/** Forgets every colour painted (a test starting clean). */
export const forgetPaintedColours = () => painted.clear();
function keep(key: string, colours: DiffColours) {
  painted.delete(key);
  painted.set(key, colours);
  if (painted.size > KEPT) painted.delete(painted.keys().next().value!);
}

/**
 * A diff's letters' colours, or a whole file's: asked once its frame is seen (in the window it is drawn in), or at once
 * when `now` (a page opened to be read is seen), loading what paints them (the runtime, its Worker and grammars) then.
 * Null until they come, and for a text it cannot paint.
 */
export function useDiffColours(diff: StructuredDiffDocument | CodeFile, frame: HTMLElement | null, now = false): DiffColours | null {
  const key = keyOf(diff);
  const [, painting] = useState(0);
  useEffect(() => {
    if (painted.has(key)) return;
    const abort = new AbortController();
    const ask = () => void import("./diff-runtime").then(({ highlightDiff }) => highlightDiff(diff, abort.signal)).then(
      colours => { if (colours && !abort.signal.aborted) { keep(key, colours); painting(count => count + 1); } },
      // The runtime answers what it cannot paint with null; a rejection is a fault (its module did not load, a bug).
      error => { if (!abort.signal.aborted) recordFailure(error, "diff colours"); });
    if (now) { ask(); return () => abort.abort(); }
    // Seen in the window it is drawn in (the coordinator's own window has its own).
    const Seen = frame?.ownerDocument.defaultView?.IntersectionObserver;
    if (!frame || !Seen) return;
    const seen = new Seen(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      seen.disconnect();
      ask();
    });
    seen.observe(frame);
    return () => { seen.disconnect(); abort.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is what `diff` paints
  }, [key, frame, now]);
  return painted.get(key) ?? null;
}

/** How long lines opened to be read wait unseen for their colours before they are shown plain. */
const WAIT_MS = 300;

/**
 * Whether lines opened to be read are shown yet: at once when their colours are there, else once they come or WAIT_MS
 * has passed, so a page opened is drawn in its colours in one go rather than plain and then coloured.
 */
export function useColoursSettled(colours: DiffColours | null): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (colours || waited) return;
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, [colours, waited]);
  return !!colours || waited;
}
