import { projectRows } from './fixture/list-rows.ts';
import { test, expect, open, openCoordinator, openReference, settleMotion } from './fixtures.ts';
import { configureCoordinator, readyCoordinator } from './coordinator-fixture.ts';
import { commandPost } from './command-post.ts';

test.use({ isolated: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  runtimePrepare: async ({}, use) => { await use(root => { configureCoordinator(root); projectRows(root, ['T111']); }); } });

test('sending and live updates preserve the closed reader and a visible task body', async ({ page, runtime }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page, runtime, '?agent=1&task=T111');
  const reader = page.locator('aside[data-reader-mode]');
  await expect(reader.locator('[data-report-feed]')).toBeVisible();
  await settleMotion(page, undefined, true);
  await reader.getByRole('button', { name: 'Close details' }).tap();
  await expect(reader).toHaveCount(0);
  await openCoordinator(page);
  // The answers counted are the sends' own; the background warm-up they would otherwise wait behind has its own lifetime.
  await readyCoordinator(page, runtime);
  const field = page.locator('[data-coordinator-card] [data-one-input]');
  for (let n = 0; n < 3; n++) {
    await field.fill('T111 markdown-answer');
    await page.locator('[data-coordinator-card] [data-ask-send]').tap();
    await expect(page.locator('[data-coordinator-turn=succeeded]')).toHaveCount(n + 1);
    const { task } = await (await page.request.get(`${runtime.origin}/api/task/view?task=T111`)).json();
    const changed = await commandPost(page.request, `${runtime.origin}/api/commands/task/update`, {
      data: { task: 'T111', title: `Updated ${n}`, expectedTaskHash: task.hash },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await expect(page.locator('[data-row=T111]')).toContainText(`Updated ${n}`);
    await expect(reader).toHaveCount(0);
  }
  await page.screenshot({ path: info.outputPath('after-send.png') });
  await openReference(page.locator('[data-coordinator-panel] [data-sent-message] button[data-label=task]').last(), { tap: true });
  await expect(reader.locator('[data-report-feed]')).toBeVisible();
  await page.screenshot({ path: info.outputPath('body.png') });
  expect(errors).toEqual([]);
});

test('a failed History requalification offers recovery instead of an empty body', async ({ page, runtime }) => {
  await open(page, runtime, '?agent=1&task=T111');
  const reader = page.locator('aside[data-reader-mode]');
  await expect(reader.locator('[data-report-feed]')).toBeVisible();
  await page.route('**/api/task/history?task=T111&*', route => route.fulfill({ status: 503,
    json: { error: { code: 'busy', message: 'History is temporarily unavailable', retry: 'later' } } }));
  const { task } = await (await page.request.get(`${runtime.origin}/api/task/view?task=P1`)).json();
  const changed = await commandPost(page.request, `${runtime.origin}/api/commands/task/update`, {
    data: { task: 'P1', values: { project_policy: 'Project instructions changed' }, expectedTaskHash: task.hash },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await expect(reader.locator('[data-read-failure]')).toBeVisible();
  await page.unroute('**/api/task/history?task=T111&*');
  await reader.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(reader.locator('[data-report-feed]')).toBeVisible();
});

test.describe('computer', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

  test('a finished task read again keeps the docked reader its width and its tree beside it', async ({ page, runtime }) => {
    await open(page, runtime, '?agent=1&task=T1141');
    const reader = page.locator('aside[data-reader-mode]:visible');
    await expect(reader.locator('[data-reader-task-id]')).toHaveText('T1141');
    await reader.locator('[data-family-entry]').click();
    await expect(page.locator('[data-family-surface="beside"]')).toBeVisible();
    await settleMotion(page);
    const width = Math.round(await reader.evaluate(aside => aside.getBoundingClientRect().width));
    // Every frame from here on: the reader's width and where its tree stands.
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as Window & { seen?: Set<string> }).seen = seen;
      const frame = () => {
        const aside = document.querySelector('aside[data-reader-mode]');
        seen.add(`${Math.round(aside?.getBoundingClientRect().width ?? 0)} ${document.querySelector('[data-family-surface]')?.getAttribute('data-family-surface') ?? 'none'}`);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    // The read again takes a while, as over a network: the finished task's list rows wait for it meanwhile.
    await page.route('**/api/task/**', async route => { await new Promise(done => setTimeout(done, 300)); await route.continue(); });
    const { task } = await (await page.request.get(`${runtime.origin}/api/task/view?task=T1141`)).json();
    const changed = await commandPost(page.request, `${runtime.origin}/api/commands/task/update`, {
      data: { task: 'T1141', title: 'Read again', expectedTaskHash: task.hash },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await expect(reader.locator('[data-head-title] h2')).toHaveText('Read again');
    await expect(reader.locator('[data-reading-line]')).toHaveCount(0);
    expect(await page.evaluate(() => [...(window as Window & { seen?: Set<string> }).seen!])).toEqual([`${width} beside`]);
  });
});
