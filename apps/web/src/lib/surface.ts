import { createContext, useContext } from "react";

/**
 * The document a part of the screen is drawn in. Almost everything is drawn in the app's own window; the coordinator's
 * conversation can be moved into a picture-in-picture window of its own, and what it holds (the Escape key, a picture
 * opened over it, a file dropped on it) belongs to that window there. Null: the app's own document.
 */
export const SurfaceDocument = createContext<Document | null>(null);

export function useSurfaceDocument(): Document {
  return useContext(SurfaceDocument) ?? document;
}

/**
 * Watches sizes in the window `node` is drawn in. A window's observer is told of sizes only while that window draws, so
 * one from the app's window watching the picture-in-picture window hears its changes late and in bursts.
 * What can move between windows makes a new one when it does.
 */
export function sizeObserver(node: Node, changed: ResizeObserverCallback): ResizeObserver {
  return new (node.ownerDocument?.defaultView ?? window).ResizeObserver(changed);
}
