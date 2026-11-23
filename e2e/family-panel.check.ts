import { test, expect, open, keepShot, settleMotion } from './fixtures.ts';
import type { Page } from '@playwright/test';

// The parent and child tasks under the reader title. The sample's T1142 is a grandchild of T11, the work right
// under project P1 (T11 → T114 → T1142); the family of T11 holds 13 tasks.
const reader = (page: Page) => page.locator('aside[data-reader-mode]:visible');
const entry = (page: Page) => reader(page).locator('[data-family-entry]');
const panel = (page: Page) => page.locator('[data-family-panel]');
const row = (page: Page, id: string) => panel(page).locator(`[data-family-row="${id}"]`);
const shown = async (page: Page, id: string) => {
  await expect(reader(page).locator('[data-reader-task-id]')).toHaveText(id);
  await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(id);
  // The reader's live run marker keeps pulsing through navigation.
  await settleMotion(page, undefined, true);
};

/** The computer's panel stands clear of the reader's window, or, in the reader's own margin, of its reading column. */
const clear = (page: Page) => page.evaluate(() => {
  const surface = document.querySelector('[data-family-surface]')!.getBoundingClientRect();
  const reader = document.querySelector('aside[data-reader-mode]:not([hidden])')!.getBoundingClientRect();
  const column = document.querySelector('aside[data-reader-mode] [data-reading-column]')!.getBoundingClientRect();
  return surface.right <= reader.left || surface.right <= column.left;
});

