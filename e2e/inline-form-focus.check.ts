/** Later native keyboard focus cancels the common form's pending opening request. */
import { test, expect, open, settleMotion } from './fixtures.ts';
import { seedTimelineStories, STORY } from './fixture/timeline-story.ts';
import { writeFileSync } from 'node:fs';
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(seedTimelineStories); } });

test('ordinary parent form focuses its select, cancels by keyboard and reopens before Escape', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, runtime, `?task=${STORY.single}&agent=1`); await settleMotion(page);
  const row = page.locator(`[data-read="${STORY.single}"]`), form = page.locator('[data-reader-header] form');
  await row.press('m'); await expect(form.locator('select')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(form.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(form).toHaveCount(0);
  await row.press('m'); await expect(form.locator('select')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
});

for (const width of [1440]) test(`UI-M1 reading lifecycle at ${width}px reduced`, async ({ page, runtime }, info) => {
  await page.addInitScript(() => {
    const turns: unknown[] = []; (window as any).readerFocusTurns = turns;
    for (const name of ['focusin', 'focusout', 'keydown', 'pointerdown', 'mousedown', 'click'])
      document.addEventListener(name, event => turns.push({ at: performance.now(), name, key: (event as KeyboardEvent).key,
        target: (event.target as Element)?.outerHTML?.slice(0, 400), active: document.activeElement?.outerHTML.slice(0, 400), stack: name === 'focusin' ? new Error().stack : undefined }), true);
  });
  try {
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, runtime, '?agent=1');
  const row = page.locator('[data-read="T11"]'), title = page.locator('[data-reader-title="T11"]');
  await row.press('Shift+Enter'); await expect(title).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('aside[data-reader-mode]')).toHaveCount(0);
  await row.click(); await expect(title).toBeFocused();
  writeFileSync(info.outputPath('lifecycle-result.json'), JSON.stringify({ width, readingFocus: true }));
  } finally {
    writeFileSync(info.outputPath('reader-focus-turns.json'), JSON.stringify(await page.evaluate(() => ({ turns: (window as any).readerFocusTurns, active: document.activeElement?.outerHTML.slice(0, 400) })), null, 2));
  }

});
