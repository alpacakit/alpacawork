/**
 * A Working row says how many agents run on it and under it, ■N before its working time, on a server whose Runs really
 * go: the owner, a member, a child, a grandchild and a child no page loads, never one still queued. A Run's start and end
 * change it live. The row keeps its one line at any width and with three digits.
 */
import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { runningRunsTest as test } from './fixture/running-runs.ts';

const mark = (page: Page, id: string) => page.locator(`[data-row="${id}"] [data-row-running-runs]`);

test('the count follows the Runs that really run, live, and only on Working rows', async ({ page, runtime, scene }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(runtime.origin + '/?agent=1');
  await expect(mark(page, scene.busy)).toHaveAttribute('data-row-running-runs', '5');
  await expect(mark(page, scene.single)).toHaveAttribute('data-row-running-runs', '1');
  await expect(mark(page, scene.crowded)).toHaveAttribute('data-row-running-runs', '128');
  await expect(page.locator(`[data-row="${scene.queuedOnly}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-row="${scene.queuedOnly}"] [data-row-status]`)).toHaveAttribute('data-row-status', 'queued');
  await expect(mark(page, scene.queuedOnly)).toHaveCount(0);
  await expect(page.locator(`[data-row="${scene.asked}"]`)).toHaveCount(1);
  await expect(mark(page, scene.asked)).toHaveCount(0);

  await scene.end(scene.grandchildRun);
  await expect(mark(page, scene.busy)).toHaveAttribute('data-row-running-runs', '4', { timeout: 15_000 });
  await scene.end(scene.finishingRun);
  await expect(mark(page, scene.busy)).toHaveAttribute('data-row-running-runs', '3', { timeout: 15_000 });
  await scene.start(scene.waitingRun);
  await expect(mark(page, scene.busy)).toHaveAttribute('data-row-running-runs', '4', { timeout: 15_000 });
  await scene.end(scene.busyMember);
  await expect(mark(page, scene.busy)).toHaveAttribute('data-row-running-runs', '3', { timeout: 15_000 });
});
