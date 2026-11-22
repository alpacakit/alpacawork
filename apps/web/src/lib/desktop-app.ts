import { useSyncExternalStore } from "react";
import { hasCoarsePointer, isInstalledApp, subscribeInstalledApp } from "./input-capabilities";

/** Chrome's and Edge's offer to install the page (not in TypeScript's DOM types). */
type InstallPromptEvent = Event & { prompt: () => Promise<unknown>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

/**
 * How this page can become a desktop app here, now:
 * - installed: it already runs in its app's own window.
 * - prompt: the browser has offered to install it (Chrome, Edge), so a button of the page's own can ask; `install`
 *   asks once and says whether it was installed.
 * - menu: Safari on a Mac, which installs only from its menu (File → Add to Dock).
 * - null: no way this page knows of (Firefox, a browser that has not offered, or an offer used up), or a touch screen,
 *   where the page has no Install button of its own and leaves the offer to the browser's own banner.
 */
export type DesktopApp =
  | { kind: "installed" }
  | { kind: "prompt"; install: () => Promise<boolean> }
  | { kind: "menu" }
  | null;

/**
 * Safari on a Mac, version 17 or later (Add to Dock came with it). An iPad asks for the Mac's page too, so a touch
 * screen is not a Mac; every other browser on a Mac names itself beside "Safari".
 */
export const isMacSafari = (agent: string, touchPoints: number) =>
  /Macintosh/.test(agent) && touchPoints === 0 && !/Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|OPR/.test(agent)
    && Number(/Version\/(\d+)[\d.]* Safari\//.exec(agent)?.[1] ?? 0) >= 17;

// The browser offers once, about when the page loads and often before React draws: the offer is kept from the start,
// and given out as long as it can still be used. Asking uses it up; the browser may offer again later.
let offer: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(listener => listener());
const keep = (next: InstallPromptEvent | null) => { offer = next; changed(); };

/** Starts keeping the browser's offer on a computer; called once, as the page starts. */
export function watchDesktopApp(at: Window = window) {
  at.addEventListener("beforeinstallprompt", event => {
    if (hasCoarsePointer(at)) return;
    // The page asks from its own button, so the browser's own way to ask is not shown as well.
    event.preventDefault();
    keep(event as InstallPromptEvent);
  });
  at.addEventListener("appinstalled", () => keep(null));
}

async function install(): Promise<boolean> {
  const asked = offer;
  if (!asked) return false;
  keep(null);
  await asked.prompt();
  return (await asked.userChoice).outcome === "accepted";
}

const PROMPT: DesktopApp = { kind: "prompt", install };
const INSTALLED: DesktopApp = { kind: "installed" };
const MENU: DesktopApp = { kind: "menu" };

export const desktopApp = (): DesktopApp =>
  isInstalledApp() ? INSTALLED
    : offer ? PROMPT
    : !hasCoarsePointer() && isMacSafari(navigator.userAgent, navigator.maxTouchPoints) ? MENU
    : null;

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  const stopInstalled = subscribeInstalledApp(onChange);
  return () => { listeners.delete(onChange); stopInstalled(); };
};
export const useDesktopApp = () => useSyncExternalStore(subscribe, desktopApp);
