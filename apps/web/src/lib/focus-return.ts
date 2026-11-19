/**
 * Where the focus goes back to when a surface (a popup, a sheet, a dialog) closes: what had it when the surface
 * opened. Opened from inside another surface that goes away on the way (a menu's item opens a form and the menu
 * closes), it goes back to what opened that surface instead, however many surfaces deep: one rule for every surface.
 * Each surface keeps the whole chain it was opened from, so a surface that has gone leaves its openers behind.
 */
const openers = new WeakMap<Element, readonly Element[]>();
// Per document (the app's, a picture-in-picture window's): the chain of the last element to take the focus, read
// while it was on the page. A press that opens a surface may take that element away before the surface reads the
// focus (a menu's item, gone with its menu): the surface uses this chain then.
const lastChains = new WeakMap<Document, readonly Element[]>();
const watched = new WeakSet<Document>();
function watch(at: Document) {
  if (watched.has(at)) return;
  watched.add(at);
  at.addEventListener("focusin", (event) => { lastChains.set(at, chainFrom(event.target as Element)); }, true);
}
if (typeof document !== "undefined") watch(document);

/** Records the chain a surface drawn in `root` was opened from, for what is opened from inside it. */
export function rememberOpener(root: Element | null, chain: readonly Element[]) {
  if (!root) return;
  openers.set(root, chain);
  watch(root.ownerDocument);
}

/** Read as a surface opens: the element with the focus, then the openers of the surfaces it stands in. */
export function openerChain(active: Element | null): Element[] {
  if (!active) return [];
  const at = active.ownerDocument;
  watch(at);
  return active !== at.body ? chainFrom(active) : [...(lastChains.get(at) ?? [])];
}

function chainFrom(active: Element): Element[] {
  let root = active.parentElement;
  while (root && !openers.has(root)) root = root.parentElement;
  return [active, ...(root ? openers.get(root)! : []).filter((element) => element !== active)];
}

/** Under a modal that is still open: the modal hides the rest of the page from reading (aria-hidden, set by Radix). */
const covered = (element: Element) => element.closest('[aria-hidden="true"]') !== null;

/**
 * As a surface closes: unless something else has the focus in its document, the first of its openers that is still
 * on the page and takes the focus (not disabled, not hidden, not under a modal still open) gets it. When none is left
 * and a modal is still open (the opener went away inside it), that modal's title takes the focus, as when it opened.
 * Which modal is open is told by what covers what, not by the order of the page.
 */
export function giveFocusBack(chain: readonly Element[]) {
  const at = chain[0]?.ownerDocument;
  if (!at || (at.activeElement && at.activeElement !== at.body)) return;
  for (const element of chain) {
    if (!element.isConnected || !("focus" in element) || covered(element)) continue;
    (element as HTMLElement).focus({ preventScroll: true });
    if (element.ownerDocument.activeElement === element) return;
  }
  const open = [...at.querySelectorAll('[data-slot="dialog-content"]')].find((content) => !covered(content));
  open?.querySelector<HTMLElement>('[data-slot="dialog-title"]')?.focus({ preventScroll: true });
}
