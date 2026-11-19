import { useEffect, type RefObject } from "react";

/** Each reading column's way to hold the row a person pressed (keepPressedRow), while its position is owned here. */
const pressedIn = new WeakMap<HTMLElement, (row: HTMLElement) => void>();

/**
 * A History row a person pressed opens where it was pressed: only one report card stands open, so the press can
 * close one above it, and the row itself changes its head; the reading position holds that row, not the first one in view.
 */
export function keepPressedRow(row: HTMLElement): void {
  const area = row.closest<HTMLElement>("[data-reader-content]");
  if (area) pressedIn.get(area)?.(row);
}

/**
 * The reader's report position, scoped to its one scrollport and one task. Browser anchoring is off on the canvas;
 * retain a report instead of an absolute scrollTop when records arrive above it or a disclosure moves it: the row the
 * person last pressed, until they move the column themselves, otherwise the first visible report. Where the column's
 * end is too near to keep it (the oldest rows), room is lent under the end and taken back once it is out of view.
 * Explicit Back restoration remains the owner until it finishes. At the top a new report is allowed to appear normally.
 */
export function useReaderReportPosition(content: RefObject<HTMLElement | null>, place: string | null,
  placing: RefObject<string | null>, rebaseDirection: () => void) {
  useEffect(() => {
    const area = content.current;
    if (!area || !place) return;
    let anchor: { row: HTMLElement; offset: number } | null = null;
    let pressed: HTMLElement | null = null;
    let rememberedTop = area.scrollTop;
    // Room lent under the column's end, over its own bottom padding.
    let lent = 0;
    const padding = getComputedStyle(area).paddingBottom;
    const lend = (px: number) => {
      lent = Math.max(0, Math.ceil(px));
      if (lent > 0) area.style.paddingBottom = `calc(${padding} + ${lent}px)`;
      else area.style.removeProperty("padding-bottom");
    };
    // Taken back as far as it is out of view: what is below the screen can shrink without moving what is on it.
    const takeBack = () => { if (lent > 0) lend(area.scrollTop + area.clientHeight - (area.scrollHeight - lent)); };
    // Layout offsets ignore the report list's transition transforms.
    const layoutTop = (element: HTMLElement) => {
      let top = 0;
      for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
      return top;
    };
    const topIn = (row: HTMLElement) => layoutTop(row) - layoutTop(area);
    const remember = () => {
      rememberedTop = area.scrollTop;
      anchor = null; pressed = null;
      takeBack();
      if (placing.current || area.scrollTop <= 0) return;
      for (const row of area.querySelectorAll<HTMLElement>("[data-report-feed] li[data-report-key]")) {
        const top = topIn(row);
        if (top + row.offsetHeight > area.scrollTop) { anchor = { row, offset: top - area.scrollTop }; break; }
      }
    };
    // The column's end pulled up under a pressed row (the browser keeps scrollTop within the content): no one moved it.
    const clamped = () => !!pressed && area.scrollTop < rememberedTop && area.scrollTop >= area.scrollHeight - area.clientHeight - 1;
    // A scroll that is its own compensation echoing back, or that clamp, keeps the row it holds; any other is a move.
    const scrolled = () => { if (area.scrollTop !== rememberedTop && !clamped()) remember(); };
    const settle = () => {
      if (placing.current) { anchor = null; pressed = null; return; }
      // An explicit jump can set scrollTop before its scroll event arrives. It has priority over this old anchor.
      if (area.scrollTop !== rememberedTop && !clamped()) { remember(); return; }
      if (!anchor || !area.contains(anchor.row) || area.scrollTop <= 0 && !pressed) { remember(); return; }
      const shift = topIn(anchor.row) - area.scrollTop - anchor.offset;
      if (Math.abs(shift) >= 1 || area.scrollTop !== rememberedTop) {
        const want = Math.max(0, area.scrollTop + shift);
        const short = want - (area.scrollHeight - area.clientHeight);
        if (short > 0) lend(lent + short);
        area.scrollTop = want;
        rememberedTop = area.scrollTop;
        // This is layout compensation, not a person's reading movement that hides the phone's header.
        rebaseDirection();
      }
    };
    pressedIn.set(area, row => {
      if (placing.current || !area.contains(row)) return;
      pressed = row;
      rememberedTop = area.scrollTop;
      anchor = { row, offset: topIn(row) - area.scrollTop };
      // Where nothing moves (reduced motion), no transition ends: the press has settled by its second frame.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (pressed === row && !disclosing()) letGo(); }));
    });
    // Title/reason changes above the feed and folding within it both move the report. Only this reader's
    // reading layout is observed; transform animations deliberately do not establish new layout positions.
    const sizes = new ResizeObserver(settle);
    const watched = new Set<Element>();
    const watchLayout = () => {
      const next = new Set<Element>([...area.children, ...area.querySelectorAll("[data-report-feed]")]);
      for (const node of watched) if (!next.has(node)) { sizes.unobserve(node); watched.delete(node); }
      for (const node of next) if (!watched.has(node)) { sizes.observe(node); watched.add(node); }
    };
    const disclosing = () => (area.getAnimations?.({ subtree: true }) ?? []).some(each => each.playState === "running" && each.effect instanceof KeyframeEffect
      && each.effect.target instanceof Element && !!each.effect.target.closest("[data-disclosure-body]"));
    const letGo = () => { settle(); pressed = null; if (area.scrollTop <= 0) anchor = null; };
    // A card closing above while the pressed one opens below can leave the column's height as it was: each moving
    // disclosure is observed itself while it moves, so the report is held on every frame, after its layout.
    const unfolding = (event: Event) => { if (event.target instanceof Element && event.target.matches("[data-disclosure-body]")) sizes.observe(event.target); };
    // Once the press's own disclosures have settled, the pressed row is held no longer than any other: what comes after
    // (a new report at the top) is placed as it was before the press.
    const unfolded = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.matches("[data-disclosure-body]")) return;
      if (!watched.has(event.target)) sizes.unobserve(event.target);
      if (pressed && !disclosing()) letGo();
    };
    area.addEventListener("transitionrun", unfolding);
    area.addEventListener("transitionend", unfolded);
    area.addEventListener("transitioncancel", unfolded);
    const mutations = new MutationObserver(() => { watchLayout(); settle(); });
    mutations.observe(area, { childList: true, subtree: true });
    watchLayout();
    area.addEventListener("scroll", scrolled, { passive: true });
    remember();
    return () => {
      mutations.disconnect(); sizes.disconnect(); area.removeEventListener("scroll", scrolled);
      for (const type of ["transitionrun", "transitionend", "transitioncancel"] as const) area.removeEventListener(type, type === "transitionrun" ? unfolding : unfolded);
      pressedIn.delete(area); lend(0);
    };
  }, [content, place, placing, rebaseDirection]);
}
