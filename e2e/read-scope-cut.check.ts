/**
 * A held read let go while the feed stays live cuts the read scope (read-model's cutReadScope). The page reads the index
 * again by itself, so the reader stops showing a Run that has ended at work, as the list already does.
 */
import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { runningRunsTest as test } from './fixture/running-runs.ts';

const working = (page: Page) => page.locator('aside[data-reader-mode] [data-working-here]');

test('a cut read scope is read again while live, so an ended Run leaves the working row', async ({ page, runtime, scene }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runtime.origin}/?agent=1&task=${scene.single}`);
  await expect(working(page)).toHaveCount(1);
  // A search holding a Task the list does not (a child that reported done), then let go as read-retention does.
  const search = page.locator('input[data-search-input]:visible');
  await search.fill('reported done');
  await expect(page.locator('[data-result-list]')).toBeVisible();
  await search.fill('');
  await page.evaluate(() => {
    let client: any; const seen = new Set();
    const walk = (f: any) => { if (!f || seen.has(f)) return; seen.add(f); if (f.memoizedProps?.client?.getQueryCache) client = f.memoizedProps.client; walk(f.child); walk(f.sibling); };
    const root = document.getElementById('root')!, key = Object.keys(root).find(k => k.startsWith('__reactContainer'))!;
    walk((root as any)[key]);
    client.removeQueries({ queryKey: ['task-search'] });
  });
  await scene.end(scene.singleRun);
  await expect(working(page)).toHaveCount(0, { timeout: 15_000 });
});
