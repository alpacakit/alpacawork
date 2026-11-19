import { onlineManager } from "@tanstack/react-query";
import { create } from "zustand";
import { useConnection } from "./connection";
import type { Connection } from "./feed";

/**
 * How long a loss lasts before it is shown. The feed's first retry waits a second and a resumed stream is live once
 * open, so a blip is over within it and draws nothing.
 */
export const OFFLINE_SHOWN_AFTER_MS = 2000;
export const subscribeOnline = (changed: () => void) => onlineManager.subscribe(changed);
export const browserOnline = () => onlineManager.isOnline();
/**
 * Out of reach is a try that failed (or the feed that stopped, or a browser that says it is offline), not a
 * subscription still opening. A new subscription is `connecting` with no failure while its whole index is on its way
 * (1 to 7 seconds measured), whatever opened it: the page opening, a pull to refresh, a return to the page. That is the
 * progress line's loading, never offline. `useConnection.offline` (no proven reachability) still holds back reads and
 * writes meanwhile; this is only what the screen says.
 */
export const outOfReach = ({ state, failures }: Pick<Connection, "state" | "failures">, online: boolean) =>
  state !== "live" && (!online || state === "stopped" || failures > 0);

/**
 * Whether the screen says it is out of reach: out of reach for longer than `OFFLINE_SHOWN_AFTER_MS`. One fact with one
 * timer for the whole screen, so what is drawn later (a section opened, a row scrolled in, a reader opened) says the same
 * at once instead of counting its own grace.
 */
const useShown = create<{ shown: boolean }>(() => ({ shown: false }));
let timer: ReturnType<typeof setTimeout> | undefined;
let out = false;
function follow() {
  // A hidden page's failed stream is not evidence about the next foreground visit.
  // The feed starts a new check on return; hidden time never earns display grace.
  const now = document.visibilityState !== "hidden" && outOfReach(useConnection.getState(), browserOnline());
  if (now === out) return;
  out = now;
  clearTimeout(timer);
  if (!now) { useShown.setState({ shown: false }); return; }
  timer = setTimeout(() => useShown.setState({ shown: true }), OFFLINE_SHOWN_AFTER_MS);
}
useConnection.subscribe(follow);
onlineManager.subscribe(follow);
document.addEventListener("visibilitychange", follow);
follow();

/** The one fact every offline look on screen follows. */
export const useOfflineShown = () => useShown((state) => state.shown);
