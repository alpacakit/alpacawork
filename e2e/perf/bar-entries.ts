import type { Locator, Page } from '@playwright/test';

type Press = (target: Locator) => Promise<unknown>;
const click: Press = target => target.click();

/**
 * A bar entry where a person finds it. A bar that folds into ☰ (a phone's) keeps Time and Settings in its menu; a version
 * before the fold shows them on the bar, so paired runs against an older build still reach them. Opening the menu is
 * done here, before any measured press of the entry.
 */
async function barEntry(page: Page, onBar: Locator, inMenu: Locator, press: Press) {
  if (await onBar.isVisible()) return onBar;
  if (!await inMenu.isVisible()) await press(page.locator('[data-bar-menu-trigger]'));
  await inMenu.waitFor();
  // The menu slides in from the start edge; a touch tap lands where the entry stands once it has come to rest.
  await page.locator('[data-bar-menu]').evaluate(menu => Promise.all(menu.getAnimations({ subtree: true }).map(motion => motion.finished)));
  return inMenu;
}

/** The phone's Time switch: a pressed button on the bar, or a menuitemcheckbox in the bar's menu. */
export const stripsSwitch = (page: Page, press: Press = click) =>
  barEntry(page, page.locator('header [data-strips]'), page.locator('[data-bar-menu] [data-strips]'), press);

/** The Settings entry: the gear on the bar, or the row in the bar's menu. */
export const settingsEntry = (page: Page, press: Press = click) =>
  barEntry(page, page.locator('header').getByRole('button', { name: 'Settings', exact: true }), page.locator('[data-bar-menu-settings]'), press);

/** Whether the strips are shown, read from the switch on the bar or in the menu. */
export async function stripsShown(target: Locator) {
  return (await target.getAttribute('aria-pressed') ?? await target.getAttribute('aria-checked')) === 'true';
}

/** The same reading inside a page-side completion check: `${STRIPS_SHOWN}==='true'`. */
export const STRIPS_SHOWN = `(document.querySelector('[data-strips]')?.getAttribute('aria-pressed') ?? document.querySelector('[data-strips]')?.getAttribute('aria-checked'))`;

/** Closes the bar's menu if it is open, by its own × (pressed as the caller presses). */
export async function leaveBarMenu(page: Page, press: Press = click) {
  const menu = page.locator('[data-bar-menu]');
  if (!await menu.isVisible()) return;
  await press(menu.getByRole('button', { name: 'Close', exact: true }));
  await menu.waitFor({ state: 'detached' });
}

/** Shows or hides the strips as a person would, and leaves the list in view. */
export async function setStrips(page: Page, shown: boolean, press: Press = click) {
  const target = await stripsSwitch(page, press);
  if (await stripsShown(target) !== shown) await press(target);
  await leaveBarMenu(page, press);
}
