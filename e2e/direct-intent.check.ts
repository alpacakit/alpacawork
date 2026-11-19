import type { Locator, Page } from '@playwright/test';
import { controlIndexSchema } from '@alpacawork/contract/control';
import { test, expect, open } from './fixtures.ts';
import type { Runtime } from './server.ts';

test.use({ isolated: true });
const intents = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('alpacawork-write-intents-v5') ?? '{"entries":{}}').entries);
/** A project is made as a Task of kind project: its write is a task/new. */
const creating = (url: string) => new URL(url).pathname === '/api/task/new';
const projectTitles = async (page: Page, runtime: Runtime) =>
  controlIndexSchema.parse(await (await page.request.get(runtime.origin + '/api/workspace/live')).json()).projects.map(project => project.title);
async function projectDialog(page: Page) {
  // A pending result can stand over this menu on a narrow screen; the native keyboard entrance stays usable.
  await page.locator('[data-project-trigger]').press('Enter');
  await page.locator('[data-project-new]').press('Enter');
  return page.getByRole('dialog', { name: 'New project', exact: true });
}
/** The parent the dialog starts with, and another it offers. */
async function parents(dialog: Locator) {
  const select = dialog.getByLabel('Parent project', { exact: true });
  const first = await select.inputValue();
  const values = await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  return { select, first, other: values.find(value => value !== first)! };
}

for (const arrival of ['committed'] as ('not-arrived' | 'committed')[]) test(`an unknown project write holds every new input until it is checked (${arrival})`, async ({ page, runtime }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, '?agent=1');
  let dialog = await projectDialog(page);
  const { select, other } = await parents(dialog);
  await dialog.locator('#project-new-name').fill('foo');
  const sent: { body: string | null; id: string | undefined }[] = [];
  await page.route(url => creating(url.href), async route => {
    sent.push({ body: route.request().postData(), id: route.request().headers()['x-alpacawork-op-id'] });
    if (sent.length === 1) {
      if (arrival === 'committed') { const response = await route.fetch(); expect(response.status()).toBe(200); }
      return route.abort('failed');
    }
    const response = await route.fetch(); await route.fulfill({ response });
  });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-toast]').getByRole('button', { name: 'Check', exact: true })).toBeVisible();
  dialog = await projectDialog(page);
  await expect(dialog.getByRole('button', { name: 'Check', exact: true })).toBeVisible();
  const foo = () => page.locator('[data-toast]').filter({ hasText: 'foo' });
  // The dialog owns this check while it is open, so no toast repeats it over the fields.
  await expect(foo()).toHaveCount(0);
  // Making a project is one write whatever its name or parent: no edit replaces or sends past its fixed request.
  await dialog.locator('#project-new-name').fill('new foo name');
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await select.selectOption(other);
  await dialog.locator('#project-new-name').fill('bar');
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await dialog.locator('#project-new-name').press('Enter');
  if (process.env.DIRECT_SECOND_SHOTS && arrival === 'not-arrived') await page.screenshot({ path: process.env.DIRECT_SECOND_SHOTS + '/held-foo.png' });
  const old = Object.values(await intents(page)).find((entry: any) => entry.payload?.title === 'foo') as any;
  expect(old).toMatchObject({ status: 'unconfirmed', payload: { kind: 'project', title: 'foo' }, operationId: sent[0]!.id });
  expect(sent).toHaveLength(1);
  expect((await projectTitles(page, runtime)).includes('foo')).toBe(arrival === 'committed');
  // Closed, the fixed operation is checkable from its notification until reload reconciles it.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(foo()).toContainText("if it hasn't arrived, it runs now");
  await expect(foo().getByRole('button', { name: 'Close notification' })).toBeVisible();
  await foo().dispatchEvent('pointerdown', { pointerId: 1, clientX: 700, clientY: 600, isPrimary: true, button: 0 });
  await foo().dispatchEvent('pointermove', { pointerId: 1, clientX: 1000, clientY: 600, isPrimary: true });
  await foo().dispatchEvent('pointerup', { pointerId: 1, clientX: 1000, clientY: 600, isPrimary: true });
  await expect(foo().getByRole('button', { name: 'Check', exact: true })).toBeVisible();
  const beforeHide = await intents(page);
  await foo().getByRole('button', { name: 'Close notification', exact: true }).click();
  await expect(foo()).toHaveCount(0);
  expect(await intents(page)).toEqual(beforeHide);
  // The fixed write still blocks a new request. Opening and closing its form republishes the same notification id.
  dialog = await projectDialog(page);
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await dialog.locator('#project-new-name').press('Enter');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(foo()).toHaveCount(0);
  expect(await intents(page)).toEqual(beforeHide);
  expect(sent).toHaveLength(1);
  await page.reload();
  // Reconnection checks the old fixed operation, never the edited project input. A committed write needs no alert.
  await expect.poll(async () => Object.values(await intents(page)).find((entry: any) => entry.payload?.title === 'foo')).toMatchObject({ status: 'confirmed', operationId: old.operationId });
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  await expect(foo()).toHaveCount(0);
  // Settled, the kept edit is made as a project of its own.
  dialog = await projectDialog(page);
  await expect(dialog.locator('#project-new-name')).toHaveValue('bar');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('bar');
  expect(sent).toHaveLength(3);
  expect(JSON.parse(sent[2]!.body!)).toMatchObject({ kind: 'project', title: 'bar' });
  expect(sent[2]!.id).not.toBe(sent[0]!.id);
  // Made once each, whether foo's first write had arrived or not.
  const titles = await projectTitles(page, runtime);
  expect(titles.filter(title => title === 'foo')).toHaveLength(1);
  expect(titles.filter(title => title === 'bar')).toHaveLength(1);
});

test('storage failure sends nothing, reports the fault and preserves editable project input through a repaired reload', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, '?agent=1');
  let dialog = await projectDialog(page);
  await dialog.locator('#project-new-name').fill('kept');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'alpacawork-write-intents-v5') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  let sent = 0;
  await page.route(url => creating(url.href), async route => { sent++; await route.continue(); });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toContainText('Draft storage is unavailable');
  await expect(dialog.locator('#project-new-name')).toHaveValue('kept');
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  expect(sent).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('alpacawork-write-intents-v5'))).toBeNull();
  await page.reload(); dialog = await projectDialog(page);
  await expect(dialog.locator('#project-new-name')).toHaveValue('kept');
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
});
