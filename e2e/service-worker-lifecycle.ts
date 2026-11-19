import { expect, type Page } from '@playwright/test';

/** Installation deliberately leaves the first document uncontrolled. Only a later navigation uses the worker. */
export async function installedWorker(page: Page) {
  // This document's readiness and activation share one bound, including failed installation.
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  }, null, { timeout: 15000 });
}

export async function controlledNavigation(page: Page, url = page.url()) {
  await installedWorker(page);
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
