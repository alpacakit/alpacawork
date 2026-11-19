import { useLayoutEffect, useRef } from "react";
import { isComposingKey } from "@/components/ui/composing";
import { markKeyboardInput } from "@/state/input-mode";
import { useSurfaceDocument } from "./surface";

/**
 * Escape has one listener per document (the app's, and a picture-in-picture window's while it is open); open surfaces
 * only register their close action, and a key closes the top surface of the document it was pressed in.
 */
export const ESCAPE_LAYER = {
  // A toast the focus is in (components/ui/toaster.tsx): the person is there, over whatever is open.
  toast: 110,
  image: 100,
  input: 90,
  popup: 80,
  dialog: 80,
  // Under task cards and dialogs, as it is drawn (--layer-coordinator).
  coordinator: 65,
} as const;

type Layer = { priority: number; at: Document; order: number; close: (event: KeyboardEvent) => boolean | void };
const layers = new Map<symbol, Layer>();
// Of surfaces at one priority, the one opened last is over the others: it closes first.
let opened = 0;

export function useEscapeLayer(open: boolean, priority: number, close: (event: KeyboardEvent) => boolean | void) {
  const latest = useRef(close);
  latest.current = close;
  const at = useSurfaceDocument();
  // Register and release with the DOM commit: a card is already reachable by
  // keyboard before passive effects run, and Esc must see the same top surface.
  useLayoutEffect(() => {
    if (!open) return;
    listen(at);
    const key = Symbol("escape layer");
    layers.set(key, { priority, at, order: ++opened, close: (event) => latest.current(event) });
    return () => { layers.delete(key); };
  }, [open, priority, at]);
}

/** Whether a surface over `priority` is open in `at` now (Esc, or a press outside, would close that one first). */
export function escapeLayerOver(priority: number, at: Document) {
  for (const layer of layers.values()) if (layer.at === at && layer.priority > priority) return true;
  return false;
}

function closeTopEscape(event: KeyboardEvent, at: Document): boolean {
  const ordered = [...layers.values()].filter(layer => layer.at === at).sort((a, b) => b.priority - a.priority || b.order - a.order);
  for (const layer of ordered) if (layer.close(event) !== false) return true;
  return false;
}

// The only Escape listener of each document. Registration works for the whole screen and for
// a surface tested on its own, without a second Radix or component key handler.
const listening = new WeakSet<Document>();
function listen(at: Document) {
  if (listening.has(at)) return;
  listening.add(at);
  at.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (isComposingKey(event)) { event.stopImmediatePropagation(); return; }
    if (closeTopEscape(event, at)) {
      markKeyboardInput();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
if (typeof document !== "undefined") listen(document);
