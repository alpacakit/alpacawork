import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures.ts';

// Saves and refusals go through config/set, so each case has a server of its own.
test.use({ isolated: true });

async function openServerSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Server', exact: true }).click();
  await page.locator('#server-advanced > summary').click();
  await expect(page.locator('#limit-attachment_mib')).toBeVisible();
}

/** The server settings' foot: what is saved, and its two buttons. */
const foot = (page: Page) => page.locator('[data-settings-foot]');

test("the settings' foot says what is saved, and its buttons do what they say: discard, save, and a refused save", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, runtime);
  await openServerSettings(page);
  const status = foot(page).getByRole('status');
  const discard = foot(page).getByRole('button', { name: 'Discard changes' }), save = foot(page).getByRole('button', { name: 'Save', exact: true });
  await expect(foot(page)).not.toHaveCSS('position', 'sticky');
  await expect(status).toHaveText('Saved');
  await expect(foot(page)).toContainText('Saving does not change the time limit of runs in progress or the agent settings of requests already accepted.');
  await expect(discard).toBeDisabled();
  await expect(save).toBeDisabled();
  await page.locator('[data-slot="dialog-body"]').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  // Only the body scrolls: at the end of a long tab the head's close button and the tabs are still in reach.
  expect(await page.locator('[data-slot="dialog-body"]').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  await expect(page.getByRole('tab', { name: 'Personal', exact: true })).toBeInViewport();

  const attachment = page.locator('#limit-attachment_mib');
  const before = await attachment.inputValue();
  await attachment.fill('60');
  await expect(status).toHaveText('Unsaved changes');
  await expect(discard).toBeEnabled();
  await page.locator('[data-slot="dialog-body"]').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await discard.click();
  await expect(page.locator('[data-toast]')).toHaveCount(0);
  await expect(attachment).toHaveValue(before);
  await expect(status).toHaveText('Saved');

  // A save refused because config.yaml changed elsewhere keeps the draft, says so by the buttons, and reads the latest.
  const file = join(runtime.root, 'config.yaml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n# changed elsewhere\n`);
  const limit = page.locator('#limit-attachment_mib');
  const limitBefore = await limit.inputValue();
  await limit.fill('60');
  await save.click();
  const refusal = foot(page).locator('..').getByRole('button', { name: 'Load the latest' });
  await expect(refusal).toBeVisible();
  await expect(limit).toHaveValue('60');
  await expect(status).toHaveText('Unsaved changes');
  await page.locator('[data-slot="dialog-body"]').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await refusal.click();
  await expect(limit).toHaveValue(limitBefore);
  await expect(refusal).toHaveCount(0);
  await expect(status).toHaveText('Saved');
  await expect(discard).toBeDisabled();

  // A save that goes through leaves nothing unsaved.
  await limit.fill('60');
  await save.click();
  await expect(status).toHaveText('Saved');
  await expect(save).toBeDisabled();
});
