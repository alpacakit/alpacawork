import { test, expect, open } from './fixtures.ts';

test.use({ isolated: true });

test('status button and menu switch away, pause, and resume', async ({ page, runtime }) => {
  await page.clock.setFixedTime(new Date());
  await open(page, runtime);
  const trigger = page.locator('[data-presence-trigger]');
  await expect(trigger).toHaveAttribute('aria-label', /away/);
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Notification status' })).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-label', /present/);
  await expect(page.locator('[data-presence-item="present"]')).toHaveAttribute('role', 'menuitemradio');
  await expect(page.locator('[data-presence-item="away"]')).toHaveAttribute('role', 'menuitemradio');
  await expect(page.locator('[data-presence-item="present"]')).toHaveAttribute('aria-checked', 'true');
  await expect(trigger.locator('[data-presence-glyph]')).toHaveAttribute('data-presence-glyph', 'present');
  await page.locator('[data-presence-item="away"]').click();
  await expect(trigger).toHaveAttribute('aria-label', /away/);
  await expect(trigger.locator('[data-presence-glyph]')).toHaveAttribute('data-presence-glyph', 'away');
  await trigger.click();
  await page.locator('[data-presence-item="hour"]').click();
  await expect(trigger).toHaveAttribute('aria-label', /Notifications paused until \d{1,2}:\d\d/);
  await expect(trigger.locator('[data-presence-glyph]')).toHaveAttribute('data-presence-glyph', 'muted');
  // The bar shows the mark alone; when it resumes is read inside.
  await expect(trigger).toHaveText('');
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Notification status' })).toContainText(/Notifications paused until \d{1,2}:\d\d/);
  await expect(page.locator('[data-presence-item="resume"]')).toBeVisible();
  await expect(page.locator('[data-presence-item="present"]')).toHaveCount(0);
  await page.locator('[data-presence-item="resume"]').click();
  await expect(trigger).toHaveAttribute('aria-label', /away/);
});
