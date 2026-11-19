
import type { Page } from "@playwright/test";
import { readOnlyTest, test, expect, open, settleMotion } from "./fixtures.ts";
import { projectRows } from './fixture/list-rows.ts';
import { patchTask } from './fixture/task-state.ts';
import type { Runtime } from "./server.ts";
import { seedTimelineScroll, seedDenseTimelineScroll, timelineInSmallPages } from "./fixture/timeline-scroll.ts";
/** An attached tree still has a zero-width clock until its axis response is drawn. */
const waitForAxis = async (page: Page, sample?: (width: number) => void) => {
  await expect.poll(async () => {
    const width = await page.locator("[data-time-clock]").evaluate(clock => clock.getBoundingClientRect().width);
    sample?.(width);
    return width;
  }).toBeGreaterThan(0);
};
/** Axis callers need a drawn clock, beyond open()'s attached list (also used without strips). */
const openAxis = async (page: Page, runtime: Runtime, search: string, sample?: (width: number) => void) => {
  await open(page, runtime, search);
  await waitForAxis(page, sample);
};

// Retry and saved-axis input share their first live read and one owned, writable fixture.
const scrollTest = test.extend({
  isolated: true,
  runtimePrepare: async ({}, use) => { await use(root => { seedTimelineScroll(root); projectRows(root, ['T114']); }); },
});

