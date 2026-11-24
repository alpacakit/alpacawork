import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures.ts';

// Saves and refusals go through config/set, so each case has a server of its own.
test.use({ isolated: true });

async function openAdvancedOptions(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.locator('#server-advanced > summary').click();
  await expect(page.locator('#limit-attachment_mib')).toBeVisible();
}

/** The save row of the tab shown (here General's Advanced options): what is saved, and its two buttons. */
const foot = (page: Page) => page.locator('[data-settings-foot]:visible');

test("the settings' foot says what is saved, and its buttons do what they say: discard, save, and a refused save", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, runtime);
  await openAdvancedOptions(page);
  const status = foot(page).getByRole('status');
  const discard = foot(page).getByRole('button', { name: 'Discard changes' }), save = foot(page).getByRole('button', { name: 'Save', exact: true });
  // On a PC the save row stays in view while the fields above it are read.
  await page.locator('#server-advanced').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect(status).toBeInViewport();
  await expect(save).toBeInViewport();
  await expect(status).toHaveText('Saved');
  await expect(foot(page)).toContainText('Saving does not change runs in progress or requests already accepted.');
  await expect(discard).toBeDisabled();
  await expect(save).toBeDisabled();
  await page.locator('[data-slot="dialog-body"]').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  // Only the body scrolls: at the end of a long tab the head's close button and the tabs are still in reach.
  expect(await page.locator('[data-slot="dialog-body"]').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  await expect(page.getByRole('tab', { name: 'Notifications', exact: true })).toBeInViewport();

  const attachment = page.locator('#limit-attachment_mib');
  const before = await attachment.inputValue();
  await attachment.fill('60');
  await expect(status).toHaveText('Unsaved changes (General → Advanced options)');
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
  // Pressed with the options' top in view, where it stands: a locator's click would first scroll the kept row to its
  // place at the end of the flow.
  await page.locator('#server-advanced').evaluate(element => element.scrollIntoView({ block: 'start' }));
  const at = (await save.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  // Said where the save was pressed, with the fields above still in view.
  const refusal = foot(page).locator('..').getByRole('button', { name: 'Load the latest' });
  await expect(refusal).toBeInViewport();
  await expect(page.locator('#server-advanced > summary')).toBeInViewport();
  await expect(limit).toHaveValue('60');
  await expect(status).toHaveText('Unsaved changes (General → Advanced options)');
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
  // On a phone it stays in the page's flow, clear of the keyboard.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(foot(page).locator('..')).not.toHaveCSS('position', 'sticky');
});
