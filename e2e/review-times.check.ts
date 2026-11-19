/**
 * A row in Awaiting review waits on the reader, so it says neither when its work is expected to report (the flag and
 * its time, "?", "over", or the time on a computer's strip) nor how its Runs go (running minutes, not running, an old last
 * output) nor how long it has been in its state, whether its Run has ended or still goes. A task at work beside them keeps
 * its expected report and work time before and after its estimate has passed; no row says how old its last output is.
 * A row in Idle waits on others' work, so it says no expected report either.
 */
import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { reviewTimes, reviewTimesTest as times } from './fixture/review-times.ts';

type Times = Awaited<ReturnType<typeof reviewTimes>>;

const row = (page: Page, id: string) => page.locator(`[data-row="${id}"]`);

/** The section a row is listed under: the last section heading before it. */
const sectionOf = (page: Page, id: string) => row(page, id).evaluate(element => [...document.querySelectorAll('[data-section]')]
  .filter(head => head.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)?.getAttribute('data-section'));

async function says(page: Page, scene: Times, over: boolean) {
  // Idle is folded at first: open it, as a reader would, to see its row. This device keeps it open across a reload.
  const idle = page.locator('[data-section="awaited"] button');
  if (await idle.getAttribute('aria-expanded') === 'false') await idle.click();
  for (const id of [scene.asked, scene.askedRunning, scene.pending, scene.review]) await expect.poll(() => sectionOf(page, id)).toBe('review');
  await expect.poll(() => sectionOf(page, scene.working)).toBe('doing');
  await expect.poll(() => sectionOf(page, scene.idle)).toBe('awaited');
  await expect(row(page, scene.idle).locator('[data-row-report], [data-future-label], [data-overrun], [data-ahead]')).toHaveCount(0);
  for (const id of [scene.asked, scene.askedRunning, scene.pending, scene.review]) {
    await expect(row(page, id).locator('[data-row-report]')).toHaveCount(0);
    await expect(row(page, id).locator('[data-row-status], [data-row-note]')).toHaveCount(0);
    await expect(row(page, id).locator('[data-future-label], [data-overrun], [data-ahead]')).toHaveCount(0);
  }
  await expect(row(page, scene.working).locator('[data-row-status]')).toHaveAttribute('data-row-status', 'running');
  // Even two hours after its last output, a running row keeps its time without an output-age note.
  await expect(row(page, scene.working).locator('[data-row-note]')).toHaveCount(0);
  await expect(page.locator('[data-time-tree]')).not.toContainText(/No output|出力なし/);
  await expect(row(page, scene.working).locator(over ? '[data-overrun]' : '[data-future-label]')).toHaveCount(1);
}

for (const width of [1440]) times(`at ${width}px an Awaiting review row says no expected report and no run state; a task at work keeps both`, async ({ page, runtime, scene }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(Date.now());
  await page.goto(runtime.origin + '/?agent=1');
  await says(page, scene, false);
  // Past the 30 minutes estimated: the task at work says so, the asked one still says nothing.
  await page.clock.setFixedTime(Date.now() + 2 * 3_600_000);
  await page.reload();
  await says(page, scene, true);
});
