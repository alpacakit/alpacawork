import { guardPinchZoom } from "@/lib/pinch-zoom";
import { followInput } from "@/state/input-mode";

type DocumentPip = { requestWindow(options?: { width?: number; height?: number }): Promise<Window> };

/**
 * The browser's picture-in-picture windows for a page (Document Picture-in-Picture): Chrome and Edge on a computer,
 * on https or localhost. Safari, Firefox and phones have none, and then there is nothing to move into one.
 */
export function documentPip(): DocumentPip | null {
  return typeof window === "undefined" ? null : (window as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture ?? null;
}

/**
 * Opens a picture-in-picture window `size` big (only right after a press), dressed as the app: its styles, and its
 * root's attributes (the theme, the language, keys or a pointer in use) kept the same while it is open. What is drawn
 * in it is the caller's; it closes with the app's window, or by its own close.
 */
export async function openPipWindow(size: { width: number; height: number }, title: string): Promise<Window> {
  const pip = await documentPip()!.requestWindow(size);
  const to = pip.document;
  to.title = title;
  // A computer's window, however narrow: the `narrow` sizes are a phone's (styles.css).
  to.body.dataset.surface = "pip";
  for (const sheet of document.styleSheets) to.head.append(copySheet(sheet, to));
  const root = document.documentElement, own = to.documentElement;
  const follow = () => {
    for (const { name } of [...own.attributes]) if (!root.hasAttribute(name)) own.removeAttribute(name);
    for (const { name, value } of root.attributes) own.setAttribute(name, value);
  };
  follow();
  const observer = new MutationObserver(follow);
  observer.observe(root, { attributes: true });
  const unfollow = followInput(to);
  const unguard = guardPinchZoom(pip);
  pip.addEventListener("pagehide", () => { observer.disconnect(); unfollow(); unguard(); }, { once: true });
  return pip;
}

/** The app's rules as they are now (a sheet of this origin), or a link to the sheet's file. */
function copySheet(sheet: CSSStyleSheet, to: Document): HTMLElement {
  try {
    const style = to.createElement("style");
    style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join("\n");
    if (sheet.media.mediaText) style.media = sheet.media.mediaText;
    return style;
  } catch {
    const link = to.createElement("link");
    link.rel = "stylesheet";
    link.href = sheet.href ?? "";
    return link;
  }
}