// A phone's panel is one sheet at every phone width (FamilyPanel's `narrow`); what 320 alone draws is the IDs' row, checked below.
for (const [name, width, height] of [['pc', 1440, 1000]] as const) {
  test.describe(name, () => {
    const narrow = width < 700;
    test.use({ viewport: { width, height }, isMobile: narrow, hasTouch: narrow });

    test('opens the family from a grandchild, picks task after task with the panel staying open, and Back returns', async ({ page, runtime }) => {
      await open(page, runtime, '?task=T1142');
      await shown(page, 'T1142');
      await expect(entry(page)).toHaveAccessibleName("Task tree 13 tasks");
      // Close under the title: the entry starts within a few pixels of the title's last line.
      const gap = await reader(page).evaluate((aside) => {
        const title = aside.querySelector('[data-head-title] h2')!.getBoundingClientRect();
        return aside.querySelector('[data-family-entry]')!.getBoundingClientRect().top - title.bottom;
      });
      expect(gap).toBeLessThan(12);
      await keepShot(page, `family-panel-${name}-1-closed`);

      // Read a little down first, so Back has a position to bring back.
      const content = reader(page).locator('[data-reader-content]');
      await content.evaluate((el) => { el.scrollTop = 24; });
      await entry(page).click();
      await expect(panel(page)).toBeVisible();
      await settleMotion(page, undefined, true);
      const reading = await content.evaluate((el) => el.scrollTop);
      // The grandchild's page fits a computer's window; on a phone it scrolls, and the position read must be kept.
      if (await content.evaluate((el) => el.scrollHeight > el.clientHeight)) expect(reading).toBeGreaterThan(0);
      if (narrow) {
        await expect(page.locator('[data-family-sheet] [data-sheet-grip]')).toBeVisible();
        // The sheet is over everything at the screen's foot: the input's floating actions do not cover its rows.
        expect(await page.evaluate(() => {
          const sheet = document.querySelector('[data-family-sheet]')!.getBoundingClientRect(), missed: string[] = [];
          for (let y = sheet.top + sheet.height / 2; y < sheet.bottom - 4; y += 16) for (const x of [12, 60, sheet.width / 2, sheet.width - 60, sheet.width - 12]) {
            const at = document.elementFromPoint(x, y);
            if (!at?.closest('[data-family-sheet]')) missed.push(`${Math.round(x)},${Math.round(y)} ${at?.outerHTML.slice(0, 60)}`);
          }
          return missed;
        })).toEqual([]);
      }
      else {
        // Beside the reader, never over what it shows.
        await expect(page.locator('[data-family-surface="beside"]')).toBeVisible();
        expect(await clear(page)).toBe(true);
      }
      // The family from the root; the task being read boxed, in view and focused; rows carry no counts.
      await expect(row(page, 'T11')).toBeVisible();
      const here = row(page, 'T1142');
      await expect(here).toHaveAttribute('data-family-here', 'true');
      await expect(here.locator('[data-family-go]')).toHaveAttribute('aria-current', 'page');
      await expect(here.locator('[data-family-go]')).toBeFocused();
      await expect(here).toBeInViewport();
      // No counts beside the rows: a fold mark is only the mark.
      expect(await panel(page).locator('[data-family-fold]').evaluateAll((folds) => folds.map((f) => (f.textContent ?? '').trim()).filter(Boolean))).toEqual([]);
      // Rows a finger can press: 40px on a phone, 30px on a computer.
      const heights = await panel(page).locator('[data-family-go]').evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height));
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(narrow ? 40 : 30);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await keepShot(page, `family-panel-${name}-2-open`);

      // Trace another branch, then pick task after task there: the reader follows each, the panel stays open, its box
      // moves, and the branches seen stay as they were.
      await row(page, 'T111').locator('[data-family-fold]').click();
      await expect(row(page, 'T1111')).toBeVisible();
      await keepShot(page, `family-panel-${name}-3-trace`);
      await row(page, 'T1111').locator('[data-family-go]').click();
      await shown(page, 'T1111');
      await expect(panel(page)).toBeVisible();
      await expect(row(page, 'T1111')).toHaveAttribute('data-family-here', 'true');
      await expect(row(page, 'T1142')).toBeVisible();
      await expect(entry(page)).toHaveAttribute('aria-expanded', 'true');
      await keepShot(page, `family-panel-${name}-4-picked`);
      await row(page, 'T1112').locator('[data-family-go]').click();
      await shown(page, 'T1112');
      await expect(row(page, 'T1112')).toHaveAttribute('data-family-here', 'true');
      await expect(row(page, 'T1112')).toBeInViewport();
      await keepShot(page, `family-panel-${name}-5-picked-again`);

      // The reader's Back, twice: the panel stays open and its box follows the reader back to the grandchild.
      await reader(page).locator('[data-reader-back]').click();
      await shown(page, 'T1111');
      await expect(row(page, 'T1111')).toHaveAttribute('data-family-here', 'true');
      await reader(page).locator('[data-reader-back]').click();
      await shown(page, 'T1142');
      await expect(row(page, 'T1142')).toHaveAttribute('data-family-here', 'true');
      await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(reading);
      await keepShot(page, `family-panel-${name}-6-back`);
      // Only the person closes it: Esc here, the focus back on the entry.
      await row(page, 'T1142').locator('[data-family-go]').focus();
      await page.keyboard.press('Escape');
      await expect(panel(page)).toHaveCount(0);
      await expect(entry(page)).toBeFocused();
    });

    // On a computer this wait is gone through in the first test above, which picks the finished T1111.
    if (narrow) test('moved to a task still being looked up, the panel stays open through the wait (review r5, I1)', async ({ page, runtime }) => {
      await open(page, runtime, '?task=T1142');
      await shown(page, 'T1142');
      await entry(page).click();
      await expect(panel(page)).toBeVisible();
      // T1111 is finished, under a branch left folded: the page does not hold it until it is looked up, held here a moment.
      let release = () => {};
      const gate = new Promise<void>((done) => { release = done; });
      await page.route('**/api/**', async (route) => { if (route.request().url().includes('T1111')) await gate; await route.continue(); });
      await page.evaluate(() => { history.pushState(null, '', '?task=T1111'); dispatchEvent(new PopStateEvent('popstate')); });
      await expect(page.locator('[data-reader-awaiting]')).toHaveCount(1);
      await expect(panel(page)).toBeVisible();
      await keepShot(page, `family-panel-${name}-pending`);
      release();
      await shown(page, 'T1111');
      await expect(panel(page)).toBeVisible();
      await expect(row(page, 'T1111')).toHaveAttribute('data-family-here', 'true');
      await expect(entry(page)).toHaveAttribute('aria-expanded', 'true');
      await page.unroute('**/api/**');
    });
  });
}
