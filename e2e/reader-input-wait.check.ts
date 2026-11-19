/** An input ending inside the open reader begins nothing; what the person chose since keeps the keyboard. */
import { test, expect, open, openCoordinator, settleMotion } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
test.use({ isolated: true });
const frames = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const composer = (page: Page) => page.locator('[aria-label="Message the coordinator"]');
const inputForm = (page: Page) => page.locator('[data-inline-form]');
const size = async (page: Page, width: number) => { await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); };
const watchBlurs = (page: Page) => page.addInitScript(() => {
  const blurs: unknown[] = []; const native = HTMLElement.prototype.blur;
  (window as any).openingBlurs = blurs;
  HTMLElement.prototype.blur = function (this: HTMLElement) {
    blurs.push({ at: performance.now(), tag: this.tagName, label: this.getAttribute('aria-label'), stack: new Error().stack });
    native.call(this);
  };
});
const focusFacts = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement;
  return { tag: active.tagName, label: active.getAttribute('aria-label'), title: active.hasAttribute('data-reader-title'), forms: document.querySelectorAll('[data-inline-form]').length,
    text: document.querySelector('[aria-label="Message the coordinator"]')?.textContent ?? null, blurs: (window as any).openingBlurs };
});
const openReaderForm = async (page: Page, runtime: Parameters<typeof open>[1]) => {
  await open(page, runtime, '?agent=1&task=T11'); await expect(page.locator('aside[data-reader-mode]')).toBeVisible(); await settleMotion(page);
};

for (const [width, after] of [[1440, 'settled']] as const)
  test(`UI-M3 Tab into the conversation, Escape closes the form, the next words land, ${after}, ${width}px reduced`, async ({ page, runtime }, info) => {
    await size(page, width); await watchBlurs(page); await openReaderForm(page, runtime);
    await openCoordinator(page); await settleMotion(page);
    await page.locator('[data-read="T11"]').press('m');
    await expect(inputForm(page).locator('select')).toBeFocused();
    let presses = 0;
    while (presses < 40 && !await composer(page).evaluate(el => el === document.activeElement)) { await page.keyboard.press('Tab'); presses++; }
    await expect(composer(page)).toBeFocused();
    await expect(inputForm(page)).toHaveCount(1);
    await page.keyboard.type('ab', { delay: 30 });
    await expect(composer(page)).toHaveText('ab');
    const reached = await focusFacts(page);
    await page.keyboard.press('Escape');
    if (after === 'settled') { await expect(inputForm(page)).toHaveCount(0); await frames(page); }
    const closed = await focusFacts(page);
    await page.keyboard.type('zq', { delay: 30 });
    await frames(page);
    const last = await focusFacts(page);
    await page.screenshot({ path: info.outputPath('composer-after-escape.png') });
    writeFileSync(info.outputPath('composer-after-escape.json'), JSON.stringify({ width, after, presses, reached, closed, last }, null, 2));
    expect.soft(last.forms).toBe(0);
    expect.soft(last.label).toBe('Message the coordinator');
    expect.soft(last.text).toBe('abzq');
    if (after === 'settled') expect.soft(closed.label).toBe('Message the coordinator');
  });