for (const acquired of [true]) scrollTest(`timeline page failure is explicit and Retry recovers ${acquired ? 'acquired' : 'cold'} coverage, then saved native input and equal first live preserve ordinary tint`, async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const w = window as any;
    w.drawMotions = []; w.indexMessages = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
      const animation = animate.apply(this, args);
      const frames = args[0] as Keyframe[];
      w.drawMotions.push({ id: animation.id, row: this.closest('[data-row]')?.getAttribute('data-row'), tint: Array.isArray(frames) && frames.some(frame => 'backgroundColor' in frame) });
      return animation;
    };
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (!String(args[0]).includes('/api/events') || !response.body) return response;
      let pending = ''; const decoder = new TextDecoder();
      const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = pending.indexOf('\n\n')) >= 0) { const message = pending.slice(0, at); pending = pending.slice(at + 2); if (/event: (index|delta)/.test(message)) w.indexMessages++; }
        controller.enqueue(chunk);
      } }));
      return new Response(body, { status: response.status, headers: response.headers });
    };
  });
  let failing = !acquired, failures = 0;
  await page.route('**/api/task/timeline?**', async route => {
    if (failing && new URL(route.request().url()).searchParams.has('after') &&
      !await page.evaluate(() => (window as any).timelineRetried === true)) {
      failures++;
      return route.fulfill({ status: 503, json: { error: { code: 'unavailable', retry: 'later', message: 'Timeline continuation unavailable' } } });
    }
    await route.continue();
  });
  await timelineInSmallPages(page);
  await openAxis(page, runtime, '?agent=1&task=T2063&zoom=21600000');
  if (await page.locator('[data-group-more=review] button').getAttribute('aria-expanded') !== 'true')
    await page.locator('[data-group-more=review] button').click();
  await settleMotion(page);
  await page.locator('[data-time-tree]').evaluate(el => { el.scrollTop = 0; });
  if (acquired) {
    await expect(page.locator('[data-row=T2063] [data-mark]')).toHaveCount(1);
    failing = true;
    const box = (await page.locator('[data-time-tree]').boundingBox())!;
    await page.mouse.move(box.x + 420, box.y + 300);
    await page.mouse.wheel(0, 65);
  }
  const failure = page.locator('[data-timeline-read] [data-read-failure]');
  await expect(failure).toBeVisible();
  await expect(failure).toBeInViewport();
  expect(failures).toBeGreaterThan(0);
  if (acquired) await expect(page.locator('[data-row=T2063] [data-mark]')).toHaveCount(1);
  // Keep the refusal until the actual Retry press; a background read must not remove its button first.
  await page.evaluate(() => document.addEventListener('click', event => {
    if ((event.target as Element).closest('[data-timeline-read] [data-read-failure] button')) (window as any).timelineRetried = true;
  }, { capture: true }));
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(failure).toHaveCount(0);
  failing = false;
  await expect(page.locator('[data-row=T2063] [data-mark]')).toHaveCount(1);
  await page.locator('aside[data-reader-mode]').getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('combobox', { name: 'Time span' }).selectOption('1800000');
  await expect.poll(() => page.locator('[data-time-tree]').evaluate(e => e.scrollWidth - e.clientWidth)).toBeGreaterThan(400);
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const request = indexedDB.open('alpacawork-read-checkpoint');
    request.onsuccess = () => { const db = request.result; const slots = db.transaction('slots').objectStore('slots').getAll(); slots.onsuccess = () => { db.close(); resolve(slots.result.some(slot => slot.key[0] === 'task-timeline' && slot.key[2] === 'axis')); }; };
    request.onerror = () => resolve(false);
  }))).toBe(true);
  await page.goto('about:blank');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/events*', async route => { await gate; await route.continue(); });
  try {
    await page.goto(`${runtime.origin}/?agent=1&zoom=1200000`);
    await expect(page.locator('[data-row=T2063]')).toBeVisible();
    await expect.poll(() => page.locator('[data-time-tree]').evaluate(e => e.scrollLeft)).toBeGreaterThan(400);
    await expect(page.locator('[data-row=T114] [data-edge]')).toBeAttached();
    // Wait past the existing scroll-rest interval: startup's own scroll must not create a glide.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).drawMotions.filter((m: any) => m.id === 'edge-glide'))).toEqual([]);
    const tree = page.locator('[data-time-tree]'), box = (await tree.boundingBox())!;
    const x = box.x + 500, y = box.y + 90;
    await page.mouse.move(x, y);
    const before = await tree.evaluate(e => e.scrollLeft);
    await page.mouse.wheel(-220, 0);
    await expect.poll(() => tree.evaluate(e => e.scrollLeft)).toBeLessThan(before - 50);
    await expect.poll(() => page.evaluate(() => (window as any).drawMotions.filter((m: any) => m.id === 'edge-glide').length)).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).drawMotions = []; });
    // The first live arrives under a held pointer; source rebasing cannot take over that gesture.
    await page.mouse.down(); await page.mouse.move(x + 80, y, { steps: 8 });
    release();
    await expect.poll(() => page.evaluate(() => (window as any).indexMessages)).toBeGreaterThan(0);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).drawMotions.filter((m: any) => m.id === 'edge-glide').length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).drawMotions.filter((m: any) => m.tint))).toEqual([]);
    await page.evaluate(() => { (window as any).drawMotions = []; });
    patchTask(runtime.root, 'T2063', { values: { notes: 'An ordinary change after an equal first live.' } });
    await expect.poll(() => page.evaluate(() => (window as any).drawMotions.filter((m: any) => m.tint && m.row === 'T2063').length)).toBeGreaterThan(0);
  } finally { release(); }
});

readOnlyTest(seedDenseTimelineScroll)('turning Time off while the first page is pending does not acquire later pages', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  let paged = false, continuations = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/task/timeline?**', async route => {
    if (new URL(route.request().url()).searchParams.has('after')) { continuations++; return route.continue(); }
    const response = await route.fetch();
    if ((await response.json()).nextAfter) paged = true;
    await gate; await route.fulfill({ response });
  });
  await timelineInSmallPages(page);
  try {
    await open(page, runtime, '?agent=1&task=T2063&strip=on&zoom=21600000');
    await page.locator('[data-reader-frame-buttons] button').last().click();
    await expect.poll(() => paged).toBe(true);
    const time = page.locator('header [data-strips]');
    await expect(time).toHaveAttribute('aria-pressed', 'true');
    await time.click();
    await expect(time).toHaveAttribute('aria-pressed', 'false');
    release(); await page.waitForTimeout(350);
    expect(continuations).toBe(0);
  } finally { release(); }
});
