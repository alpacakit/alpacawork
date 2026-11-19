import { useLayoutEffect, useSyncExternalStore, useState } from "react";
import { usePersonalSettings } from "@/data/personal-settings";
import { urlValue } from "./screen-settings";

/** A visit-only URL override wins over the server preference and the OS. */
type Theme = "light" | "dark";

/** The applied document is authoritative, including a picture-in-picture surface. */
export const appliedTheme = (at: Document): Theme => at.documentElement.dataset.theme === "dark" ? "dark" : "light";
const surfaces = new WeakMap<Document, Set<() => void>>();

/** One subscription per surface for readers of applied theme/CSS tokens, never one observer per image. */
export function subscribeAppliedTheme(at: Document, notify: () => void) {
  let listeners = surfaces.get(at);
  if (!listeners) {
    listeners = new Set();
    surfaces.set(at, listeners);
  }
  // The first subscriber owns the observers; the final unsubscribe disconnects them.
  if (!listeners.size) {
    const publish = () => { for (const listener of listeners!) listener(); };
    const observer = new at.defaultView!.MutationObserver(publish);
    observer.observe(at.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    observer.observe(at.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "media", "disabled"] });
    at.head.addEventListener("load", publish, true);
    const disconnect = () => { observer.disconnect(); at.head.removeEventListener("load", publish, true); };
    disposals.set(at, disconnect);
  }
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (!listeners.size) { disposals.get(at)?.(); disposals.delete(at); surfaces.delete(at); }
  };
}
const disposals = new WeakMap<Document, () => void>();

const system = matchMedia("(prefers-color-scheme: dark)");
const subscribe = (notify: () => void) => {
  system.addEventListener("change", notify);
  return () => system.removeEventListener("change", notify);
};

function useTheme(): Theme {
  const preference = usePersonalSettings((state) => state.values.theme);
  const [manual] = useState<Theme | null>(() => {
    const theme = urlValue("theme");
    return theme === "light" || theme === "dark" ? theme : null;
  });
  const dark = useSyncExternalStore(subscribe, () => system.matches);
  return manual ?? (preference === "light" || preference === "dark" ? preference : dark ? "dark" : "light");
}

/** Keeps the page and browser chrome on the same CSS background. Mounted once, by the shell. */
export function useApplyTheme() {
  const theme = useTheme();
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (background) for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
      meta.content = background;
    document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
      ?.setAttribute("content", theme === "dark" ? "black" : "default");
  }, [theme]);
}
