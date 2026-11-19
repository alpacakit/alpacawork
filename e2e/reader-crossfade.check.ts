import { projectRows } from './fixture/list-rows.ts';
import type { Page } from "@playwright/test";
import { expect, open, settleMotion, test } from "./fixtures.ts";

test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => { projectRows(root, ['T111', 'T113', 'T114', 'T117', 'T1112']); }); } });

/**
 * The reader open on a task, turned to another (a row pressed), stays where it is and what it showed dissolves into
 * what it shows now: a still copy of it lies over the reader and fades away, while the reader under it is already the
 * other task's, to read and press. Quick presses never make it jump, and no other motion is laid over it.
 */
const reader = (page: Page) => page.locator("aside[data-reader-mode]");
const shown = (page: Page) => reader(page).locator("header [data-reader-task-id]");
const copies = (page: Page) => page.locator("[data-still-copy]");
const row = (page: Page, id: string) => page.locator(`[data-read="${id}"]`);
/** Each copy laid over the reader, and how it is drawn frame by frame until it goes (kept from the first frame on). */
async function watchCopies(page: Page) {
  await page.addInitScript(() => {
    type Seen = { at: number; frames: { t: number; opacity: number }[]; hidden: string | null; inert: boolean; pointer: string; named: boolean; timing: EffectTiming | null };
    const seen: Seen[] = [];
    (window as unknown as { copiesSeen: Seen[] }).copiesSeen = seen;
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.hasAttribute("data-still-copy")) continue;
        const entry: Seen = { at: performance.now(), frames: [], hidden: node.getAttribute("aria-hidden"), inert: node.inert,
          pointer: node.style.pointerEvents, named: node.hasAttribute("data-reader-mode") || node.hasAttribute("aria-label"), timing: null };
        seen.push(entry);
        const look = () => {
          entry.timing ??= node.getAnimations()[0]?.effect?.getTiming() ?? null;
          if (!node.isConnected) return;
          entry.frames.push({ t: performance.now() - entry.at, opacity: Number(getComputedStyle(node).opacity) });
          requestAnimationFrame(look);
        };
        look();
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
type Seen = { frames: { t: number; opacity: number }[]; hidden: string | null; inert: boolean; pointer: string; named: boolean; timing: EffectTiming | null };
const seen = (page: Page) => page.evaluate(() => (window as unknown as { copiesSeen: Seen[] }).copiesSeen);

/**
 * The reader open on `id` over the flat list of the fixture's requested tasks.
 */
async function openOn(page: Page, runtime: Parameters<typeof open>[1], id = "T111") {
  await watchCopies(page);
  await open(page, runtime, `?task=${id}`);
  await expect(shown(page)).toHaveText(id);
  await settleMotion(page);
}

test("quick presses never pile up copies or leave one behind: the reader ends on the last task pressed", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOn(page, runtime);
  for (const id of ["T113", "T114", "T117", "T111", "T113"]) {
    await row(page, id).click();
    await expect(shown(page)).toHaveText(id);
    expect(await copies(page).count()).toBeLessThanOrEqual(2);
  }
  await expect(copies(page)).toHaveCount(0);
  await expect(shown(page)).toHaveText("T113");
  // The row marked as the one shown, the address and the reader agree. The mark is the ring on the row's label;
  // its colour is a design choice that may change, so only the ring itself is read.
  const marked = page.locator("[data-row] [data-row-label].ring-1");
  await expect(marked).toHaveCount(1);
  await expect(marked.locator("[data-read]")).toHaveAttribute("data-read", "T113");
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe("T113");
  // Each press laid one copy over the reader; none was shown again.
  expect((await seen(page)).length).toBe(5);
});

test("a tab chosen dissolves what is read under the title, all of it, and never covers the title or its tabs", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOn(page, runtime);
  const tab = (pane: string) => reader(page).locator(`[data-reader-entry="${pane}"]`);
  const content = reader(page).locator("[data-reader-content]");
  // Read from the top, and a little down (the pane chosen is drawn from its own place, bringing the tabs back down).
  for (const [pane, scrolled] of [["about", 0], ["task", 0], ["about", 0], ["task", 40]] as const) {
    if (scrolled) { await content.evaluate((node, top) => { node.scrollTop = top; }, scrolled); await settleMotion(page); }
    // Pressed and held still on its first frame, so what is drawn is read before it goes.
    await tab(pane).evaluate((node) => { (node as HTMLElement).click(); for (const each of document.getAnimations()) each.pause(); });
    await expect(tab(pane)).toHaveAttribute("aria-current", "page");
    expect(await copies(page).count()).toBeLessThanOrEqual(2);
    const live = await page.evaluate(() => ({ tabs: document.querySelector("aside[data-reader-mode] [data-reader-entries]")!.getBoundingClientRect().bottom,
      bottom: document.querySelector("aside[data-reader-mode] [data-reader-content]")!.getBoundingClientRect().bottom }));
    for (const copy of await copies(page).all()) {
      // What the copy draws: the elements seen in it, each from where its own cut (clip-path inset) lets it start.
      const drawn = await copy.evaluate((node) => {
        const seen = [node, ...node.querySelectorAll<HTMLElement>("*")].filter((each) => getComputedStyle(each).visibility === "visible" && each.getBoundingClientRect().height > 0);
        const cutTop = (each: Element) => {
          for (let at: Element | null = each; at && at !== node.parentElement; at = at.parentElement) {
            const inset = /inset\((\d+(?:\.\d+)?)px/.exec(getComputedStyle(at).clipPath);
            if (inset) return at.getBoundingClientRect().top + Number(inset[1]);
          }
          return -Infinity;
        };
        return { top: Math.min(...seen.map((each) => Math.max(each.getBoundingClientRect().top, cutTop(each)))), bottom: Math.max(...seen.map((each) => each.getBoundingClientRect().bottom)) };
      });
      expect(drawn.top).toBeGreaterThanOrEqual(live.tabs - 1);
      expect(drawn.bottom).toBeGreaterThanOrEqual(live.bottom - 1);
    }
    await page.evaluate(() => { for (const each of document.getAnimations()) each.play(); });
  }
  await expect(copies(page)).toHaveCount(0);
  expect((await seen(page)).length).toBe(4);
});
