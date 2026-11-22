import { useSyncExternalStore } from "react";

/** The primary input is a finger or another coarse pointer, independent of screen width or user agent. */
const COARSE_POINTER_QUERY = "(pointer: coarse)";
export const hasCoarsePointer = (at: Window = window) => at.matchMedia(COARSE_POINTER_QUERY).matches;

const subscribeCoarsePointer = (onChange: () => void) => {
  const query = matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
export const useCoarsePointer = () => useSyncExternalStore(subscribeCoarsePointer, hasCoarsePointer);

/** The primary input can rest on something without pressing it (a mouse), independent of screen width. */
const HOVER_QUERY = "(hover: hover)";
const canHoverNow = () => matchMedia(HOVER_QUERY).matches;
const subscribeHover = (onChange: () => void) => {
  const query = matchMedia(HOVER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
export const useCanHover = () => useSyncExternalStore(subscribeHover, canHoverNow);

/** The page runs in its installed app's own window (no address bar), not in a browser tab. */
const INSTALLED_APP_QUERY = "(display-mode: standalone)";
export const isInstalledApp = () => matchMedia(INSTALLED_APP_QUERY).matches;
export const subscribeInstalledApp = (onChange: () => void) => {
  const query = matchMedia(INSTALLED_APP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
export const useInstalledApp = () => useSyncExternalStore(subscribeInstalledApp, isInstalledApp);
