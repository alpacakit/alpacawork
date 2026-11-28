import { stylesheet } from "./stylesheet";

if (typeof window !== "undefined") {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver = class {
    root = null; rootMargin = "0px"; thresholds = [0];
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // jsdom has no pointer capture. Model one owner per pointer; native delivery/transfer is checked in browser e2e.
  const captures = new Map<number, Element>();
  Element.prototype.setPointerCapture = function (id) { captures.set(id, this); };
  Element.prototype.hasPointerCapture = function (id) { return captures.get(id) === this; };
  Element.prototype.releasePointerCapture = function (id) {
    if (!this.hasPointerCapture(id)) return;
    captures.delete(id);
    const lost = new Event("lostpointercapture", { bubbles: true });
    Object.assign(lost, { pointerId: id });
    this.dispatchEvent(lost);
  };
  beforeEach(() => captures.clear());
  HTMLElement.prototype.scrollTo = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  // jsdom has no Web Animations API; motion itself is checked in browser e2e. An animation ends at once (the
  // answered card's flight awaits its end).
  // Ended, it says so as a browser's does: `onfinish` runs (unless it was cancelled first) and no element holds it.
  Element.prototype.animate = () => {
    let cancelled = false;
    const animation = { finished: Promise.resolve(), playState: "finished", cancel() { cancelled = true; }, pause() {}, play() {},
      onfinish: null as ((event: Event) => void) | null };
    queueMicrotask(() => { if (!cancelled) animation.onfinish?.(new Event("finish")); });
    return animation as unknown as Animation;
  };
  Element.prototype.getAnimations = () => [];
  // The motion steps and curves and the window's margin are styles.css's, which jsdom does not load: the
  // page's root gets them as the browser would (the first declaration of each, not the reduced-motion one).
  for (const [, name, value] of stylesheet.matchAll(/(--(?:motion|ease)-[a-z-]+|--spacing-window):\s*([^;]+);/g))
    if (!document.documentElement.style.getPropertyValue(name!)) document.documentElement.style.setProperty(name!, value!.trim());
  globalThis.CSS ??= { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`) } as typeof CSS;
}

// A browser tab owns retained drafts. Each test starts with a fresh tab.
import { beforeEach } from "vitest";
beforeEach(async () => {
  // Imported here, after the browser stubs above: the stores they reach read the screen's media queries and URL as they load.
  const [{ useDraftStore }, { useWriteIntentStore }] = await Promise.all([import("../src/features/forms/draft-store"), import("../src/data/write-intent")]);
  const { useReaderSend } = await import("../src/features/coordinator/reader-send");
  const { useSitting } = await import("../src/features/reader/next-question");
  useReaderSend.setState({ receipts: new Map(), sendDraft: null, action: null, post: null });
  useSitting.setState({ departures: {}, outcomeKey: "", sent: null, emptied: null });
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
  // The home list's open sections are kept on the device; each test starts as a new device does.
  (await import("../src/features/tree/section-fold")).sectionsOpen.remove();
  useDraftStore.setState({ entries: {}, unavailable: false });
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  const { reloadedWrites, reloadedWaiting } = await import('../src/data/write-intent');
  reloadedWrites.clear(); reloadedWaiting.clear();
  const { restoredDraftKeys } = await import('../src/features/forms/draft-store');
  restoredDraftKeys.clear();
  const { useUndoOffers } = await import('../src/data/undo-offers');
  useUndoOffers.setState({ offers: [] });
  if (typeof window !== 'undefined') window.__ALPACAWORK_WRITE_GRACE_MS__ = 0;
});

if (typeof window !== 'undefined') window.__ALPACAWORK_WRITE_GRACE_MS__ = 0;
