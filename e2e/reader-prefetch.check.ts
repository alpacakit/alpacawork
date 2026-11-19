import { configureCoordinator } from './coordinator-fixture.ts';
import { projectRows } from './fixture/list-rows.ts';
import { observeReadAhead } from './read-ahead-observation.ts';
import { test, expect, open, openAbout, openCoordinator } from './fixtures.ts';

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => { configureCoordinator(root); projectRows(root, ['T111', 'T113']); }); } });

// A row awaiting the person, updated while closed, must be ready even when it was never a next-row candidate.
test.describe('updated detail idle read ahead 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('a live update fetches the closed detail before it opens without loading or marking read', async ({ page, runtime }, info) => {
    const { commandPost } = await import('./command-post.ts');
    const observation = observeReadAhead(page);
    await open(page, runtime, '?agent=1');
    const row = page.locator('[data-row=T113]').first();
    await expect(row).toBeVisible();
    await openCoordinator(page);
    const input = page.locator('[data-coordinator-card] [data-one-input]');
    await input.focus();
    // The person is at the keys from before the update is written until the draft is in, so the update lands while they
    // type: a focused input alone is quiet, and a page quiet for the read-ahead's pause may read the update at once.
    let atKeys = true;
    const keys = (async () => { while (atKeys) { await page.keyboard.press('End'); await page.waitForTimeout(100); } })();
    keys.catch(() => {}); // Awaited below; a case that fails before then closes the page under it.
    const notices = await (await page.request.get(`${runtime.origin}/api/person/notices`)).json();
    const { task } = await (await page.request.get(`${runtime.origin}/api/task/view?task=T113`)).json();
    const changed = await commandPost(page.request, `${runtime.origin}/api/task/update`, {
      data: { task: 'T113', values: { notes: 'Idle-prefetched latest body.' }, title: 'Idle-prefetched task', expectedTaskHash: task.hash },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    const latest = (await changed.json()).task;
    const commented = await commandPost(page.request, `${runtime.origin}/api/task/comment`, {
      data: { task: 'T113', title: 'Idle-prefetched latest timeline', description: 'Latest chronology acquired before opening.', expectedTaskHash: latest.hash },
    });
    expect(commented.ok(), await commented.text()).toBe(true);
    await expect(row).toContainText('Idle-prefetched task');
    atKeys = false; await keys;
    await page.keyboard.type('Keep this draft', { delay: 100 });
    expect(observation.requests.filter(id => id.startsWith('T113:'))).toEqual([]);
    for (let n = 0; n < 4; n++) {
      await page.mouse.wheel(0, 80);
      await page.waitForTimeout(150);
      expect(observation.requests.filter(id => id.startsWith('T113:'))).toEqual([]);
    }
    await expect(input).toContainText('Keep this draft');
    await observation.ready('T113');
    const before = [...observation.requests.filter(id => id.startsWith('T113:'))];
    await row.click();
    const reader = page.locator('aside[data-reader-mode]:visible');
    await expect(reader.locator('[data-reader-task-id]')).toHaveText('T113');
    await expect(reader).toContainText('Idle-prefetched task');
    await expect(reader).toContainText('Idle-prefetched latest timeline');
    await observation.check('T113');
    expect(observation.requests.filter(id => id.startsWith('T113:'))).toEqual(before);
    await reader.screenshot({ path: info.outputPath('updated-ready.png') });
    await openAbout(reader);
    await expect(reader).toContainText('Idle-prefetched latest body.');
    expect(await (await page.request.get(`${runtime.origin}/api/person/notices`)).json()).toEqual(notices);
    expect(observation.requests.filter(id => id.startsWith('T113:'))).toEqual(before);
  });
});
