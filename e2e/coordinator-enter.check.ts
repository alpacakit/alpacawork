import { labelLayer } from './editor-surface.ts';
import { test as base, expect, open, openCoordinator, writeCoordinator } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import type { Page } from '@playwright/test';
import { start, type Runtime } from './server.ts';
const test = base.extend({ runtime: async ({}, use) => {
  // The chosen profile must exist before the coordinator conversation is created.
  const runtime = await start(undefined, configureCoordinator);
  try { await use(runtime); } finally { await runtime.stop(); }
} });
const field = (page: Page) => page.locator('[data-one-input]');
test.use({ isolated: true, channel: 'chrome' });
async function begin(page: Page, runtime: Runtime, phone = false) {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await open(page, runtime, '?agent=1'); await writeCoordinator(page);
}
async function launch(page: Page) { await openCoordinator(page); await expect(field(page)).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('[data-coordinator-card]').getByRole('button', { name: 'Attach', exact: true })).toBeEnabled(); }

test.describe('Enter sending in Chrome', () => {
  test('Enter sends, Shift+Enter breaks lines, and IME/candidates/empty input do not send', async ({ page, runtime }) => {
    await page.route('**/api/coordinator/skills?*', route => route.fulfill({ json: { status: 'ready', profile: 'fake',
      skills: [{ name: 'alpacawork', description: 'Manage', invocation: '/' }] } }));
    await begin(page, runtime); await launch(page);
    let sends = 0;
    page.on('request', request => { if (request.url().endsWith('/api/coordinator/messages')) sends++; });
    await field(page).fill(''); await field(page).press('Enter');
    expect(sends).toBe(0); await expect(field(page).locator('p')).toHaveCount(1);
    await field(page).fill('First'); await field(page).press('End'); await field(page).press('Shift+Enter');
    await page.keyboard.insertText('More'); await expect(field(page).locator('br')).toHaveCount(1);
    expect(sends).toBe(0); await expect(field(page)).toHaveAttribute('title', /Enter to send.*Shift\+Enter for a new line/);
    // Chrome confirmation while composing, then Safari's compositionend-before-keydown ordering.
    await field(page).dispatchEvent('compositionstart');
    await field(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    await field(page).dispatchEvent('compositionend');
    await page.waitForTimeout(70);
    await field(page).dispatchEvent('keydown', { key: 'Enter', isComposing: false, keyCode: 229 });
    expect(sends).toBe(0);
    await page.waitForTimeout(70);
    for (const [trigger, kind] of [['#T111', 'task'], ['/alpacawork', 'skill']] as const) {
      // Keep the editor's selection in its native keyboard path after the IME probe.
      // fill('') selects the DOM then sends Delete; that selection can lag the editor's state.
      await field(page).press('ControlOrMeta+a'); await field(page).press('Backspace');
      await expect(field(page)).toHaveText(''); await expect(field(page)).toBeFocused();
      await page.keyboard.insertText(trigger); await expect(field(page)).toHaveText(trigger);
      await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible(); await field(page).press('Enter');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(labelLayer(field(page)).locator(`[data-label=${kind}]`)).toHaveCount(1); expect(sends).toBe(0);
    }
    await field(page).fill('#zzzznomatch'); await expect(page.getByRole('listbox')).toBeVisible();
    await field(page).press('Enter'); expect(sends).toBe(0);
    await field(page).fill('Body sent with Enter');
    await field(page).press('End'); await field(page).press('Shift+Enter'); await page.keyboard.insertText('Continuation line');
    expect(sends).toBe(0);
    const request = page.waitForRequest(request => request.url().endsWith('/api/coordinator/messages'));
    await field(page).press('Enter'); expect((await request).postDataJSON().text).toBe('Body sent with Enter\nContinuation line');
    expect(sends).toBe(1);
  });
});
